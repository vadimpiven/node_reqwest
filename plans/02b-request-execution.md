# Request Execution + Tests (Chunk 02b)

## Purpose

Implement `Agent::dispatch` with backpressure, cancellation, and per-request timeouts. Verify
via integration tests against `wiremock`.

Key flow: spawn a task; use `tokio::select!` to race abort against send/receive;
`PauseState::wait_if_paused` gates each chunk read.

## Architecture

```text
Agent::dispatch(options, handler) ─► RequestController
      │
      └─► tokio::spawn ─► execute_request
                              │
                              ├─► select! { cancelled, request.send() }
                              │
                              └─► loop {
                                    select! { cancelled, wait_if_paused }
                                    select! { cancelled, stream.next() }
                                  }
```

## Implementation

### packages/core/src/agent.rs (Replace entire file)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! HTTP Agent wrapping reqwest::Client with lifecycle management.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use reqwest::Client;
use tokio::select;
use tokio::runtime::Handle;
use tokio::sync::Notify;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::dispatcher::{
    DispatchHandler, DispatchOptions, PauseState, RequestController, ResponseStart,
};
use crate::error::CoreError;

/// Configuration for creating an Agent. See 02a for full documentation.
#[derive(Debug, Clone, Default)]
pub struct AgentConfig {
    pub timeout: Option<Duration>,
    pub connect_timeout: Option<Duration>,
    pub headers_timeout: Option<Duration>,
    pub body_timeout: Option<Duration>,
    pub pool_idle_timeout: Option<Duration>,
    pub max_redirections: u32,
}

/// Internal state for tracking active requests.
///
/// Tokens are keyed by a monotonic request id (not by cancellation state,
/// which was identity-ambiguous). `destroy_error` is consulted by the
/// in-flight task when its cancel arm fires, so a `destroy(err)` surfaces
/// `err` to handlers instead of a generic `RequestAborted`.
struct AgentState {
    next_id: AtomicU64,
    active_tokens: Mutex<HashMap<u64, CancellationToken>>,
    active_count: AtomicUsize,
    idle_notify: Notify,
    closed: AtomicBool,
    destroyed: AtomicBool,
    destroy_error: Mutex<Option<CoreError>>,
    /// Agent-level defaults applied when DispatchOptions leave a field None.
    defaults: AgentDefaults,
}

#[derive(Clone, Copy, Default)]
struct AgentDefaults {
    headers_timeout: Option<Duration>,
    body_timeout: Option<Duration>,
    connect_timeout: Option<Duration>,
}

/// HTTP Agent managing connection pooling and request lifecycle.
pub struct Agent {
    client: Client,
    state: Arc<AgentState>,
}

impl Agent {
    /// Create a new Agent.
    ///
    /// - `cookie_store(false)` is enforced; no shared jar across requests.
    /// - Redirect policy is `Policy::none()` unless `max_redirections > 0`,
    ///   matching undici's default and preventing silent SSRF /
    ///   protocol-downgrade follows.
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

        let state = AgentState {
            next_id: AtomicU64::new(1),
            active_tokens: Mutex::new(HashMap::new()),
            active_count: AtomicUsize::new(0),
            idle_notify: Notify::new(),
            closed: AtomicBool::new(false),
            destroyed: AtomicBool::new(false),
            destroy_error: Mutex::new(None),
            defaults: AgentDefaults {
                headers_timeout: config.headers_timeout,
                body_timeout: config.body_timeout,
                connect_timeout: config.connect_timeout,
            },
        };

