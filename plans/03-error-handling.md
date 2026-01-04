# Error Handling

Map Core errors to Undici-compatible JS errors using Symbol.for.

**Prerequisites**: 01-core-foundation.md and 02-core-backpressure.md complete

## Goal

Verify CoreError→UndiciError mapping works with proper cross-library `instanceof` compatibility.

## Architecture

```text
Core (Rust)              Node (Rust FFI)          Node (TypeScript)
┌─────────────┐          ┌───────────┐           ┌──────────────────┐
│ CoreError   │─────────▶│ error_code│──────────▶│ createUndiciError│
│ enum        │          │ error_name│           │ + Symbol.for     │
└─────────────┘          └───────────┘           └──────────────────┘
```

## Dependencies (add to packages/core/Cargo.toml)

```toml
[dependencies]
thiserror = { workspace = true }

# Add to root Cargo.toml
[workspace.dependencies]
thiserror = "2.0.12"
```

## Core Error Types (packages/core/src/error.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use thiserror::Error;

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
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),
    #[error("The client is destroyed")]
    ClientDestroyed,
    #[error("The client is closed")]
    ClientClosed,
    #[error("Request body length does not match content-length header")]
    RequestContentLengthMismatch,
    #[error("Response body length does not match content-length header")]
    ResponseContentLengthMismatch,
    #[error("Response content exceeded max size")]
    ResponseExceededMaxSize,
    #[error("Not supported: {0}")]
    NotSupported(String),
    #[error("Response error")]
    ResponseError { status_code: u16, message: String },
    #[error("Network error: {0}")]
    Network(String),
}

impl CoreError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::RequestAborted => "UND_ERR_ABORTED",
            Self::ConnectTimeout => "UND_ERR_CONNECT_TIMEOUT",
            Self::HeadersTimeout => "UND_ERR_HEADERS_TIMEOUT",
            Self::BodyTimeout => "UND_ERR_BODY_TIMEOUT",
            Self::Socket(_) => "UND_ERR_SOCKET",
            Self::Network(_) => "UND_ERR_SOCKET",
            Self::InvalidArgument(_) => "UND_ERR_INVALID_ARG",
            Self::ClientDestroyed => "UND_ERR_DESTROYED",
            Self::ClientClosed => "UND_ERR_CLOSED",
            Self::RequestContentLengthMismatch => "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
            Self::ResponseContentLengthMismatch => "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
            Self::ResponseExceededMaxSize => "UND_ERR_RES_EXCEEDED_MAX_SIZE",
            Self::NotSupported(_) => "UND_ERR_NOT_SUPPORTED",
            Self::ResponseError { .. } => "UND_ERR_RESPONSE",
        }
    }

    pub fn error_name(&self) -> &'static str {
        match self {
            Self::RequestAborted => "AbortError",
            Self::ConnectTimeout => "ConnectTimeoutError",
            Self::HeadersTimeout => "HeadersTimeoutError",
            Self::BodyTimeout => "BodyTimeoutError",
            Self::Socket(_) => "SocketError",
            Self::Network(_) => "SocketError",
            Self::InvalidArgument(_) => "InvalidArgumentError",
            Self::ClientDestroyed => "ClientDestroyedError",
            Self::ClientClosed => "ClientClosedError",
            Self::RequestContentLengthMismatch => "RequestContentLengthMismatchError",
            Self::ResponseContentLengthMismatch => "ResponseContentLengthMismatchError",
            Self::ResponseExceededMaxSize => "ResponseExceededMaxSizeError",
            Self::NotSupported(_) => "NotSupportedError",
            Self::ResponseError { .. } => "ResponseError",
        }
    }

    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::ResponseError { status_code, .. } => Some(*status_code),
            _ => None,
        }
    }
}
```

## Update Core Exports (packages/core/src/lib.rs)

```rust
// Add to existing lib.rs

pub mod error;

