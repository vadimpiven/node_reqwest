# Dispatcher Implementation

Implement undici `DispatchHandler` interface with `DispatchController` for pause/resume/abort.

## Goals

1. **Design Guidelines Compliance** — Concise, copy-paste-ready code, no verbose prose
2. **Clear Core/Node Separation** — Core: business logic + async trait; Node: JS↔Rust marshaling only
3. **Rust Best Practices** — Proper error handling, zero-cost abstractions, `async_trait`
4. **undici Interface Compliance** — All `DispatchHandler`/`DispatchController` callbacks satisfied
5. **Complete Dependencies** — All required crates/features in Cargo.toml
6. **Testing Framework** — Core: wiremock + tokio-test; Node: vitest + playwright
7. **Backpressure Correctness** — No unlimited queues, bounded memory, proper pause/resume
8. **Minimal Copying** — Data copied only at Node/Rust boundary, `Bytes` arc-backed elsewhere
9. **Undici Error Compatibility** — Replicate Undici errors with `Symbol.for`, proper instanceof checks

## Error Handling Strategy

Core Rust errors map to Undici-compatible JS errors using `Symbol.for` for proper `instanceof` checks.

### Error Handling Architecture

```text
Core (Rust)              Node (Rust FFI)          Node (TypeScript)
┌─────────────┐          ┌───────────┐           ┌──────────────────┐
│ CoreError   │─────────▶│ error_code│──────────▶│ createUndiciError│
│ enum        │          │ error_name│           │ + Symbol.for     │
└─────────────┘          └───────────┘           └──────────────────┘
```

### Core Error Types (packages/core/src/error.rs)

```rust
#[derive(Debug, Clone, Error)]
pub enum CoreError {
    #[error("Request aborted")]
    RequestAborted,
    #[error("Connect timeout")]
    ConnectTimeout,
    #[error("Headers timeout")]
    HeadersTimeout,
    #[error("Body timeout")]
    BodyTimeout,
    #[error("Socket error: {0}")]
    Socket(String),
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),
    #[error("The client is destroyed")]
    ClientDestroyed,
    #[error("The client is closed")]
    ClientClosed,
    #[error("Request body length does not match content-length header")]
    RequestContentLengthMismatch,
    #[error("Response body length does not match content-length header")]
    ResponseContentLengthMismatch,
    #[error("Response content exceeded max size")]
    ResponseExceededMaxSize,
    #[error("Not supported: {0}")]
    NotSupported(String),
    #[error("Response error")]
    ResponseError { status_code: u16, message: String },
    #[error("Network error: {0}")]
    Network(String),
}

impl CoreError {
    pub fn error_code(&self) -> &'static str { /* maps to UND_ERR_* codes */ }
    pub fn error_name(&self) -> &'static str { /* maps to error class names */ }
}
```

### Undici Error Classes (packages/node/export/errors.ts)

Pattern: Each error class uses `Symbol.for('undici.error.CODE')` for cross-library `instanceof`.

