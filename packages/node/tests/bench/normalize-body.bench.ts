// SPDX-License-Identifier: Apache-2.0 OR MIT

import { bench, describe } from "vitest";
import { normalizeBody } from "../../export/normalize.ts";

describe("normalizeBody", () => {
  bench("null input", () => {
    normalizeBody(null);
  });

  bench("string body", () => {
    normalizeBody('{"key":"value"}');
  });

  bench("Buffer body", () => {
    normalizeBody(Buffer.from("request body content"));
  });

  bench("Uint8Array body", () => {
    normalizeBody(new Uint8Array([72, 101, 108, 108, 111]));
  });

  bench("large string body", () => {
    normalizeBody(JSON.stringify({ data: "x".repeat(1024) }));
  });
});
