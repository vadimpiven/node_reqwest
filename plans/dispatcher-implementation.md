# Dispatcher Implementation

Implement undici `DispatchHandler` interface with `DispatchController` for pause/resume/abort.

## Solution

TypeScript creates `DispatchController`, Rust handles HTTP via reqwest with callbacks through
`neon::event::Channel`. Backpressure via `AtomicBool + Notify`, abort via `CancellationToken`.

## Architecture

```text
JS: AgentImpl.dispatch(opts, handler)
         ↓
    Create DispatchController ─────────────────────────┐
         ↓                                             │
    handler.onRequestStart(controller, context)        │
         ↓                                             │
    Rust: Addon.agentDispatch(agent, options, callbacks)
         ↓                                             │
    Response headers → onResponseStart()               │
         ↓                                             │
    Body chunks ←── pause/resume signals ──────────────┘
         ↓
    onResponseData() per chunk → onResponseEnd() or onResponseError()
```

## Implementation

### DispatchController (TypeScript)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from 'undici';

interface RequestHandle {
  abort(): void;
  pause(): void;
  resume(): void;
}

class DispatchControllerImpl implements Dispatcher.DispatchController {
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;
  #requestHandle: RequestHandle | null = null;

  get aborted() { return this.#aborted; }
  get paused() { return this.#paused; }
  get reason() { return this.#reason; }

  setRequestHandle(handle: RequestHandle): void {
    this.#requestHandle = handle;
  }

  abort(reason: Error): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason;
    this.#requestHandle?.abort();
  }

  pause(): void {
    if (!this.#paused) {
      this.#paused = true;
      this.#requestHandle?.pause();
    }
  }

  resume(): void {
    if (this.#paused) {
      this.#paused = false;
      this.#requestHandle?.resume();
    }
  }
}
```

### Addon Interface

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { IncomingHttpHeaders } from 'undici';

export type DispatchCallbacks = {
  onResponseStart: (statusCode: number, headers: IncomingHttpHeaders, statusMessage: string) => void;
  onResponseData: (chunk: Buffer) => void;
  onResponseEnd: (trailers: IncomingHttpHeaders) => void;
  onResponseError: (error: Error) => void;
};

agentDispatch(agent: AgentInstance, options: AgentDispatchOptions, callbacks: DispatchCallbacks): RequestHandle;
```

### Rust Implementation

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use futures::StreamExt;
use neon::prelude::*;
use tokio::{select, sync::Notify};
use tokio_util::sync::CancellationToken;

pub struct PauseState {
    paused: AtomicBool,
    notify: Notify,
}

impl PauseState {
    pub fn new() -> Self {
        Self { paused: AtomicBool::new(false), notify: Notify::new() }
    }

    pub async fn wait_if_paused(&self) {
        while self.paused.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }

    pub fn pause(&self) { self.paused.store(true, Ordering::SeqCst); }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.notify.notify_one();
    }
}

pub struct RequestHandle {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl RequestHandle {
    pub fn abort(&self) { self.token.cancel(); }
    pub fn pause(&self) { self.pause_state.pause(); }
    pub fn resume(&self) { self.pause_state.resume(); }
}

async fn stream_response_body(
    response: reqwest::Response,
    token: CancellationToken,
    pause_state: Arc<PauseState>,
    channel: Channel,
    on_response_data: Root<JsFunction>,
    on_response_end: Root<JsFunction>,
    on_response_error: Root<JsFunction>,
) {
    let mut stream = response.bytes_stream();

    loop {
        pause_state.wait_if_paused().await;

        select! {
            () = token.cancelled() => {
                let _ = channel.send(move |mut cx| {
                    let error = cx.error("Request aborted")?;
                    on_response_error.into_inner(&mut cx).call_with(&cx).arg(error).exec(&mut cx)
                }).await;
                return;
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(data)) => {
                        let chunk_vec = data.to_vec();
                        let _ = channel.send(move |mut cx| {
                            fn send_chunk(cx: &mut Cx<'_>, data: &[u8]) -> NeonResult<()> {
                                let _buffer = JsBuffer::from_slice(cx, data)?;
                                Ok(())
                            }
                            send_chunk(&mut cx, &chunk_vec)
                        }).await;
                    }
                    Some(Err(e)) => {
                        let error_msg = e.to_string();
                        let _ = channel.send(move |mut cx| {
                            let error = cx.error(&error_msg)?;
                            on_response_error.into_inner(&mut cx).call_with(&cx).arg(error).exec(&mut cx)
                        }).await;
                        return;
                    }
                    None => {
                        let _ = channel.send(move |mut cx| {
                            let trailers = cx.empty_object();
                            on_response_end.into_inner(&mut cx).call_with(&cx).arg(trailers).exec(&mut cx)
                        }).await;
                        return;
                    }
                }
            }
        }
    }
}
```

### AbortSignal Integration

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use neon::prelude::*;
use tokio_util::sync::{CancellationToken, WaitForCancellationFuture};

struct AbortSignal {
    signal: Option<Root<JsObject>>,
    token: CancellationToken,
}

impl AbortSignal {
    pub fn try_from_value<'a>(cx: &mut Cx<'a>, value: Handle<'_, JsValue>) -> NeonResult<Option<Self>> {
        if value.is_a::<JsUndefined, _>(cx) { return Ok(None); }

        let signal: Handle<'_, JsObject> = value.downcast_or_throw(cx)?;
        let token = CancellationToken::new();

        let callback = JsFunction::new(cx, {
            let token = token.clone();
            move |mut cx| { token.cancel(); Ok(cx.undefined()) }
        })?;
        signal.set(cx, "onabort", callback)?;

        let aborted: Handle<'_, JsBoolean> = signal.get(cx, "aborted")?;
        if aborted.value(cx) {
            return signal.call_method_with(cx, "throwIfAborted")?.exec(cx)?;
        }

        Ok(Some(Self { signal: Some(signal.root(cx)), token }))
    }

    pub fn aborted(&self) -> WaitForCancellationFuture<'_> { self.token.cancelled() }
}
```

