# Core Types + Backpressure Primitives (Chunk 02a)

## Purpose

Foundational types for the undici-compatible dispatcher: HTTP data structures, handler trait,
controller with pause/cancel, and lifecycle trait for graceful shutdown.

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
/// Not Clone: `reqwest::Body` is not Clone; bodies are consumed during execution.
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
    /// Request body. Supports materialized (Bytes) or streaming bodies.
    /// None for bodyless requests (GET/HEAD).
    pub body: Option<reqwest::Body>,
    /// Time (ms) to wait for response headers.
    /// `None` = use `AgentConfig::headers_timeout`. `Some(0)` is invalid and
    /// must be rejected at the FFI boundary (`InvalidArgumentError`).
    pub headers_timeout_ms: Option<u64>,
    /// Idle time (ms) between body chunks. Same semantics as above.
    pub body_timeout_ms: Option<u64>,
    /// Per-request connect timeout override.
    pub connect_timeout_ms: Option<u64>,
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
            .field("connect_timeout_ms", &self.connect_timeout_ms)
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
            headers_timeout_ms: None,
            body_timeout_ms: None,
            connect_timeout_ms: None,
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

/// Pause state for backpressure signaling.
///
/// Uses `tokio::sync::watch` for race-free state sync.
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
    /// `wait_for` performs an atomic check-and-wait.
    ///
    /// Pause is chunk-granular: a chunk already in flight from reqwest will
    /// be delivered before pause takes effect. Callers needing strict
    /// pre-chunk gating should drain the controller before pausing.
    pub async fn wait_if_paused(&self) {
        let mut rx = self.receiver.clone();
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

// Lifecycle methods (`close`, `destroy`, `is_closed`, `is_destroyed`) are
// declared inherent on `Agent` in 02b. A trait here would have a single impl
// and add indirection without polymorphism. `DispatchHandler` stays a trait
// because it has multiple implementations (`MockHandler`, `JsDispatchHandler`).

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
        // wait_if_paused returns immediately when not paused
        let state = PauseState::new();
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
///
/// The agent-level timeout fields supply defaults for per-request overrides
/// in `DispatchOptions`. When the per-request value is `None`, the agent's
/// default is used. `max_redirections = 0` (the default) matches undici:
/// the dispatcher returns 30x responses to the caller verbatim. Any non-zero
/// value enables `reqwest::redirect::Policy::limited(n)`.
///
/// Security: `Agent::new` always calls `cookie_store(false)` and never
/// installs a cookie provider. A shared jar across requests is a cross-tenant
/// leak hazard in multi-user server contexts, so the dispatcher refuses to
/// keep one. Drop the `cookies` reqwest feature from `Cargo.toml` unless a
/// future per-request cookie-header helper needs it.
#[derive(Debug, Clone, Default)]
pub struct AgentConfig {
    /// Total request timeout (reqwest-level). `None` = no limit.
    pub timeout: Option<Duration>,
    /// Default per-request connect timeout.
    pub connect_timeout: Option<Duration>,
    /// Default per-request headers timeout (response status + headers).
    pub headers_timeout: Option<Duration>,
    /// Default per-request body timeout (idle between chunks).
    pub body_timeout: Option<Duration>,
    /// Pool idle timeout (socket close after idleness).
    pub pool_idle_timeout: Option<Duration>,
    /// 0 = no redirects (undici default). Else cap via `Policy::limited(n)`.
    pub max_redirections: u32,
}

/// HTTP Agent managing connection pooling.
pub struct Agent {
    pub(crate) client: Client,
}

impl Agent {
    /// Create a new Agent with the given configuration. See 02b for the
    /// full implementation including redirect policy and lifecycle state.
    pub fn new(config: AgentConfig) -> Result<Self, CoreError> {
        let mut builder = Client::builder().cookie_store(false);

        if let Some(timeout) = config.timeout {
            builder = builder.timeout(timeout);
        }
        if let Some(timeout) = config.connect_timeout {
            builder = builder.connect_timeout(timeout);
        }
        if let Some(timeout) = config.pool_idle_timeout {
            builder = builder.pool_idle_timeout(timeout);
        }

        builder = builder.redirect(if config.max_redirections == 0 {
            reqwest::redirect::Policy::none()
        } else {
            reqwest::redirect::Policy::limited(config.max_redirections as usize)
        });

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
    DispatchHandler, DispatchOptions, Method, PauseState, RequestController, ResponseStart,
};
pub use error::CoreError;
```

## Summary

| Metric            | Value                                                    |
| :---------------- | :------------------------------------------------------- |
| **Dependencies**  | `reqwest`, `tokio`, `tokio-util`, `async-trait`, `bytes` |
| **Pause State**   | `tokio::sync::watch` (race-free)                         |
| **Thread Safety** | All types are `Send + Sync`                              |
| **Tests**         | 5 unit tests                                             |

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
