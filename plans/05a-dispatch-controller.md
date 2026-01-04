# DispatchController (Chunk 5A)

## Problem/Purpose

Implement the `Dispatcher.DispatchController` interface to provide users with a standard way
to control requests, even before the native handle is established.

## Solution

Create `DispatchControllerImpl` to manage internal state (`#aborted`, `#paused`) and
synchronize it with the native `RequestHandle` through a late-binding mechanism.

## Architecture

```text
User 
  └─ DispatchController.abort() 
       └─ Buffer State (if no handle) 
            └─ setRequestHandle() 
                 └─ Apply State to Native Handle
```

## Implementation

### packages/node/export/agent.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from 'undici';
import type { RequestHandle } from './addon-def';

export class DispatchControllerImpl implements Dispatcher.DispatchController {
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;
  #requestHandle: RequestHandle | null = null;

  get aborted(): boolean { return this.#aborted; }
  get paused(): boolean { return this.#paused; }
  get reason(): Error | null { return this.#reason; }

  setRequestHandle(handle: RequestHandle): void {
    this.#requestHandle = handle;
    if (this.#aborted) {
      (this.#requestHandle as any).abort();
    } else if (this.#paused) {
      (this.#requestHandle as any).pause();
    }
  }

  abort(reason: Error): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason;
    (this.#requestHandle as any)?.abort();
  }

  pause(): void {
    if (!this.#paused) {
      this.#paused = true;
      (this.#requestHandle as any)?.pause();
    }
  }

  resume(): void {
    if (this.#paused) {
      this.#paused = false;
      (this.#requestHandle as any)?.resume();
    }
  }
}
```

### packages/node/tests/vitest/controller.test.ts

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DispatchControllerImpl } from '../../export/agent';

describe('DispatchController', () => {
  it('should buffer abort state when no handle', () => {
    const ctrl = new DispatchControllerImpl();
    const error = new Error('User abort');
    ctrl.abort(error);
    
    expect(ctrl.aborted).toBe(true);
    expect(ctrl.reason).toBe(error);

    const mockHandle = { abort: vi.fn(), pause: vi.fn(), resume: vi.fn() };
    ctrl.setRequestHandle(mockHandle as any);
    
    expect(mockHandle.abort).toHaveBeenCalled();
  });

  it('should buffer pause state when no handle', () => {
    const ctrl = new DispatchControllerImpl();
    ctrl.pause();
    
    expect(ctrl.paused).toBe(true);

    const mockHandle = { abort: vi.fn(), pause: vi.fn(), resume: vi.fn() };
    ctrl.setRequestHandle(mockHandle as any);
    
    expect(mockHandle.pause).toHaveBeenCalled();
  });

  it('should call abort on handle if already set', () => {
    const ctrl = new DispatchControllerImpl();
    const mockHandle = { abort: vi.fn(), pause: vi.fn(), resume: vi.fn() };
    ctrl.setRequestHandle(mockHandle as any);

    ctrl.abort(new Error('test'));
    expect(mockHandle.abort).toHaveBeenCalled();
  });

  it('should handle pause and resume', () => {
    const ctrl = new DispatchControllerImpl();
    const mockHandle = { abort: vi.fn(), pause: vi.fn(), resume: vi.fn() };
    ctrl.setRequestHandle(mockHandle as any);

    ctrl.pause();
    expect(ctrl.paused).toBe(true);
    expect(mockHandle.pause).toHaveBeenCalled();

    ctrl.resume();
    expect(ctrl.paused).toBe(false);
    expect(mockHandle.resume).toHaveBeenCalled();
  });

  it('should ignore duplicate abort calls', () => {
    const ctrl = new DispatchControllerImpl();
    const mockHandle = { abort: vi.fn(), pause: vi.fn(), resume: vi.fn() };
    ctrl.setRequestHandle(mockHandle as any);

    ctrl.abort(new Error('first'));
    ctrl.abort(new Error('second'));
    
    expect(mockHandle.abort).toHaveBeenCalledTimes(1);
    expect(ctrl.reason?.message).toBe('first');
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Interface** | `Dispatcher.DispatchController` |
| **Encapsulation** | Private class fields (`#`) |
| **Tests** | 5 controller state tests |

## File Structure

```text
packages/node/
├── export/
│   └── agent.ts
└── tests/vitest/
    └── controller.test.ts
```