pub use error::CoreError;
```

## Undici Error Classes (packages/node/export/errors.ts)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

const kUndiciError = Symbol.for('undici.error.UND_ERR');

export class UndiciError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UndiciError';
    this.code = code;
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kUndiciError] === true;
  }
  get [kUndiciError](): boolean { return true; }
}

const kRequestAbortedError = Symbol.for('undici.error.UND_ERR_ABORTED');
export class RequestAbortedError extends UndiciError {
  constructor(message = 'Request aborted') {
    super(message, 'UND_ERR_ABORTED');
    this.name = 'AbortError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kRequestAbortedError] === true;
  }
  get [kRequestAbortedError](): boolean { return true; }
}

const kConnectTimeoutError = Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT');
export class ConnectTimeoutError extends UndiciError {
  constructor(message = 'Connect timeout') {
    super(message, 'UND_ERR_CONNECT_TIMEOUT');
    this.name = 'ConnectTimeoutError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kConnectTimeoutError] === true;
  }
  get [kConnectTimeoutError](): boolean { return true; }
}

const kHeadersTimeoutError = Symbol.for('undici.error.UND_ERR_HEADERS_TIMEOUT');
export class HeadersTimeoutError extends UndiciError {
  constructor(message = 'Headers timeout') {
    super(message, 'UND_ERR_HEADERS_TIMEOUT');
    this.name = 'HeadersTimeoutError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kHeadersTimeoutError] === true;
  }
  get [kHeadersTimeoutError](): boolean { return true; }
}

const kBodyTimeoutError = Symbol.for('undici.error.UND_ERR_BODY_TIMEOUT');
export class BodyTimeoutError extends UndiciError {
  constructor(message = 'Body timeout') {
    super(message, 'UND_ERR_BODY_TIMEOUT');
    this.name = 'BodyTimeoutError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kBodyTimeoutError] === true;
  }
  get [kBodyTimeoutError](): boolean { return true; }
}

const kSocketError = Symbol.for('undici.error.UND_ERR_SOCKET');
export class SocketError extends UndiciError {
  socket: any;
  constructor(message = 'Socket error', socket?: any) {
    super(message, 'UND_ERR_SOCKET');
    this.name = 'SocketError';
    this.socket = socket || null;
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kSocketError] === true;
  }
  get [kSocketError](): boolean { return true; }
}

const kInvalidArgumentError = Symbol.for('undici.error.UND_ERR_INVALID_ARG');
export class InvalidArgumentError extends UndiciError {
  constructor(message = 'Invalid argument') {
    super(message, 'UND_ERR_INVALID_ARG');
    this.name = 'InvalidArgumentError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kInvalidArgumentError] === true;
  }
  get [kInvalidArgumentError](): boolean { return true; }
}

const kClientDestroyedError = Symbol.for('undici.error.UND_ERR_DESTROYED');
export class ClientDestroyedError extends UndiciError {
  constructor(message = 'The client is destroyed') {
    super(message, 'UND_ERR_DESTROYED');
    this.name = 'ClientDestroyedError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kClientDestroyedError] === true;
  }
  get [kClientDestroyedError](): boolean { return true; }
}

const kClientClosedError = Symbol.for('undici.error.UND_ERR_CLOSED');
export class ClientClosedError extends UndiciError {
  constructor(message = 'The client is closed') {
    super(message, 'UND_ERR_CLOSED');
    this.name = 'ClientClosedError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kClientClosedError] === true;
  }
  get [kClientClosedError](): boolean { return true; }
}

const kRequestContentLengthMismatchError = Symbol.for('undici.error.UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
export class RequestContentLengthMismatchError extends UndiciError {
  constructor(message = 'Request body length does not match content-length header') {
    super(message, 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
    this.name = 'RequestContentLengthMismatchError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kRequestContentLengthMismatchError] === true;
  }
  get [kRequestContentLengthMismatchError](): boolean { return true; }
}

const kResponseContentLengthMismatchError = Symbol.for('undici.error.UND_ERR_RES_CONTENT_LENGTH_MISMATCH');
export class ResponseContentLengthMismatchError extends UndiciError {
  constructor(message = 'Response body length does not match content-length header') {
    super(message, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH');
    this.name = 'ResponseContentLengthMismatchError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kResponseContentLengthMismatchError] === true;
  }
  get [kResponseContentLengthMismatchError](): boolean { return true; }
}

const kResponseExceededMaxSizeError = Symbol.for('undici.error.UND_ERR_RES_EXCEEDED_MAX_SIZE');
export class ResponseExceededMaxSizeError extends UndiciError {
  constructor(message = 'Response content exceeded max size') {
    super(message, 'UND_ERR_RES_EXCEEDED_MAX_SIZE');
    this.name = 'ResponseExceededMaxSizeError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kResponseExceededMaxSizeError] === true;
  }
  get [kResponseExceededMaxSizeError](): boolean { return true; }
}

const kNotSupportedError = Symbol.for('undici.error.UND_ERR_NOT_SUPPORTED');
export class NotSupportedError extends UndiciError {
  constructor(message = 'Not supported') {
    super(message, 'UND_ERR_NOT_SUPPORTED');
    this.name = 'NotSupportedError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kNotSupportedError] === true;
  }
  get [kNotSupportedError](): boolean { return true; }
}

const kResponseError = Symbol.for('undici.error.UND_ERR_RESPONSE');
export class ResponseError extends UndiciError {
  statusCode: number;
  body: any;
  headers: any;
  constructor(message: string, statusCode: number, options: { headers?: any; body?: any } = {}) {
    super(message, 'UND_ERR_RESPONSE');
    this.name = 'ResponseError';
    this.statusCode = statusCode;
    this.body = options.body || null;
    this.headers = options.headers || null;
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kResponseError] === true;
  }
  get [kResponseError](): boolean { return true; }
}

export interface CoreErrorInfo {
  code: string;
  name: string;
  message: string;
  statusCode?: number;
}

export function createUndiciError(errorInfo: CoreErrorInfo): Error {
  const { code, message, statusCode } = errorInfo;
  switch (code) {
    case 'UND_ERR_ABORTED': return new RequestAbortedError(message);
    case 'UND_ERR_CONNECT_TIMEOUT': return new ConnectTimeoutError(message);
    case 'UND_ERR_HEADERS_TIMEOUT': return new HeadersTimeoutError(message);
    case 'UND_ERR_BODY_TIMEOUT': return new BodyTimeoutError(message);
    case 'UND_ERR_SOCKET': return new SocketError(message);
    case 'UND_ERR_DESTROYED': return new ClientDestroyedError(message);
    case 'UND_ERR_CLOSED': return new ClientClosedError(message);
    case 'UND_ERR_INVALID_ARG': return new InvalidArgumentError(message);
    case 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH': return new RequestContentLengthMismatchError(message);
    case 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH': return new ResponseContentLengthMismatchError(message);
    case 'UND_ERR_RES_EXCEEDED_MAX_SIZE': return new ResponseExceededMaxSizeError(message);
    case 'UND_ERR_NOT_SUPPORTED': return new NotSupportedError(message);
    case 'UND_ERR_RESPONSE': return new ResponseError(message, statusCode || 500);
    default: return new UndiciError(message, code);
  }
}
```

