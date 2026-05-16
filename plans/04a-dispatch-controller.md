# DispatchController (Chunk 04a)

Internal implementation of `Dispatcher.DispatchController` with state
buffering. `abort`/`pause`/`resume` calls made before the native request
handle exists are queued and applied via an internal `setRequestHandle()`
seam.

This class is **not** part of the public export surface — users only see
the `DispatchController` interface that undici defines. See review:
Architect I2 + Node Important.

## Flow

```text
handler.onRequestStart(controller, {})
  └─► controller.abort(reason)   // no handle yet — buffer state
       └─► (later) setRequestHandle(handle)
            └─► applies buffered abort/pause to native handle
```

## Implementation

### packages/node/export/dispatch-controller.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from "undici";

import type { Addon, RequestHandle } from "./addon-def.ts";

/**
 * Symbol-keyed internal seam for late handle binding.
 * Not exposed to user code: users receive the controller via
 * `handler.onRequestStart(controller, {})` and only ever see the
 * public `Dispatcher.DispatchController` interface.
 */
export const kSetRequestHandle = Symbol("node_reqwest.setRequestHandle");

/**
 * DispatchController with state buffering.
 *
 * Buffering exists because `handler.onRequestStart(controller, {})` is
 * called *before* the native request is constructed. A handler that
 * synchronously calls `controller.abort()` from `onRequestStart` must
 * still cancel the request once the native handle materializes.
 *
 * @internal — not part of the public export surface.
 */
export class DispatchController implements Dispatcher.DispatchController {
    #aborted = false;
    #paused = false;
    #reason: Error | null = null;
    #requestHandle: RequestHandle | null = null;
    readonly #addon: Addon;

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
     * Bind the native request handle and flush any buffered state.
     * Calling twice is a no-op: subsequent calls are ignored to keep
     * lifecycle deterministic (Agent owns binding; user code never sees
     * this method).
     *
     * @internal
     */
    [kSetRequestHandle](handle: RequestHandle): void {
        if (this.#requestHandle !== null) return; // idempotent

        this.#requestHandle = handle;

        if (this.#aborted) {
            this.#addon.requestHandleAbort(handle);
        } else if (this.#paused) {
            this.#addon.requestHandlePause(handle);
        }
    }

    /**
     * Abort the in-flight request. Undici's signature is `abort(reason?)`
     * with any value; we coerce non-Error reasons into a wrapping Error
     * so that downstream handlers always receive a real Error instance.
     */
    abort(reason?: unknown): void {
        if (this.#aborted) return;

        this.#aborted = true;
        this.#reason = reason instanceof Error
            ? reason
            : new Error(typeof reason === "string" ? reason : "Aborted");

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
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, expect, vi } from "vitest";

import type { Addon, RequestHandle } from "../../export/addon-def.ts";
import {
    DispatchController,
    kSetRequestHandle,
} from "../../export/dispatch-controller.ts";

type MockAddon = Addon & {
    requestHandleAbort: ReturnType<typeof vi.fn>;
    requestHandlePause: ReturnType<typeof vi.fn>;
    requestHandleResume: ReturnType<typeof vi.fn>;
};

function createMockAddon(): MockAddon {
    return {
        hello: vi.fn(() => "hello"),
        agentCreate: vi.fn(),
        agentDispatch: vi.fn(),
        agentClose: vi.fn(),
        agentDestroy: vi.fn(),
        requestHandleAbort: vi.fn(),
        requestHandlePause: vi.fn(),
        requestHandleResume: vi.fn(),
    } as unknown as MockAddon;
}

describe("DispatchController", () => {
    it("buffers abort until handle is set", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);
        const error = new Error("User abort");

        ctrl.abort(error);

        expect(ctrl.aborted).toBe(true);
        expect(ctrl.reason).toBe(error);
        expect(addon.requestHandleAbort).not.toHaveBeenCalled();

        const handle = {} as RequestHandle;
        ctrl[kSetRequestHandle](handle);
        expect(addon.requestHandleAbort).toHaveBeenCalledWith(handle);
    });

    it("buffers pause until handle is set", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);

        ctrl.pause();
        expect(ctrl.paused).toBe(true);
        expect(addon.requestHandlePause).not.toHaveBeenCalled();

        const handle = {} as RequestHandle;
        ctrl[kSetRequestHandle](handle);
        expect(addon.requestHandlePause).toHaveBeenCalledWith(handle);
    });

    it("calls native abort immediately when handle already bound", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);
        const handle = {} as RequestHandle;

        ctrl[kSetRequestHandle](handle);
        ctrl.abort(new Error("test"));
        expect(addon.requestHandleAbort).toHaveBeenCalledWith(handle);
    });

    it("supports pause / resume after handle binding", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);
        const handle = {} as RequestHandle;
        ctrl[kSetRequestHandle](handle);

        ctrl.pause();
        expect(addon.requestHandlePause).toHaveBeenCalledWith(handle);

        ctrl.resume();
        expect(ctrl.paused).toBe(false);
        expect(addon.requestHandleResume).toHaveBeenCalledWith(handle);
    });

    it("ignores duplicate abort calls (first reason wins)", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);
        ctrl[kSetRequestHandle]({} as RequestHandle);

        ctrl.abort(new Error("first"));
        ctrl.abort(new Error("second"));

        expect(addon.requestHandleAbort).toHaveBeenCalledTimes(1);
        expect(ctrl.reason?.message).toBe("first");
    });

    it("ignores duplicate pause / no-op resume", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);
        ctrl[kSetRequestHandle]({} as RequestHandle);

        ctrl.pause();
        ctrl.pause();
        expect(addon.requestHandlePause).toHaveBeenCalledTimes(1);

        const ctrl2 = new DispatchController(addon);
        ctrl2[kSetRequestHandle]({} as RequestHandle);
        ctrl2.resume();
        expect(addon.requestHandleResume).not.toHaveBeenCalled();
    });

    it("coerces non-Error abort reason to Error", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);

        ctrl.abort("string reason");
        expect(ctrl.reason).toBeInstanceOf(Error);
        expect(ctrl.reason?.message).toBe("string reason");
    });

    it("setRequestHandle called twice is a no-op", () => {
        const addon = createMockAddon();
        const ctrl = new DispatchController(addon);
        const first = {} as RequestHandle;
        const second = {} as RequestHandle;

        ctrl[kSetRequestHandle](first);
        ctrl[kSetRequestHandle](second);
        ctrl.abort(new Error("x"));

        // Abort routes to the first handle, never the second.
        expect(addon.requestHandleAbort).toHaveBeenCalledTimes(1);
        expect(addon.requestHandleAbort).toHaveBeenCalledWith(first);
    });
});
```

## Summary

| Metric           | Value                                                |
| :--------------- | :--------------------------------------------------- |
| **Interface**    | `Dispatcher.DispatchController` (public)             |
| **Class export** | `DispatchController` — internal, not re-exported     |
| **Seam**         | `[kSetRequestHandle]` — symbol-keyed, `@internal`    |
| **State fields** | `#aborted`, `#paused`, `#reason`, `#requestHandle`   |
| **Tests**        | 8 controller state tests (incl. double-bind no-op)   |

## File Structure

```text
packages/node/
├── export/
│   └── dispatch-controller.ts   # class + kSetRequestHandle symbol
└── tests/vitest/
    └── controller.test.ts
```
