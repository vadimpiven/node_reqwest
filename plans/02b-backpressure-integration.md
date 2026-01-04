# Backpressure Integration + Tests (Chunk 2B)

**Part**: 2 of 6 (Core Backpressure)  
**Chunk**: 2B of 2  
**Time**: 1.5 hours  
**Prerequisites**: Chunk 2A complete (backpressure types compile)

## Goal

Wire `RequestController` into request execution with `select!` macro and
add 4 comprehensive backpressure tests.

## Update Agent (packages/core/src/agent.rs)

Replace the existing `dispatch()` and `execute_request()` methods:

```rust
// ADD this import
use tokio::select;

impl Agent {
    /// Dispatch a request. Returns controller for abort/pause/resume.
    pub fn dispatch(
        &self,
        runtime: tokio::runtime::Handle,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
    ) -> RequestController {                                    // CHANGED: now returns controller
        let controller = RequestController::new();              // NEW
        let client = self.client.clone();
        let token = controller.token();                         // NEW
        let pause_state = controller.pause_state();             // NEW

        runtime.spawn(async move {
            Self::execute_request(client, options, handler, token, pause_state).await;  // CHANGED
        });

        controller                                              // NEW
    }

    async fn execute_request(
        client: Client,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
        token: CancellationToken,                               // NEW param
        pause_state: Arc<PauseState>,                           // NEW param
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

        // Send request with cancellation support --- CHANGED
        let response = select! {
            () = token.cancelled() => {
                handler.on_response_error(DispatchError::Aborted).await;
                return;
            }
            result = request.send() => {
                match result {
                    Ok(resp) => resp,
                    Err(e) if e.is_timeout() => {              // NEW: detect timeouts
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

        // Extract headers (unchanged)
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

        // Stream body with backpressure --- CHANGED
        let mut stream = response.bytes_stream();
        loop {
            // Block if paused - core backpressure mechanism
            pause_state.wait_if_paused().await;                 // NEW

            select! {                                            // CHANGED: wrap in select
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
```

## Tests (packages/core/tests/backpressure.rs)

Create new test file:

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
```

## File Structure

```text
packages/core/
├── src/
│   └── agent.rs            # UPDATED: dispatch() returns controller
└── tests/
    └── backpressure.rs     # NEW: 4 backpressure tests
```

## Verification

```bash
cd packages/core
cargo test
```

**Expected output:**

```text
running 7 tests
test agent_dispatch::test_get_200_ok ... ok
test agent_dispatch::test_network_error ... ok
test agent_dispatch::test_multi_value_headers ... ok
test backpressure::test_abort_before_response ... ok
test backpressure::test_abort_during_streaming ... ok
test backpressure::test_pause_resume_backpressure ... ok
test backpressure::test_timeout ... ok

test result: ok. 7 passed; 0 failed
```

## Milestone Checklist

- [ ] `Agent::dispatch()` returns `RequestController`
- [ ] `execute_request()` respects cancellation token
- [ ] `wait_if_paused()` blocks data streaming
- [ ] Timeout detection with `is_timeout()`
- [ ] All 7 tests pass (3 from Part 1 + 4 new)
- [ ] Ready for Part 3 (error handling)

## Next Steps

Once all tests pass:

1. Celebrate! Part 2 complete 🎉
2. Move to **Chunk 3A** (`03a-core-errors.md`)
3. Define comprehensive error types

## Design Notes

- **select! macro**: Enables concurrent abort and streaming
- **Backpressure point**: `wait_if_paused()` blocks before each chunk read
- **No unbounded queues**: Pause blocks at source (reqwest stream)
- **Timeout handling**: Distinguishes timeout from other network errors
