# DispatchController (Chunk 04a)

## Problem/Purpose

Implement the `Dispatcher.DispatchController` interface to provide users with a standard
way to control requests, including state buffering before native handle is established.

## Solution

Create `DispatchControllerImpl` that manages internal state (`#aborted`, `#paused`) and
synchronizes with the native `RequestHandle` through late-binding via `setRequestHandle()`.

## Architecture

```text
User
  └─► DispatchController.abort()
       └─► Buffer State (if no handle yet)
            └─► setRequestHandle(handle)
                 └─► Apply Buffered State to Native Handle
```

## Implementation

### packages/node/export/dispatch-controller.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from 'undici';

import type { Addon, RequestHandle } from './addon-def.ts';

/**
 * DispatchController implementation with state buffering.
 *
 * Allows abort/pause/resume before native handle is established.
 */
export class DispatchControllerImpl implements Dispatcher.DispatchController {
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;
  #requestHandle: RequestHandle | null = null;
  #addon: Addon;

  constructor(addon: Addon) {
    this.#addon = addon;
  }

  get aborted(): boolean {
    return this.#aborted;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get reason(): Error | null {
    return this.#reason;
  }

  /**
   * Set the native request handle. Applies any buffered state.
   */
  setRequestHandle(handle: RequestHandle): void {
    this.#requestHandle = handle;

    // Apply buffered state
    if (this.#aborted) {
      this.#addon.requestHandleAbort(handle);
    } else if (this.#paused) {
      this.#addon.requestHandlePause(handle);
    }
  }

  abort(reason: Error): void {
    if (this.#aborted) return;

    this.#aborted = true;
    this.#reason = reason;

    if (this.#requestHandle) {
      this.#addon.requestHandleAbort(this.#requestHandle);
    }
  }

  pause(): void {
    if (this.#paused) return;

    this.#paused = true;

    if (this.#requestHandle) {
      this.#addon.requestHandlePause(this.#requestHandle);
    }
  }

  resume(): void {
    if (!this.#paused) return;

    this.#paused = false;

    if (this.#requestHandle) {
      this.#addon.requestHandleResume(this.#requestHandle);
    }
  }
}
```

### packages/node/tests/vitest/controller.test.ts

```typescript
import { describe, it, expect, vi } from 'vitest';

import { DispatchControllerImpl } from '../../export/dispatch-controller.ts';
import type { Addon, RequestHandle } from '../../export/addon-def.ts';

function createMockAddon(): Addon & {
  requestHandleAbort: ReturnType<typeof vi.fn>;
  requestHandlePause: ReturnType<typeof vi.fn>;
  requestHandleResume: ReturnType<typeof vi.fn>;
} {
  return {
    hello: vi.fn(() => 'hello'),
    agentCreate: vi.fn(),
    agentDispatch: vi.fn(),
    agentClose: vi.fn(),
    agentDestroy: vi.fn(),
    requestHandleAbort: vi.fn(),
    requestHandlePause: vi.fn(),
    requestHandleResume: vi.fn(),
  } as unknown as Addon & {
    requestHandleAbort: ReturnType<typeof vi.fn>;
    requestHandlePause: ReturnType<typeof vi.fn>;
    requestHandleResume: ReturnType<typeof vi.fn>;
  };
}

describe('DispatchController', () => {
  it('should buffer abort state when no handle', () => {
    const addon = createMockAddon();
    const ctrl = new DispatchControllerImpl(addon);
    const error = new Error('User abort');

    ctrl.abort(error);

    expect(ctrl.aborted).toBe(true);
    expect(ctrl.reason).toBe(error);
    expect(addon.requestHandleAbort).not.toHaveBeenCalled();

    const mockHandle = {} as RequestHandle;
    ctrl.setRequestHandle(mockHandle);

    expect(addon.requestHandleAbort).toHaveBeenCalledWith(mockHandle);
  });

  it('should buffer pause state when no handle', () => {
    const addon = createMockAddon();
    const ctrl = new DispatchControllerImpl(addon);

    ctrl.pause();

    expect(ctrl.paused).toBe(true);
    expect(addon.requestHandlePause).not.toHaveBeenCalled();

    const mockHandle = {} as RequestHandle;
    ctrl.setRequestHandle(mockHandle);

    expect(addon.requestHandlePause).toHaveBeenCalledWith(mockHandle);
  });

  it('should call abort on handle if already set', () => {
    const addon = createMockAddon();
    const ctrl = new DispatchControllerImpl(addon);
    const mockHandle = {} as RequestHandle;

    ctrl.setRequestHandle(mockHandle);
    ctrl.abort(new Error('test'));

    expect(addon.requestHandleAbort).toHaveBeenCalledWith(mockHandle);
  });

  it('should handle pause and resume', () => {
    const addon = createMockAddon();
    const ctrl = new DispatchControllerImpl(addon);
    const mockHandle = {} as RequestHandle;

    ctrl.setRequestHandle(mockHandle);

    ctrl.pause();
    expect(ctrl.paused).toBe(true);
    expect(addon.requestHandlePause).toHaveBeenCalledWith(mockHandle);

    ctrl.resume();
    expect(ctrl.paused).toBe(false);
    expect(addon.requestHandleResume).toHaveBeenCalledWith(mockHandle);
  });

  it('should ignore duplicate abort calls', () => {
    const addon = createMockAddon();
    const ctrl = new DispatchControllerImpl(addon);
    const mockHandle = {} as RequestHandle;

    ctrl.setRequestHandle(mockHandle);

    ctrl.abort(new Error('first'));
    ctrl.abort(new Error('second'));

    expect(addon.requestHandleAbort).toHaveBeenCalledTimes(1);
    expect(ctrl.reason?.message).toBe('first');
  });

  it('should not call pause if already paused', () => {
    const addon = createMockAddon();
    const ctrl = new DispatchControllerImpl(addon);
    const mockHandle = {} as RequestHandle;

    ctrl.setRequestHandle(mockHandle);

    ctrl.pause();
    ctrl.pause();

    expect(addon.requestHandlePause).toHaveBeenCalledTimes(1);
  });

  it('should not call resume if not paused', () => {
    const addon = createMockAddon();
    const ctrl = new DispatchControllerImpl(addon);
    const mockHandle = {} as RequestHandle;

    ctrl.setRequestHandle(mockHandle);

    ctrl.resume();

    expect(addon.requestHandleResume).not.toHaveBeenCalled();
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Interface** | `Dispatcher.DispatchController` |
| **State Fields** | `#aborted`, `#paused`, `#reason` |
| **Late Binding** | `setRequestHandle()` applies buffered state |
| **Tests** | 7 controller state tests |

## File Structure

```text
packages/node/
├── export/
│   └── dispatch-controller.ts
└── tests/vitest/
    └── controller.test.ts
```
