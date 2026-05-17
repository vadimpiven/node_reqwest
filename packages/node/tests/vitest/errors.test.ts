// SPDX-License-Identifier: Apache-2.0 OR MIT

import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  BodyTimeoutError,
  ClientClosedError,
  ClientDestroyedError,
  ConnectTimeoutError,
  type CoreErrorInfo,
  createUndiciError,
  HeadersOverflowError,
  HeadersTimeoutError,
  InvalidArgumentError,
  NotSupportedError,
  RedirectError,
  RequestAbortedError,
  ResponseError,
  SocketError,
  UndiciError,
} from "../../export/errors.ts";

describe("Undici Error Classes", () => {
  it("creates correct error instances", () => {
    const err = new RequestAbortedError();
    expect(err.code).toBe("UND_ERR_ABORTED");
    expect(err.name).toBe("AbortError");
  });

  it("chains instanceof up to Error", () => {
    const err = new ConnectTimeoutError();
    expect(err instanceof ConnectTimeoutError).toBe(true);
    expect(err instanceof UndiciError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("disjoint cross-class instanceof", () => {
    const body = new BodyTimeoutError();
    expect(body instanceof BodyTimeoutError).toBe(true);
    expect(body instanceof HeadersTimeoutError).toBe(false);
    expect(body instanceof ConnectTimeoutError).toBe(false);
    expect(body instanceof RequestAbortedError).toBe(false);
  });

  it.each([
    ["UND_ERR_ABORTED", RequestAbortedError],
    ["UND_ERR_CONNECT_TIMEOUT", ConnectTimeoutError],
    ["UND_ERR_HEADERS_TIMEOUT", HeadersTimeoutError],
    ["UND_ERR_BODY_TIMEOUT", BodyTimeoutError],
    ["UND_ERR_SOCKET", SocketError],
    ["UND_ERR_HEADERS_OVERFLOW", HeadersOverflowError],
    ["UND_ERR_DESTROYED", ClientDestroyedError],
    ["UND_ERR_CLOSED", ClientClosedError],
    ["UND_ERR_INVALID_ARG", InvalidArgumentError],
    ["UND_ERR_NOT_SUPPORTED", NotSupportedError],
    ["UND_ERR_REDIRECT", RedirectError],
  ] as const)("maps %s → matching class", (code, Klass) => {
    const err = createUndiciError({ code, message: `case ${code}` });
    expect(err).toBeInstanceOf(Klass);
    expect(err.message).toBe(`case ${code}`);
  });

  it("handles ResponseError with body and headers", () => {
    const info: CoreErrorInfo = {
      code: "UND_ERR_RESPONSE",
      message: "Bad request",
      statusCode: 400,
      body: new Uint8Array([0x7b, 0x7d]),
      headers: { "content-type": "application/json" },
    };
    const err = createUndiciError(info);
    assert(err instanceof ResponseError);
    assert(err.headers !== null && !Array.isArray(err.headers));
    expect(err.statusCode).toBe(400);
    expect(err.body).toEqual(new Uint8Array([0x7b, 0x7d]));
    expect(err.headers["content-type"]).toBe("application/json");
  });

  it("maps redirect-policy violations to RedirectError", () => {
    const err = createUndiciError({ code: "UND_ERR_REDIRECT", message: "too many" });
    expect(err instanceof RedirectError).toBe(true);
  });

  it("default branch returns base UndiciError for unknown codes", () => {
    const err = createUndiciError({ code: "UND_ERR_FUTURE_CODE", message: "x" });
    expect(err instanceof UndiciError).toBe(true);
    expect(err instanceof RequestAbortedError).toBe(false);
    expect(err.code).toBe("UND_ERR_FUTURE_CODE");
  });

  it("instanceof guards reject primitives without throwing", () => {
    const nul: unknown = null;
    const undef: unknown = undefined;
    const str: unknown = "str";
    expect(nul instanceof UndiciError).toBe(false);
    expect(undef instanceof RequestAbortedError).toBe(false);
    expect(str instanceof BodyTimeoutError).toBe(false);
  });
});