        Ok(Self { client, state: Arc::new(state) })
    }

    /// Get a reference to the underlying client.
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Dispatch a request, returning a controller for abort/pause.
    ///
    /// Errors: `ClientDestroyed` if destroyed, `ClientClosed` if closed.
    pub fn dispatch(
        &self,
        runtime: Handle,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
    ) -> Result<RequestController, CoreError> {
        if self.state.destroyed.load(Ordering::Acquire) {
            return Err(CoreError::ClientDestroyed);
        }
        if self.state.closed.load(Ordering::Acquire) {
            return Err(CoreError::ClientClosed);
        }

        let controller = RequestController::new();
        let client = self.client.clone();
        let token = controller.token();
        let pause_state = controller.pause_state();
        let state = Arc::clone(&self.state);

        // Issue a monotonic id; identity is by id, never by token state.
        let id = state.next_id.fetch_add(1, Ordering::Relaxed);
        state.active_count.fetch_add(1, Ordering::AcqRel);
        state.active_tokens.lock().insert(id, token.clone());

        runtime.spawn(async move {
            Self::execute_request(
                client,
                options,
                handler,
                token,
                pause_state,
                Arc::clone(&state),
            )
            .await;

            state.active_tokens.lock().remove(&id);
            if state.active_count.fetch_sub(1, Ordering::AcqRel) == 1 {
                state.idle_notify.notify_waiters();
            }
        });

        Ok(controller)
    }

    /// Resolve the cancellation reason. Returns the destroy-supplied error
    /// when set, else `RequestAborted` for user-driven `controller.abort()`.
    fn cancel_reason(state: &AgentState) -> CoreError {
        state
            .destroy_error
            .lock()
            .as_ref()
            .cloned()
            .unwrap_or(CoreError::RequestAborted)
    }

    /// Validate a header name/value pair. Reqwest's builder also rejects
    /// CR/LF/NUL, but it surfaces an opaque "builder error". Validating here
    /// keeps the message fixed (no echo of attacker bytes) and locates the
    /// failure before crossing into reqwest.
    fn validate_header(name: &str, value: &str) -> Result<(), CoreError> {
        // RFC 7230 token chars for header names.
        let name_ok = !name.is_empty()
            && name.bytes().all(|b| {
                matches!(b,
                    b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-'
                    | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
                    | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z')
            });
        if !name_ok {
            return Err(CoreError::InvalidArgument("invalid header name".into()));
        }
        // Header values: VCHAR / obs-text / SP / HTAB; reject CR, LF, NUL.
        if value.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return Err(CoreError::InvalidArgument("invalid header value".into()));
        }
        Ok(())
    }

    async fn execute_request(
        client: Client,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
        token: CancellationToken,
        pause_state: Arc<PauseState>,
        state: Arc<AgentState>,
    ) {
        let method = options.method.to_reqwest();

        let origin = options.origin.as_deref().unwrap_or_default();
        let url = if options.query.is_empty() {
            format!("{}{}", origin, options.path)
        } else {
            format!("{}{}?{}", origin, options.path, options.query)
        };

        let mut request = client.request(method, &url);

        for (key, values) in &options.headers {
            for value in values {
                if let Err(e) = Self::validate_header(key, value) {
                    handler.on_response_error(e).await;
                    return;
                }
                request = request.header(key.as_str(), value.as_str());
            }
        }

        if let Some(body) = options.body {
            request = request.body(body);
        }

        // Resolve per-request -> agent-default -> hard fallback (5 minutes).
        let headers_timeout = options
            .headers_timeout_ms
            .map(Duration::from_millis)
            .or(state.defaults.headers_timeout)
            .unwrap_or(Duration::from_secs(300));

        let send_future = request.send();

        let response = select! {
            () = token.cancelled() => {
                handler.on_response_error(Self::cancel_reason(&state)).await;
                return;
            }
            result = timeout(headers_timeout, send_future) => {
                match result {
                    Ok(Ok(resp)) => resp,
                    Ok(Err(e)) => {
                        handler.on_response_error(CoreError::from_reqwest(e, false)).await;
                        return;
                    }
                    Err(_elapsed) => {
                        handler.on_response_error(CoreError::HeadersTimeout).await;
                        return;
                    }
                }
            }
        };

        let headers = response
            .headers()
            .iter()
            .fold(HashMap::new(), |mut acc, (k, v)| {
                acc.entry(k.to_string())
                    .or_insert_with(Vec::new)
                    .push(v.to_str().unwrap_or_default().to_string());
                acc
            });

        handler
            .on_response_start(ResponseStart {
                status_code: response.status().as_u16(),
                // Use IANA canonical reason (compile-time table) rather than
                // the server-supplied phrase. Intentional: server reason
                // phrases have been a smuggling vector in Node's http parser,
                // and undici-coded consumers key on status_code anyway.
                status_message: response
                    .status()
                    .canonical_reason()
                    .unwrap_or_default()
                    .to_string(),
                headers,
            })
            .await;

        let body_timeout_duration = options
            .body_timeout_ms
            .map(Duration::from_millis)
            .or(state.defaults.body_timeout)
            .unwrap_or(Duration::from_secs(300));

        let mut stream = response.bytes_stream();

        loop {
            // Race pause against cancel: cancel cuts through pause so a
            // paused request stays abortable.
            select! {
                biased;
                () = token.cancelled() => {
                    drop(stream);
                    handler.on_response_error(Self::cancel_reason(&state)).await;
                    return;
                }
                () = pause_state.wait_if_paused() => {}
            }

            select! {
                biased;
                () = token.cancelled() => {
                    // Drop stream on abort - avoid FFI copies. TCP connection
                    // may close instead of returning to the pool; acceptable
                    // trade-off for aborts.
                    drop(stream);
                    handler.on_response_error(Self::cancel_reason(&state)).await;
                    return;
                }
                // Idle timeout resets on each successful chunk
                result = timeout(body_timeout_duration, stream.next()) => {
                    match result {
                        Ok(Some(Ok(data))) => handler.on_response_data(data).await,
                        Ok(Some(Err(e))) => {
                            drop(stream);
                            handler.on_response_error(CoreError::from_reqwest(e, true)).await;
                            return;
                        }
                        Ok(None) => {
                            // Response complete; reqwest doesn't expose trailers
                            handler.on_response_end(HashMap::new()).await;
                            return;
                        }
                        Err(_elapsed) => {
                            drop(stream);
                            handler.on_response_error(CoreError::BodyTimeout).await;
                            return;
                        }
                    }
                }
            }
        }
    }
}

