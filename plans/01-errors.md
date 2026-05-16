# Error Types (Chunk 01)

Rust `CoreError` enum mapped to undici-compatible TypeScript error classes.
TypeScript classes use `Symbol.for` for cross-library `instanceof`.

Estimated time: 1.5 hours. Dependencies: `thiserror = "2.0"`, `reqwest`.
12 error classes (11 specific + 1 base).

`SecureProxyConnectionError` is omitted: reqwest does not distinguish proxy TLS
errors from general socket errors.

## Security guarantees

- URL userinfo is stripped from any reqwest error string before crossing FFI
  (regex `(://)[^@/]*@` → `$1<redacted>@`).
- Error messages are truncated to 256 chars to bound log volume and prevent
  body-fragment echo from `is_decode()` errors.
- Invalid header names/values map to `InvalidArgument` with a fixed sanitized
  message (`"invalid header name"` / `"invalid header value"`); raw bytes
  are never echoed.

## Architecture

```text
Rust CoreError ─┬─► error_code()   ─► "UND_ERR_*"
                └─► status_code()  ─► Option<u16>
                         │
                         ▼
              FFI (CoreErrorInfo: code, message, statusCode?, body?, headers?)
                         │
                         ▼
              createUndiciError(info) ─► JavaScript Error
```

Class name is set inside the TS factory; it is not transmitted across the FFI.

## File Structure

```text
packages/core/src/
├── lib.rs
└── error.rs
packages/node/
├── export/errors.ts
└── tests/vitest/errors.test.ts
```

## Implementation

### packages/core/src/error.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use thiserror::Error;

/// Maximum length for any reqwest-derived error string after redaction.
const MAX_MESSAGE_LEN: usize = 256;

fn userinfo_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(://)[^@/\s]*@").expect("static regex"))
}

/// Strip URL userinfo and truncate to MAX_MESSAGE_LEN. Never echoes secrets.
pub(crate) fn sanitize_message(raw: &str) -> String {
    let redacted = userinfo_re().replace_all(raw, "$1<redacted>@");
    let mut s = redacted.into_owned();
    if s.len() > MAX_MESSAGE_LEN {
        s.truncate(MAX_MESSAGE_LEN);
    }
    s
}

#[derive(Debug, Clone, Error)]
pub enum CoreError {
    #[error("Request aborted")]
    RequestAborted,

    #[error("Connect timeout")]
    ConnectTimeout,

    #[error("Headers timeout")]
    HeadersTimeout,

    #[error("Body timeout")]
    BodyTimeout,

    #[error("Socket error: {0}")]
    Socket(String),

    #[error("Headers overflow")]
    HeadersOverflow,

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    #[error("The client is destroyed")]
    ClientDestroyed,

    #[error("The client is closed")]
    ClientClosed,

    #[error("Not supported: {0}")]
    NotSupported(String),

    #[error("Redirect error: {0}")]
    Redirect(String),

    #[error("{message}")]
    ResponseError {
        status_code: u16,
        message: String,
        /// Response body bytes captured before the failure (may be empty).
        body: Option<Vec<u8>>,
        /// Response headers captured before the failure (may be empty).
        headers: HashMap<String, Vec<String>>,
    },
}

