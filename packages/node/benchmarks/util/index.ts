// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Helpers shared across `*.bench.ts` files. Vitest's `bench` runner records
//! each iteration's wall time; we drive `N` parallel dispatches per iteration
//! to keep behavior aligned with how real consumers exercise the agent.

export type RequestRunner = (resolve: () => void, reject: (err: Error) => void) => void;

export const PARALLEL_REQUESTS = 100;
export const WARMUP_REQUESTS = 100;

/** Fire `count` dispatches in parallel; resolves when all complete. */
export function makeParallelRequests(
  cb: RequestRunner,
  count = PARALLEL_REQUESTS,
): Promise<void[]> {
  return Promise.all(Array.from({ length: count }, () => new Promise<void>(cb)));
}

/** Sequential warm-up — primes the pool and JIT before timed samples. */
export async function warmup(cb: RequestRunner, count = WARMUP_REQUESTS): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>(cb);
  }
}
