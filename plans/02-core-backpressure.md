# Core Backpressure

Add pause/resume/abort mechanisms to request handling.

**Prerequisites**: 01-core-foundation.md complete and tested

## Goal

Verify abort, pause, and resume work correctly with no unbounded queues.

## Dependencies (add to packages/core/Cargo.toml)

```toml
[dependencies]
tokio-util = { workspace = true }

# Add to root Cargo.toml if missing
[workspace.dependencies]
tokio-util = { version = "0.7", features = ["sync"] }
```text

## PauseState (packages/core/src/dispatcher.rs)

```rust
// Add to existing dispatcher.rs

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Pause state for backpressure
pub struct PauseState {
    paused: AtomicBool,
    notify: Notify,
}

impl PauseState {
    #[must_use]
    pub fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    /// Blocks until not paused. Uses SeqCst for cross-thread visibility.
    pub async fn wait_if_paused(&self) {
        while self.paused.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.notify.notify_one();
    }

    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

impl Default for PauseState {
    fn default() -> Self { Self::new() }
}

/// Handle for controlling in-flight request
pub struct RequestController {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl RequestController {
    #[must_use]
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            pause_state: Arc::new(PauseState::new()),
        }
    }

    pub fn abort(&self) { self.token.cancel(); }
    pub fn pause(&self) { self.pause_state.pause(); }
    pub fn resume(&self) { self.pause_state.resume(); }

    #[must_use]
    pub fn token(&self) -> CancellationToken { self.token.clone() }
    
    #[must_use]
    pub fn pause_state(&self) -> Arc<PauseState> { Arc::clone(&self.pause_state) }
    
    #[must_use]
    pub fn is_cancelled(&self) -> bool { self.token.is_cancelled() }
}

impl Default for RequestController {
    fn default() -> Self { Self::new() }
}
```text

## Update DispatchError (packages/core/src/dispatcher.rs)

```rust
// Add to existing DispatchError enum

#[derive(Debug, Clone)]
pub enum DispatchError {
    Aborted,                // NEW
    Timeout,                // NEW
    Network(String),
    Http(u16, String),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Aborted => write!(f, "Request aborted"),
            Self::Timeout => write!(f, "Request timeout"),
            Self::Network(msg) => write!(f, "Network error: {msg}"),
            Self::Http(code, msg) => write!(f, "HTTP {code}: {msg}"),
        }
    }
}
```text

## Update Agent (packages/core/src/agent.rs)

```rust
// Replace existing dispatch() and execute_request()

use tokio::select;

impl Agent {
    /// Dispatch a request. Returns controller for abort/pause/resume.
    pub fn dispatch(
        &self,
        runtime: tokio::runtime::Handle,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
    ) -> RequestController {
        let controller = RequestController::new();
        let client = self.client.clone();
        let token = controller.token();
        let pause_state = controller.pause_state();

        runtime.spawn(async move {
            Self::execute_request(client, options, handler, token, pause_state).await;
        });

        controller
    }

    async fn execute_request(
        client: Client,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
        token: CancellationToken,
        pause_state: Arc<PauseState>,
    ) {
        let method = match options.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Delete => reqwest::Method::DELETE,
            Method::Head => reqwest::Method::HEAD,
            Method::Connect => reqwest::Method::CONNECT,
            Method::Options => reqwest::Method::OPTIONS,
            Method::Trace => reqwest::Method::TRACE,
            Method::Patch => reqwest::Method::PATCH,
        };

        let url = format!(
            "{}{}",
            options.origin.as_deref().unwrap_or(""),
            options.path
        );

        let mut request = client.request(method, &url);

        for (key, values) in &options.headers {
            for value in values {
                request = request.header(key.as_str(), value.as_str());
            }
        }

        // Send request with cancellation support
        let response = select! {
            () = token.cancelled() => {
                handler.on_response_error(DispatchError::Aborted).await;
                return;
            }
            result = request.send() => {
                match result {
                    Ok(resp) => resp,
                    Err(e) if e.is_timeout() => {
                        handler.on_response_error(DispatchError::Timeout).await;
                        return;
                    }
                    Err(e) => {
                        handler.on_response_error(DispatchError::Network(e.to_string())).await;
                        return;
                    }
                }
            }
        };

        // Extract headers
        let headers = response.headers()
            .iter()
            .fold(HashMap::new(), |mut acc, (k, v)| {
                acc.entry(k.to_string())
                    .or_insert_with(Vec::new)
                    .push(v.to_str().unwrap_or("").to_string());
                acc
            });

        handler.on_response_start(ResponseStart {
            status_code: response.status().as_u16(),
            status_message: response.status().canonical_reason().unwrap_or("").to_string(),
            headers,
        }).await;

        // Stream body with backpressure
        let mut stream = response.bytes_stream();
        loop {
            // Block if paused - core backpressure mechanism
            pause_state.wait_if_paused().await;

            select! {
                () = token.cancelled() => {
                    handler.on_response_error(DispatchError::Aborted).await;
                    return;
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(data)) => {
                            handler.on_response_data(data).await;
                        }
                        Some(Err(e)) => {
                            handler.on_response_error(DispatchError::Network(e.to_string())).await;
                            return;
                        }
                        None => {
                            handler.on_response_end(HashMap::new()).await;
                            return;
                        }
                    }
                }
            }
        }
    }
}
```text