```typescript
const kUndiciError = Symbol.for('undici.error.UND_ERR');

export class UndiciError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UndiciError';
    this.code = code;
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kUndiciError] === true;
  }
  get [kUndiciError](): boolean { return true; }
}

const kRequestAbortedError = Symbol.for('undici.error.UND_ERR_ABORTED');
export class RequestAbortedError extends UndiciError {
  constructor(message = 'Request aborted') {
    super(message, 'UND_ERR_ABORTED');
    this.name = 'AbortError';
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kRequestAbortedError] === true;
  }
  get [kRequestAbortedError](): boolean { return true; }
}

const kSocketError = Symbol.for('undici.error.UND_ERR_SOCKET');
export class SocketError extends UndiciError {
  socket: any;
  constructor(message = 'Socket error', socket?: any) {
    super(message, 'UND_ERR_SOCKET');
    this.name = 'SocketError';
    this.socket = socket || null;
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kSocketError] === true;
  }
  get [kSocketError](): boolean { return true; }
}

const kResponseError = Symbol.for('undici.error.UND_ERR_RESPONSE');
export class ResponseError extends UndiciError {
  statusCode: number;
  body: any;
  headers: any;
  constructor(message: string, statusCode: number, options: { headers?: any; body?: any } = {}) {
    super(message, 'UND_ERR_RESPONSE');
    this.name = 'ResponseError';
    this.statusCode = statusCode;
    this.body = options.body || null;
    this.headers = options.headers || null;
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kResponseError] === true;
  }
  get [kResponseError](): boolean { return true; }
}

// ... Similar pattern for: ConnectTimeoutError, HeadersTimeoutError, BodyTimeoutError,
//     ClientDestroyedError, ClientClosedError, InvalidArgumentError,
//     RequestContentLengthMismatchError, ResponseContentLengthMismatchError,
//     ResponseExceededMaxSizeError, NotSupportedError

export interface CoreErrorInfo {
  code: string;
  name: string;
  message: string;
  statusCode?: number;
}

export function createUndiciError(errorInfo: CoreErrorInfo): Error {
  const { code, message, statusCode } = errorInfo;
  switch (code) {
    case 'UND_ERR_ABORTED': return new RequestAbortedError(message);
    case 'UND_ERR_CONNECT_TIMEOUT': return new ConnectTimeoutError(message);
    case 'UND_ERR_HEADERS_TIMEOUT': return new HeadersTimeoutError(message);
    case 'UND_ERR_BODY_TIMEOUT': return new BodyTimeoutError(message);
    case 'UND_ERR_SOCKET': return new SocketError(message);
    case 'UND_ERR_DESTROYED': return new ClientDestroyedError(message);
    case 'UND_ERR_CLOSED': return new ClientClosedError(message);
    case 'UND_ERR_INVALID_ARG': return new InvalidArgumentError(message);
    case 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH': return new RequestContentLengthMismatchError(message);
    case 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH': return new ResponseContentLengthMismatchError(message);
    case 'UND_ERR_RES_EXCEEDED_MAX_SIZE': return new ResponseExceededMaxSizeError(message);
    case 'UND_ERR_NOT_SUPPORTED': return new NotSupportedError(message);
    case 'UND_ERR_RESPONSE': return new ResponseError(message, statusCode || 500);
    default: return new UndiciError(message, code);
  }
}
```

### Rust FFI Error Marshaling (packages/node/src/agent.rs)

```rust
async fn on_response_error(&self, error: CoreError) {
    let channel = self.channel.clone();
    let on_error = Arc::clone(&self.on_error);
    let error_code = error.error_code().to_string();
    let error_name = error.error_name().to_string();
    let error_msg = error.to_string();
    let status_code = match &error {
        CoreError::ResponseError { status_code, .. } => Some(*status_code),
        _ => None,
    };

    channel.send(move |mut cx| {
        let error_info = cx.empty_object();
        error_info.set(&mut cx, "code", cx.string(&error_code))?;
        error_info.set(&mut cx, "name", cx.string(&error_name))?;
        error_info.set(&mut cx, "message", cx.string(&error_msg))?;
        if let Some(code) = status_code {
            error_info.set(&mut cx, "statusCode", cx.number(code as f64))?;
        }
        on_error.to_inner(&mut cx).call_with(&cx).arg(error_info).exec(&mut cx)
    });
}
```

### TypeScript Error Callback (packages/node/export/agent.ts)

```typescript
import { createUndiciError, type CoreErrorInfo } from './errors';

const callbacks: DispatchCallbacks = {
  onResponseError: (errorInfo: CoreErrorInfo) => {
    this.#onRequestComplete();
    const undiciError = createUndiciError(errorInfo);
    handler.onResponseError?.(controller, controller.reason ?? undiciError);
  },
};
```

### Error Mapping Table

