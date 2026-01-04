# Agent Integration + E2E Tests (Chunk 5B)

## Problem/Purpose

Complete the library by integrating the FFI layer into a standard `Agent` class, enabling
full Undici compatibility and high-level resource management.

## Solution

Implement the `Agent` class extending `EventEmitter`, managing the native instance
lifecycle and coordinating request dispatching with backpressure.

## Architecture

```text
User 
  └─ Agent.dispatch()
       ├─ Callback Marshaling (Native -> JS)
       ├─ Concurrency tracking
       └─ Native Handle synchronization
```

## Implementation

### packages/node/export/agent.ts (Complete Agent)

```typescript
import { EventEmitter } from 'node:events';
import type { Dispatcher } from 'undici';
import Addon from '../index.node';

export class Agent extends EventEmitter implements Dispatcher {
  #agent: any;
  #pendingRequests = 0;
  #maxConcurrent = 100;

  constructor(url: string | URL, options?: any) {
    super();
    this.#agent = Addon.agentCreate({
      timeout: options?.bodyTimeout ?? 0,
      connectTimeout: options?.connectTimeout ?? 0,
      poolIdleTimeout: options?.keepAliveTimeout ?? 30000,
    });
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const controller = new DispatchControllerImpl();
    handler.onRequestStart?.(controller, {});

    const callbacks = {
      onResponseStart: (code: number, headers: any, msg: string) => handler.onResponseStart?.(controller, code, headers, msg),
      onResponseData: (chunk: Buffer) => handler.onResponseData?.(controller, chunk),
      onResponseEnd: (trailers: any) => {
        this.#onRequestComplete();
        handler.onResponseEnd?.(controller, trailers);
      },
      onResponseError: (err: any) => {
        this.#onRequestComplete();
        handler.onResponseError?.(controller, err);
      },
    };

    this.#pendingRequests++;
    const busy = this.#pendingRequests >= this.#maxConcurrent;
    const nativeHandle = Addon.agentDispatch(this.#agent, options, callbacks);
    
    controller.setRequestHandle({
      abort: () => Addon.requestHandleAbort(nativeHandle),
      pause: () => Addon.requestHandlePause(nativeHandle),
      resume: () => Addon.requestHandleResume(nativeHandle),
    });

    return !busy;
  }

  #onRequestComplete() {
    this.#pendingRequests--;
    if (this.#pendingRequests < this.#maxConcurrent) {
      queueMicrotask(() => this.emit('drain'));
    }
  }

  // ... close() and destroy() implementations calling native agentClose/agentDestroy ...
}
```

### packages/node/tests/vitest/dispatch-integration.test.ts

```typescript
import { describe, it, expect } from 'vitest';
import { Agent } from '../../export/agent';

describe('E2E Dispatch', () => {
  it('should complete a real request', async () => {
    const agent = new Agent('https://httpbin.org');
    await new Promise<void>((resolve, reject) => {
      agent.dispatch({ path: '/get', method: 'GET' }, {
        onResponseStart: () => {},
        onResponseData: () => {},
        onResponseEnd: () => resolve(),
        onResponseError: (c, err) => reject(err),
      });
    });
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Exports** | `Agent`, `DispatchController` |
| **Events** | `drain` (standard Undici) |
| **Max Concurrency** | Default 100 |

## File Structure

```text
packages/node/
└── export/
    └── agent.ts
```
