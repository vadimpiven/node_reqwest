# Backpressure Integration + Tests (Chunk 2B)

## Problem/Purpose

Integrate the `RequestController` into the request execution flow to enable real-time
control over aborts and backpressure.

## Solution

Modify `Agent::dispatch` and `execute_request` to verify cancellation tokens via
`tokio::select!` and block data streaming using `PauseState::wait_if_paused`.

## Architecture

```text
Agent::execute_request
  ├─ select! 
  │    ├─ token.cancelled() -> return DispatchError::Aborted
  │    └─ request.send() -> proceed
  └─ loop
       ├─ pause_state.wait_if_paused() -> block if signal set
       └─ select!
            ├─ token.cancelled() -> return DispatchError::Aborted
            └─ stream.next() -> process chunk
```

## Implementation

### packages/core/src/agent.rs

```rust
use tokio::select;

impl Agent {
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

        let url = format!("{}{}", options.origin.as_deref().unwrap_or(""), options.path);
        let mut request = client.request(method, &url);

        for (key, values) in &options.headers {
            for value in values {
                request = request.header(key.as_str(), value.as_str());
            }
        }

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
        loop {
            pause_state.wait_if_paused().await;
            select! {
                () = token.cancelled() => {
                    handler.on_response_error(DispatchError::Aborted).await;
                    return;
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(data)) => handler.on_response_data(data).await,
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

### packages/core/tests/backpressure.rs

```rust
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
    Mock::given(method("GET")).and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server).await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()), path: "/slow".to_string(),
        method: Method::Get, headers: Default::default(),
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
    Mock::given(method("GET")).and(path("/large"))
        .respond_with(ResponseTemplate::new(200).set_body_string(large_body))
        .mount(&server).await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()), path: "/large".to_string(),
        method: Method::Get, headers: Default::default(),
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    tokio::time::sleep(Duration::from_millis(100)).await;
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
    Mock::given(method("GET")).and(path("/data"))
        .respond_with(ResponseTemplate::new(200).set_body_string("chunk1chunk2chunk3"))
        .mount(&server).await;

    let agent = Agent::new(AgentConfig::default()).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()), path: "/data".to_string(),
        method: Method::Get, headers: Default::default(),
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    controller.pause();
    assert!(controller.pause_state().is_paused());
    tokio::time::sleep(Duration::from_millis(100)).await;
    controller.resume();
    assert!(!controller.pause_state().is_paused());
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.response_starts.len(), 1);
    assert!(!events.data_chunks.is_empty());
    assert_eq!(events.response_ends.len(), 1);
}

#[tokio::test]
async fn test_timeout() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).and(path("/timeout"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server).await;

    let config = AgentConfig {
        timeout: Some(Duration::from_millis(100)),
        ..Default::default()
    };
    let agent = Agent::new(config).expect("agent");
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()), path: "/timeout".to_string(),
        method: Method::Get, headers: Default::default(),
    };

    agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    done.notified().await;

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].contains("timeout"));
}
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Abort Control** | `CancellationToken` |
| **Backpressure Control** | `AtomicBool` + `Notify` |
| **Est. Test Run** | < 5 seconds |

## File Structure

```text
packages/core/
├── src/
│   └── agent.rs
└── tests/
    └── backpressure.rs
```
