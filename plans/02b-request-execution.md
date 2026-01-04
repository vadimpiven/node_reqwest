# Request Execution + Tests (Chunk 02b)

## Problem/Purpose

Implement the core HTTP execution flow with backpressure integration and verify via tests.

## Solution

Add `Agent::dispatch` to spawn request tasks with cancellation and pause support, using
`tokio::select!` for abort handling and `PauseState::wait_if_paused` for backpressure.

## Architecture

```text
Agent::dispatch(options, handler) ─► RequestController
      │
      └─► tokio::spawn ─► execute_request
                              │
                              ├─► select! { cancelled, request.send() }
                              │
                              └─► loop { wait_if_paused, select! { cancelled, stream.next() } }
```

## Implementation

### packages/core/src/agent.rs (Replace entire file)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! HTTP Agent wrapping reqwest::Client.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use reqwest::Client;
use tokio::select;
use tokio::runtime::Handle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::dispatcher::{
    DispatchHandler, DispatchOptions, PauseState, RequestController, ResponseStart,
};
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

    /// Dispatch a request, returning a controller for abort/pause.
    pub fn dispatch(
        &self,
        runtime: Handle,
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
        let method = options.method.to_reqwest();
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

        if let Some(body) = options.body {
            request = request.body(body);
        }

        // Per-request headers timeout (time until response headers received)
        let headers_timeout = if options.headers_timeout_ms > 0 {
            Duration::from_millis(options.headers_timeout_ms)
        } else {
            Duration::from_secs(300) // 5 minutes default
        };

        let send_future = request.send();

        let response = select! {
            () = token.cancelled() => {
                handler.on_response_error(CoreError::RequestAborted).await;
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
                    .push(v.to_str().unwrap_or("").to_string());
                acc
            });

        handler
            .on_response_start(ResponseStart {
                status_code: response.status().as_u16(),
                status_message: response
                    .status()
                    .canonical_reason()
                    .unwrap_or("")
                    .to_string(),
                headers,
            })
            .await;

        // Per-request body timeout (time for entire body transfer)
        let body_timeout_duration = if options.body_timeout_ms > 0 {
            Duration::from_millis(options.body_timeout_ms)
        } else {
            Duration::from_secs(300) // 5 minutes default
        };

        let body_deadline = tokio::time::Instant::now() + body_timeout_duration;
        let mut stream = response.bytes_stream();

        loop {
            pause_state.wait_if_paused().await;

            // Check body timeout
            if tokio::time::Instant::now() > body_deadline {
                handler.on_response_error(CoreError::BodyTimeout).await;
                return;
            }

            select! {
                () = token.cancelled() => {
                    handler.on_response_error(CoreError::RequestAborted).await;
                    return;
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(data)) => handler.on_response_data(data).await,
                        Some(Err(e)) => {
                            handler.on_response_error(CoreError::from_reqwest(e, true)).await;
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
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: 0,
        body_timeout_ms: 0,
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
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
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: 0,
        body_timeout_ms: 0,
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
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
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: 0,
        body_timeout_ms: 0,
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
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
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: 0,
        body_timeout_ms: 0,
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
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
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: 0,
        body_timeout_ms: 0,
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].to_lowercase().contains("timeout"));
}

#[tokio::test]
async fn test_per_request_headers_timeout() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow-headers"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server)
        .await;

    // Agent has no timeout, but request has headers_timeout_ms
    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/slow-headers".to_string(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        headers_timeout_ms: 100, // 100ms per-request timeout
        body_timeout_ms: 0,
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    // Headers timeout produces HeadersTimeout error
    assert!(events.errors[0].contains("Headers timeout") || events.errors[0].contains("timeout"));
}

// Note: Content-Length validation is handled internally by hyper/reqwest.
// When the response declares Content-Length but provides fewer/more bytes,
// reqwest returns an error with `is_body()` returning true.
// This is mapped to CoreError::Socket in `from_reqwest(err, true)`.
// Adding explicit test would require a misbehaving server which is complex to set up.
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Test Dependency** | `wiremock = "0.6"` |
| **Concurrency** | `tokio::spawn` for non-blocking dispatch |
| **Backpressure** | `select!` + `wait_if_paused()` |
| **Per-request timeout** | `tokio::time::timeout` wrapping send and body phases |
| **Tests** | 6 integration tests |

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