## Update Exports (packages/core/src/lib.rs)

```rust
// Add to re-exports

pub use dispatcher::{
    DispatchError, DispatchHandler, DispatchOptions, Method, ResponseStart,
    PauseState, RequestController, // NEW
};
```text

## Tests (packages/core/tests/backpressure.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

mod support;

use core::{Agent, AgentConfig, DispatchOptions, Method};
use std::sync::Arc;
use std::time::Duration;
use support::mock_handler::MockHandler;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn test_abort_before_response() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/slow".to_string(),
        method: Method::Get,
        headers: Default::default(),
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    controller.abort();

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout waiting for abort");

    let events = events.lock().await;
    assert!(events.response_starts.is_empty());
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].contains("aborted"));
}

#[tokio::test]
async fn test_abort_during_streaming() {
    let server = MockServer::start().await;
    // Large response that will stream multiple chunks
    let large_body = "x".repeat(1024 * 1024); // 1MB
    Mock::given(method("GET"))
        .and(path("/large"))
        .respond_with(ResponseTemplate::new(200).set_body_string(large_body))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/large".to_string(),
        method: Method::Get,
        headers: Default::default(),
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    
    // Wait for first chunk, then abort
    tokio::time::sleep(Duration::from_millis(100)).await;
    controller.abort();

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout waiting for abort");

    let events = events.lock().await;
    // Should have received at least headers
    assert_eq!(events.response_starts.len(), 1);
    // Should have error from abort
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].contains("aborted"));
}

#[tokio::test]
async fn test_pause_resume_backpressure() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/data"))
        .respond_with(ResponseTemplate::new(200).set_body_string("chunk1chunk2chunk3"))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/data".to_string(),
        method: Method::Get,
        headers: Default::default(),
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    
    // Pause immediately
    controller.pause();
    assert!(controller.pause_state().is_paused());
    
    // Wait a bit and verify still paused
    tokio::time::sleep(Duration::from_millis(100)).await;
    
    // Resume
    controller.resume();
    assert!(!controller.pause_state().is_paused());

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout");

    let events = events.lock().await;
    assert_eq!(events.response_starts.len(), 1);
    assert!(!events.data_chunks.is_empty());
    assert_eq!(events.response_ends.len(), 1);
}

#[tokio::test]
async fn test_timeout() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/timeout"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server)
        .await;

    let config = AgentConfig {
        timeout: Some(Duration::from_millis(100)),
        ..Default::default()
    };
    let agent = Agent::new(config).expect("agent");
    let (handler, events, done) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/timeout".to_string(),
        method: Method::Get,
        headers: Default::default(),
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout waiting for timeout error");

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].contains("timeout"));
}
```text

## File Structure

```text
packages/core/
├── Cargo.toml              # Add tokio-util
├── src/
│   ├── dispatcher.rs       # Add PauseState, RequestController
│   └── agent.rs            # Update dispatch() to return controller
└── tests/
    └── backpressure.rs     # NEW: Abort, pause, timeout tests
```text

## Verification

```bash
cd packages/core
cargo test
```text

Expected output:

```text
test agent_dispatch::test_get_200_ok ... ok
test agent_dispatch::test_network_error ... ok
test agent_dispatch::test_multi_value_headers ... ok
test backpressure::test_abort_before_response ... ok
test backpressure::test_abort_during_streaming ... ok
test backpressure::test_pause_resume_backpressure ... ok
test backpressure::test_timeout ... ok
```text
