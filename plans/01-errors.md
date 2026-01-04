# Error Types (Chunk 01)

## Problem/Purpose

Establish error types that maintain parity with undici's error structure, usable across
Rust core, FFI boundary, and TypeScript layers.

## Solution

Implement `CoreError` enum in Rust with undici metadata, and corresponding TypeScript
error classes using `Symbol.for` for cross-library `instanceof` checks.

## Architecture

```text
Rust CoreError ─┬─► error_code()   ─► "UND_ERR_*"
                ├─► error_name()   ─► "*Error"
                └─► status_code()  ─► Option<u16>
                         │
                         ▼
              FFI (CoreErrorInfo struct)
                         │
                         ▼
              createUndiciError(info) ─► JavaScript Error subclass
```

## Implementation

### packages/core/Cargo.toml

```toml
[package]
name = "core"
edition.workspace = true

[dependencies]
reqwest = { workspace = true }
thiserror = { workspace = true }

[dev-dependencies]
pretty_assertions = { workspace = true }
```

### packages/core/src/error.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Error types with undici compatibility metadata.
//!
//! Uses a macro to reduce boilerplate for error code/name mapping.

use thiserror::Error;

/// Macro to define CoreError variants with automatic code/name mapping.
///
/// Usage: `define_errors! { VariantName(fields) => ("UND_ERR_CODE", "ClassName"), ... }`
macro_rules! define_errors {
    ($(
        $(#[$meta:meta])*
        $variant:ident $( ( $($field:ty),* ) )? => ($code:literal, $name:literal)
    ),* $(,)?) => {
        #[derive(Debug, Clone, Error)]
        pub enum CoreError {
            $(
                $(#[$meta])*
                $variant $( ( $($field),* ) )?,
            )*

            #[error("{message}")]
            ResponseError { status_code: u16, message: String },
        }

        impl CoreError {
            /// Returns the undici error code (e.g., "UND_ERR_ABORTED").
            pub fn error_code(&self) -> &'static str {
                match self {
                    $( Self::$variant { .. } => $code, )*
                    Self::ResponseError { .. } => "UND_ERR_RESPONSE",
                }
            }

            /// Returns the undici error class name (e.g., "AbortError").
            pub fn error_name(&self) -> &'static str {
                match self {
                    $( Self::$variant { .. } => $name, )*
                    Self::ResponseError { .. } => "ResponseError",
                }
            }
        }
    };
}

