# Core Types + Backpressure Primitives (Chunk 02a)

## Problem/Purpose

Define foundational types for the undici-compatible dispatcher including backpressure
primitives, lifecycle management (close/destroy), and controller-based API.

## Solution

Implement core HTTP data structures, `DispatchHandler` trait, `RequestController`
with atomic pause state and cancellation token, and `Lifecycle` trait for graceful
shutdown with request tracking.

## Architecture

```text
Agent (owns) ─► reqwest::Client
DispatchOptions ─► { origin, path, method, headers, body_reader }
DispatchHandler (trait) ─► { on_response_start, on_data, on_end, on_error }
RequestController ─► { CancellationToken, PauseState }
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
parking_lot = { workspace = true }
reqwest = { workspace = true }
thiserror = { workspace = true }
tokio = { workspace = true }
tokio-util = { workspace = true }

[dev-dependencies]
pretty_assertions = { workspace = true }
tempfile = { workspace = true }
tokio-test = { workspace = true }
wiremock = { workspace = true }
```

### packages/core/src/dispatcher.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Core dispatcher types and traits.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::error::CoreError;

/// HTTP method enum matching undici's supported methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Head,
    Post,
    Put,
    Delete,
    Connect,
    Options,
    Trace,
    Patch,
}

impl Method {
    /// Convert to reqwest::Method.
    pub fn to_reqwest(self) -> reqwest::Method {
        match self {
            Self::Get => reqwest::Method::GET,
            Self::Head => reqwest::Method::HEAD,
            Self::Post => reqwest::Method::POST,
            Self::Put => reqwest::Method::PUT,
            Self::Delete => reqwest::Method::DELETE,
            Self::Connect => reqwest::Method::CONNECT,
            Self::Options => reqwest::Method::OPTIONS,
            Self::Trace => reqwest::Method::TRACE,
            Self::Patch => reqwest::Method::PATCH,
        }
    }
}

/// Options for dispatching a request.
///
/// Note: Cannot derive Clone because reqwest::Body is not Clone.
/// This is intentional - bodies are consumed during request execution.
pub struct DispatchOptions {
    /// Origin URL (scheme + host + port), e.g., "https://example.com:8080"
    pub origin: Option<String>,
    /// Request path, e.g., "/api/users"
    pub path: String,
    /// Pre-encoded query string (without leading '?'), e.g., "key=value&key2=value2"
    /// Keys and values should already be URL-encoded via encodeURIComponent.
    pub query: String,
    pub method: Method,
    pub headers: HashMap<String, Vec<String>>,
    /// Request body. Supports both materialized (Bytes) and streaming bodies.
    /// None for bodyless requests like GET/HEAD.
    pub body: Option<reqwest::Body>,
    /// Time (ms) to wait for response headers. 0 = use default (300000ms).
    pub headers_timeout_ms: u64,
    /// Idle time (ms) between body chunks. 0 = use default (300000ms).
    pub body_timeout_ms: u64,
}

impl std::fmt::Debug for DispatchOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchOptions")
            .field("origin", &self.origin)
            .field("path", &self.path)
            .field("query", &self.query)
            .field("method", &self.method)
            .field("headers", &self.headers)
            .field("body", &self.body.as_ref().map(|_| "<body>"))
            .field("headers_timeout_ms", &self.headers_timeout_ms)
            .field("body_timeout_ms", &self.body_timeout_ms)
            .finish()
    }
}

impl Default for DispatchOptions {
    fn default() -> Self {
        Self {
            origin: None,
            path: "/".to_string(),
            query: String::new(),
            method: Method::Get,
            headers: HashMap::new(),
            body: None,
            headers_timeout_ms: 300_000, // 5 minutes, matches undici
            body_timeout_ms: 300_000,    // 5 minutes, matches undici
        }
    }
}

/// Response start metadata.
#[derive(Debug, Clone)]
pub struct ResponseStart {
    pub status_code: u16,
    pub status_message: String,
    pub headers: HashMap<String, Vec<String>>,
}

/// Trait for handling dispatch lifecycle events.
#[async_trait]
pub trait DispatchHandler: Send + Sync {
    /// Called when response headers are received.
    async fn on_response_start(&self, response: ResponseStart);

    /// Called for each chunk of response body data.
    async fn on_response_data(&self, chunk: Bytes);

    /// Called when response is complete.
    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>);

    /// Called when an error occurs.
    async fn on_response_error(&self, error: CoreError);
}

/// Pause state for backpressure signaling using watch channel.
///
/// Uses `tokio::sync::watch` for race-condition-free state synchronization.
pub struct PauseState {
    sender: watch::Sender<bool>,
    receiver: watch::Receiver<bool>,
}

impl Default for PauseState {
    fn default() -> Self {
        Self::new()
    }
}

impl PauseState {
    pub fn new() -> Self {
        let (sender, receiver) = watch::channel(false);
        Self { sender, receiver }
    }

    /// Block until not paused. Returns immediately if not paused.
    /// Uses wait_for for atomic check-and-wait to avoid race conditions.
    pub async fn wait_if_paused(&self) {
        let mut rx = self.receiver.clone();
        // wait_for handles the initial check + waiting atomically
        let _ = rx.wait_for(|paused| !*paused).await;
    }