### dispatch() Method

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
  if (this.#closed) {
    const controller = new DispatchControllerImpl();
    handler.onResponseError?.(controller, new Error('Dispatcher is closed'));
    return false;
  }

  const controller = new DispatchControllerImpl();
  handler.onRequestStart?.(controller, {});

  const callbacks = {
    onResponseStart: (statusCode: number, headers: IncomingHttpHeaders, statusMessage: string) => {
      if (controller.aborted) return;
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (chunk: Buffer) => {
      if (controller.aborted) return;
      handler.onResponseData?.(controller, chunk);
    },
    onResponseEnd: (trailers: IncomingHttpHeaders) => {
      if (controller.aborted) return;
      handler.onResponseEnd?.(controller, trailers);
    },
    onResponseError: (error: Error) => {
      handler.onResponseError?.(controller, controller.reason ?? error);
    },
  };

  const requestHandle = Addon.agentDispatch(this.#agent, this.#buildDispatchOptions(options), callbacks);
  controller.setRequestHandle(requestHandle);
  return true;
}
```

### close/destroy

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

async close(): Promise<void> {
  this.#closed = true;
  await Addon.agentClose(this.#agent);
}

async destroy(err?: Error): Promise<void> {
  this.#destroyed = true;
  this.#closed = true;
  await Addon.agentDestroy(this.#agent, err ?? null);
}
```

## Rust Trait Abstraction

Core defines an async trait using `#[async_trait]`. `packages/node` provides `DispatchCallbacks`
struct that implements this trait by bridging to JS via Neon Channel.

### Core Trait (packages/core/src/dispatcher.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::collections::HashMap;
use std::sync::Arc;
use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// HTTP method
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get, Head, Post, Put, Delete, Connect, Options, Trace, Patch,
}

/// Request options matching undici DispatchOptions
#[derive(Debug, Clone)]
pub struct DispatchOptions {
    pub origin: Option<String>,
    pub path: String,
    pub method: Method,
    pub headers: HashMap<String, Vec<String>>,
    pub body: Option<BodySource>,
    pub upgrade: Option<String>,
    pub timeout: Option<std::time::Duration>,
}

/// Request body source
pub enum BodySource {
    Bytes(Bytes),
    Stream(mpsc::Receiver<Bytes>),
}

/// Response metadata
#[derive(Debug, Clone)]
pub struct ResponseStart {
    pub status_code: u16,
    pub status_message: String,
    pub headers: HashMap<String, Vec<String>>,
}

/// Dispatch error types
#[derive(Debug, Clone)]
pub enum DispatchError {
    Aborted,
    Timeout,
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
impl std::error::Error for DispatchError {}

/// Async trait for dispatch lifecycle callbacks (defined in core)
#[async_trait]
pub trait DispatchHandler: Send + Sync {
    /// Called when response headers are received
    async fn on_response_start(&self, response: ResponseStart);

