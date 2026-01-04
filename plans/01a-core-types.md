# Core Types + Basic Agent (Chunk 1A)

**Part**: 1 of 6 (Core Foundation)  
**Chunk**: 1A of 2  
**Time**: 1.5 hours  
**Prerequisites**: None - this is the starting point

## Goal

Define all core dispatcher types and create a basic Agent structure that compiles.
No execution logic yet - just type definitions.

## Dependencies (Cargo.toml)

```toml
# packages/core/Cargo.toml
[package]
name = "core"
edition.workspace = true

[lints]
workspace = true

[dependencies]
async-trait = { workspace = true }
bytes = { workspace = true }
futures = { workspace = true }
reqwest = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
tokio-stream = { workspace = true }

[dev-dependencies]
pretty_assertions.workspace = true
tempfile.workspace = true
tokio-test = { workspace = true }

# Workspace (add to root Cargo.toml if missing)
[workspace.dependencies]
tokio-test = "0.4"
```

## Core Types (packages/core/src/dispatcher.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::collections::HashMap;
use async_trait::async_trait;
use bytes::Bytes;

/// HTTP method
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get, Head, Post, Put, Delete, Connect, Options, Trace, Patch,
}

/// Request options matching undici DispatchOptions
#[derive(Debug, Clone)]
pub struct DispatchOptions {
    pub origin: Option<String>,
    pub path: String,
    pub method: Method,
    pub headers: HashMap<String, Vec<String>>,
}

/// Response metadata
#[derive(Debug, Clone)]
pub struct ResponseStart {
    pub status_code: u16,
    pub status_message: String,
    pub headers: HashMap<String, Vec<String>>,
}

/// Dispatch error types (basic version for Chunk 1A)
#[derive(Debug, Clone)]
pub enum DispatchError {
    Network(String),
    Http(u16, String),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(msg) => write!(f, "Network error: {msg}"),
            Self::Http(code, msg) => write!(f, "HTTP {code}: {msg}"),
        }
    }
}

impl std::error::Error for DispatchError {}

/// Async trait for dispatch lifecycle callbacks
#[async_trait]
pub trait DispatchHandler: Send + Sync {
    async fn on_response_start(&self, response: ResponseStart);
    async fn on_response_data(&self, chunk: Bytes);
    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>);
    async fn on_response_error(&self, error: DispatchError);
}
```

## Agent Structure (packages/core/src/agent.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use reqwest::Client;
use std::time::Duration;

pub struct Agent {
    client: Client,
}

#[derive(Debug)]
pub enum AgentError {
    Build(String),
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Build(msg) => write!(f, "Failed to build HTTP client: {msg}"),
        }
    }
}

impl std::error::Error for AgentError {}

impl From<reqwest::Error> for AgentError {
    fn from(e: reqwest::Error) -> Self { Self::Build(e.to_string()) }
}

#[derive(Debug, Clone, Default)]
pub struct AgentConfig {
    pub timeout: Option<Duration>,
    pub connect_timeout: Option<Duration>,
    pub pool_idle_timeout: Option<Duration>,
}

impl Agent {
    pub fn new(config: AgentConfig) -> Result<Self, AgentError> {
        let mut builder = Client::builder();

        if let Some(timeout) = config.timeout {
            builder = builder.timeout(timeout);
        }
        if let Some(timeout) = config.connect_timeout {
            builder = builder.connect_timeout(timeout);
        }
        if let Some(timeout) = config.pool_idle_timeout {
            builder = builder.pool_idle_timeout(timeout);
        }

        let client = builder.build()?;
        Ok(Self { client })
    }
}
```

## Lib (packages/core/src/lib.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Core functionality for `node_reqwest`.

pub mod agent;
pub mod dispatcher;

pub use agent::{Agent, AgentConfig, AgentError};
pub use dispatcher::{
    DispatchError, DispatchHandler, DispatchOptions, Method, ResponseStart,
};
```

## File Structure

```text
packages/core/
├── Cargo.toml              # Dependencies listed above
├── src/
│   ├── lib.rs             # Module exports
│   ├── dispatcher.rs      # Types and DispatchHandler trait
│   └── agent.rs           # Agent struct with new() method
└── tests/                 # Will add in Chunk 1B
```

## Verification

```bash
cd packages/core
cargo build
```

**Expected output:**

```text
   Compiling core v0.1.0
    Finished dev [unoptimized + debuginfo] target(s) in X.XXs
```

## Milestone Checklist

- [ ] All types in `dispatcher.rs` compile
- [ ] `Agent::new()` compiles and creates a client
- [ ] `cargo build` succeeds with no errors
- [ ] Types are properly exported from `lib.rs`
- [ ] Ready to proceed to Chunk 1B (request execution)

## Next Steps

Once this chunk is complete and verified:

1. Move to **Chunk 1B** (`01b-request-execution.md`)
2. Implement `Agent::dispatch()` and `execute_request()`
3. Add wiremock tests

## Design Notes

- **No execution logic yet**: This chunk focuses only on type definitions
- **Simple error model**: We'll expand `DispatchError` in Part 2
- **Basic Agent**: Just construction for now, dispatch comes in 1B
- **Undici compatibility**: `DispatchOptions` matches undici interface
