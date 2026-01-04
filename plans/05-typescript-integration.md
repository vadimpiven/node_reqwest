# TypeScript Integration

Complete undici `Dispatcher` interface with `DispatchController` and `Agent.dispatch()`.

**Prerequisites**: 01-04 complete and tested

## Goal

Implement full undici compatibility with proper controller state management and drain events.

## DispatchController (packages/node/export/agent.ts)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from 'undici';
import type { Addon, RequestHandle, DispatchCallbacks, CoreErrorInfo } from './addon-def';
import { createUndiciError } from './errors';
import AddonImpl from '../index.node';

const Addon: Addon = AddonImpl;

interface RequestHandle {
  abort(): void;
  pause(): void;
  resume(): void;
}

class DispatchControllerImpl implements Dispatcher.DispatchController {
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;
  #requestHandle: RequestHandle | null = null;

  get aborted(): boolean { return this.#aborted; }
  get paused(): boolean { return this.#paused; }
  get reason(): Error | null { return this.#reason; }

  setRequestHandle(handle: RequestHandle): void {
    this.#requestHandle = handle;
    // Apply pending state if abort/pause was called before handle was set
    if (this.#aborted) {
      this.#requestHandle.abort();
    } else if (this.#paused) {
      this.#requestHandle.pause();
    }
  }

  abort(reason: Error): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason;
    this.#requestHandle?.abort();
  }

  pause(): void {
    if (!this.#paused) {
      this.#paused = true;
      this.#requestHandle?.pause();
    }
  }

  resume(): void {
    if (this.#paused) {
      this.#paused = false;
      this.#requestHandle?.resume();
    }
  }
}
```text

## Agent Implementation (packages/node/export/agent.ts)

```typescript
import { EventEmitter } from 'node:events';

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

    // Check if aborted during onRequestStart
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
    
    // Wrap native handle
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

  // Stub implementations for other Dispatcher methods
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
```text

## Tests (packages/node/tests/vitest/controller.test.ts)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../../export/agent';
import type { Dispatcher } from 'undici';

describe('DispatchController', () => {
  it('should handle abort before request handle is set', () => {
    const agent = new Agent('http://httpbin.org');
    let controller: Dispatcher.DispatchController | null = null;

    const handler: Dispatcher.DispatchHandler = {
      onRequestStart: (ctrl) => {
        controller = ctrl;
        ctrl.abort(new Error('Early abort'));
      },
      onResponseError: vi.fn(),
    };

    agent.dispatch({ path: '/get', method: 'GET' }, handler);

    expect(controller?.aborted).toBe(true);
    expect(controller?.reason?.message).toBe('Early abort');
    expect(handler.onResponseError).toHaveBeenCalled();
  });

  it('should handle pause before request handle is set', async () => {
    const agent = new Agent('http://httpbin.org');
    let controller: Dispatcher.DispatchController | null = null;

    const handler: Dispatcher.DispatchHandler = {
      onRequestStart: (ctrl) => {
        controller = ctrl;
        ctrl.pause();
      },
      onResponseStart: vi.fn(),
    };

    agent.dispatch({ path: '/get', method: 'GET' }, handler);

    expect(controller?.paused).toBe(true);

    // Allow request to start
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    controller?.resume();
    expect(controller?.paused).toBe(false);
  });

  it('should track pending requests and emit drain', (done) => {
    const agent = new Agent('http://httpbin.org', { maxConcurrent: 2 } as any);
    
    // Set internal max to 2 for testing
    (agent as any).#maxConcurrent = 2;

    agent.on('drain', () => {
      done();
    });

    // Dispatch 3 requests, third should trigger busy state
    for (let i = 0; i < 3; i++) {
      const busy = agent.dispatch(
        { path: '/get', method: 'GET' },
        {
          onResponseEnd: () => {},
          onResponseError: () => {},
        }
      );

      if (i < 2) {
        expect(busy).toBe(true);
      } else {
        expect(busy).toBe(false);
      }
    }
  });
});

describe('Agent', () => {
  it('should reject dispatch when closed', () => {
    const agent = new Agent('http://httpbin.org');
    const onError = vi.fn();

    agent.close();

    agent.dispatch({ path: '/get', method: 'GET' }, { onResponseError: onError });

    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'Dispatcher is closed' })
    );
  });

  it('should reject dispatch when destroyed', () => {
    const agent = new Agent('http://httpbin.org');
    const onError = vi.fn();

    agent.destroy();

    agent.dispatch({ path: '/get', method: 'GET' }, { onResponseError: onError });

    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'Dispatcher is destroyed' })
    );
  });
});
```text

## Integration Tests (packages/node/tests/vitest/dispatch-integration.test.ts)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, expect } from 'vitest';
import { Agent } from '../../export/agent';

describe('Dispatch Integration', () => {
  it('should complete a full request/response cycle', async () => {
    const agent = new Agent('https://httpbin.org');
    
    const events: string[] = [];
    let statusCode = 0;
    let responseData = '';

    await new Promise<void>((resolve, reject) => {
      agent.dispatch(
        { path: '/headers', method: 'GET' },
        {
          onResponseStart: (controller, code) => {
            events.push('start');
            statusCode = code;
          },
          onResponseData: (controller, chunk) => {
            events.push('data');
            responseData += chunk.toString();
          },
          onResponseEnd: () => {
            events.push('end');
            resolve();
          },
          onResponseError: (controller, error) => {
            events.push('error');
            reject(error);
          },
        }
      );
    });

    expect(events).toEqual(['start', 'data', 'end']);
    expect(statusCode).toBe(200);
    expect(responseData).toContain('headers');
  });

  it('should handle abort mid-stream', async () => {
    const agent = new Agent('https://httpbin.org');
    
    const events: string[] = [];

    await new Promise<void>((resolve) => {
      agent.dispatch(
        { path: '/stream-bytes/10000', method: 'GET' },
        {
          onResponseStart: (controller) => {
            events.push('start');
            // Abort immediately
            controller.abort(new Error('Test abort'));
          },
          onResponseData: (controller) => {
            events.push('data');
          },
          onResponseEnd: () => {
            events.push('end');
          },
          onResponseError: (controller, error) => {
            events.push('error');
            expect(error.message).toBe('Test abort');
            resolve();
          },
        }
      );
    });

    expect(events).toContain('error');
  });

  it('should handle pause and resume', async () => {
    const agent = new Agent('https://httpbin.org');
    
    let pauseCount = 0;
    let dataCount = 0;

    await new Promise<void>((resolve, reject) => {
      agent.dispatch(
        { path: '/stream-bytes/1000', method: 'GET' },
        {
          onResponseStart: (controller) => {
            // Pause after start
            controller.pause();
            pauseCount++;

            // Resume after 100ms
            setTimeout(() => {
              controller.resume();
            }, 100);
          },
          onResponseData: (controller, chunk) => {
            dataCount++;
          },
          onResponseEnd: () => {
            resolve();
          },
          onResponseError: (controller, error) => {
            reject(error);
          },
        }
      );
    });

    expect(pauseCount).toBe(1);
    expect(dataCount).toBeGreaterThan(0);
  });
});
```text

## File Structure

```text
packages/node/
├── export/
│   └── agent.ts            # UPDATE: Add DispatchControllerImpl + Agent.dispatch()
└── tests/vitest/
    ├── controller.test.ts  # NEW: Controller state tests
    └── dispatch-integration.test.ts # NEW: E2E dispatch tests
```text

## Verification

```bash
cd packages/node
pnpm build
pnpm test controller.test.ts
pnpm test dispatch-integration.test.ts
```text

Expected output:

```text
✓ DispatchController > should handle abort before request handle is set
✓ DispatchController > should handle pause before request handle is set
✓ DispatchController > should track pending requests and emit drain
✓ Agent > should reject dispatch when closed
✓ Agent > should reject dispatch when destroyed
✓ Dispatch Integration > should complete a full request/response cycle
✓ Dispatch Integration > should handle abort mid-stream
✓ Dispatch Integration > should handle pause and resume
```text