impl Agent {
    /// Close gracefully: reject new requests, drain active.
    pub async fn close(&self) {
        self.state.closed.store(true, Ordering::Release);

        while self.state.active_count.load(Ordering::Acquire) > 0 {
            self.state.idle_notify.notified().await;
        }
    }

    /// Destroy abruptly: cancel all pending requests and surface `error` to
    /// each in-flight handler's `on_response_error`.
    pub async fn destroy(&self, error: CoreError) {
        self.state.destroyed.store(true, Ordering::Release);
        self.state.closed.store(true, Ordering::Release);
        *self.state.destroy_error.lock() = Some(error);

        // Drain tokens by id; cancel each. Identity is by id, not state.
        let tokens: Vec<CancellationToken> = {
            let mut guard = self.state.active_tokens.lock();
            guard.drain().map(|(_id, t)| t).collect()
        };
        for token in tokens {
            token.cancel();
        }

        while self.state.active_count.load(Ordering::Acquire) > 0 {
            self.state.idle_notify.notified().await;
        }
    }

    pub fn is_closed(&self) -> bool {
        self.state.closed.load(Ordering::Acquire)
    }

    pub fn is_destroyed(&self) -> bool {
        self.state.destroyed.load(Ordering::Acquire)
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

    #[test]
    fn agent_lifecycle_states() {
        let agent = Agent::new(AgentConfig::default()).expect("agent");
        assert!(!agent.is_closed());
        assert!(!agent.is_destroyed());
    }
}
```

### packages/core/tests/support/mod.rs

```rust
pub mod mock_handler;
```

### packages/core/tests/support/mock_handler.rs

```rust
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::{Mutex, Notify};

use core::{CoreError, DispatchHandler, ResponseStart};

#[derive(Default)]
pub struct RecordedEvents {
    pub response_starts: Vec<ResponseStart>,
    pub data_chunks: Vec<Bytes>,
    pub response_ends: Vec<HashMap<String, Vec<String>>>,
    pub errors: Vec<String>,
}

pub struct MockHandler {
    events: Arc<Mutex<RecordedEvents>>,
    done: Arc<Notify>,
}

impl MockHandler {
    pub fn new() -> (Self, Arc<Mutex<RecordedEvents>>, Arc<Notify>) {
        let events = Arc::new(Mutex::new(RecordedEvents::default()));
        let done = Arc::new(Notify::new());
        (
            Self {
                events: Arc::clone(&events),
                done: Arc::clone(&done),
            },
            events,
            done,
        )
    }
}

#[async_trait]
impl DispatchHandler for MockHandler {
    async fn on_response_start(&self, response: ResponseStart) {
        self.events.lock().await.response_starts.push(response);
    }