    /// Called for each body chunk
    async fn on_response_data(&self, chunk: Bytes);

    /// Called when response completes successfully
    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>);

    /// Called on error
    async fn on_response_error(&self, error: DispatchError);
}

/// Handle for controlling in-flight request
pub struct RequestController {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl RequestController {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            pause_state: Arc::new(PauseState::new()),
        }
    }

    pub fn abort(&self) { self.token.cancel(); }
    pub fn pause(&self) { self.pause_state.pause(); }
    pub fn resume(&self) { self.pause_state.resume(); }

    pub fn token(&self) -> CancellationToken { self.token.clone() }
    pub fn pause_state(&self) -> Arc<PauseState> { Arc::clone(&self.pause_state) }
}

impl Default for RequestController {
    fn default() -> Self { Self::new() }
}

/// Pause state for backpressure
pub struct PauseState {
    paused: std::sync::atomic::AtomicBool,
    notify: tokio::sync::Notify,
}

impl PauseState {
    pub fn new() -> Self {
        Self {
            paused: std::sync::atomic::AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub async fn wait_if_paused(&self) {
        while self.paused.load(std::sync::atomic::Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }

    pub fn pause(&self) {
        self.paused.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused.store(false, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_one();
    }
}

impl Default for PauseState {
    fn default() -> Self { Self::new() }
}
```

### Core Agent (packages/core/src/agent.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use crate::dispatcher::*;
use futures::StreamExt;
use reqwest::Client;
use std::sync::Arc;
use tokio::select;

/// HTTP agent wrapping reqwest Client
pub struct Agent {
    client: Client,
    runtime: tokio::runtime::Handle,
}

impl Agent {
    pub fn new(config: AgentConfig) -> Result<Self, AgentError> {
        let mut builder = Client::builder()
            .timeout(config.timeout)
            .connect_timeout(config.connect_timeout);

        if let Some(proxy) = config.proxy {
            builder = builder.proxy(proxy);
        }

        if let Some(ca) = config.ca {
            for cert in ca {
                builder = builder.add_root_certificate(cert);
            }
        }

        let client = builder.build()?;
        let runtime = tokio::runtime::Handle::current();

        Ok(Self { client, runtime })
    }

    /// Dispatch a request with async trait handler
    pub fn dispatch(
        &self,
        options: DispatchOptions,
        handler: Arc<dyn DispatchHandler>,
    ) -> RequestController {
        let controller = RequestController::new();
        let client = self.client.clone();
        let token = controller.token();
        let pause_state = controller.pause_state();

        self.runtime.spawn(async move {
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
        // Build request
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
            options.origin.unwrap_or_default(),
            options.path
        );

        let mut request = client.request(method, &url);

        for (key, values) in &options.headers {
            for value in values {
                request = request.header(key, value);
            }
        }

        if let Some(body) = options.body {
            request = match body {
                BodySource::Bytes(bytes) => request.body(bytes),
                BodySource::Stream(rx) => {
                    request.body(reqwest::Body::wrap_stream(
                        tokio_stream::wrappers::ReceiverStream::new(rx)
                            .map(Ok::<_, std::io::Error>)
                    ))
                }
            };
        }

        // Send request
        let response = select! {
            () = token.cancelled() => {
                handler.on_response_error(DispatchError::Aborted).await;
                return;
            }
            result = request.send() => {
                match result {
                    Ok(resp) => resp,
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
            .fold(std::collections::HashMap::new(), |mut acc, (k, v)| {
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
                            handler.on_response_end(std::collections::HashMap::new()).await;
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[derive(Default)]
pub struct AgentConfig {
    pub timeout: Option<std::time::Duration>,
    pub connect_timeout: Option<std::time::Duration>,
    pub proxy: Option<reqwest::Proxy>,
    pub ca: Option<Vec<reqwest::Certificate>>,
}

#[derive(Debug)]
pub struct AgentError(pub String);

impl From<reqwest::Error> for AgentError {
    fn from(e: reqwest::Error) -> Self { Self(e.to_string()) }
}
```

### Node Bindings (packages/node/src/agent.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Neon bindings for core::Agent - NO business logic, only JS↔Rust marshaling

use async_trait::async_trait;
use bytes::Bytes;
use core::{Agent, AgentConfig, DispatchHandler, DispatchOptions, DispatchError, ResponseStart};
use neon::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

pub struct AgentInstance {
    inner: Agent,
}

impl Finalize for AgentInstance {}

/// DispatchCallbacks implements DispatchHandler trait by bridging to JS
pub struct DispatchCallbacks {
    channel: Channel,
    on_start: Arc<Root<JsFunction>>,
    on_data: Arc<Root<JsFunction>>,
    on_end: Arc<Root<JsFunction>>,
    on_error: Arc<Root<JsFunction>>,
}

#[async_trait]
impl DispatchHandler for DispatchCallbacks {
    async fn on_response_start(&self, response: ResponseStart) {
        let channel = self.channel.clone();
        let on_start = Arc::clone(&self.on_start);
        let _ = channel.send(move |mut cx| {
            fn call(cx: &mut Cx<'_>, root: &Root<JsFunction>, resp: ResponseStart) -> NeonResult<()> {
                let headers = headers_to_js(cx, &resp.headers)?;
                root.to_inner(cx)
                    .call_with(cx)
                    .arg(cx.number(resp.status_code as f64))
                    .arg(headers)
                    .arg(cx.string(&resp.status_message))
                    .exec(cx)
            }
            call(&mut cx, &on_start, resp)
        }).await;
    }

    async fn on_response_data(&self, chunk: Bytes) {
        let channel = self.channel.clone();
        let on_data = Arc::clone(&self.on_data);
        let _ = channel.send(move |mut cx| {
            fn call(cx: &mut Cx<'_>, root: &Root<JsFunction>, data: &[u8]) -> NeonResult<()> {
                let buffer = JsBuffer::from_slice(cx, data)?;
                root.to_inner(cx).call_with(cx).arg(buffer).exec(cx)
            }
            call(&mut cx, &on_data, &chunk)
        }).await;
    }

    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>) {
        let channel = self.channel.clone();
        let on_end = Arc::clone(&self.on_end);
        let _ = channel.send(move |mut cx| {
            fn call(cx: &mut Cx<'_>, root: &Root<JsFunction>, trailers: &HashMap<String, Vec<String>>) -> NeonResult<()> {
                let obj = headers_to_js(cx, trailers)?;
                root.to_inner(cx).call_with(cx).arg(obj).exec(cx)
            }
            call(&mut cx, &on_end, &trailers)
        }).await;
    }

    async fn on_response_error(&self, error: DispatchError) {
        let channel = self.channel.clone();
        let on_error = Arc::clone(&self.on_error);
        let error_msg = error.to_string();
        let _ = channel.send(move |mut cx| {
            fn call(cx: &mut Cx<'_>, root: &Root<JsFunction>, msg: &str) -> NeonResult<()> {
                let err = cx.error(msg)?;
                root.to_inner(cx).call_with(cx).arg(err).exec(cx)
            }
            call(&mut cx, &on_error, &error_msg)
        }).await;
    }
}

fn create_handler(cx: &mut FunctionContext<'_>, js_callbacks: Handle<'_, JsObject>) -> NeonResult<Arc<dyn DispatchHandler>> {
    Ok(Arc::new(DispatchCallbacks {
        channel: cx.channel(),
        on_start: Arc::new(js_callbacks.get::<JsFunction, _, _>(cx, "onResponseStart")?.root(cx)),
        on_data: Arc::new(js_callbacks.get::<JsFunction, _, _>(cx, "onResponseData")?.root(cx)),
        on_end: Arc::new(js_callbacks.get::<JsFunction, _, _>(cx, "onResponseEnd")?.root(cx)),
        on_error: Arc::new(js_callbacks.get::<JsFunction, _, _>(cx, "onResponseError")?.root(cx)),
    }))
}

fn headers_to_js<'a>(cx: &mut Cx<'a>, headers: &HashMap<String, Vec<String>>) -> JsResult<'a, JsObject> {
    let obj = cx.empty_object();
    for (key, values) in headers {
        if values.len() == 1 {
            let val = cx.string(&values[0]);
            obj.set(cx, key.as_str(), val)?;
        } else {
            let arr = cx.empty_array();
            for (i, v) in values.iter().enumerate() {
                let val = cx.string(v);
                arr.set(cx, i as u32, val)?;
            }
            obj.set(cx, key.as_str(), arr)?;
        }
    }
    Ok(obj)
}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsBox<AgentInstance>> {
    let config = AgentConfig::default(); // TODO: parse from cx
    let agent = Agent::new(config).map_err(|e| cx.throw_error::<_, ()>(e.0).unwrap_err())?;
    Ok(cx.boxed(AgentInstance { inner: agent }))
}

#[neon::export(name = "agentDispatch", context)]
fn agent_dispatch<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentInstance>>,
    options: Handle<'cx, JsObject>,
    callbacks: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<RequestHandleInstance>> {
    let dispatch_options = parse_dispatch_options(cx, options)?;
    let handler = create_handler(cx, callbacks)?;

    let controller = agent.inner.dispatch(dispatch_options, handler);
    Ok(cx.boxed(RequestHandleInstance { inner: controller }))
}

fn parse_dispatch_options<'cx>(cx: &mut FunctionContext<'cx>, obj: Handle<'cx, JsObject>) -> NeonResult<DispatchOptions> {
    let path: Handle<JsString> = obj.get(cx, "path")?;
    let method_str: Handle<JsString> = obj.get(cx, "method")?;