define_errors! {
    #[error("Request aborted")]
    RequestAborted => ("UND_ERR_ABORTED", "AbortError"),

    #[error("Connect timeout")]
    ConnectTimeout => ("UND_ERR_CONNECT_TIMEOUT", "ConnectTimeoutError"),

    #[error("Headers timeout")]
    HeadersTimeout => ("UND_ERR_HEADERS_TIMEOUT", "HeadersTimeoutError"),

    #[error("Body timeout")]
    BodyTimeout => ("UND_ERR_BODY_TIMEOUT", "BodyTimeoutError"),

    #[error("Headers overflow")]
    HeadersOverflow => ("UND_ERR_HEADERS_OVERFLOW", "HeadersOverflowError"),

    #[error("Socket error: {0}")]
    Socket(String) => ("UND_ERR_SOCKET", "SocketError"),

    #[error("Invalid argument: {0}")]
    InvalidArgument(String) => ("UND_ERR_INVALID_ARG", "InvalidArgumentError"),

    #[error("The client is destroyed")]
    ClientDestroyed => ("UND_ERR_DESTROYED", "ClientDestroyedError"),

    #[error("The client is closed")]
    ClientClosed => ("UND_ERR_CLOSED", "ClientClosedError"),

    #[error("Request body length does not match content-length header")]
    RequestContentLengthMismatch => ("UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "RequestContentLengthMismatchError"),

    #[error("Response body length does not match content-length header")]
    ResponseContentLengthMismatch => ("UND_ERR_RES_CONTENT_LENGTH_MISMATCH", "ResponseContentLengthMismatchError"),

    #[error("Response content exceeded max size")]
    ResponseExceededMaxSize => ("UND_ERR_RES_EXCEEDED_MAX_SIZE", "ResponseExceededMaxSizeError"),

    #[error("Not supported: {0}")]
    NotSupported(String) => ("UND_ERR_NOT_SUPPORTED", "NotSupportedError"),

    #[error("Secure proxy connection error: {0}")]
    SecureProxyConnectionError(String) => ("UND_ERR_SECURE_PROXY_CONNECTION", "SecureProxyConnectionError"),
}

impl CoreError {
    /// Returns the HTTP status code if applicable.
    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::ResponseError { status_code, .. } => Some(*status_code),
            _ => None,
        }
    }

    /// Create CoreError from a reqwest::Error, mapping to the closest undici error type.
    ///
    /// Mapping logic:
    /// - Timeout errors → ConnectTimeout (connect phase) or BodyTimeout (body phase)
    /// - Connect errors → Socket with "connect" in message
    /// - Body errors → Socket
    /// - Decode errors → Socket (parsing failure)
    /// - Redirect errors → Socket (redirect policy violation)
    /// - Status errors → ResponseError
    /// - Builder errors → InvalidArgument
    /// - Upgrade errors → NotSupported
    pub fn from_reqwest(err: reqwest::Error, in_body_phase: bool) -> Self {
        if err.is_timeout() {
            return if in_body_phase {
                Self::BodyTimeout
            } else {
                Self::ConnectTimeout
            };
        }

        if err.is_connect() {
            return Self::Socket(format!("Connect error: {err}"));
        }

        if err.is_status() {
            if let Some(status) = err.status() {
                return Self::ResponseError {
                    status_code: status.as_u16(),
                    message: err.to_string(),
                };
            }
        }

        if err.is_body() {
            return Self::Socket(format!("Body error: {err}"));
        }

        if err.is_decode() {
            return Self::Socket(format!("Decode error: {err}"));
        }

        if err.is_redirect() {
            return Self::Socket(format!("Redirect error: {err}"));
        }

        if err.is_builder() {
            return Self::InvalidArgument(err.to_string());
        }

        if err.is_upgrade() {
            return Self::NotSupported(format!("Upgrade: {err}"));
        }

        Self::Socket(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn error_codes_match_undici() {
        assert_eq!(CoreError::RequestAborted.error_code(), "UND_ERR_ABORTED");
        assert_eq!(CoreError::ConnectTimeout.error_code(), "UND_ERR_CONNECT_TIMEOUT");
        assert_eq!(CoreError::Socket("test".into()).error_code(), "UND_ERR_SOCKET");
        assert_eq!(CoreError::HeadersOverflow.error_code(), "UND_ERR_HEADERS_OVERFLOW");
        assert_eq!(
            CoreError::SecureProxyConnectionError("tls".into()).error_code(),
            "UND_ERR_SECURE_PROXY_CONNECTION"
        );
    }

    #[test]
    fn error_names_match_undici() {
        assert_eq!(CoreError::RequestAborted.error_name(), "AbortError");
        assert_eq!(CoreError::ConnectTimeout.error_name(), "ConnectTimeoutError");
        assert_eq!(
            CoreError::SecureProxyConnectionError("tls".into()).error_name(),
            "SecureProxyConnectionError"
        );
    }

    #[test]
    fn response_error_has_status_code() {
        let err = CoreError::ResponseError {
            status_code: 404,
            message: "Not Found".into(),
        };
        assert_eq!(err.status_code(), Some(404));
        assert_eq!(CoreError::RequestAborted.status_code(), None);
    }
}
```

### packages/core/src/lib.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Core library for node_reqwest - Rust HTTP client with undici compatibility.

pub mod error;

pub use error::CoreError;
```

### packages/node/export/errors.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

const kUndiciError = Symbol.for('undici.error.UND_ERR');

export interface CoreErrorInfo {
  code: string;
  name: string;
  message: string;
  statusCode?: number;
}

export class UndiciError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'UndiciError';
    this.code = code;
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kUndiciError] === true;
  }

  get [kUndiciError](): boolean {
    return true;
  }
}

