# Error Types (Chunk 01)

## Problem/Purpose

Error types with undici compatibility: Rust `CoreError` + TypeScript classes.

## Solution

`CoreError` enum with undici metadata. TypeScript classes use `Symbol.for` for
cross-library `instanceof`.

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
              createUndiciError(info) ─► JavaScript Error
```

## Implementation

### packages/core/src/error.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use thiserror::Error;

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
            pub fn error_code(&self) -> &'static str {
                match self {
                    $( Self::$variant { .. } => $code, )*
                    Self::ResponseError { .. } => "UND_ERR_RESPONSE",
                }
            }

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

    #[error("Socket error: {0}")]
    Socket(String) => ("UND_ERR_SOCKET", "SocketError"),

    #[error("Invalid argument: {0}")]
    InvalidArgument(String) => ("UND_ERR_INVALID_ARG", "InvalidArgumentError"),

    #[error("The client is destroyed")]
    ClientDestroyed => ("UND_ERR_DESTROYED", "ClientDestroyedError"),

    #[error("The client is closed")]
    ClientClosed => ("UND_ERR_CLOSED", "ClientClosedError"),

    #[error("Not supported: {0}")]
    NotSupported(String) => ("UND_ERR_NOT_SUPPORTED", "NotSupportedError"),
}

impl CoreError {
    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::ResponseError { status_code, .. } => Some(*status_code),
            _ => None,
        }
    }

    /// Map reqwest::Error to CoreError.
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

        if err.is_body() || err.is_decode() || err.is_redirect() {
            return Self::Socket(err.to_string());
        }

        if err.is_builder() {
            return Self::InvalidArgument(err.to_string());
        }

        Self::Socket(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes() {
        assert_eq!(CoreError::RequestAborted.error_code(), "UND_ERR_ABORTED");
        assert_eq!(CoreError::ConnectTimeout.error_code(), "UND_ERR_CONNECT_TIMEOUT");
    }

    #[test]
    fn response_error_status() {
        let err = CoreError::ResponseError {
            status_code: 404,
            message: "Not Found".into(),
        };
        assert_eq!(err.status_code(), Some(404));
    }
}
```

### packages/core/src/lib.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

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

export const RequestAbortedError = defineError(
  'UND_ERR_ABORTED',
  'Request aborted',
  'AbortError'
);

export const ConnectTimeoutError = defineError(
  'UND_ERR_CONNECT_TIMEOUT',
  'Connect timeout',
  'ConnectTimeoutError'
);

export const HeadersTimeoutError = defineError(
  'UND_ERR_HEADERS_TIMEOUT',
  'Headers timeout',
  'HeadersTimeoutError'
);

export const BodyTimeoutError = defineError(
  'UND_ERR_BODY_TIMEOUT',
  'Body timeout',
  'BodyTimeoutError'
);

export const SocketError = defineError('UND_ERR_SOCKET', 'Socket error', 'SocketError');

export const InvalidArgumentError = defineError(
  'UND_ERR_INVALID_ARG',
  'Invalid argument',
  'InvalidArgumentError'
);

export const ClientDestroyedError = defineError(
  'UND_ERR_DESTROYED',
  'The client is destroyed',
  'ClientDestroyedError'
);

export const ClientClosedError = defineError(
  'UND_ERR_CLOSED',
  'The client is closed',
  'ClientClosedError'
);

export const NotSupportedError = defineError(
  'UND_ERR_NOT_SUPPORTED',
  'Not supported',
  'NotSupportedError'
);

const kResponseError = Symbol.for('undici.error.UND_ERR_RESPONSE');

export class ResponseError extends UndiciError {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message, 'UND_ERR_RESPONSE');
    this.name = 'ResponseError';
    this.statusCode = statusCode;
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (instance as Record<symbol, boolean>)?.[kResponseError] === true;
  }

  get [kResponseError](): boolean {
    return true;
  }
}

export function createUndiciError(info: CoreErrorInfo): Error {
  const { code, message, statusCode } = info;
  switch (code) {
    case 'UND_ERR_ABORTED':
      return new RequestAbortedError(message);
    case 'UND_ERR_CONNECT_TIMEOUT':
      return new ConnectTimeoutError(message);
    case 'UND_ERR_HEADERS_TIMEOUT':
      return new HeadersTimeoutError(message);
    case 'UND_ERR_BODY_TIMEOUT':
      return new BodyTimeoutError(message);
    case 'UND_ERR_SOCKET':
      return new SocketError(message);
    case 'UND_ERR_DESTROYED':
      return new ClientDestroyedError(message);
    case 'UND_ERR_CLOSED':
      return new ClientClosedError(message);
    case 'UND_ERR_INVALID_ARG':
      return new InvalidArgumentError(message);
    case 'UND_ERR_NOT_SUPPORTED':
      return new NotSupportedError(message);
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
  ResponseError,
  createUndiciError,
  type CoreErrorInfo,
} from '../../export/errors.ts';

describe('Undici Error Classes', () => {
  it('creates correct error instances', () => {
    const err = new RequestAbortedError();
    expect(err.code).toBe('UND_ERR_ABORTED');
    expect(err.name).toBe('AbortError');
  });

  it('supports instanceof checks', () => {
    const err = new RequestAbortedError();
    expect(err instanceof RequestAbortedError).toBe(true);
    expect(err instanceof UndiciError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('creates errors from CoreErrorInfo', () => {
    const info: CoreErrorInfo = {
      code: 'UND_ERR_ABORTED',
      name: 'AbortError',
      message: 'Request was aborted',
    };
    const err = createUndiciError(info);
    expect(err instanceof RequestAbortedError).toBe(true);
  });

  it('handles ResponseError with status code', () => {
    const info: CoreErrorInfo = {
      code: 'UND_ERR_RESPONSE',
      name: 'ResponseError',
      message: 'Bad request',
      statusCode: 400,
    };
    const err = createUndiciError(info) as ResponseError;
    expect(err instanceof ResponseError).toBe(true);
    expect(err.statusCode).toBe(400);
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Rust Dependency** | `thiserror = "2.0"`, `reqwest` |
| **Error Classes** | 10 (9 specific + 1 base) |
| **Est. Time** | 1.5 hours |

## File Structure

```text
packages/core/src/
├── lib.rs
└── error.rs
packages/node/
├── export/errors.ts
└── tests/vitest/errors.test.ts
```
