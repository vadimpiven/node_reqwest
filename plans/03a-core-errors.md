# Core Error Types (Chunk 3A)

**Part**: 3 of 6 (Error Handling)  
**Chunk**: 3A of 2  
**Time**: 1 hour  
**Prerequisites**: Part 2 complete (Chunks 2A-2B, 7 tests passing)

## Goal

Define comprehensive `CoreError` enum with all Undici error variants and mapping methods.
Focus only on Rust types - JS/TS comes in 3B.

## Add Dependency

```toml
# packages/core/Cargo.toml
[dependencies]
thiserror = { workspace = true }

# Root Cargo.toml
[workspace.dependencies]
thiserror = "2.0.12"
```

## Core Error Types (packages/core/src/error.rs)

Create new file with complete error type:

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

## Update Exports (packages/core/src/lib.rs)

```rust
// ADD module and re-export
pub mod error;

pub use error::CoreError;
```

## File Structure

```text
packages/core/
├── Cargo.toml              # UPDATED: Add thiserror
├── src/
│   ├── error.rs           # NEW: CoreError enum
│   └── lib.rs             # UPDATED: Export error module
└── tests/                 # No changes yet
```

## Verification

```bash
cd packages/core
cargo build
cargo test
```

All 7 previous tests should still pass. New error types just need to compile.

## Milestone Checklist

- [ ] `CoreError` enum compiles with thiserror
- [ ] `error_code()` returns Undici error codes
- [ ] `error_name()` returns error class names
- [ ] `status_code()` extracts HTTP status for ResponseError
- [ ] Display/Error traits work correctly
- [ ] All 7 tests still pass
- [ ] Ready for Chunk 3B (TypeScript errors)

## Next Steps

1. Move to **Chunk 3B** (`03b-typescript-errors.md`)
2. Create TypeScript error classes with Symbol.for
3. Implement createUndiciError() factory

## Design Notes

- **thiserror**: Derives Display and Error traits automatically
- **Undici compatibility**: Error codes match undici exactly
- **No JS integration yet**: Pure Rust types for now
- **14 error variants**: Covers all common HTTP client error cases