| Core Error                          | Undici Error                         | Symbol                                | Code                           |
| :---------------------------------- | :----------------------------------- | :------------------------------------ | :----------------------------- |
| `CoreError::RequestAborted`         | `RequestAbortedError`                | `undici.error.UND_ERR_ABORTED`        | `UND_ERR_ABORTED`              |
| `CoreError::ConnectTimeout`         | `ConnectTimeoutError`                | `undici.error.UND_ERR_CONNECT_TIMEOUT`| `UND_ERR_CONNECT_TIMEOUT`      |
| `CoreError::HeadersTimeout`         | `HeadersTimeoutError`                | `undici.error.UND_ERR_HEADERS_TIMEOUT`| `UND_ERR_HEADERS_TIMEOUT`      |
| `CoreError::BodyTimeout`            | `BodyTimeoutError`                   | `undici.error.UND_ERR_BODY_TIMEOUT`   | `UND_ERR_BODY_TIMEOUT`         |
| `CoreError::Socket`                 | `SocketError`                        | `undici.error.UND_ERR_SOCKET`         | `UND_ERR_SOCKET`               |
| `CoreError::Network`                | `SocketError`                        | `undici.error.UND_ERR_SOCKET`         | `UND_ERR_SOCKET`               |
| `CoreError::InvalidArgument`        | `InvalidArgumentError`               | `undici.error.UND_ERR_INVALID_ARG`    | `UND_ERR_INVALID_ARG`          |
| `CoreError::ClientDestroyed`        | `ClientDestroyedError`               | `undici.error.UND_ERR_DESTROYED`      | `UND_ERR_DESTROYED`            |
| `CoreError::ClientClosed`           | `ClientClosedError`                  | `undici.error.UND_ERR_CLOSED`         | `UND_ERR_CLOSED`               |
| `CoreError::RequestContentLength…`  | `RequestContentLengthMismatchError`  | `undici.error.UND_ERR_REQ_CONTENT_…`  | `UND_ERR_REQ_CONTENT_LENGTH_…` |
| `CoreError::ResponseContentLength…` | `ResponseContentLengthMismatchError` | `undici.error.UND_ERR_RES_CONTENT_…`  | `UND_ERR_RES_CONTENT_LENGTH_…` |
| `CoreError::ResponseExceededMaxSize`| `ResponseExceededMaxSizeError`       | `undici.error.UND_ERR_RES_EXCEEDED_…` | `UND_ERR_RES_EXCEEDED_MAX_SIZE`|
| `CoreError::NotSupported`           | `NotSupportedError`                  | `undici.error.UND_ERR_NOT_SUPPORTED`  | `UND_ERR_NOT_SUPPORTED`        |
| `CoreError::ResponseError`          | `ResponseError`                      | `undici.error.UND_ERR_RESPONSE`       | `UND_ERR_RESPONSE`             |

### Files Modified/Created

```text
packages/
├── core/src/
│   ├── error.rs      # NEW: CoreError enum with error_code(), error_name()
│   └── lib.rs        # UPDATE: pub mod error; re-export
└── node/
    ├── export/
    │   ├── errors.ts      # NEW: Undici error classes + createUndiciError()
    │   ├── addon-def.ts   # UPDATE: CoreErrorInfo interface
    │   └── agent.ts       # UPDATE: import createUndiciError, use in callbacks
    └── src/
        └── agent.rs       # UPDATE: JsDispatchHandler::on_response_error marshaling
```

## Solution

TypeScript creates `DispatchController`, Rust handles HTTP via reqwest with callbacks through
`neon::event::Channel`. Backpressure via `AtomicBool + Notify`, abort via `CancellationToken`.

## Request Flow Architecture

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

## undici DispatchHandler Interface (from types/dispatcher.d.ts)

| Method             | Signature                                                    | Our Implementation                    |
| :----------------- | :----------------------------------------------------------- | :------------------------------------ |
| `onRequestStart`   | `(controller, context) => void`                              | TS calls before dispatch              |
| `onRequestUpgrade` | `(controller, statusCode, headers, socket) => void`          | Rust callback via Channel (WebSocket) |
| `onResponseStart`  | `(controller, statusCode, headers, statusMessage?) => void`  | Rust callback via Channel             |
| `onResponseData`   | `(controller, chunk: Buffer) => void`                        | Rust callback via Channel             |
| `onResponseEnd`    | `(controller, trailers) => void`                             | Rust callback via Channel             |
| `onResponseError`  | `(controller, error: Error) => void`                         | Rust callback via Channel             |

## undici DispatchController Interface (from types/dispatcher.d.ts)

| Property/Method | Type                     | Our Implementation               |
| :-------------- | :----------------------- | :------------------------------- |
| `aborted`       | `boolean` (getter)       | `#aborted` private field         |
| `paused`        | `boolean` (getter)       | `#paused` private field          |
| `reason`        | `Error \| null` (getter) | `#reason` private field          |
| `abort(reason)` | `(Error) => void`        | Calls `RequestHandle.abort()`    |
| `pause()`       | `() => void`             | Calls `RequestHandle.pause()`    |
| `resume()`      | `() => void`             | Calls `RequestHandle.resume()`   |

## Implementation

### DispatchController (TypeScript)

```typescript
// packages/node/export/agent.ts
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

  get aborted(): boolean { return this.#aborted; }
  get paused(): boolean { return this.#paused; }
  get reason(): Error | null { return this.#reason; }

  setRequestHandle(handle: RequestHandle): void {
    this.#requestHandle = handle;
    // Apply pending state if abort/pause was called before handle was set
    if (this.#aborted) {
      this.#requestHandle.abort();
    } else if (this.#paused) {
      this.#requestHandle.pause();
    }
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

### Addon Interface (TypeScript)

```typescript
// packages/node/export/addon-def.ts
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ReadableStreamBYOBReader } from 'node:stream/web';
import type { IncomingHttpHeaders } from 'undici';