const kRequestAbortedError = Symbol.for('undici.error.UND_ERR_ABORTED');

export class RequestAbortedError extends UndiciError {
  constructor(message = 'Request aborted') {
    super(message, 'UND_ERR_ABORTED');
    this.name = 'AbortError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kRequestAbortedError] === true;
  }

  get [kRequestAbortedError](): boolean {
    return true;
  }
}

const kConnectTimeoutError = Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT');

export class ConnectTimeoutError extends UndiciError {
  constructor(message = 'Connect timeout') {
    super(message, 'UND_ERR_CONNECT_TIMEOUT');
    this.name = 'ConnectTimeoutError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kConnectTimeoutError] === true;
  }

  get [kConnectTimeoutError](): boolean {
    return true;
  }
}

const kHeadersTimeoutError = Symbol.for('undici.error.UND_ERR_HEADERS_TIMEOUT');

export class HeadersTimeoutError extends UndiciError {
  constructor(message = 'Headers timeout') {
    super(message, 'UND_ERR_HEADERS_TIMEOUT');
    this.name = 'HeadersTimeoutError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kHeadersTimeoutError] === true;
  }

  get [kHeadersTimeoutError](): boolean {
    return true;
  }
}

const kBodyTimeoutError = Symbol.for('undici.error.UND_ERR_BODY_TIMEOUT');

export class BodyTimeoutError extends UndiciError {
  constructor(message = 'Body timeout') {
    super(message, 'UND_ERR_BODY_TIMEOUT');
    this.name = 'BodyTimeoutError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kBodyTimeoutError] === true;
  }

  get [kBodyTimeoutError](): boolean {
    return true;
  }
}

const kHeadersOverflowError = Symbol.for('undici.error.UND_ERR_HEADERS_OVERFLOW');

export class HeadersOverflowError extends UndiciError {
  constructor(message = 'Headers overflow') {
    super(message, 'UND_ERR_HEADERS_OVERFLOW');
    this.name = 'HeadersOverflowError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kHeadersOverflowError] === true;
  }

  get [kHeadersOverflowError](): boolean {
    return true;
  }
}

const kSocketError = Symbol.for('undici.error.UND_ERR_SOCKET');

export class SocketError extends UndiciError {
  socket: unknown;

  constructor(message = 'Socket error', socket?: unknown) {
    super(message, 'UND_ERR_SOCKET');
    this.name = 'SocketError';
    this.socket = socket ?? null;
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kSocketError] === true;
  }

  get [kSocketError](): boolean {
    return true;
  }
}

const kInvalidArgumentError = Symbol.for('undici.error.UND_ERR_INVALID_ARG');

export class InvalidArgumentError extends UndiciError {
  constructor(message = 'Invalid argument') {
    super(message, 'UND_ERR_INVALID_ARG');
    this.name = 'InvalidArgumentError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kInvalidArgumentError] === true;
  }

  get [kInvalidArgumentError](): boolean {
    return true;
  }
}

const kClientDestroyedError = Symbol.for('undici.error.UND_ERR_DESTROYED');

export class ClientDestroyedError extends UndiciError {
  constructor(message = 'The client is destroyed') {
    super(message, 'UND_ERR_DESTROYED');
    this.name = 'ClientDestroyedError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kClientDestroyedError] === true;
  }

  get [kClientDestroyedError](): boolean {
    return true;
  }
}

const kClientClosedError = Symbol.for('undici.error.UND_ERR_CLOSED');

