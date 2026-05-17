// SPDX-License-Identifier: Apache-2.0 OR MIT

import type Stream from "node:stream";
import { type FormData, Response } from "undici";

/**
 * Normalizes PEM certificate input into an array of strings.
 */
export function normalizePem(pem?: string | Buffer | (string | Buffer)[]): string[] {
  if (!pem) {
    return [];
  }

  if (Array.isArray(pem)) {
    return pem.flatMap(normalizePem);
  }

  return [Buffer.isBuffer(pem) ? pem.toString() : pem];
}

export type HeaderValue = string | string[] | number | undefined;

/**
 * Normalizes various header formats into a flat record of lowercase key-value pairs.
 */
export function normalizeHeaders(
  headers?: Record<string, HeaderValue> | Iterable<[string, HeaderValue]> | string[] | null,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};
  const add = (key: string, value: HeaderValue): void => {
    if (value === undefined || value === null) {
      return;
    }
    const k = key.toLowerCase();
    const v = Array.isArray(value) ? value.join(", ") : String(value);
    if (!v) {
      return;
    }
    const existing = result[k];
    result[k] = existing ? `${existing}, ${v}` : v;
  };

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = headers[i];
      if (key !== undefined) {
        add(key, headers[i + 1]);
      }
    }
  } else if (Symbol.iterator in headers) {
    for (const [key, value] of headers) {
      add(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      add(key, value);
    }
  }

  return result;
}

/**
 * Normalizes various body types into a ReadableStreamBYOBReader.
 */
export function normalizeBody(
  body?: string | Buffer | Uint8Array | FormData | Stream.Readable | null,
): ReadableStreamBYOBReader | null {
  if (!body) {
    return null;
  }

  const response = new Response(body);
  if (!response.body) {
    return null;
  }

  return response.body.getReader({ mode: "byob" });
}
