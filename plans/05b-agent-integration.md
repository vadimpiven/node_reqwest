# Agent Integration + E2E Tests (Chunk 5B)

## Problem/Purpose

Complete the library by integrating the FFI layer into a standard `Agent` class, enabling
full Undici compatibility and high-level resource management.

## Solution

Implement the `Agent` class extending `EventEmitter`, managing the native instance
lifecycle and coordinating request dispatching with backpressure. Uses `DispatchControllerImpl`
from chunk 5A.

## Architecture

```text
User 
  └─ Agent.dispatch()
       ├─ Callback Marshaling (Native -> JS)
       ├─ Concurrency tracking
       └─ Native Handle synchronization
```

## Implementation

### packages/node/export/agent.ts (Complete Agent Class)

```typescript
import { EventEmitter } from 'node:events';
import type { Dispatcher } from 'undici';
import type { Addon, DispatchCallbacks, CoreErrorInfo } from './addon-def';
import { createUndiciError } from './errors';
import AddonImpl from '../index.node';

const Addon: Addon = AddonImpl;

interface RequestHandle {
  abort(): void;
  pause(): void;
  resume(): void;
}

export class Agent extends EventEmitter implements Dispatcher {
  #agent: any;
  #closed = false;
  #destroyed = false;
  #pendingRequests = 0;
  #needDrain = false;
  #maxConcurrent = 100;
  #origin: URL | null = null;

  constructor(url: string | URL, options?: Dispatcher.AgentOptions) {
    super();
    
    this.#origin = typeof url === 'string' ? new URL(url) : url;

    this.#agent = Addon.agentCreate({
      timeout: options?.bodyTimeout ?? 0,
      connectTimeout: options?.connectTimeout ?? 0,
      poolIdleTimeout: options?.keepAliveTimeout ?? 30000,
    });
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler
  ): boolean {
    if (this.#closed) {
      const controller = new DispatchControllerImpl();
      handler.onResponseError?.(controller, new Error('Dispatcher is closed'));
      return false;
    }

    if (this.#destroyed) {
      const controller = new DispatchControllerImpl();
      handler.onResponseError?.(controller, new Error('Dispatcher is destroyed'));
      return false;
    }

    const controller = new DispatchControllerImpl();
    handler.onRequestStart?.(controller, {});

    if (controller.aborted) {
      handler.onResponseError?.(controller, controller.reason ?? new Error('Aborted'));
      return true;
    }

    const callbacks: DispatchCallbacks = {
      onResponseStart: (statusCode: number, headers: any, statusMessage: string) => {
        if (controller.aborted) return;
        handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
      },
      onResponseData: (chunk: Buffer) => {
        if (controller.aborted) return;
        handler.onResponseData?.(controller, chunk);
      },
      onResponseEnd: (trailers: any) => {
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

    const dispatchOptions = {
      origin: this.#origin?.origin ?? options.origin ?? '',
      path: options.path ?? '/',
      method: options.method ?? 'GET',
      headers: this.#buildHeaders(options.headers),
    };

    const nativeHandle = Addon.agentDispatch(this.#agent, dispatchOptions, callbacks);
    
    const requestHandle: RequestHandle = {
      abort: () => Addon.requestHandleAbort(nativeHandle),
      pause: () => Addon.requestHandlePause(nativeHandle),
      resume: () => Addon.requestHandleResume(nativeHandle),
    };
    controller.setRequestHandle(requestHandle);

    return !busy;
  }

  #buildHeaders(headers?: Record<string, string | string[]>): Record<string, string> {
    if (!headers) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      result[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    return result;
  }

  #onRequestComplete(): void {
    this.#pendingRequests--;
    if (this.#needDrain && this.#pendingRequests < this.#maxConcurrent) {
      this.#needDrain = false;
      if (this.#origin) {
        queueMicrotask(() => this.emit('drain', this.#origin));
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Addon.agentClose(this.#agent);
  }

  async destroy(err?: Error): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#closed = true;
    await Addon.agentDestroy(this.#agent, err ?? null);
  }

  connect(options: any, callback: any): void {
    throw new Error('connect() not implemented');
  }

  pipeline(options: any, handler: any): any {
    throw new Error('pipeline() not implemented');
  }

  request(options: any, callback?: any): Promise<any> {
    throw new Error('request() not implemented');
  }

  stream(options: any, factory: any, callback?: any): Promise<any> {
    throw new Error('stream() not implemented');
  }

  upgrade(options: any, callback?: any): Promise<any> {
    throw new Error('upgrade() not implemented');
  }
}
```

### packages/node/tests/vitest/dispatch-integration.test.ts

```typescript
import { describe, it, expect } from 'vitest';
import { Agent } from '../../export/agent';

describe('E2E Dispatch Integration', () => {
  it('should complete a real HTTP request', async () => {
    const agent = new Agent('https://httpbin.org');
    
    await new Promise<void>((resolve, reject) => {
      let statusCode: number | undefined;
      const chunks: Buffer[] = [];

      agent.dispatch(
        { path: '/get', method: 'GET' },
        {
          onResponseStart: (controller, code) => {
            statusCode = code;
          },
          onResponseData: (controller, chunk) => {
            chunks.push(chunk);
          },
          onResponseEnd: (controller) => {
            expect(statusCode).toBe(200);
            expect(chunks.length).toBeGreaterThan(0);
            resolve();
          },
          onResponseError: (controller, err) => {
            reject(err);
          },
        }
      );
    });

    await agent.close();
  });

  it('should handle abort mid-request', async () => {
    const agent = new Agent('https://httpbin.org');
    
    await new Promise<void>((resolve) => {
      let aborted = false;

      agent.dispatch(
        { path: '/delay/5', method: 'GET' },
        {
          onRequestStart: (controller) => {
            setTimeout(() => {
              controller.abort(new Error('User abort'));
              aborted = true;
            }, 100);
          },
          onResponseError: (controller, err) => {
            expect(aborted).toBe(true);
            expect(err.message).toBe('User abort');
            resolve();
          },
        }
      );
    });

    await agent.close();
  });

  it('should emit drain event', async () => {
    const agent = new Agent('https://httpbin.org');
    let drainEmitted = false;

    agent.on('drain', () => {
      drainEmitted = true;
    });

    // Simulate many concurrent requests
    const promises = Array.from({ length: 5 }, () =>
      new Promise<void>((resolve, reject) => {
        agent.dispatch(
          { path: '/get', method: 'GET' },
          {
            onResponseEnd: () => resolve(),
            onResponseError: (controller, err) => reject(err),
          }
        );
      })
    );

    await Promise.all(promises);
    expect(drainEmitted).toBe(true);

    await agent.close();
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Exports** | `Agent`, `DispatchController` |
| **Events** | `drain` (standard Undici) |
| **E2E Tests** | 3 integration tests |

## File Structure

```text
packages/node/
├── export/
│   └── agent.ts
└── tests/vitest/
    └── dispatch-integration.test.ts
```
