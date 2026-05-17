// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from "undici";

import type { Addon, RequestHandle } from "./addon-def.ts";

/** Internal seam: `Agent.dispatch` binds the Rust-side handle after the FFI call. */
export const kSetRequestHandle = Symbol("node_reqwest.setRequestHandle");

/**
 * Buffers `abort`/`pause`/`resume` issued before the FFI handle is bound,
 * then replays them onto the handle via [`kSetRequestHandle`].
 */
export class DispatchController implements Dispatcher.DispatchController {
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;
  #requestHandle: RequestHandle | null = null;
  readonly #addon: Addon;
  /** Flat `[name, value, name, value, ...]` Buffer pairs — read by `undici.fetch`. */
  rawHeaders?: Buffer[];

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

  [kSetRequestHandle](handle: RequestHandle): void {
    if (this.#requestHandle !== null) return;
    this.#requestHandle = handle;

    if (this.#aborted) {
      this.#addon.requestHandleAbort(handle);
    } else if (this.#paused) {
      this.#addon.requestHandlePause(handle);
    }
  }

  abort(reason?: unknown): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason =
      reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Aborted");

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