export class ClientClosedError extends UndiciError {
  constructor(message = 'The client is closed') {
    super(message, 'UND_ERR_CLOSED');
    this.name = 'ClientClosedError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kClientClosedError] === true;
  }

  get [kClientClosedError](): boolean {
    return true;
  }
}

const kRequestContentLengthMismatchError = Symbol.for(
  'undici.error.UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'
);

export class RequestContentLengthMismatchError extends UndiciError {
  constructor(message = 'Request body length does not match content-length header') {
    super(message, 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
    this.name = 'RequestContentLengthMismatchError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kRequestContentLengthMismatchError] === true;
  }

  get [kRequestContentLengthMismatchError](): boolean {
    return true;
  }
}

const kResponseContentLengthMismatchError = Symbol.for(
  'undici.error.UND_ERR_RES_CONTENT_LENGTH_MISMATCH'
);

export class ResponseContentLengthMismatchError extends UndiciError {
  constructor(message = 'Response body length does not match content-length header') {
    super(message, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH');
    this.name = 'ResponseContentLengthMismatchError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kResponseContentLengthMismatchError] === true;
  }

  get [kResponseContentLengthMismatchError](): boolean {
    return true;
  }
}

const kResponseExceededMaxSizeError = Symbol.for('undici.error.UND_ERR_RES_EXCEEDED_MAX_SIZE');

export class ResponseExceededMaxSizeError extends UndiciError {
  constructor(message = 'Response content exceeded max size') {
    super(message, 'UND_ERR_RES_EXCEEDED_MAX_SIZE');
    this.name = 'ResponseExceededMaxSizeError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kResponseExceededMaxSizeError] === true;
  }

  get [kResponseExceededMaxSizeError](): boolean {
    return true;
  }
}

const kNotSupportedError = Symbol.for('undici.error.UND_ERR_NOT_SUPPORTED');

export class NotSupportedError extends UndiciError {
  constructor(message = 'Not supported') {
    super(message, 'UND_ERR_NOT_SUPPORTED');
    this.name = 'NotSupportedError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kNotSupportedError] === true;
  }

  get [kNotSupportedError](): boolean {
    return true;
  }
}

const kResponseError = Symbol.for('undici.error.UND_ERR_RESPONSE');

export class ResponseError extends UndiciError {
  statusCode: number;
  body: unknown;
  headers: unknown;

  constructor(
    message: string,
    statusCode: number,
    options: { headers?: unknown; body?: unknown } = {}
  ) {
    super(message, 'UND_ERR_RESPONSE');
    this.name = 'ResponseError';
    this.statusCode = statusCode;
    this.body = options.body ?? null;
    this.headers = options.headers ?? null;
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kResponseError] === true;
  }

  get [kResponseError](): boolean {
    return true;
  }
}

const kSecureProxyConnectionError = Symbol.for('undici.error.UND_ERR_SECURE_PROXY_CONNECTION');

export class SecureProxyConnectionError extends UndiciError {
  constructor(message = 'Secure proxy connection error') {
    super(message, 'UND_ERR_SECURE_PROXY_CONNECTION');
    this.name = 'SecureProxyConnectionError';
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kSecureProxyConnectionError] === true;
  }

  get [kSecureProxyConnectionError](): boolean {
    return true;
  }
}

