# Request Execution + Tests (Chunk 1B)

## Problem/Purpose

Implement the core HTTP execution flow and provide verification via integration tests.

## Solution

Add `Agent::dispatch` to spawn request tasks and `execute_request` to handle the
`reqwest` lifecycle and callback marshaling.

## Architecture

```text
Agent::dispatch (Handle)
  └─ tokio::spawn (Async Task)
       └─ execute_request
            ├─ reqwest::Request -> send()
            └─ response.bytes_stream() -> on_response_data()
```

## Implementation

### packages/core/Cargo.toml

```toml
[dev-dependencies]
wiremock = { workspace = true }
```

### packages/core/src/agent.rs

```rust
use crate::dispatcher::*;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;

impl Agent {
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

        let url = format!("{}{}", options.origin.as_deref().unwrap_or(""), options.path);
        let mut request = client.request(method, &url);

        for (key, values) in &options.headers {
            for value in values {
                request = request.header(key.as_str(), value.as_str());
            }
        }

        let response = match request.send().await {
            Ok(resp) => resp,
            Err(e) => {
                handler.on_response_error(DispatchError::Network(e.to_string())).await;
                return;
            }
        };

        let headers = response.headers().iter().fold(HashMap::new(), |mut acc, (k, v)| {
            acc.entry(k.to_string()).or_insert_with(Vec::new).push(v.to_str().unwrap_or("").to_string());
            acc
        });

        handler.on_response_start(ResponseStart {
            status_code: response.status().as_u16(),
            status_message: response.status().canonical_reason().unwrap_or("").to_string(),
            headers,
        }).await;

        let mut stream = response.bytes_stream();
        while let Some(item) = stream.next().await {
            match item {
                Ok(data) => handler.on_response_data(data).await,
                Err(e) => {
                    handler.on_response_error(DispatchError::Network(e.to_string())).await;
                    return;
                }
            }
        }
        handler.on_response_end(HashMap::new()).await;
    }
}
```

### packages/core/tests/support/mod.rs

```rust
pub mod mock_handler;
```

### packages/core/tests/support/mock_handler.rs

```rust
use async_trait::async_trait;
use bytes::Bytes;
use core::{DispatchError, DispatchHandler, ResponseStart};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

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
        (Self { events: Arc::clone(&events), done: Arc::clone(&done) }, events, done)
    }
}

#[async_trait]
impl DispatchHandler for MockHandler {
    async fn on_response_start(&self, response: ResponseStart) { self.events.lock().await.response_starts.push(response); }
    async fn on_response_data(&self, chunk: Bytes) { self.events.lock().await.data_chunks.push(chunk); }
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

### packages/core/tests/agent_dispatch.rs

```rust
mod support;
use core::{Agent, AgentConfig, DispatchOptions, Method};
use std::sync::Arc;
use support::mock_handler::MockHandler;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn test_get_200_ok() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).and(path("/test"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&server).await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()), path: "/test".to_string(),
        method: Method::Get, headers: Default::default(),
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

## Tables

| Metric | Value |
| :--- | :--- |
| **Dependency** | `wiremock` (for testing) |
| **Concurrency** | `tokio::spawn` for non-blocking dispatch |
| **Est. Test Run** | < 5 seconds |

## File Structure

```text
packages/core/
├── src/
│   └── agent.rs
└── tests/
    ├── support/
    │   ├── mod.rs
    │   └── mock_handler.rs
    └── agent_dispatch.rs
```