## Tests (packages/node/tests/vitest/errors.test.ts)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, expect } from 'vitest';
import {
  UndiciError,
  RequestAbortedError,
  SocketError,
  ResponseError,
  createUndiciError,
  type CoreErrorInfo,
} from '../../export/errors';

describe('Undici Error Classes', () => {
  it('should create correct error instances', () => {
    const abortError = new RequestAbortedError();
    expect(abortError.name).toBe('AbortError');
    expect(abortError.code).toBe('UND_ERR_ABORTED');
    expect(abortError.message).toBe('Request aborted');
  });

  it('should support instanceof checks', () => {
    const abortError = new RequestAbortedError();
    expect(abortError instanceof RequestAbortedError).toBe(true);
    expect(abortError instanceof UndiciError).toBe(true);
    expect(abortError instanceof Error).toBe(true);
  });

  it('should support cross-library instanceof via Symbol.for', () => {
    const abortError = new RequestAbortedError();
    const kRequestAbortedError = Symbol.for('undici.error.UND_ERR_ABORTED');
    expect(abortError[kRequestAbortedError]).toBe(true);
  });

  it('should create errors from CoreErrorInfo', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_SOCKET',
      name: 'SocketError',
      message: 'Connection refused',
    };
    const error = createUndiciError(errorInfo);
    expect(error instanceof SocketError).toBe(true);
    expect(error.message).toBe('Connection refused');
  });

  it('should handle ResponseError with status code', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_RESPONSE',
      name: 'ResponseError',
      message: 'Server error',
      statusCode: 500,
    };
    const error = createUndiciError(errorInfo) as ResponseError;
    expect(error instanceof ResponseError).toBe(true);
    expect(error.statusCode).toBe(500);
  });

  it('should fallback to UndiciError for unknown codes', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UNKNOWN_CODE',
      name: 'UnknownError',
      message: 'Unknown error',
    };
    const error = createUndiciError(errorInfo);
    expect(error instanceof UndiciError).toBe(true);
    expect(error.code).toBe('UNKNOWN_CODE');
  });
});
```

## Error Mapping Table

| Core Error                          | Undici Error                         | Symbol                                | Code                           |
| :---------------------------------- | :----------------------------------- | :------------------------------------ | :----------------------------- |
| `CoreError::RequestAborted`         | `RequestAbortedError`                | `undici.error.UND_ERR_ABORTED`        | `UND_ERR_ABORTED`              |
| `CoreError::ConnectTimeout`         | `ConnectTimeoutError`                | `undici.error.UND_ERR_CONNECT_TIMEOUT`| `UND_ERR_CONNECT_TIMEOUT`      |
| `CoreError::HeadersTimeout`         | `HeadersTimeoutError`                | `undici.error.UND_ERR_HEADERS_TIMEOUT`| `UND_ERR_HEADERS_TIMEOUT`      |
| `CoreError::BodyTimeout`            | `BodyTimeoutError`                   | `undici.error.UND_ERR_BODY_TIMEOUT`   | `UND_ERR_BODY_TIMEOUT`         |
| `CoreError::Socket`                 | `SocketError`                        | `undici.error.UND_ERR_SOCKET`         | `UND_ERR_SOCKET`               |
| `CoreError::Network`                | `SocketError`                        | `undici.error.UND_ERR_SOCKET`         | `UND_ERR_SOCKET`               |
| `CoreError::InvalidArgument`        | `InvalidArgumentError`               | `undici.error.UND_ERR_INVALID_ARG`    | `UND_ERR_INVALID_ARG`          |
| `CoreError::ClientDestroyed`        | `ClientDestroyedError`               | `undici.error.UND_ERR_DESTROYED`      | `UND_ERR_DESTROYED`            |
| `CoreError::ClientClosed`           | `ClientClosedError`                  | `undici.error.UND_ERR_CLOSED`         | `UND_ERR_CLOSED`               |
| `CoreError::RequestContentLength…`  | `RequestContentLengthMismatchError`  | `undici.error.UND_ERR_REQ_CONTENT_…`  | `UND_ERR_REQ_CONTENT_LENGTH_…` |
| `CoreError::ResponseContentLength…` | `ResponseContentLengthMismatchError` | `undici.error.UND_ERR_RES_CONTENT_…`  | `UND_ERR_RES_CONTENT_LENGTH_…` |
| `CoreError::ResponseExceededMaxSize`| `ResponseExceededMaxSizeError`       | `undici.error.UND_ERR_RES_EXCEEDED_…` | `UND_ERR_RES_EXCEEDED_MAX_SIZE`|
| `CoreError::NotSupported`           | `NotSupportedError`                  | `undici.error.UND_ERR_NOT_SUPPORTED`  | `UND_ERR_NOT_SUPPORTED`        |
| `CoreError::ResponseError`          | `ResponseError`                      | `undici.error.UND_ERR_RESPONSE`       | `UND_ERR_RESPONSE`             |

## File Structure

```text
packages/
├── core/src/
│   ├── error.rs           # NEW: CoreError enum with mappings
│   └── lib.rs             # UPDATE: export error module
└── node/
    ├── export/
    │   └── errors.ts      # NEW: All Undici error classes
    └── tests/vitest/
        └── errors.test.ts # NEW: Error class tests
```

## Verification

```bash
# Core
cd packages/core
cargo test

# Node
cd packages/node
pnpm test errors.test.ts
```