    let method = match method_str.value(cx).to_uppercase().as_str() {
        "GET" => core::Method::Get,
        "POST" => core::Method::Post,
        "PUT" => core::Method::Put,
        "DELETE" => core::Method::Delete,
        "HEAD" => core::Method::Head,
        "OPTIONS" => core::Method::Options,
        "PATCH" => core::Method::Patch,
        "CONNECT" => core::Method::Connect,
        "TRACE" => core::Method::Trace,
        _ => return cx.throw_error("Invalid HTTP method"),
    };

    Ok(DispatchOptions {
        origin: obj.get_opt::<JsString, _, _>(cx, "origin")?.map(|s| s.value(cx)),
        path: path.value(cx),
        method,
        headers: HashMap::new(), // TODO: parse headers
        body: None,              // TODO: parse body
        upgrade: None,
        timeout: None,
    })
}

pub struct RequestHandleInstance {
    inner: core::RequestController,
}

impl Finalize for RequestHandleInstance {}

#[neon::export(name = "requestHandleAbort", context)]
fn request_handle_abort<'cx>(cx: &mut FunctionContext<'cx>, handle: Handle<'cx, JsBox<RequestHandleInstance>>) -> JsResult<'cx, JsUndefined> {
    handle.inner.abort();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandlePause", context)]
fn request_handle_pause<'cx>(cx: &mut FunctionContext<'cx>, handle: Handle<'cx, JsBox<RequestHandleInstance>>) -> JsResult<'cx, JsUndefined> {
    handle.inner.pause();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandleResume", context)]
fn request_handle_resume<'cx>(cx: &mut FunctionContext<'cx>, handle: Handle<'cx, JsBox<RequestHandleInstance>>) -> JsResult<'cx, JsUndefined> {
    handle.inner.resume();
    Ok(cx.undefined())
}
```

## File Structure

```text
packages/
├── core/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs           # pub mod dispatcher; pub mod agent;
│       ├── dispatcher.rs    # DispatchHandler trait, DispatchOptions, etc.
│       └── agent.rs         # Agent impl with reqwest, runtime-agnostic
└── node/
    ├── Cargo.toml
    ├── export/
    │   ├── agent.ts         # DispatchControllerImpl, AgentImpl
    │   └── addon-def.ts     # TypeScript types for addon
    └── src/
        ├── lib.rs           # Neon exports
        └── agent.rs         # NeonHandler impl, JS↔Rust marshaling ONLY
```

## Dependencies

| Crate              | Purpose                              |
| :----------------- | :----------------------------------- |
| `reqwest`          | HTTP client                          |
| `reqwest-websocket`| WebSocket upgrade support            |
| `tokio`            | Async runtime                        |
| `tokio-util`       | CancellationToken                    |
| `futures`          | StreamExt for bytes_stream           |

## Implementation Order

1. DispatchController skeleton (TS)
2. Basic Rust dispatch with Channel callbacks
3. Wire addon interface
4. Complete dispatch() flow
5. Add abort support
6. Add backpressure support
7. Implement close/destroy
8. Add drain event
9. Add WebSocket upgrade support
10. Tests

## Core Package Testing

### Testability Analysis

The design is highly testable because:

1. **Trait abstraction**: `DispatchHandler` is an async trait - easy to mock
2. **No FFI in tests**: Core tests don't need Neon/Node.js
3. **Pure Rust async**: Can use tokio-test and standard Rust testing
4. **HTTP mocking**: `wiremock` provides isolated mock servers per test

### Test Strategy

We test the **integration** between `Agent` and mock HTTP servers. We don't re-test:

- `reqwest` internals (compression, TLS, cookies) - trusted
- `tokio` runtime behavior - trusted
- HTTP parsing - handled by hyper/reqwest

We focus on testing our code paths: dispatcher lifecycle, abort, pause/resume, error handling.

### Mock DispatchHandler for Tests

```rust
// packages/core/tests/support/mock_handler.rs
// SPDX-License-Identifier: Apache-2.0 OR MIT

use async_trait::async_trait;
use bytes::Bytes;
use core::{DispatchError, DispatchHandler, ResponseStart};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Default)]
pub struct RecordedEvents {
    pub response_starts: Vec<ResponseStart>,
    pub data_chunks: Vec<Bytes>,
    pub response_ends: Vec<HashMap<String, Vec<String>>>,
    pub errors: Vec<DispatchError>,
}

