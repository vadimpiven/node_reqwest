# Core Types + Basic Agent (Chunk 1A)

## Problem/Purpose

Define foundational types for the undici-compatible dispatcher and establish the basic
`Agent` structure.

## Solution

Implement core HTTP data structures and a `DispatchHandler` trait to manage request
lifecycles.

## Architecture

```text
Agent (owns) -> reqwest::Client
DispatchOptions (input) -> { origin, path, method, headers }
DispatchHandler (trait) -> callbacks { on_response_start, on_data, ... }
```

## Implementation

### packages/core/Cargo.toml

```toml
[package]
name = "core"
edition.workspace = true

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
```

### packages/core/src/dispatcher.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT
use std::collections::HashMap;
use async_trait::async_trait;
use bytes::Bytes;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get, Head, Post, Put, Delete, Connect, Options, Trace, Patch,
}

#[derive(Debug, Clone)]
pub struct DispatchOptions {
    pub origin: Option<String>,
    pub path: String,
    pub method: Method,
    pub headers: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ResponseStart {
    pub status_code: u16,
    pub status_message: String,
    pub headers: HashMap<String, Vec<String>>,
}

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

#[async_trait]
pub trait DispatchHandler: Send + Sync {
    async fn on_response_start(&self, response: ResponseStart);
    async fn on_response_data(&self, chunk: Bytes);
    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>);
    async fn on_response_error(&self, error: DispatchError);
}
```

### packages/core/src/agent.rs

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
        if let Some(timeout) = config.timeout { builder = builder.timeout(timeout); }
        if let Some(timeout) = config.connect_timeout { builder = builder.connect_timeout(timeout); }
        if let Some(timeout) = config.pool_idle_timeout { builder = builder.pool_idle_timeout(timeout); }
        Ok(Self { client: builder.build()? })
    }
}
```

### packages/core/src/lib.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT
pub mod agent;
pub mod dispatcher;
pub use agent::{Agent, AgentConfig, AgentError};
pub use dispatcher::*;
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Dependencies** | `reqwest`, `tokio`, `async-trait`, `bytes` |
| **Est. Build Time** | < 2 minutes |
| **Memory Sync** | `Send + Sync` for `DispatchHandler` |

## File Structure

```text
packages/core/
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── dispatcher.rs
    └── agent.rs
```