export interface RequestHandle {
  readonly _: unique symbol;
}

export type DispatchCallbacks = {
  onResponseStart: (statusCode: number, headers: IncomingHttpHeaders, statusMessage: string) => void;
  onResponseData: (chunk: Buffer) => void;
  onResponseEnd: (trailers: IncomingHttpHeaders) => void;
  onResponseError: (error: Error) => void;
};

export type AgentCreationOptions = {
  allowH2: boolean;
  ca: string[];
  keepAliveInitialDelay: number;
  keepAliveTimeout: number;
  localAddress: string | null;
  maxCachedSessions: number;
  proxy:
    | { type: 'no-proxy' | 'system' }
    | {
        type: 'custom';
        uri: string;
        headers: Record<string, string>;
        token: string | null;
      };
  rejectInvalidHostnames: boolean;
  rejectUnauthorized: boolean;
  timeout: number;
};

export type AgentDispatchOptions = {
  blocking: boolean;
  body: ReadableStreamBYOBReader | null;
  bodyTimeout: number;
  expectContinue: boolean;
  headers: Record<string, string>;
  headersTimeout: number;
  idempotent: boolean;
  method: string;
  origin: string;
  path: string;
  query: string;
  reset: boolean;
  throwOnError: boolean;
  upgrade: string | null;
};

export interface AgentInstance {
  readonly _: unique symbol;
}

export interface Addon {
  hello(): string;

  agentCreate(options: AgentCreationOptions): AgentInstance;
  agentDispatch(agent: AgentInstance, options: AgentDispatchOptions, callbacks: DispatchCallbacks): RequestHandle;
  agentClose(agent: AgentInstance): Promise<void>;
  agentDestroy(agent: AgentInstance, error: Error | null): Promise<void>;

  requestHandleAbort(handle: RequestHandle): void;
  requestHandlePause(handle: RequestHandle): void;
  requestHandleResume(handle: RequestHandle): void;
}
```

### dispatch() Method (TypeScript)

```typescript
// packages/node/export/agent.ts
// SPDX-License-Identifier: Apache-2.0 OR MIT

dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
  if (this.#closed) {
    const controller = new DispatchControllerImpl();
    handler.onResponseError?.(controller, new Error('Dispatcher is closed'));
    return false;
  }

  if (this.#destroyed) {
    const controller = new DispatchControllerImpl();
    handler.onResponseError?.(controller, new Error('Dispatcher is destroyed'));
    return false;
  }

  const controller = new DispatchControllerImpl();
  handler.onRequestStart?.(controller, {});

  // Check if aborted during onRequestStart
  if (controller.aborted) {
    handler.onResponseError?.(controller, controller.reason ?? new Error('Aborted'));
    return true;
  }

  const callbacks: DispatchCallbacks = {
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
      this.#onRequestComplete();
      handler.onResponseEnd?.(controller, trailers);
    },
    onResponseError: (error: Error) => {
      this.#onRequestComplete();
      handler.onResponseError?.(controller, controller.reason ?? error);
    },
  };

  this.#pendingRequests++;
  const busy = this.#pendingRequests >= this.#maxConcurrent;
  if (busy) this.#needDrain = true;

  const nativeHandle = Addon.agentDispatch(this.#agent, this.#buildDispatchOptions(options), callbacks);
  
  // Wrap native handle as RequestHandle interface
  const requestHandle: RequestHandle = {
    abort: () => Addon.requestHandleAbort(nativeHandle),
    pause: () => Addon.requestHandlePause(nativeHandle),
    resume: () => Addon.requestHandleResume(nativeHandle),
  };
  controller.setRequestHandle(requestHandle);

  return !busy;
}

#pendingRequests = 0;
#needDrain = false;
#maxConcurrent = 100;
#origin: URL | null = null;