export function createUndiciError(errorInfo: CoreErrorInfo): Error {
  const { code, message, statusCode } = errorInfo;
  switch (code) {
    case 'UND_ERR_ABORTED':
      return new RequestAbortedError(message);
    case 'UND_ERR_CONNECT_TIMEOUT':
      return new ConnectTimeoutError(message);
    case 'UND_ERR_HEADERS_TIMEOUT':
      return new HeadersTimeoutError(message);
    case 'UND_ERR_BODY_TIMEOUT':
      return new BodyTimeoutError(message);
    case 'UND_ERR_HEADERS_OVERFLOW':
      return new HeadersOverflowError(message);
    case 'UND_ERR_SOCKET':
      return new SocketError(message);
    case 'UND_ERR_DESTROYED':
      return new ClientDestroyedError(message);
    case 'UND_ERR_CLOSED':
      return new ClientClosedError(message);
    case 'UND_ERR_INVALID_ARG':
      return new InvalidArgumentError(message);
    case 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH':
      return new RequestContentLengthMismatchError(message);
    case 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH':
      return new ResponseContentLengthMismatchError(message);
    case 'UND_ERR_RES_EXCEEDED_MAX_SIZE':
      return new ResponseExceededMaxSizeError(message);
    case 'UND_ERR_NOT_SUPPORTED':
      return new NotSupportedError(message);
    case 'UND_ERR_SECURE_PROXY_CONNECTION':
      return new SecureProxyConnectionError(message);
    case 'UND_ERR_RESPONSE':
      return new ResponseError(message, statusCode ?? 500);
    default:
      return new UndiciError(message, code);
  }
}
```

### packages/node/tests/vitest/errors.test.ts

```typescript
import { describe, it, expect } from 'vitest';

import {
  UndiciError,
  RequestAbortedError,
  ConnectTimeoutError,
  HeadersOverflowError,
  SocketError,
  ResponseError,
  createUndiciError,
  type CoreErrorInfo,
} from '../../export/errors.ts';

describe('Undici Error Classes', () => {
  it('should create correct error instances', () => {
    const abortError = new RequestAbortedError();
    expect(abortError.code).toBe('UND_ERR_ABORTED');
    expect(abortError.name).toBe('AbortError');
    expect(abortError.message).toBe('Request aborted');

    const timeoutError = new ConnectTimeoutError('Custom timeout');
    expect(timeoutError.code).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(timeoutError.message).toBe('Custom timeout');
  });

  it('should support instanceof checks', () => {
    const abortError = new RequestAbortedError();
    expect(abortError instanceof RequestAbortedError).toBe(true);
    expect(abortError instanceof UndiciError).toBe(true);
    expect(abortError instanceof Error).toBe(true);
  });

  it('should support cross-library instanceof via Symbol.for', () => {
    const error = new RequestAbortedError();
    const kAbort = Symbol.for('undici.error.UND_ERR_ABORTED');
    const kUndici = Symbol.for('undici.error.UND_ERR');
    expect((error as Record<symbol, boolean>)[kAbort]).toBe(true);
    expect((error as Record<symbol, boolean>)[kUndici]).toBe(true);
  });

  it('should create errors from CoreErrorInfo', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_ABORTED',
      name: 'AbortError',
      message: 'Request was aborted',
    };
    const error = createUndiciError(errorInfo);
    expect(error instanceof RequestAbortedError).toBe(true);
    expect(error.message).toBe('Request was aborted');
  });

  it('should handle ResponseError with status code', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_RESPONSE',
      name: 'ResponseError',
      message: 'Bad request',
      statusCode: 400,
    };
    const error = createUndiciError(errorInfo) as ResponseError;
    expect(error instanceof ResponseError).toBe(true);
    expect(error.statusCode).toBe(400);
  });

  it('should fallback to UndiciError for unknown codes', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_UNKNOWN',
      name: 'UnknownError',
      message: 'Unknown error occurred',
    };
    const error = createUndiciError(errorInfo);
    expect(error instanceof UndiciError).toBe(true);
    expect((error as UndiciError).code).toBe('UND_ERR_UNKNOWN');
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Rust Dependency** | `thiserror = "2.0"`, `reqwest` (for `from_reqwest`) |
| **Error Classes** | 15 (14 specific + 1 base) |
| **Instance Check** | `Symbol.for('undici.error.*')` |
| **Tests** | 4 Rust + 6 TypeScript |

## File Structure

```text
packages/core/
├── Cargo.toml
└── src/
    ├── lib.rs
    └── error.rs
packages/node/
├── export/
│   └── errors.ts
└── tests/vitest/
    └── errors.test.ts
```
