// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Error surface: re-export undici's classes directly so `instanceof` checks
//! work against consumer code that imports from `undici`. We add nothing —
//! undici 8 already provides every class we need, except `RedirectError`
//! which it dropped; we shim that one to keep the discriminator round-trip.

import { errors as undiciErrors } from "undici";

export const UndiciError = undiciErrors.UndiciError;
export const RequestAbortedError = undiciErrors.RequestAbortedError;
export const ConnectTimeoutError = undiciErrors.ConnectTimeoutError;
export const HeadersTimeoutError = undiciErrors.HeadersTimeoutError;
export const BodyTimeoutError = undiciErrors.BodyTimeoutError;
export const SocketError = undiciErrors.SocketError;
export const HeadersOverflowError = undiciErrors.HeadersOverflowError;
export const InvalidArgumentError = undiciErrors.InvalidArgumentError;
export const ClientDestroyedError = undiciErrors.ClientDestroyedError;
export const ClientClosedError = undiciErrors.ClientClosedError;
export const NotSupportedError = undiciErrors.NotSupportedError;
export const ResponseError = undiciErrors.ResponseError;

/**
 * Wire shape crossing the Neon FFI. `code` is the discriminator;
 * `body` / `headers` are carried only for `UND_ERR_RESPONSE`.
 */
export interface CoreErrorInfo {
  code: string;
  message: string;
  statusCode?: number;
  body?: Uint8Array;
  headers?: Record<string, string | string[]>;
}

/**
 * `RedirectError` was dropped from undici 8's public error surface; we keep
 * a thin subclass of `UndiciError` so the `UND_ERR_REDIRECT` discriminator
 * still round-trips and `instanceof UndiciError` holds.
 */
export class RedirectError extends UndiciError {
  constructor(message = "Redirect error") {
    super(message);
    this.name = "RedirectError";
    this.code = "UND_ERR_REDIRECT";
  }
}

export function createUndiciError(info: CoreErrorInfo): InstanceType<typeof UndiciError> {
  const { code, message, statusCode, body, headers } = info;
  switch (code) {
    case "UND_ERR_ABORTED":
      return new RequestAbortedError(message);
    case "UND_ERR_CONNECT_TIMEOUT":
      return new ConnectTimeoutError(message);
    case "UND_ERR_HEADERS_TIMEOUT":
      return new HeadersTimeoutError(message);
    case "UND_ERR_BODY_TIMEOUT":
      return new BodyTimeoutError(message);
    case "UND_ERR_SOCKET":
      return new SocketError(message);
    case "UND_ERR_HEADERS_OVERFLOW":
      return new HeadersOverflowError(message);
    case "UND_ERR_DESTROYED":
      return new ClientDestroyedError(message);
    case "UND_ERR_CLOSED":
      return new ClientClosedError(message);
    case "UND_ERR_INVALID_ARG":
      return new InvalidArgumentError(message);
    case "UND_ERR_NOT_SUPPORTED":
      return new NotSupportedError(message);
    case "UND_ERR_REDIRECT":
      return new RedirectError(message);
    case "UND_ERR_RESPONSE":
      return new ResponseError(message, statusCode ?? 500, {
        headers: headers ?? null,
        body: body ?? null,
      });
    default: {
      // Base `UndiciError` always sets `code = "UND_ERR"`; preserve the
      // original FFI discriminator so consumers can still match unknown
      // codes that the JS side hasn't been taught about yet.
      const err = new UndiciError(message);
      err.code = code;
      return err;
    }
  }
}