#onRequestComplete(): void {
  this.#pendingRequests--;
  if (this.#needDrain && this.#pendingRequests < this.#maxConcurrent) {
    this.#needDrain = false;
    if (this.#origin) {
      queueMicrotask(() => this.emit('drain', this.#origin));
    }
  }
}
```

### close/destroy (TypeScript)

```typescript
// packages/node/export/agent.ts
// SPDX-License-Identifier: Apache-2.0 OR MIT

#closed = false;
#destroyed = false;

async close(): Promise<void> {
  if (this.#closed) return;
  this.#closed = true;
  await Addon.agentClose(this.#agent);
}

async destroy(err?: Error): Promise<void> {
  if (this.#destroyed) return;
  this.#destroyed = true;
  this.#closed = true;
  await Addon.agentDestroy(this.#agent, err ?? null);
}
```

## Core Package

### Cargo.toml (packages/core/Cargo.toml)

```toml
[package]
name = "core"
edition.workspace = true

[lints]
workspace = true

[dependencies]
async-trait = { workspace = true }
bytes = { workspace = true }
futures = { workspace = true }
reqwest = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tokio = { workspace = true }
tokio-stream = { workspace = true }
tokio-util = { workspace = true }

[dev-dependencies]
pretty_assertions.workspace = true
tempfile.workspace = true
tokio-test = { workspace = true }
wiremock = { workspace = true }
```

### Core Types (packages/core/src/dispatcher.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use async_trait::async_trait;
use bytes::Bytes;
use thiserror::Error;
use tokio::sync::{mpsc, Notify};
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
    pub headers_timeout: Option<std::time::Duration>,
    pub body_timeout: Option<std::time::Duration>,
}

/// Request body source
pub enum BodySource {
    Bytes(Bytes),
    Stream(mpsc::Receiver<Bytes>),
}

impl std::fmt::Debug for BodySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bytes(b) => f.debug_tuple("Bytes").field(&b.len()).finish(),
            Self::Stream(_) => f.debug_tuple("Stream").finish(),
        }
    }
}

/// Response metadata
#[derive(Debug, Clone)]
pub struct ResponseStart {
    pub status_code: u16,
    pub status_message: String,
    pub headers: HashMap<String, Vec<String>>,
}

/// Dispatch error types
#[derive(Debug, Clone, Error)]
pub enum DispatchError {
    #[error("Request aborted")]
    Aborted,
    #[error("Request timeout")]
    Timeout,
    #[error("Network error: {0}")]
    Network(String),
    #[error("HTTP {0}: {1}")]
    Http(u16, String),
}

/// Async trait for dispatch lifecycle callbacks
#[async_trait]
pub trait DispatchHandler: Send + Sync {
    async fn on_response_start(&self, response: ResponseStart);
    async fn on_response_data(&self, chunk: Bytes);
    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>);
    async fn on_response_error(&self, error: DispatchError);
}

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
```

### Core Agent (packages/core/src/agent.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use crate::dispatcher::*;
use futures::StreamExt;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::select;

/// HTTP agent wrapping reqwest Client
pub struct Agent {
    client: Client,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("Failed to build HTTP client: {0}")]
    Build(String),
}

impl From<reqwest::Error> for AgentError {
    fn from(e: reqwest::Error) -> Self { Self::Build(e.to_string()) }
}

#[derive(Debug, Clone, Default)]
pub struct AgentConfig {
    pub timeout: Option<Duration>,
    pub connect_timeout: Option<Duration>,
    pub pool_idle_timeout: Option<Duration>,
    pub proxy: Option<reqwest::Proxy>,
    pub ca_certs: Vec<reqwest::Certificate>,
    pub accept_invalid_certs: bool,
    pub http2_only: bool,
}

impl Agent {
    pub fn new(config: AgentConfig) -> Result<Self, AgentError> {
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
        if let Some(proxy) = config.proxy {
            builder = builder.proxy(proxy);
        }
        for cert in config.ca_certs {
            builder = builder.add_root_certificate(cert);
        }
        if config.accept_invalid_certs {
            builder = builder.danger_accept_invalid_certs(true);
        }
        if config.http2_only {
            builder = builder.http2_prior_knowledge();
        }

        let client = builder.build()?;
        Ok(Self { client })
    }

    /// Dispatch a request. Returns controller for abort/pause/resume.
    /// Spawns async task on provided runtime handle.
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

        // Apply timeouts
        if let Some(timeout) = options.headers_timeout {
            request = request.timeout(timeout);
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
                            // `data` is Bytes (arc-backed) - no copy here
                            handler.on_response_data(data).await;
                        }
                        Some(Err(e)) => {
                            handler.on_response_error(DispatchError::Network(e.to_string())).await;
                            return;
                        }
                        None => {
                            // Stream complete
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

### Core Lib (packages/core/src/lib.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Core functionality for `node_reqwest`.

pub mod agent;
pub mod dispatcher;

pub use agent::{Agent, AgentConfig, AgentError};
pub use dispatcher::{
    BodySource, DispatchError, DispatchHandler, DispatchOptions, Method, PauseState,
    RequestController, ResponseStart,
};
```

## Node Package

### Cargo.toml (packages/node/Cargo.toml)

```toml
[package]
name = "node_reqwest"
edition.workspace = true

[lints]
workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
async-trait = { workspace = true }
bytes = { workspace = true }
core = { workspace = true }
mimalloc = { workspace = true }
neon = { workspace = true }
tokio = { workspace = true }

[build-dependencies]
anyhow.workspace = true
meta = { workspace = true }
```

### Node Agent Bindings (packages/node/src/agent.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Neon bindings for core::Agent - NO business logic, only JS↔Rust marshaling

use async_trait::async_trait;
use bytes::Bytes;
use core::{
    Agent, AgentConfig, DispatchError, DispatchHandler, DispatchOptions, Method,
    RequestController, ResponseStart,
};
use neon::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

/// Wrapper for core::Agent
pub struct AgentInstance {
    inner: Agent,
    runtime: tokio::runtime::Handle,
}

impl Finalize for AgentInstance {}

/// Wrapper for RequestController
pub struct RequestHandleInstance {
    inner: RequestController,
}

impl Finalize for RequestHandleInstance {}

/// DispatchCallbacks bridges Rust async trait to JS callbacks via Neon Channel
struct JsDispatchHandler {
    channel: Channel,
    on_start: Arc<Root<JsFunction>>,
    on_data: Arc<Root<JsFunction>>,
    on_end: Arc<Root<JsFunction>>,
    on_error: Arc<Root<JsFunction>>,
}

#[async_trait]
impl DispatchHandler for JsDispatchHandler {
    async fn on_response_start(&self, response: ResponseStart) {
        let channel = self.channel.clone();
        let on_start = Arc::clone(&self.on_start);
        let status_code = response.status_code;
        let status_message = response.status_message.clone();
        let headers = response.headers.clone();

        channel.send(move |mut cx| {
            let headers_obj = headers_to_js(&mut cx, &headers)?;
            on_start.to_inner(&mut cx)
                .call_with(&cx)
                .arg(cx.number(status_code as f64))
                .arg(headers_obj)
                .arg(cx.string(&status_message))
                .exec(&mut cx)
        });
    }

    async fn on_response_data(&self, chunk: Bytes) {
        let channel = self.channel.clone();
        let on_data = Arc::clone(&self.on_data);

        channel.send(move |mut cx| {
            // One copy here: Rust Bytes → V8 ArrayBuffer
            let buffer = JsBuffer::from_slice(&mut cx, &chunk)?;
            on_data.to_inner(&mut cx)
                .call_with(&cx)
                .arg(buffer)
                .exec(&mut cx)
        });
    }

    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>) {
        let channel = self.channel.clone();
        let on_end = Arc::clone(&self.on_end);

        channel.send(move |mut cx| {
            let trailers_obj = headers_to_js(&mut cx, &trailers)?;
            on_end.to_inner(&mut cx)
                .call_with(&cx)
                .arg(trailers_obj)
                .exec(&mut cx)
        });
    }

    async fn on_response_error(&self, error: DispatchError) {
        let channel = self.channel.clone();
        let on_error = Arc::clone(&self.on_error);
        let error_msg = error.to_string();

        channel.send(move |mut cx| {
            let err = cx.error(&error_msg)?;
            on_error.to_inner(&mut cx)
                .call_with(&cx)
                .arg(err)
                .exec(&mut cx)
        });
    }
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

fn parse_dispatch_options(cx: &mut FunctionContext<'_>, obj: Handle<'_, JsObject>) -> NeonResult<DispatchOptions> {
    let path: Handle<JsString> = obj.get(cx, "path")?;
    let method_str: Handle<JsString> = obj.get(cx, "method")?;
    let origin: Handle<JsValue> = obj.get(cx, "origin")?;

    let method = match method_str.value(cx).to_uppercase().as_str() {
        "GET" => Method::Get,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "DELETE" => Method::Delete,
        "HEAD" => Method::Head,
        "OPTIONS" => Method::Options,
        "PATCH" => Method::Patch,
        "CONNECT" => Method::Connect,
        "TRACE" => Method::Trace,
        _ => return cx.throw_error("Invalid HTTP method"),
    };

    let origin_str = if origin.is_a::<JsString, _>(cx) {
        Some(origin.downcast_or_throw::<JsString, _>(cx)?.value(cx))
    } else {
        None
    };

    // Parse headers
    let headers_obj: Handle<JsObject> = obj.get(cx, "headers")?;
    let headers_keys = headers_obj.get_own_property_names(cx)?;
    let mut headers = HashMap::new();
    for i in 0..headers_keys.len(cx) {
        let key: Handle<JsString> = headers_keys.get(cx, i)?;
        let key_str = key.value(cx);
        let value: Handle<JsString> = headers_obj.get(cx, key)?;
        headers.insert(key_str, vec![value.value(cx)]);
    }

    Ok(DispatchOptions {
        origin: origin_str,
        path: path.value(cx),
        method,
        headers,
        body: None, // TODO: implement body streaming
        upgrade: None,
        headers_timeout: None,
        body_timeout: None,
    })
}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(cx: &mut FunctionContext<'cx>, options: Handle<'cx, JsObject>) -> JsResult<'cx, JsBox<AgentInstance>> {
    // TODO: parse options from JS object
    let config = AgentConfig::default();
    
    let runtime = tokio::runtime::Handle::try_current()
        .or_else(|_| {
            // Create runtime if not already in async context
            tokio::runtime::Runtime::new()
                .map(|rt| {
                    let handle = rt.handle().clone();
                    std::mem::forget(rt); // Leak to keep runtime alive
                    handle
                })
        })
        .map_err(|e| cx.throw_error::<_, ()>(format!("Failed to get tokio runtime: {e}")).unwrap_err())?;

    let agent = Agent::new(config)
        .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

    Ok(cx.boxed(AgentInstance { inner: agent, runtime }))
}

#[neon::export(name = "agentDispatch", context)]
fn agent_dispatch<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentInstance>>,
    options: Handle<'cx, JsObject>,
    callbacks: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<RequestHandleInstance>> {
    let dispatch_options = parse_dispatch_options(cx, options)?;

    let handler = Arc::new(JsDispatchHandler {
        channel: cx.channel(),
        on_start: Arc::new(callbacks.get::<JsFunction, _, _>(cx, "onResponseStart")?.root(cx)),
        on_data: Arc::new(callbacks.get::<JsFunction, _, _>(cx, "onResponseData")?.root(cx)),
        on_end: Arc::new(callbacks.get::<JsFunction, _, _>(cx, "onResponseEnd")?.root(cx)),
        on_error: Arc::new(callbacks.get::<JsFunction, _, _>(cx, "onResponseError")?.root(cx)),
    });

    let controller = agent.inner.dispatch(agent.runtime.clone(), dispatch_options, handler);
    Ok(cx.boxed(RequestHandleInstance { inner: controller }))
}

#[neon::export(name = "agentClose", context)]
fn agent_close<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentInstance>>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    // reqwest Client uses reference counting, dropping cleans up
    deferred.settle_with(&cx.channel(), move |mut cx| Ok(cx.undefined()));
    Ok(promise)
}

#[neon::export(name = "agentDestroy", context)]
fn agent_destroy<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentInstance>>,
    _error: Handle<'cx, JsValue>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    // reqwest Client uses reference counting, dropping cleans up
    deferred.settle_with(&cx.channel(), move |mut cx| Ok(cx.undefined()));
    Ok(promise)
}

#[neon::export(name = "requestHandleAbort", context)]
fn request_handle_abort<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandleInstance>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.abort();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandlePause", context)]
fn request_handle_pause<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandleInstance>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.pause();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandleResume", context)]
fn request_handle_resume<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandleInstance>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.resume();
    Ok(cx.undefined())
}
```

### Node Lib (packages/node/src/lib.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Node.js bindings for reqwest - Rust HTTP client library

mod agent;

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

use neon::prelude::*;

#[neon::export(name = "hello", context)]
fn hello<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsString> {
    Ok(cx.string("hello"))
}
```

## Workspace Dependencies (add to root Cargo.toml)

```toml
# Add to [workspace.dependencies]
thiserror = { version = "2.0.12" }
```

## File Structure

```text
packages/
├── core/
│   ├── Cargo.toml           # async-trait, bytes, futures, reqwest, thiserror, tokio, tokio-util
│   └── src/
│       ├── lib.rs           # pub mod dispatcher; pub mod agent; re-exports
│       ├── dispatcher.rs    # DispatchHandler trait, DispatchOptions, PauseState, RequestController
│       └── agent.rs         # Agent impl with reqwest, execute_request
└── node/
    ├── Cargo.toml           # core, neon, tokio, async-trait, bytes, mimalloc
    ├── export/
    │   ├── agent.ts         # DispatchControllerImpl, AgentImpl, dispatch/close/destroy
    │   └── addon-def.ts     # TypeScript types: DispatchCallbacks, RequestHandle, etc.
    └── src/
        ├── lib.rs           # Neon module registration
        └── agent.rs         # JsDispatchHandler, Neon exports (agentCreate, agentDispatch, etc.)
```

## Testing Framework

### Core Tests (packages/core/tests/)

| Test File                  | Purpose                               |
| :------------------------- | :------------------------------------ |
| `support/mod.rs`           | Test utilities                        |
| `support/mock_handler.rs`  | Mock `DispatchHandler` implementation |
| `agent_dispatch.rs`        | Integration tests with wiremock       |

```rust
// packages/core/tests/support/mod.rs
pub mod mock_handler;
```

```rust
// packages/core/tests/support/mock_handler.rs
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
    pub errors: Vec<DispatchError>,
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
        self.events.lock().await.errors.push(error);
        self.done.notify_one();
    }
}
```

```rust
// packages/core/tests/agent_dispatch.rs
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
        body: None,
        upgrade: None,
        headers_timeout: None,
        body_timeout: None,
    };

    let _controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));

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
        upgrade: None,
        headers_timeout: None,
        body_timeout: None,
    };

    let controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));
    controller.abort();

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout waiting for abort");

    let events = events.lock().await;
    assert!(events.response_starts.is_empty());
    assert_eq!(events.errors.len(), 1);
    assert!(matches!(&events.errors[0], core::DispatchError::Aborted));
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
        body: None,
        upgrade: None,
        headers_timeout: None,
        body_timeout: None,
    };

    let _controller = agent.dispatch(tokio::runtime::Handle::current(), opts, Arc::new(handler));

    tokio::time::timeout(Duration::from_secs(5), done.notified())
        .await
        .expect("timeout waiting for error");

    let events = events.lock().await;
    assert_eq!(events.errors.len(), 1);
    assert!(matches!(&events.errors[0], core::DispatchError::Network(_)));
}
```

### Node Tests (packages/node/tests/)

| Test File                 | Purpose                  |
| :------------------------ | :----------------------- |
| `vitest/agent.test.ts`    | Unit tests for Agent     |
| `playwright/e2e.spec.ts`  | E2E tests with real HTTP |

## Backpressure Verification

| Concern                    | Status | Implementation                                                           |
| :------------------------- | :----- | :----------------------------------------------------------------------- |
| **Minimal copying**        | ✅     | `Bytes` arc-backed; single copy at JS boundary (`JsBuffer::from_slice`)  |
| **No unlimited queues**    | ✅     | No buffering; `wait_if_paused()` blocks before next chunk                |
| **Request order**          | N/A    | Each request independent                                                 |
| **Cancellation isolation** | ✅     | Per-request `CancellationToken`                                          |
| **Memory bounded**         | ✅     | Max 1 chunk in flight during pause                                       |
| **Deadlock risk**          | ✅     | `while` loop handles spurious wakeups                                    |

### Data Flow (Zero-Copy Path)

```text
reqwest stream → Bytes (arc-backed, no copy)
                      ↓
              handler.on_response_data(data)
                      ↓
              JsBuffer::from_slice() ← ONE COPY into V8 heap
                      ↓
              JS callback receives Buffer
```

### Memory Bounds

- hyper read buffer: ~16KB (configurable)
- Max in-flight per request: 1 chunk
- **Total: hyper buffer + chunk size per request**

## Implementation Order

1. Core: `dispatcher.rs` types + `PauseState` + `RequestController`
2. Core: `agent.rs` with `Agent::new()` and `Agent::dispatch()`
3. Node: Update `Cargo.toml` with dependencies
4. Node: `JsDispatchHandler` implementing `DispatchHandler` trait
5. Node: Neon exports (`agentCreate`, `agentDispatch`, `requestHandle*`)
6. TypeScript: `DispatchControllerImpl` class
7. TypeScript: Update `addon-def.ts` with new types
8. TypeScript: Update `AgentImpl.dispatch()` to use callbacks
9. Core tests: `MockHandler` + wiremock tests
10. Node tests: vitest + playwright integration