pub struct MockHandler {
    events: Arc<Mutex<RecordedEvents>>,
}

impl MockHandler {
    pub fn new() -> (Self, Arc<Mutex<RecordedEvents>>) {
        let events = Arc::new(Mutex::new(RecordedEvents::default()));
        (Self { events: Arc::clone(&events) }, events)
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
    }

    async fn on_response_error(&self, error: DispatchError) {
        self.events.lock().await.errors.push(error);
    }
}
```

### Test Scenarios

| #  | Scenario                | What it tests                                                        | Priority |
| :- | :---------------------- | :------------------------------------------------------------------- | :------- |
| 1  | **GET 200 OK**          | Basic flow: on_response_start → on_response_data → on_response_end   | High     |
| 2  | **POST with body**      | Request body is sent correctly                                       | High     |
| 3  | **Response headers**    | Headers map correctly converted                                      | High     |
| 4  | **Streamed response**   | Multiple data chunks received in order                               | High     |
| 5  | **404 response**        | HTTP errors call on_response_start with status                       | High     |
| 6  | **Network error**       | Connection refused → on_response_error(Network)                      | High     |
| 7  | **Abort before send**   | cancel() before request → on_response_error(Aborted)                 | High     |
| 8  | **Abort during stream** | cancel() mid-body → on_response_error(Aborted)                       | Medium   |
| 9  | **Pause/resume**        | pause() delays data, resume() continues                              | Medium   |
| 10 | **Request timeout**     | Slow server → on_response_error(Timeout)                             | Medium   |
| 11 | **Empty response body** | 204 No Content → on_response_end with no data                        | Low      |
| 12 | **Multi-value headers** | Headers like Set-Cookie appear as Vec                                | Low      |

### Example Test

```rust
// packages/core/tests/agent_dispatch.rs
// SPDX-License-Identifier: Apache-2.0 OR MIT

