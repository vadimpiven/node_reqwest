// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from "undici";

import type { Agent } from "../../export/agent.ts";

export interface DispatchResult {
  status: number | null;
  bytes: Buffer;
  headers: Record<string, string | string[]> | null;
  error: Error | null;
}

type HandlerOverrides = Partial<Dispatcher.DispatchHandler>;

/**
 * Drives a single `agent.dispatch()` call and resolves once a terminal
 * lifecycle event fires. Optional `overrides` lets callers observe events
 * (e.g. inject `onRequestStart` to abort). Only defined override keys are
 * passed through — undici's Dispatcher contract rejects handler methods
 * set to `undefined`.
 */
export function dispatchOnce(
  agent: InstanceType<typeof Agent> | Dispatcher,
  options: Dispatcher.DispatchOptions,
  overrides: HandlerOverrides = {},
): Promise<DispatchResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let status: number | null = null;
    let headers: Record<string, string | string[]> | null = null;

    const handler: Dispatcher.DispatchHandler = {
      // undici 8 requires `onRequestStart` to be a function (not undefined).
      // Override via `overrides.onRequestStart` if a test needs to act here.
      onRequestStart(controller, ctx) {
        overrides.onRequestStart?.(controller, ctx);
        return true;
      },
      onResponseStart(controller, s, h, msg) {
        status = s;
        // undici types `h` as `IncomingHttpHeaders` (string|string[]|undefined);
        // strip the `undefined` legs since `onResponseStart` never sets them.
        const stable: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(h)) {
          if (v !== undefined) stable[k] = v;
        }
        headers = stable;
        overrides.onResponseStart?.(controller, s, h, msg);
        return true;
      },
      onResponseData(controller, chunk) {
        chunks.push(chunk);
        overrides.onResponseData?.(controller, chunk);
        return true;
      },
      onResponseEnd(controller, trailers) {
        overrides.onResponseEnd?.(controller, trailers);
        resolve({ status, bytes: Buffer.concat(chunks), headers, error: null });
        return true;
      },
      onResponseError(controller, error) {
        overrides.onResponseError?.(controller, error);
        resolve({ status, bytes: Buffer.concat(chunks), headers, error });
      },
    };
    if (overrides.onRequestUpgrade !== undefined) {
      handler.onRequestUpgrade = overrides.onRequestUpgrade;
    }

    agent.dispatch(options, handler);
  });
}