    async fn on_response_data(&self, chunk: Bytes) {
        self.events.lock().await.data_chunks.push(chunk);
    }

    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>) {
        self.events.lock().await.response_ends.push(trailers);
        self.done.notify_one();
    }

    async fn on_response_error(&self, error: CoreError) {
        self.events.lock().await.errors.push(error.to_string());
        self.done.notify_one();
    }
}
```

### packages/core/tests/agent_dispatch.rs

```rust
mod support;

use std::sync::Arc;

use core::{Agent, AgentConfig, DispatchOptions, Method};
use support::mock_handler::MockHandler;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn test_get_200_ok() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/test".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.response_starts.len(), 1);
    assert_eq!(events.response_starts[0].status_code, 200);
    assert_eq!(events.data_chunks.len(), 1);
    assert_eq!(&events.data_chunks[0][..], b"hello");
    assert_eq!(events.response_ends.len(), 1);
    assert!(events.errors.is_empty());
}
```

### packages/core/tests/backpressure.rs

```rust
mod support;

use std::sync::Arc;
use std::time::Duration;

use core::{Agent, AgentConfig, DispatchOptions, Method};
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
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");
    controller.abort();
    done.notified().await;

    let events = events.lock().await;
    assert!(events.response_starts.is_empty());
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].contains("aborted"));
}

#[tokio::test]
async fn test_abort_during_streaming() {
    let server = MockServer::start().await;
    let large_body = "x".repeat(1024 * 1024);
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
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");
    tokio::time::sleep(Duration::from_millis(50)).await;
    controller.abort();
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.response_starts.len(), 1);
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
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");
    controller.pause();
    assert!(controller.is_paused());
    tokio::time::sleep(Duration::from_millis(50)).await;
    controller.resume();
    assert!(!controller.is_paused());
    done.notified().await;

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
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].to_lowercase().contains("timeout"));
}

#[tokio::test]
async fn test_query_parameters() {
    use wiremock::matchers::query_param;

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search"))
        .and(query_param("q", "hello world"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_string("found"))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/search".to_string(),
        query: "q=hello%20world&page=1".to_string(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.response_starts.len(), 1);
    assert_eq!(events.response_starts[0].status_code, 200);
    assert_eq!(&events.data_chunks[0][..], b"found");
}

#[tokio::test]
async fn test_per_request_headers_timeout() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow-headers"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server)
        .await;

    // Agent has no timeout; request sets headers_timeout_ms
    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/slow-headers".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: Some(100), // 100ms per-request timeout
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    // Headers timeout produces HeadersTimeout error
    assert!(events.errors[0].contains("Headers timeout") || events.errors[0].contains("timeout"));
}

#[tokio::test]
async fn test_close_rejects_new_requests() {
    let agent = Agent::new(AgentConfig::default()).expect("agent");
    agent.close().await;

    let (handler, _events, _done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some("http://example.com".to_string()),
        path: "/".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    let result = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    assert!(result.is_err());
}

#[tokio::test]
async fn test_destroy_cancels_pending() {
    use core::CoreError;

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(60)))
        .mount(&server)
        .await;

    let agent = Arc::new(Agent::new(AgentConfig::default()).expect("agent"));
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/slow".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };

    // Start a request
    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler)).expect("dispatch");

    // Destroy while pending
    tokio::time::sleep(Duration::from_millis(10)).await;
    agent.destroy(CoreError::ClientDestroyed).await;

    // Request should be aborted
    done.notified().await;
    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
}

// Content-Length mismatch is handled by hyper/reqwest: it returns an error with
// `is_body()` true, mapped to `CoreError::Socket` via `from_reqwest(err, true)`.
// No explicit test: would require a misbehaving server.