mod support;

use core::{Agent, AgentConfig, DispatchOptions, Method};
use std::sync::Arc;
use support::mock_handler::MockHandler;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn test_get_200_ok() {
    // Start mock server
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&server)
        .await;

    // Create agent
    let agent = Agent::new(AgentConfig::default()).unwrap();

    // Create mock handler
    let (handler, events) = MockHandler::new();

    // Dispatch request
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/test".to_string(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        upgrade: None,
        timeout: None,
    };

    let _controller = agent.dispatch(opts, Arc::new(handler));

    // Wait for completion (in real tests, use proper sync)
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Assert events
    let events = events.lock().await;
    assert_eq!(events.response_starts.len(), 1);
    assert_eq!(events.response_starts[0].status_code, 200);
    assert_eq!(events.data_chunks.len(), 1);
    assert_eq!(&events.data_chunks[0][..], b"hello");
    assert_eq!(events.response_ends.len(), 1);
    assert!(events.errors.is_empty());
}

#[tokio::test]
async fn test_abort_before_response() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(10)))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).unwrap();
    let (handler, events) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/slow".to_string(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        upgrade: None,
        timeout: None,
    };

    let controller = agent.dispatch(opts, Arc::new(handler));

    // Abort immediately
    controller.abort();

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let events = events.lock().await;
    assert!(events.response_starts.is_empty());
    assert_eq!(events.errors.len(), 1);
    matches!(&events.errors[0], core::DispatchError::Aborted);
}