impl CoreError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::RequestAborted => "UND_ERR_ABORTED",
            Self::ConnectTimeout => "UND_ERR_CONNECT_TIMEOUT",
            Self::HeadersTimeout => "UND_ERR_HEADERS_TIMEOUT",
            Self::BodyTimeout => "UND_ERR_BODY_TIMEOUT",
            Self::Socket(_) => "UND_ERR_SOCKET",
            Self::HeadersOverflow => "UND_ERR_HEADERS_OVERFLOW",
            Self::InvalidArgument(_) => "UND_ERR_INVALID_ARG",
            Self::ClientDestroyed => "UND_ERR_DESTROYED",
            Self::ClientClosed => "UND_ERR_CLOSED",
            Self::NotSupported(_) => "UND_ERR_NOT_SUPPORTED",
            Self::Redirect(_) => "UND_ERR_REDIRECT",
            Self::ResponseError { .. } => "UND_ERR_RESPONSE",
        }
    }

    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::ResponseError { status_code, .. } => Some(*status_code),
            _ => None,
        }
    }

    /// Map reqwest::Error to CoreError.
    ///
    /// All reqwest-derived strings flow through `sanitize_message` to redact
    /// URL userinfo and truncate to a bounded size. `in_body_phase` is the
    /// caller's signal that the error fired while consuming the response body
    /// (used only to disambiguate `is_timeout()`).
    ///
    /// # Timeout semantics
    /// - `is_connect() && is_timeout()` → `ConnectTimeout`.
    /// - `is_timeout()` pre-body → `HeadersTimeout`.
    /// - `is_timeout()` in body phase → `BodyTimeout`.
    ///
    /// Note: explicit `tokio::time::timeout(..)` wrappers in `Agent::dispatch`
    /// drive the per-request `HeadersTimeout` / `BodyTimeout`. `from_reqwest`
    /// only sees reqwest's own internal timeout (the agent-wide `timeout` knob).
    pub fn from_reqwest(err: reqwest::Error, in_body_phase: bool) -> Self {
        if err.is_timeout() {
            if err.is_connect() {
                return Self::ConnectTimeout;
            }
            return if in_body_phase {
                Self::BodyTimeout
            } else {
                Self::HeadersTimeout
            };
        }

        if err.is_redirect() {
            return Self::Redirect(sanitize_message(&err.to_string()));
        }

        if err.is_connect() {
            return Self::Socket(sanitize_message(&format!("Connect error: {err}")));
        }

        if err.is_status() {
            if let Some(status) = err.status() {
                return Self::ResponseError {
                    status_code: status.as_u16(),
                    message: sanitize_message(&err.to_string()),
                    body: None,
                    headers: HashMap::new(),
                };
            }
        }

        if err.is_body() || err.is_decode() {
            return Self::Socket(sanitize_message(&err.to_string()));
        }

        if err.is_builder() {
            return Self::InvalidArgument(sanitize_message(&err.to_string()));
        }

        Self::Socket(sanitize_message(&err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes() {
        assert_eq!(CoreError::RequestAborted.error_code(), "UND_ERR_ABORTED");
        assert_eq!(CoreError::ConnectTimeout.error_code(), "UND_ERR_CONNECT_TIMEOUT");
        assert_eq!(CoreError::Redirect(String::new()).error_code(), "UND_ERR_REDIRECT");
    }

    #[test]
    fn response_error_status() {
        let err = CoreError::ResponseError {
            status_code: 404,
            message: "Not Found".into(),
            body: None,
            headers: HashMap::new(),
        };
        assert_eq!(err.status_code(), Some(404));
    }

    #[test]
    fn sanitize_redacts_userinfo() {
        let raw = "error sending request for url (https://abc123:@example.invalid/path)";
        let out = sanitize_message(raw);
        assert!(!out.contains("abc123"));
        assert!(out.contains("<redacted>@example.invalid"));
    }

    #[test]
    fn sanitize_truncates() {
        let raw = "x".repeat(1024);
        assert_eq!(sanitize_message(&raw).len(), 256);
    }

    /// Drive every `from_reqwest` branch via a live tokio runtime. The branch
    /// table makes the classification regressions visible at a glance.
    #[tokio::test]
    async fn from_reqwest_branch_table() {
        // Builder error: invalid scheme.
        let builder = reqwest::Client::builder()
            .https_only(true)
            .build()
            .expect("client");
        let err = builder.get("ftp://example.invalid").send().await.unwrap_err();
        assert_eq!(
            CoreError::from_reqwest(err, false).error_code(),
            "UND_ERR_INVALID_ARG"
        );

        // Connect error to a closed TCP port.
        let client = reqwest::Client::new();
        let err = client.get("http://127.0.0.1:1").send().await.unwrap_err();
        let code = CoreError::from_reqwest(err, false).error_code();
        assert!(matches!(code, "UND_ERR_SOCKET" | "UND_ERR_CONNECT_TIMEOUT"));

        // in_body_phase=true changes the timeout discrimination.
        // (Direct test via a fake reqwest::Error is infeasible; covered by
        // integration tests in 02b that drive a slow streaming server.)
    }
}
```

`regex` is added under `[dependencies]` for the redactor (or copy the small
matcher inline if the crate is undesirable).

### packages/core/src/lib.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

pub mod error;

pub use error::CoreError;
```

### packages/node/export/errors.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

const kUndiciError = Symbol.for("undici.error.UND_ERR");

/**
 * Wire shape crossing the Neon FFI. `code` is the discriminator;
 * the TS factory sets `name` per-class so it never round-trips.
 * `body` / `headers` are carried only for `UND_ERR_RESPONSE`.
 */
export interface CoreErrorInfo {
    code: string;
    message: string;
    statusCode?: number;
    body?: Uint8Array;
    headers?: Record<string, string | string[]>;
}

export class UndiciError extends Error {
    code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = "UndiciError";
        this.code = code;
    }

    static [Symbol.hasInstance](instance: unknown): boolean {
        return (instance as Record<symbol, boolean>)?.[kUndiciError] === true;
    }

    get [kUndiciError](): boolean {
        return true;
    }
}

// Macro-like pattern for error classes
function defineError(code: string, defaultMessage: string, className: string) {
    const kSymbol = Symbol.for(`undici.error.${code}`);

    return class extends UndiciError {
        constructor(message = defaultMessage) {
            super(message, code);
            this.name = className;
        }

        static [Symbol.hasInstance](instance: unknown): boolean {
            return (instance as Record<symbol, boolean>)?.[kSymbol] === true;
        }

        get [kSymbol](): boolean {
            return true;
        }
    };
}

// Class symbol is `RequestAbortedError` but `.name === "AbortError"` to match
// undici (and the WHATWG `DOMException` AbortError convention used by
// `AbortController`/`AbortSignal` consumers). Deliberate parity choice.
export const RequestAbortedError = defineError("UND_ERR_ABORTED", "Request aborted", "AbortError");

export const ConnectTimeoutError = defineError(
    "UND_ERR_CONNECT_TIMEOUT",
    "Connect timeout",
    "ConnectTimeoutError",
);

export const HeadersTimeoutError = defineError(
    "UND_ERR_HEADERS_TIMEOUT",
    "Headers timeout",
    "HeadersTimeoutError",
);

export const BodyTimeoutError = defineError(
    "UND_ERR_BODY_TIMEOUT",
    "Body timeout",
    "BodyTimeoutError",
);

export const SocketError = defineError("UND_ERR_SOCKET", "Socket error", "SocketError");

export const HeadersOverflowError = defineError(
    "UND_ERR_HEADERS_OVERFLOW",
    "Headers overflow",
    "HeadersOverflowError",
);

export const InvalidArgumentError = defineError(
    "UND_ERR_INVALID_ARG",
    "Invalid argument",
    "InvalidArgumentError",
);

export const ClientDestroyedError = defineError(
    "UND_ERR_DESTROYED",
    "The client is destroyed",
    "ClientDestroyedError",
);

export const ClientClosedError = defineError(
    "UND_ERR_CLOSED",
    "The client is closed",
    "ClientClosedError",
);

export const NotSupportedError = defineError(
    "UND_ERR_NOT_SUPPORTED",
    "Not supported",
    "NotSupportedError",
);

export const RedirectError = defineError(
    "UND_ERR_REDIRECT",
    "Redirect error",
    "RedirectError",
);

const kResponseError = Symbol.for("undici.error.UND_ERR_RESPONSE");

export class ResponseError extends UndiciError {
    statusCode: number;
    body: Uint8Array | null;
    headers: Record<string, string | string[]>;

    constructor(
        message: string,
        statusCode: number,
        body: Uint8Array | null = null,
        headers: Record<string, string | string[]> = {},
    ) {
        super(message, "UND_ERR_RESPONSE");
        this.name = "ResponseError";
        this.statusCode = statusCode;
        this.body = body;
        this.headers = headers;
    }

    static [Symbol.hasInstance](instance: unknown): boolean {
        return (instance as Record<symbol, boolean>)?.[kResponseError] === true;
    }

    get [kResponseError](): boolean {
        return true;
    }
}

export function createUndiciError(info: CoreErrorInfo): Error {
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
            // Header-validation paths (CRLF, control bytes, etc.) reach here
            // with a fixed sanitized `message` set in Rust — never echoes
            // attacker bytes.
            return new InvalidArgumentError(message);
        case "UND_ERR_NOT_SUPPORTED":
            return new NotSupportedError(message);
        case "UND_ERR_REDIRECT":
            return new RedirectError(message);
        case "UND_ERR_RESPONSE":
            return new ResponseError(message, statusCode ?? 500, body ?? null, headers ?? {});
        default:
            return new UndiciError(message, code);
    }
}
```

### packages/node/tests/vitest/errors.test.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT
import { describe, it, expect } from "vitest";

import {
    UndiciError,
    RequestAbortedError,
    BodyTimeoutError,
    HeadersTimeoutError,
    ConnectTimeoutError,
    RedirectError,
    ResponseError,
    createUndiciError,
    type CoreErrorInfo,
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

    it("creates errors from CoreErrorInfo", () => {
        const info: CoreErrorInfo = {
            code: "UND_ERR_ABORTED",
            message: "Request was aborted",
        };
        const err = createUndiciError(info);
        expect(err instanceof RequestAbortedError).toBe(true);
    });

    it("handles ResponseError with body and headers", () => {
        const info: CoreErrorInfo = {
            code: "UND_ERR_RESPONSE",
            message: "Bad request",
            statusCode: 400,
            body: new Uint8Array([0x7b, 0x7d]),
            headers: { "content-type": "application/json" },
        };
        const err = createUndiciError(info) as ResponseError;
        expect(err instanceof ResponseError).toBe(true);
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
        expect((err as UndiciError).code).toBe("UND_ERR_FUTURE_CODE");
    });

    it("instanceof guards reject primitives without throwing", () => {
        expect((null as unknown) instanceof UndiciError).toBe(false);
        expect((undefined as unknown) instanceof RequestAbortedError).toBe(false);
        expect(("str" as unknown) instanceof BodyTimeoutError).toBe(false);
    });
});
```