    pub fn pause(&self) {
        let _ = self.sender.send(true);
    }

    pub fn resume(&self) {
        let _ = self.sender.send(false);
    }

    pub fn is_paused(&self) -> bool {
        *self.receiver.borrow()
    }
}

/// Handle for controlling an in-flight request.
pub struct RequestController {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl Default for RequestController {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestController {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            pause_state: Arc::new(PauseState::new()),
        }
    }

    /// Abort the request.
    pub fn abort(&self) {
        self.token.cancel();
    }

    /// Pause response data consumption (backpressure).
    pub fn pause(&self) {
        self.pause_state.pause();
    }

    /// Resume response data consumption.
    pub fn resume(&self) {
        self.pause_state.resume();
    }

    /// Get the cancellation token for select! usage.
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// Get the pause state for async waiting.
    pub fn pause_state(&self) -> Arc<PauseState> {
        Arc::clone(&self.pause_state)
    }

    /// Check if request was aborted.
    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Check if request is paused.
    pub fn is_paused(&self) -> bool {
        self.pause_state.is_paused()
    }
}

/// Trait for managing dispatcher lifecycle.
///
/// Implementations must track active requests and handle graceful/abrupt shutdown.
#[async_trait]
pub trait Lifecycle: Send + Sync {
    /// Close gracefully: wait for all pending requests to complete.
    async fn close(&self);

    /// Destroy abruptly: cancel all pending requests with the given error.
    async fn destroy(&self, error: CoreError);

    /// Check if the dispatcher is closed.
    fn is_closed(&self) -> bool;

    /// Check if the dispatcher is destroyed.
    fn is_destroyed(&self) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_state_atomic_operations() {
        let state = PauseState::new();
        assert!(!state.is_paused());

        state.pause();
        assert!(state.is_paused());

        state.resume();
        assert!(!state.is_paused());
    }

    #[test]
    fn request_controller_abort() {
        let ctrl = RequestController::new();
        assert!(!ctrl.is_cancelled());

        ctrl.abort();
        assert!(ctrl.is_cancelled());
    }

    #[tokio::test]
    async fn pause_state_wait_resumes() {
        let state = Arc::new(PauseState::new());
        state.pause();

        let state_clone = Arc::clone(&state);
        let handle = tokio::spawn(async move {
            state_clone.wait_if_paused().await;
            true
        });

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        state.resume();

        let result = tokio::time::timeout(std::time::Duration::from_millis(100), handle)
            .await
            .expect("timeout")
            .expect("join");
        assert!(result);
    }

    #[tokio::test]
    async fn pause_state_wait_for_immediate_resume() {
        // Test that wait_if_paused returns immediately when not paused
        let state = PauseState::new();
        // Should complete instantly
        tokio::time::timeout(std::time::Duration::from_millis(10), state.wait_if_paused())
            .await
            .expect("should not timeout");
    }
}
```

### packages/core/src/agent.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! HTTP Agent wrapping reqwest::Client.

use std::time::Duration;

use reqwest::Client;

use crate::error::CoreError;

/// Configuration for creating an Agent.
#[derive(Debug, Clone, Default)]
pub struct AgentConfig {
    pub timeout: Option<Duration>,
    pub connect_timeout: Option<Duration>,
    pub pool_idle_timeout: Option<Duration>,
}

/// HTTP Agent managing connection pooling.
pub struct Agent {
    pub(crate) client: Client,
}

impl Agent {
    /// Create a new Agent with the given configuration.
    pub fn new(config: AgentConfig) -> Result<Self, CoreError> {
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

        let client = builder
            .build()
            .map_err(|e| CoreError::from_reqwest(e, false))?;

        Ok(Self { client })
    }

    /// Get a reference to the underlying client.
    pub fn client(&self) -> &Client {
        &self.client
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_creation_default() {
        let agent = Agent::new(AgentConfig::default());
        assert!(agent.is_ok());
    }

    #[test]
    fn agent_creation_with_timeouts() {
        let config = AgentConfig {
            timeout: Some(Duration::from_secs(30)),
            connect_timeout: Some(Duration::from_secs(10)),
            pool_idle_timeout: Some(Duration::from_secs(60)),
        };
        let agent = Agent::new(config);
        assert!(agent.is_ok());
    }
}
```

### packages/core/src/lib.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Core library for node_reqwest - Rust HTTP client with undici compatibility.

pub mod agent;
pub mod dispatcher;
pub mod error;

pub use agent::{Agent, AgentConfig};
pub use dispatcher::{
    DispatchHandler, DispatchOptions, Lifecycle, Method, PauseState, RequestController,
    ResponseStart,
};
pub use error::CoreError;
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Dependencies** | `reqwest`, `tokio`, `tokio-util`, `async-trait`, `bytes` |
| **Pause State** | `tokio::sync::watch` (race-condition-free) |
| **Thread Safety** | All types are `Send + Sync` |
| **Tests** | 5 unit tests |

## File Structure

```text
packages/core/
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── agent.rs
    ├── dispatcher.rs
    └── error.rs
```
