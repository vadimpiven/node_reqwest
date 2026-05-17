// SPDX-License-Identifier: Apache-2.0 OR MIT

import { bench, describe } from "vitest";
import { normalizeHeaders } from "../../export/normalize.ts";

describe("normalizeHeaders", () => {
  bench("empty input", () => {
    normalizeHeaders();
  });

  bench("object with string values", () => {
    normalizeHeaders({
      "Content-Type": "application/json",
      Accept: "text/html",
      Authorization: "Bearer token123",
    });
  });

  bench("object with array values", () => {
    normalizeHeaders({
      "Accept-Encoding": ["gzip", "deflate", "br"],
      "Cache-Control": ["no-cache", "no-store"],
      "X-Custom": ["value1", "value2", "value3"],
    });
  });

  bench("object with many headers", () => {
    normalizeHeaders({
      "Content-Type": "application/json",
      Accept: "text/html",
      Authorization: "Bearer token123",
      "Accept-Encoding": "gzip",
      "Cache-Control": "no-cache",
      "X-Request-Id": "abc-123",
      "X-Forwarded-For": "127.0.0.1",
      "X-Forwarded-Proto": "https",
      "User-Agent": "node-reqwest/1.0",
      Cookie: "session=abc; theme=dark",
    });
  });

  bench("flat string array pairs", () => {
    normalizeHeaders([
      "Content-Type",
      "application/json",
      "Accept",
      "text/html",
      "Authorization",
      "Bearer token123",
    ]);
  });

  bench("Map iterable", () => {
    const headers = new Map<string, string>([
      ["Content-Type", "application/json"],
      ["Accept", "text/html"],
      ["Authorization", "Bearer token123"],
    ]);
    normalizeHeaders(headers);
  });

  bench("object with mixed value types", () => {
    normalizeHeaders({
      "Content-Type": "application/json",
      "Content-Length": 42,
      "X-Optional": undefined,
      Accept: ["text/html", "application/json"],
    });
  });
});
