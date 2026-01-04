# Request Execution + Tests (Chunk 1B)

**Part**: 1 of 6 (Core Foundation)  
**Chunk**: 1B of 2  
**Time**: 1.5 hours  
**Prerequisites**: Chunk 1A complete (types compile)

## Goal

Implement HTTP request/response execution with wiremock integration tests.
Verify basic GET requests, error handling, and multi-value headers work correctly.

## Add Test Dependency

```toml
# packages/core/Cargo.toml
[dev-dependencies]
wiremock = { workspace = true }

# Root Cargo.toml
[workspace.dependencies]
wiremock = "0.6"
```

## Update Agent (packages/core/src/agent.rs)

Add dispatch method and execution logic:

```rust
// ADD these imports at top
use crate::dispatcher::*;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;

impl Agent {
    /// Dispatch a request. Spawns async task on provided runtime.
    pub fn dispatch(
        &self,
        runtime: tokio::runtime::Handle,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
    ) {
        let client = self.client.clone();
        runtime.spawn(async move {
            Self::execute_request(client, options, handler).await;
        });
    }

    async fn execute_request(
        client: Client,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
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

        // Send request
        let response = match request.send().await {
            Ok(resp) => resp,
            Err(e) => {
                handler.on_response_error(DispatchError::Network(e.to_string())).await;
                return;
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

        // Stream body
        let mut stream = response.bytes_stream();
        loop {
            match stream.next().await {
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
```

## Test Utilities (packages/core/tests/support/mod.rs)

```rust
pub mod mock_handler;
```

## Mock Handler (packages/core/tests/support/mock_handler.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use async_trait::async_trait;
use bytes::Bytes;
use core::{DispatchError, DispatchHandler, ResponseStart};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

#[derive(Debug, Default)]
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

    async fn on_response_error(&self, error: DispatchError) {
        self.events.lock().await.errors.push(error.to_string());
        self.done.notify_one();
    }
}
```

## Tests (packages/core/tests/agent_dispatch.rs)

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
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout waiting for request");

    let events = events.lock().await;
    assert_eq!(events.response_starts.len(), 1);
    assert_eq!(events.response_starts[0].status_code, 200);
    assert_eq!(events.data_chunks.len(), 1);
    assert_eq!(&events.data_chunks[0][..], b"hello");
    assert_eq!(events.response_ends.len(), 1);
    assert!(events.errors.is_empty());
}

#[tokio::test]
async fn test_network_error() {
    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some("http://127.0.0.1:1".to_string()), // Unreachable port
        path: "/".to_string(),
        method: Method::Get,
        headers: Default::default(),
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout waiting for error");

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].contains("Network error"));
}

#[tokio::test]
async fn test_multi_value_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/headers"))
        .respond_with(
            ResponseTemplate::new(200)
                .append_header("set-cookie", "a=1")
                .append_header("set-cookie", "b=2")
        )
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/headers".to_string(),
        method: Method::Get,
        headers: Default::default(),
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout");

    let events = events.lock().await;
    let set_cookie = events.response_starts[0].headers.get("set-cookie");
    assert!(set_cookie.is_some());
    assert_eq!(set_cookie.unwrap().len(), 2);
}
```

## File Structure

```text
packages/core/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── dispatcher.rs
│   └── agent.rs           # UPDATED: Added dispatch() and execute_request()
└── tests/
    ├── support/
    │   ├── mod.rs         # NEW
    │   └── mock_handler.rs# NEW
    └── agent_dispatch.rs  # NEW
```

## Verification

```bash
cd packages/core
cargo test
```

**Expected output:**

```text
running 3 tests
test agent_dispatch::test_get_200_ok ... ok
test agent_dispatch::test_network_error ... ok
test agent_dispatch::test_multi_value_headers ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

## Milestone Checklist

- [ ] `Agent::dispatch()` spawns async task
- [ ] `execute_request()` handles successful responses
- [ ] Network errors propagate to `on_response_error()`
- [ ] Multi-value headers are collected correctly
- [ ] All 3 tests pass
- [ ] Ready for Part 2 (backpressure)

## Next Steps

Once all tests pass:

1. Celebrate! Part 1 is complete 🎉
2. Move to **Chunk 2A** (`02a-pause-cancellation.md`)
3. Add backpressure primitives

## Design Notes

- **Task spawning**: Uses provided tokio runtime handle
- **Streaming**: Uses reqwest's `bytes_stream()`
- **No backpressure yet**: Request runs to completion
- **Error handling**: Basic - will enhance in Part 3
