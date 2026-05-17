// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, expect, it, vi } from "vitest";

import type { Addon, RequestHandle } from "../../export/addon-def.ts";
import { DispatchController, kSetRequestHandle } from "../../export/dispatch-controller.ts";

function createMockAddon(): Addon {
  return {
    agentCreate: vi.fn(),
    agentDispatch: vi.fn(),
    agentClose: vi.fn(),
    agentDestroy: vi.fn(),
    requestHandleAbort: vi.fn(),
    requestHandlePause: vi.fn(),
    requestHandleResume: vi.fn(),
  };
}

// `RequestHandle` is an opaque Neon `JsBox` from Rust; we can't construct
// a real one in tests, so this returns a Symbol-keyed sentinel cast at the
// interface boundary — the only place tests legitimately fake an opaque type.
function fakeHandle(): RequestHandle {
  return {} as RequestHandle;
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

    const handle = fakeHandle();
    ctrl[kSetRequestHandle](handle);
    expect(addon.requestHandleAbort).toHaveBeenCalledWith(handle);
  });

  it("buffers pause until handle is set", () => {
    const addon = createMockAddon();
    const ctrl = new DispatchController(addon);

    ctrl.pause();
    expect(ctrl.paused).toBe(true);
    expect(addon.requestHandlePause).not.toHaveBeenCalled();

    const handle = fakeHandle();
    ctrl[kSetRequestHandle](handle);
    expect(addon.requestHandlePause).toHaveBeenCalledWith(handle);
  });

  it("calls native abort immediately when handle already bound", () => {
    const addon = createMockAddon();
    const ctrl = new DispatchController(addon);
    const handle = fakeHandle();

    ctrl[kSetRequestHandle](handle);
    ctrl.abort(new Error("test"));
    expect(addon.requestHandleAbort).toHaveBeenCalledWith(handle);
  });

  it("supports pause / resume after handle binding", () => {
    const addon = createMockAddon();
    const ctrl = new DispatchController(addon);
    const handle = fakeHandle();
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
    ctrl[kSetRequestHandle](fakeHandle());

    ctrl.abort(new Error("first"));
    ctrl.abort(new Error("second"));

    expect(addon.requestHandleAbort).toHaveBeenCalledTimes(1);
    expect(ctrl.reason?.message).toBe("first");
  });

  it("ignores duplicate pause / no-op resume", () => {
    const addon = createMockAddon();
    const ctrl = new DispatchController(addon);
    ctrl[kSetRequestHandle](fakeHandle());

    ctrl.pause();
    ctrl.pause();
    expect(addon.requestHandlePause).toHaveBeenCalledTimes(1);

    const ctrl2 = new DispatchController(addon);
    ctrl2[kSetRequestHandle](fakeHandle());
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
    const first = fakeHandle();
    const second = fakeHandle();

    ctrl[kSetRequestHandle](first);
    ctrl[kSetRequestHandle](second);
    ctrl.abort(new Error("x"));

    expect(addon.requestHandleAbort).toHaveBeenCalledTimes(1);
    expect(addon.requestHandleAbort).toHaveBeenCalledWith(first);
  });
});
