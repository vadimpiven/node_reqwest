// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch with a timeout that aborts the request after FETCH_TIMEOUT_MS.
 */
export async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Fetch a URL and return the response body as a Node.js Readable stream.
 */
export async function fetchStream(url: string): Promise<Readable> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("Response body is empty");
  }
  return Readable.fromWeb(response.body);
}

/**
 * Create a pass-through Transform that computes a SHA-256 hash
 * of all data flowing through it. Call `digest()` after the
 * stream ends to get the hex hash.
 */
export function createHashPassthrough(): { stream: Transform; digest: () => string } {
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest("hex") };
}