#[tokio::test]
async fn test_network_error() {
    let agent = Agent::new(AgentConfig::default()).unwrap();
    let (handler, events) = MockHandler::new();

    let opts = DispatchOptions {
        origin: Some("http://127.0.0.1:1".to_string()), // Unreachable port
        path: "/".to_string(),
        method: Method::Get,
        headers: Default::default(),
        body: None,
        upgrade: None,
        timeout: None,
    };

    let _controller = agent.dispatch(opts, Arc::new(handler));

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    matches!(&events.errors[0], core::DispatchError::Network(_));
}
```

### Test Dependencies

| Crate               | Purpose                               |
| :------------------ | :------------------------------------ |
| `wiremock`          | Mock HTTP server (per-test isolation) |
| `tokio-test`        | Async test utilities                  |
| `pretty_assertions` | Better assertion diffs                |

## Backpressure Analysis

### How undici Implements Backpressure

From `unwrap-handler.js` and `wrap-handler.js`:

1. **Return value protocol**: `onHeaders()` and `onData()` return `boolean`:
   - `true` → continue reading socket
   - `false` → pause socket, stop reading

2. **Controller pattern**: Handler calls `controller.pause()`, socket is paused internally

3. **Resume mechanism**: `onHeaders` receives `resume()` callback, stored in controller

4. **Integration**: The underlying socket is paused/resumed directly

### Our Implementation Approach

We use `AtomicBool + Notify` polling pattern:

```rust
pub struct PauseState {
    paused: AtomicBool,
    notify: Notify,
}

// In streaming loop:
loop {
    pause_state.wait_if_paused().await;  // Block if paused
    // ... read next chunk ...
}
```

### Verification Checklist

| Concern                    | Status | Analysis                                                                          |
| :------------------------- | :----- | :-------------------------------------------------------------------------------- |
| **Minimal copying**        | OK     | `Bytes` uses arc-backed buffer, moved through callbacks                           |
| **No unlimited queues**    | OK     | No buffering between chunks; pause stops reqwest stream polling                   |
| **Request order**          | N/A    | No ordering needed; each request is independent                                   |
| **Cancellation isolation** | OK     | Each request has its own `CancellationToken`; canceling one doesn't affect others |
| **Memory bounded**         | OK     | At most 1 chunk in flight per request during pause                                |
| **Deadlock risk**          | WARN   | See note below                                                                    |

### Key Implementation Details

**1. Zero-copy data flow:**

```text
reqwest stream → Bytes (arc-backed) → on_response_data() → Neon JsBuffer
                      ↑ no copy                   ↑ one copy into V8 heap
```

**2. Bounded buffering:**

- reqwest's `bytes_stream()` uses internal hyper buffering (typically 16KB)
- Our loop reads one chunk, waits for callback, then reads next
- When paused, `wait_if_paused()` blocks before polling next chunk
- **Max memory per request**: hyper read buffer + 1 chunk in callback

**3. Request isolation:**

```rust
// Each request spawns its own task with unique state
self.runtime.spawn(async move {
    let token = controller.token();         // New token per request
    let pause_state = controller.pause_state(); // New state per request
    // ...
});
```

**4. undici compatibility:**

| undici behavior              | Our implementation                                           |
| :--------------------------- | :----------------------------------------------------------- |
| `controller.pause()`         | Sets `AtomicBool`, Rust loop blocks on `Notify`              |
| `controller.resume()`        | Clears `AtomicBool`, `notify_one()` wakes loop               |
| `controller.abort(reason)`   | Cancels token, `select!` picks cancellation branch           |
| Multiple rapid pause/resume  | Works correctly due to `SeqCst` ordering                     |

### Potential Issues and Mitigations

#### Issue 1: Notify wakeup race

```rust
// Current code - potential race:
pub fn resume(&self) {
    self.paused.store(false, Ordering::SeqCst);
    self.notify.notify_one();  // What if waiter hasn't entered notified() yet?
}
```

**Mitigation**: The `while` loop handles spurious wakeups correctly:

```rust
pub async fn wait_if_paused(&self) {
    while self.paused.load(Ordering::SeqCst) {
        self.notify.notified().await;  // Will re-check condition after wakeup
    }
}
```

#### Issue 2: Channel.send() backpressure to JS

The `channel.send()` awaits until JS event loop processes the callback. If JS is slow:

- Rust task blocks in `channel.send().await`
- This naturally provides backpressure to reqwest stream
- However, we're not pausing reqwest based on JS slowness

**Recommendation**: Consider if we need to propagate JS backpressure:

```rust
// Option: Pause when JS callback is slow
handler.on_response_data(data).await; // Blocks until JS processes
// If this takes > threshold, JS should call pause() itself
```

Current design relies on JS calling `pause()` explicitly.

#### Issue 3: Request ordering (HTTP/2 multiplexing)

- undici: No strict ordering required between independent requests
- Our design: Each request is independent parallel task
- HTTP/2: reqwest handles multiplexing internally
- **No ordering guarantees needed or provided**

### Performance Characteristics

| Metric               | Value                                                    |
| :------------------- | :------------------------------------------------------- |
| Chunks in flight     | 1 per request (waiting in callback)                      |
| Buffer memory        | hyper default (16KB) + chunk size (varies)               |
| Pause latency        | Near-instant (AtomicBool check per chunk)                |
| Resume latency       | Notify wakeup time (~microseconds)                       |
| Cross-request impact | None (isolated tokens and pause states)                  |

### Backpressure Test Scenarios

| Test                       | What to verify                                             |
| :------------------------- | :--------------------------------------------------------- |
| Pause mid-stream           | No more chunks delivered after pause()                     |
| Resume after pause         | Chunks resume flowing, no data lost                        |
| Rapid pause/resume toggle  | No stuck state, no lost chunks                             |
| Pause during slow server   | Pause takes effect on next chunk boundary                  |
| Abort while paused         | Clean termination, no hanging                              |
| Parallel slow requests     | Each paused independently, no cross-contamination          |

## Resolved Design Decisions

### Request Body Streaming

JS normalizes body to `ReadableStreamBYOBReader` (see `normalizeBody` in agent.ts). Rust
receives chunks via repeated addon calls:

```rust
// Rust receives body as channel receiver
struct RequestBody {
    receiver: mpsc::Receiver<Bytes>,
}

