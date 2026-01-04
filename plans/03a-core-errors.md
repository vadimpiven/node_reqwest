# Core Error Types (Chunk 3A)

## Problem/Purpose

Establish a robust error handling system in Rust that maintains parity with Undici's
error structure.

## Solution

Implement a `CoreError` enum using `thiserror` to handle various HTTP and network failure
modes, providing metadata for the FFI layer.

## Architecture

```text
CoreError (enum)
  ├─ Message (Display)
  ├─ error_code() -> "UND_ERR_*"
  ├─ error_name() -> "*Error"
  └─ status_code() -> Option<u16>
```

## Implementation

### packages/core/Cargo.toml

```toml
[dependencies]
thiserror = { workspace = true }
```

### packages/core/src/error.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT
use thiserror::Error;

#[derive(Debug, Clone, Error)]
pub enum CoreError {
    #[error("Request aborted")] RequestAborted,
    #[error("Connect timeout")] ConnectTimeout,
    #[error("Headers timeout")] HeadersTimeout,
    #[error("Body timeout")] BodyTimeout,
    #[error("Socket error: {0}")] Socket(String),
    #[error("Invalid argument: {0}")] InvalidArgument(String),
    #[error("The client is destroyed")] ClientDestroyed,
    #[error("The client is closed")] ClientClosed,
    #[error("Request body length does not match content-length header")] RequestContentLengthMismatch,
    #[error("Response body length does not match content-length header")] ResponseContentLengthMismatch,
    #[error("Response content exceeded max size")] ResponseExceededMaxSize,
    #[error("Not supported: {0}")] NotSupported(String),
    #[error("Response error")] ResponseError { status_code: u16, message: String },
    #[error("Network error: {0}")] Network(String),
}

impl CoreError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::RequestAborted => "UND_ERR_ABORTED",
            Self::ConnectTimeout => "UND_ERR_CONNECT_TIMEOUT",
            Self::HeadersTimeout => "UND_ERR_HEADERS_TIMEOUT",
            Self::BodyTimeout => "UND_ERR_BODY_TIMEOUT",
            Self::Socket(_) | Self::Network(_) => "UND_ERR_SOCKET",
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
            Self::Socket(_) | Self::Network(_) => "SocketError",
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

### packages/core/src/lib.rs

```rust
pub mod error;
pub use error::CoreError;
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Dependency** | `thiserror = "2.0.12"` |
| **Coverage** | 14 Undici error codes mapped |
| **Metadata** | Code, Name, HTTP Status |

## File Structure

```text
packages/core/
└── src/
    ├── lib.rs
    └── error.rs
```
