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
  it('should buffer abort state', () => {
    const ctrl = new DispatchControllerImpl();
    ctrl.abort(new Error('reason'));
    const handle = { abort: vi.fn(), pause: vi.fn(), resume: vi.fn() };
    ctrl.setRequestHandle(handle as any);
    expect(handle.abort).toHaveBeenCalled();
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Interface** | `Dispatcher.DispatchController` |
| **Encapsulation** | Private class fields (`#`) |
| **Parity** | Matches Undici 6.x behavior |

## File Structure

```text
packages/node/
└── export/
    └── agent.ts
```
