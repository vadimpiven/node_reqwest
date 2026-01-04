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
import { createUndiciError, type CoreErrorInfo } from './errors.ts';

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
  #pendingRequests = 0;
  #needDrain = false;
  readonly #maxConcurrent = 100;

  constructor(options?: AgentOptions) {
    super();
    const creationOptions: AgentCreationOptions = {
      allowH2: options?.connection?.allowH2 ?? true,
      ca: normalizePem(options?.connection?.ca),
      keepAliveInitialDelay: options?.connection?.keepAliveInitialDelay ?? 60000,
      keepAliveTimeout: options?.connection?.keepAliveTimeout ?? 4000,
      localAddress: options?.connection?.localAddress ?? null,
      maxCachedSessions: options?.connection?.maxCachedSessions ?? 100,
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
    if (this.#closed) {
      const controller = new DispatchControllerImpl(Addon);
      handler.onResponseError?.(controller, new Error('Dispatcher is closed'));
      return false;
    }

    if (this.#destroyed) {
      const controller = new DispatchControllerImpl(Addon);
      handler.onResponseError?.(controller, new Error('Dispatcher is destroyed'));
      return false;
    }

    const controller = new DispatchControllerImpl(Addon);
    handler.onRequestStart?.(controller, {});

    if (controller.aborted) {
      handler.onResponseError?.(controller, controller.reason ?? new Error('Aborted'));
      return true;
    }

    const dispatchOptions: AgentDispatchOptions = {
      blocking: options.blocking ?? options.method !== 'HEAD',
      body: normalizeBody(options.body),
      bodyTimeout: options.bodyTimeout ?? 300000,
      expectContinue: options.expectContinue ?? false,
      headers: normalizeHeaders(options.headers),
      headersTimeout: options.headersTimeout ?? 300000,
      idempotent: options.idempotent ?? (options.method === 'GET' || options.method === 'HEAD'),
      method: options.method,
      origin: String(options.origin ?? ''),
      path: options.path,
      query: new URLSearchParams(options.query ?? '').toString(),
      reset: options.reset ?? false,
      throwOnError: options.throwOnError ?? false,
      upgrade: null, // Upgrade deferred - not in MVP
    };

    const callbacks: DispatchCallbacks = {
      onResponseStart: (
        statusCode: number,
        headers: Record<string, string | string[]>,
        statusMessage: string
      ) => {
        if (controller.aborted) return;
        handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
      },
      onResponseData: (chunk: Buffer) => {
        if (controller.aborted) return;
        handler.onResponseData?.(controller, chunk);
      },
      onResponseEnd: (trailers: Record<string, string | string[]>) => {
        if (controller.aborted) return;
        this.#onRequestComplete();
        handler.onResponseEnd?.(controller, trailers);
      },
      onResponseError: (errorInfo: CoreErrorInfo) => {
        this.#onRequestComplete();
        const undiciError = createUndiciError(errorInfo);
        handler.onResponseError?.(controller, controller.reason ?? undiciError);
      },
    };

    this.#pendingRequests++;
    const busy = this.#pendingRequests >= this.#maxConcurrent;
    if (busy) this.#needDrain = true;

    const nativeHandle = Addon.agentDispatch(this.#agent, dispatchOptions, callbacks);
    controller.setRequestHandle(nativeHandle);

    return !busy;
  }

  #onRequestComplete(): void {
    this.#pendingRequests--;
    if (this.#needDrain && this.#pendingRequests < this.#maxConcurrent) {
      this.#needDrain = false;
      queueMicrotask(() => this.emit('drain', new URL('http://localhost')));
    }
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
    throw new Error('connect() not implemented');
  }

  pipeline(_options: unknown, _handler: unknown): never {
    throw new Error('pipeline() not implemented');
  }

  request(_options: unknown, _callback?: unknown): Promise<never> {
    return Promise.reject(new Error('request() not implemented'));
  }

  stream(_options: unknown, _factory: unknown, _callback?: unknown): Promise<never> {
    return Promise.reject(new Error('stream() not implemented'));
  }

  upgrade(_options: unknown, _callback?: unknown): Promise<never> {
    return Promise.reject(new Error('upgrade() not implemented'));
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

  it('should return false when busy', async () => {
    const agent = new Agent();

    // Dispatch many requests without waiting
    const results: boolean[] = [];
    for (let i = 0; i < 150; i++) {
      const result = agent.dispatch(
        { origin: 'http://localhost:1', path: '/', method: 'GET' },
        {
          onResponseError: () => {
            // Expected - no server
          },
        }
      );
      results.push(result);
    }

    // At some point should return false (busy)
    expect(results.some((r) => r === false)).toBe(true);

    await agent.destroy();
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Exports** | `Agent`, `DispatchControllerImpl`, `hello` |
| **Events** | `drain` (undici standard) |
| **Concurrency Limit** | 100 pending requests |
| **Tests** | 3 E2E integration tests |

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