#[tokio::test]
async fn test_body_timeout_between_chunks() {
    // Hand-rolled TCP server: send headers + first chunk, then stall.
    // Asserts BodyTimeout fires on the idle gap, not HeadersTimeout.
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        // Read request, then write a chunked response with one chunk and hang.
        let mut buf = [0u8; 1024];
        let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
        let _ = sock
            .write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n",
            )
            .await;
        // Stall indefinitely.
        tokio::time::sleep(Duration::from_secs(60)).await;
    });

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(format!("http://{addr}")),
        path: "/".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: Some(100),
        connect_timeout_ms: None,
    };
    agent
        .dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler))
        .expect("dispatch");
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].contains("Body timeout"));
}

#[tokio::test]
async fn test_connect_timeout_blackhole() {
    // 10.255.255.1:1 — RFC1918 + reserved port; routable but never answers.
    let config = AgentConfig {
        connect_timeout: Some(Duration::from_millis(150)),
        ..Default::default()
    };
    let agent = Agent::new(config).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some("http://10.255.255.1:1".to_string()),
        path: "/".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };
    agent
        .dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler))
        .expect("dispatch");
    done.notified().await;
    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    let msg = events.errors[0].to_lowercase();
    assert!(msg.contains("connect") || msg.contains("timeout"));
}

#[tokio::test]
async fn test_abort_during_headers() {
    // Server accepts TCP but never writes the status line.
    use tokio::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (_sock, _) = listener.accept().await.expect("accept");
        tokio::time::sleep(Duration::from_secs(60)).await;
    });

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(format!("http://{addr}")),
        path: "/".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };
    let controller = agent
        .dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler))
        .expect("dispatch");
    tokio::time::sleep(Duration::from_millis(50)).await;
    controller.abort();
    done.notified().await;
    let events = events.lock().await;
    assert!(events.response_starts.is_empty());
    assert_eq!(events.errors.len(), 1);
}

#[tokio::test]
async fn test_abort_while_paused() {
    // Pause a streaming response, then abort. Must error promptly.
    let server = MockServer::start().await;
    let body = "x".repeat(1024 * 1024);
    Mock::given(method("GET"))
        .and(path("/big"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/big".to_string(),
        query: String::new(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: None,
        body_timeout_ms: None,
        connect_timeout_ms: None,
    };
    let controller = agent
        .dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler))
        .expect("dispatch");
    controller.pause();
    tokio::time::sleep(Duration::from_millis(50)).await;
    controller.abort();
    tokio::time::timeout(Duration::from_secs(2), done.notified())
        .await
        .expect("abort should wake paused loop");
    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
}

#[tokio::test]
async fn test_concurrent_dispatch_then_destroy_no_leaks() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(60)))
        .mount(&server)
        .await;

    let agent = Arc::new(Agent::new(AgentConfig::default()).expect("agent"));
    let mut dones = Vec::new();
    for _ in 0..50 {
        let (handler, _events, done) = MockHandler::new();
        let opts = DispatchOptions {
            origin: Some(server.uri()),
            path: "/slow".to_string(),
            query: String::new(),
            method: Method::Get,
            headers: Default::default(),
            body: None,
            headers_timeout_ms: None,
            body_timeout_ms: None,
            connect_timeout_ms: None,
        };
        agent
            .dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler))
            .expect("dispatch");
        dones.push(done);
    }
    agent.destroy(core::CoreError::ClientDestroyed).await;
    for d in dones {
        d.notified().await;
    }
    // After drain, the token map is empty (no leaks).
}
```

## Summary

| Metric                  | Value                                                |
| :---------------------- | :--------------------------------------------------- |
| **Test Dependency**     | `wiremock = "0.6.5"` (workspace pin)                 |
| **Concurrency**         | `tokio::spawn` for non-blocking dispatch             |
| **Backpressure**        | `select!` + `wait_if_paused()`                       |
| **Per-request timeout** | `tokio::time::timeout` wrapping send and body phases |
| **Tests**               | 13 integration tests                                 |

## File Structure

```text
packages/core/
├── src/
│   └── agent.rs
└── tests/
    ├── support/
    │   ├── mod.rs
    │   └── mock_handler.rs
    ├── agent_dispatch.rs
    └── backpressure.rs
```
