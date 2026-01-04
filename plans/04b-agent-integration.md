# Agent Integration + E2E Tests (Chunk 04b)

## Problem/Purpose

Complete the library by integrating the FFI layer into a standard `Agent` class, enabling
full undici compatibility with request/response lifecycle management.

## Solution

Implement `Agent` class extending `Dispatcher`, coordinating request dispatch with the
native addon and managing concurrency/drain events.

## Architecture

```text
User
  └─► Agent.dispatch(options, handler)
       ├─► DispatchControllerImpl ─► handler.onRequestStart()
       ├─► normalizeBody() ─► ReadableStreamBYOBReader
       ├─► Addon.agentDispatch() ─► RequestHandle
       ├─► controller.setRequestHandle(handle)
       └─► Callback marshaling ─► handler.on*()
```

## Implementation

### packages/node/export/agent-def.ts (Update)

Remove unsupported fields (reqwest doesn't support direct connection/pipelining configuration):

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type * as undici from 'undici';

/**
 * Network connection and TLS settings.
 *
 * Note: Some undici options are not supported by reqwest:
 * - 'connections' - reqwest manages pool size internally
 * - 'pipelining' - reqwest uses HTTP/2 multiplexing instead
 * - 'maxCachedSessions' - reqwest manages TLS sessions internally
 * - 'keepAliveInitialDelay' - not configurable in reqwest
 */
export type ConnectionOptions = Pick<
  undici.buildConnector.BuildOptions & undici.Client.Options & TlsConnectionOptions,
  | 'allowH2'
  | 'ca'
  | 'keepAliveTimeout'
  | 'localAddress'
  | 'rejectUnauthorized'
  | 'timeout'
> & {
  /**
   * Whether to verify that the server's certificate identity matches the requested hostname.
   * This is a specialized check that can be disabled independently of CA chain verification.
   * @default true
   */
  rejectInvalidHostnames?: boolean;
};

/**
 * Configuration for an upstream proxy.
 */
export type ProxyOptions = Pick<undici.ProxyAgent.Options, 'headers' | 'token' | 'uri'>;

/**
 * Configuration options for the Agent.
 */
export type AgentOptions = {
  /**
   * Network connection and TLS settings for direct or proxy tunnel connections.
   */
  connection?: ConnectionOptions | null;
  /**
   * Proxy configuration.
   * @default 'system'
   */
  proxy?: 'no-proxy' | 'system' | ProxyOptions | null;
};

/**
 * Factory for creating agents with specific configurations.
 */
export interface Agent {
  /**
   * Creates an Agent fully compatible with the Node.js global fetch dispatcher.
   */
  new (options?: AgentOptions): undici.Dispatcher;
}
```

### packages/node/export/agent.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type Stream from 'node:stream';

import { Dispatcher, type FormData, Response } from 'undici';

import type {
  Addon as AddonType,
  AgentCreationOptions,
  AgentDispatchOptions,
  AgentInstance,
  DispatchCallbacks,
} from './addon-def.ts';
import type { Agent as AgentDef, AgentOptions } from './agent-def.ts';
import { DispatchControllerImpl } from './dispatch-controller.ts';
import { createUndiciError, ClientClosedError, ClientDestroyedError, InvalidArgumentError, NotSupportedError, RequestAbortedError, ResponseError, type CoreErrorInfo } from './errors.ts';

// Import the actual addon - this will be the native binary
import AddonImpl from '../index.node';

const Addon: AddonType = AddonImpl;

function normalizePem(pem?: string | Buffer | (string | Buffer)[]): string[] {
  if (!pem) return [];

  if (Array.isArray(pem)) {
    return pem.flatMap(normalizePem);
  }

  return [Buffer.isBuffer(pem) ? pem.toString() : pem];
}

function normalizeHeaders(
  headers?:
    | Record<string, string | string[] | undefined>
    | Iterable<[string, string | string[] | undefined]>
    | string[]
    | null
): Record<string, string> {
  if (!headers) return {};

  const result: Record<string, string> = {};
  const add = (key: string, value?: string | string[]) => {
    if (!value) return;
    const k = key.toLowerCase();
    const v = Array.isArray(value) ? value.join(', ') : value;
    const existing = result[k];
    result[k] = existing ? `${existing}, ${v}` : v;
  };

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      add(headers[i], headers[i + 1]);
    }
  } else if (Symbol.iterator in headers) {
    for (const [key, value] of headers) {
      add(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      add(key, value);
    }
  }

  return result;
}

function normalizeBody(
  body?: string | Buffer | Uint8Array | FormData | Stream.Readable | null
): ReadableStreamBYOBReader | null {
  if (!body) return null;

  const response = new Response(body);
  if (!response.body) return null;

  return response.body.getReader({ mode: 'byob' });
}

class AgentImpl extends Dispatcher {
  readonly #agent: AgentInstance;
  #closed = false;
  #destroyed = false;
  /** Origins that have established at least one successful connection */
  #connectedOrigins = new Set<string>();

  constructor(options?: AgentOptions) {
    super();
    const creationOptions: AgentCreationOptions = {
      allowH2: options?.connection?.allowH2 ?? true,
      ca: normalizePem(options?.connection?.ca),
      keepAliveTimeout: options?.connection?.keepAliveTimeout ?? 4000,
      localAddress: options?.connection?.localAddress ?? null,
      proxy: options?.proxy
        ? typeof options.proxy === 'string'
          ? { type: options.proxy }
          : {
              type: 'custom',
              uri: options.proxy.uri,
              headers: normalizeHeaders(options.proxy.headers),
              token: options.proxy.token ?? null,
            }
        : { type: 'system' },
      rejectInvalidHostnames:
        options?.connection?.rejectInvalidHostnames ??
        options?.connection?.rejectUnauthorized ??
        true,
      rejectUnauthorized: options?.connection?.rejectUnauthorized ?? true,
      timeout: options?.connection?.timeout ?? 10000,
    };
    this.#agent = Addon.agentCreate(creationOptions);
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler
  ): boolean {
    const controller = new DispatchControllerImpl(Addon);

    // Reject unsupported CONNECT method and upgrade requests
    if (options.method === 'CONNECT' || options.upgrade) {
      const error = new NotSupportedError(
        'CONNECT method and upgrade requests are not supported'
      );
      handler.onResponseError?.(controller, error);
      return true;
    }

    if (this.#closed) {
      handler.onResponseError?.(controller, new ClientClosedError());
      return true;
    }

    if (this.#destroyed) {
      handler.onResponseError?.(controller, new ClientDestroyedError());
      return true;
    }

    // Call onRequestStart with empty context (no retries supported - all bodies are streams)
    try {
      handler.onRequestStart?.(controller, {});
    } catch (err) {
      handler.onResponseError?.(controller, err instanceof Error ? err : new Error(String(err)));
      return true;
    }

    if (controller.aborted) {
      handler.onResponseError?.(controller, controller.reason ?? new RequestAbortedError());
      return true;
    }

    // Handle external abort signal
    if (options.signal) {
      const signal = options.signal as AbortSignal;
      if (signal.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason : new RequestAbortedError();
        handler.onResponseError?.(controller, reason);
        return true;
      }
      signal.addEventListener('abort', () => {
        const reason = signal.reason instanceof Error ? signal.reason : new RequestAbortedError();
        controller.abort(reason);
      }, { once: true });
    }

    // Validate origin
    if (!options.origin) {
      handler.onResponseError?.(controller, new InvalidArgumentError('origin is required'));
      return true;
    }
    let origin: URL;
    try {
      origin = new URL(String(options.origin));
    } catch {
      handler.onResponseError?.(controller, new InvalidArgumentError('origin must be a valid URL'));
      return true;
    }

    const dispatchOptions: AgentDispatchOptions = {
      blocking: options.blocking ?? options.method !== 'HEAD',
      body: normalizeBody(options.body),
      bodyTimeout: options.bodyTimeout ?? 300000,
      headers: normalizeHeaders(options.headers),
      headersTimeout: options.headersTimeout ?? 300000,
      idempotent: options.idempotent ?? (options.method === 'GET' || options.method === 'HEAD'),
      method: options.method,
      origin: origin.origin,
      path: options.path,
      query: options.query
        ? Object.entries(options.query)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&')
        : '',
      reset: options.reset ?? false,
      throwOnError: options.throwOnError ?? false,
    };

    const originKey = origin.origin;
    // Track whether this request established a connection (for event emission)
    let requestConnected = false;

    const callbacks: DispatchCallbacks = {
      onResponseStart: (
        statusCode: number,
        headers: Record<string, string | string[]>,
        statusMessage: string
      ) => {
        if (controller.aborted) return;

        // Mark that connection was established for this request
        requestConnected = true;

        // Emit 'connect' event on first successful connection to this origin
        if (originKey && !this.#connectedOrigins.has(originKey)) {
          this.#connectedOrigins.add(originKey);
          queueMicrotask(() => this.emit('connect', origin, [this]));
        }

        // Handle throwOnError option
        if (dispatchOptions.throwOnError && statusCode >= 400) {
          const error = new ResponseError(
            `Request failed with status code ${statusCode}`,
            statusCode
          );
          handler.onResponseError?.(controller, error);
          controller.abort(error);
          return;
        }

        handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
      },
      onResponseData: (chunk: Buffer) => {
        if (controller.aborted) return;
        handler.onResponseData?.(controller, chunk);
      },
      onResponseEnd: (trailers: Record<string, string | string[]>) => {
        if (controller.aborted) return;
        // Note: trailers always empty - reqwest doesn't expose HTTP trailers
        handler.onResponseEnd?.(controller, trailers);
      },
      onResponseError: (errorInfo: CoreErrorInfo) => {
        // If controller was aborted with a reason, use that instead of the generic error
        // This handles user-initiated aborts with custom reasons
        if (controller.aborted && errorInfo.code === 'UND_ERR_ABORTED') {
          handler.onResponseError?.(controller, controller.reason ?? new RequestAbortedError());
          return;
        }

        const undiciError = createUndiciError(errorInfo);
        const isConnectionError =
          errorInfo.code === 'UND_ERR_SOCKET' ||
          errorInfo.code === 'UND_ERR_CONNECT_TIMEOUT';

        if (isConnectionError) {
          if (requestConnected) {
            // Connection was established then lost -> 'disconnect'
            queueMicrotask(() => this.emit('disconnect', origin, [this], undiciError));
          } else {
            // Connection never established -> 'connectionError'
            queueMicrotask(() => this.emit('connectionError', origin, [this], undiciError));
          }
        }

        handler.onResponseError?.(controller, undiciError);
      },
    };

    const nativeHandle = Addon.agentDispatch(this.#agent, dispatchOptions, callbacks);
    controller.setRequestHandle(nativeHandle);

    // Always return true - no internal queuing/backpressure limit
    // reqwest manages connection pooling internally
    return true;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return Addon.agentClose(this.#agent);
  }

  destroy(): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    this.#destroyed = true;
    this.#closed = true;
    return Addon.agentDestroy(this.#agent);
  }

  // Stubs for unimplemented methods
  connect(_options: unknown, _callback?: unknown): never {
    throw new NotSupportedError('connect() not implemented');
  }

  pipeline(_options: unknown, _handler: unknown): never {
    throw new NotSupportedError('pipeline() not implemented');
  }

  request(_options: unknown, _callback?: unknown): Promise<never> {
    return Promise.reject(new NotSupportedError('request() not implemented'));
  }

  stream(_options: unknown, _factory: unknown, _callback?: unknown): Promise<never> {
    return Promise.reject(new NotSupportedError('stream() not implemented'));
  }

  upgrade(_options: unknown, _callback?: unknown): Promise<never> {
    return Promise.reject(new NotSupportedError('upgrade() not implemented'));
  }
}

export const Agent: AgentDef = AgentImpl;

export { DispatchControllerImpl } from './dispatch-controller.ts';

export const hello = (): string => Addon.hello();
```

### packages/node/tests/vitest/dispatch-integration.test.ts

```typescript
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';

import { Agent } from '../../export/agent.ts';

describe('E2E Dispatch Integration', () => {
  it('should complete a real HTTP request', async () => {
    // Create local test server
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello world');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const agent = new Agent();

      await new Promise<void>((resolve, reject) => {
        let statusCode: number | undefined;
        const chunks: Buffer[] = [];

        agent.dispatch(
          { origin: `http://localhost:${port}`, path: '/', method: 'GET' },
          {
            onResponseStart: (_controller, code) => {
              statusCode = code;
            },
            onResponseData: (_controller, chunk) => {
              chunks.push(chunk);
            },
            onResponseEnd: () => {
              expect(statusCode).toBe(200);
              expect(chunks.length).toBeGreaterThan(0);
              const body = Buffer.concat(chunks).toString();
              expect(body).toBe('hello world');
              resolve();
            },
            onResponseError: (_controller, err) => {
              reject(err);
            },
          }
        );
      });

      await agent.close();
    } finally {
      server.close();
    }
  });

  it('should handle abort mid-request', async () => {
    const server = createServer((req, res) => {
      // Delay response
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 5000);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const agent = new Agent();

      await new Promise<void>((resolve) => {
        let aborted = false;

        agent.dispatch(
          { origin: `http://localhost:${port}`, path: '/', method: 'GET' },
          {
            onRequestStart: (controller) => {
              setTimeout(() => {
                controller.abort(new Error('User abort'));
                aborted = true;
              }, 50);
            },
            onResponseError: (_controller, err) => {
              expect(aborted).toBe(true);
              expect(err.message).toBe('User abort');
              resolve();
            },
          }
        );
      });

      await agent.close();
    } finally {
      server.close();
    }
  });

  it('should properly encode query parameters', async () => {
    const server = createServer((req, res) => {
      // Verify the query string is properly encoded
      const url = new URL(req.url!, `http://localhost`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        q: url.searchParams.get('q'),
        special: url.searchParams.get('special&key'),
      }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const agent = new Agent();

      await new Promise<void>((resolve, reject) => {
        const chunks: Buffer[] = [];

        agent.dispatch(
          {
            origin: `http://localhost:${port}`,
            path: '/search',
            method: 'GET',
            query: { q: 'hello world', 'special&key': 'value=1' },
          },
          {
            onResponseStart: (_controller, code) => {
              expect(code).toBe(200);
            },
            onResponseData: (_controller, chunk) => {
              chunks.push(chunk);
            },
            onResponseEnd: () => {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              expect(body.q).toBe('hello world');
              expect(body['special&key']).toBe('value=1');
              resolve();
            },
            onResponseError: (_controller, err) => {
              reject(err);
            },
          }
        );
      });

      await agent.close();
    } finally {
      server.close();
    }
  });

  it('should handle throwOnError option', async () => {
    const server = createServer((req, res) => {
      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const agent = new Agent();

      await new Promise<void>((resolve) => {
        agent.dispatch(
          {
            origin: `http://localhost:${port}`,
            path: '/',
            method: 'GET',
            throwOnError: true,
          },
          {
            onResponseError: (_controller, err) => {
              expect(err).toBeInstanceOf(Error);
              expect(err.message).toContain('404');
              resolve();
            },
          }
        );
      });

      await agent.close();
    } finally {
      server.close();
    }
  });

  it('should stream request body', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Received ${body.length} bytes`);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const agent = new Agent();

      // Create a readable stream with test data
      const testData = 'A'.repeat(10 * 1024); // 10KB
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(testData));
          controller.close();
        }
      });

      await new Promise<void>((resolve, reject) => {
        const chunks: Buffer[] = [];

        agent.dispatch(
          {
            origin: `http://localhost:${port}`,
            path: '/upload',
            method: 'POST',
            body: readable,
          },
          {
            onResponseStart: (_controller, code) => {
              expect(code).toBe(200);
            },
            onResponseData: (_controller, chunk) => {
              chunks.push(chunk);
            },
            onResponseEnd: () => {
              const response = Buffer.concat(chunks).toString();
              expect(response).toContain('10240 bytes');
              resolve();
            },
            onResponseError: (_controller, err) => {
              reject(err);
            },
          }
        );
      });

      await agent.close();
    } finally {
      server.close();
    }
  });

});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Exports** | `Agent`, `DispatchControllerImpl`, `hello` |
| **Events** | `connect` (per-origin), `disconnect`, `connectionError` |
| **dispatch() return** | Always `true` (reqwest manages pooling) |
| **throwOnError** | Emits `ResponseError` for 4xx/5xx when enabled |
| **Tests** | 5 E2E integration tests |

## File Structure

```text
packages/node/
├── export/
│   ├── addon-def.ts
│   ├── agent-def.ts
│   ├── agent.ts
│   ├── dispatch-controller.ts
│   └── errors.ts
└── tests/vitest/
    └── dispatch-integration.test.ts
```