impl From<RequestBody> for reqwest::Body {
    fn from(body: RequestBody) -> Self {
        reqwest::Body::wrap_stream(ReceiverStream::new(body.receiver))
    }
}
```

```typescript
// JS pumps BYOB reader to Rust
async function pumpBody(reader: ReadableStreamBYOBReader, requestId: number) {
  while (true) {
    const buffer = new Uint8Array(65536);
    const { done, value } = await reader.read(buffer);
    if (done) {
      Addon.finishBody(requestId);
      break;
    }
    Addon.sendBodyChunk(requestId, value);
  }
}
```

### WebSocket Upgrade Support

Use `reqwest-websocket` crate (wraps tokio-tungstenite):

```rust
use reqwest_websocket::RequestBuilderExt;

async fn handle_upgrade(
    client: &reqwest::Client,
    url: &str,
    channel: Channel,
    on_upgrade: Root<JsFunction>,
) -> Result<(), Error> {
    let response = client.get(url).upgrade().send().await?;
    let websocket = response.into_websocket().await?;

    // Return socket handle to JS for onRequestUpgrade callback
    channel.send(move |mut cx| {
        let socket_handle = /* wrap websocket */;
        on_upgrade.into_inner(&mut cx)
            .call_with(&cx)
            .arg(/* statusCode */)
            .arg(/* headers */)
            .arg(socket_handle)
            .exec(&mut cx)
    }).await;

    Ok(())
}
```

Difficulty: **Medium** - reqwest-websocket provides clean API, main work is exposing
WebSocket as JS Duplex stream via Neon.

### Drain Event

Track pending requests, emit `drain` when no longer busy:

```typescript
class AgentImpl extends Dispatcher {
  #pendingRequests = 0;
  #needDrain = false;
  #maxConcurrent = 100;

  dispatch(options, handler): boolean {
    this.#pendingRequests++;
    // ... dispatch ...

    const busy = this.#pendingRequests >= this.#maxConcurrent;
    if (busy) this.#needDrain = true;
    return !busy;
  }

  // Called from Rust on request complete
  #onRequestComplete() {
    this.#pendingRequests--;
    if (this.#needDrain && this.#pendingRequests < this.#maxConcurrent) {
      this.#needDrain = false;
      queueMicrotask(() => this.emit('drain', this.#origin));
    }
  }
}
```

### Root Cloning

Wrap `Root<JsFunction>` in `Arc` before spawning async task:

```rust
// Clone roots into Arc before async block
let on_data = Arc::new(callbacks.get::<JsFunction, _, _>(cx, "onResponseData")?.root(cx));
let channel = cx.channel();

runtime.spawn(async move {
    loop {
        let on_data = Arc::clone(&on_data);
        let channel = channel.clone();

        // Use to_inner() for borrowed access (does not consume)
        let _ = channel.send(move |mut cx| {
            on_data.to_inner(&mut cx)
                .call_with(&cx)
                .arg(buffer)
                .exec(&mut cx)
        }).await;
    }
});
```
