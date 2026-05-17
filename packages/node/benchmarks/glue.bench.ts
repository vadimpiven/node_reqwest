// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Microbenchmarks for pure-function glue on the dispatch hot path. These
//! are CodSpeed's sweet spot: deterministic, CPU-only work that surfaces
//! regressions caused by accidental allocations or slower codepaths.

import { bench, describe } from "vitest";

import { Agent } from "../export/agent.ts";
import { createUndiciError } from "../export/errors.ts";

const SIMPLE_HEADERS = {
  "content-type": "application/json",
  accept: "*/*",
  "user-agent": "node-reqwest-bench/1.0",
  "x-request-id": "abcdef0123456789",
};

const HEADER_ARRAY: string[] = [];
for (const [k, v] of Object.entries(SIMPLE_HEADERS)) {
  HEADER_ARRAY.push(k, v);
}

const SIMPLE_QUERY = { q: "hello world", page: "3", filter: "active" };

describe("Agent construction", () => {
  bench("new Agent() default options", () => {
    const a = new Agent();
    void a.close();
  });

  bench("new Agent({ allowH2, timeouts, proxy })", () => {
    const a = new Agent({
      allowH2: true,
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
      connectTimeout: 5_000,
      proxy: "none",
    });
    void a.close();
  });
});

describe("dispatch() pre-flight (sync path)", () => {
  // dispatch() does header validation, URL parsing, body normalization, and
  // pending-map bookkeeping before crossing the FFI. Aborting in
  // onRequestStart short-circuits the FFI call so we measure only the sync
  // glue — the codspeed sweet spot.
  const agent = new Agent();
  const opts = {
    origin: "http://127.0.0.1:1",
    path: "/api/users",
    method: "GET",
    headers: SIMPLE_HEADERS,
    query: SIMPLE_QUERY,
  } as const;

  bench("record + abort in onRequestStart", () => {
    agent.dispatch(opts, {
      onRequestStart(controller) {
        controller.abort(new Error("bench-abort"));
        return true;
      },
      onResponseError: () => true,
    });
  });
});

describe("error class factory", () => {
  bench("createUndiciError — UND_ERR_SOCKET", () => {
    createUndiciError({ code: "UND_ERR_SOCKET", message: "Connection reset" });
  });

  bench("createUndiciError — UND_ERR_RESPONSE with body", () => {
    createUndiciError({
      code: "UND_ERR_RESPONSE",
      message: "Request failed with status code 500",
      statusCode: 500,
      body: new Uint8Array([0x7b, 0x7d]),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("header serialization shapes", () => {
  // Flat string-pair array — the shape `undici.fetch` hands us.
  bench("Array<string> input", () => {
    const out: Record<string, string> = {};
    for (let i = 0; i < HEADER_ARRAY.length; i += 2) {
      out[HEADER_ARRAY[i].toLowerCase()] = HEADER_ARRAY[i + 1];
    }
  });

  // Record input — the shape direct `dispatch()` callers usually pass.
  bench("Record<string, string> input", () => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(SIMPLE_HEADERS)) {
      out[k.toLowerCase()] = v;
    }
  });
});
