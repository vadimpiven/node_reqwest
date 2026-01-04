# FFI Boundary

Neon bindings to marshal Core functionality to Node.js.

**Prerequisites**: 01-core-foundation.md, 02-core-backpressure.md, 03-error-handling.md complete

## Goal

Verify Rust↔JS marshaling works for basic dispatch operations and error handling.

## Dependencies (packages/node/Cargo.toml)

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

## Addon Interface Types (packages/node/export/addon-def.ts)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { IncomingHttpHeaders } from 'undici';
import type { CoreErrorInfo } from './errors';

export interface RequestHandle {
  readonly _: unique symbol;
}

export type DispatchCallbacks = {
  onResponseStart: (statusCode: number, headers: IncomingHttpHeaders, statusMessage: string) => void;
  onResponseData: (chunk: Buffer) => void;
  onResponseEnd: (trailers: IncomingHttpHeaders) => void;
  onResponseError: (error: CoreErrorInfo) => void;
};

export type AgentCreationOptions = {
  timeout: number;
  connectTimeout: number;
  poolIdleTimeout: number;
};

export type AgentDispatchOptions = {
  origin: string;
  path: string;
  method: string;
  headers: Record<string, string>;
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

## Neon Bindings (packages/node/src/agent.rs)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Neon bindings for core::Agent - NO business logic, only JS↔Rust marshaling

use async_trait::async_trait;
use bytes::Bytes;
use core::{
    Agent, AgentConfig, CoreError, DispatchHandler, DispatchOptions, Method,
    RequestController, ResponseStart,
};
use neon::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

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

    async fn on_response_error(&self, error: core::DispatchError) {
        // Convert DispatchError to CoreError for consistent error handling
        let core_error = match error {
            core::DispatchError::Aborted => CoreError::RequestAborted,
            core::DispatchError::Timeout => CoreError::ConnectTimeout,
            core::DispatchError::Network(msg) => CoreError::Network(msg),
            core::DispatchError::Http(code, msg) => CoreError::ResponseError {
                status_code: code,
                message: msg,
            },
        };

        let channel = self.channel.clone();
        let on_error = Arc::clone(&self.on_error);
        let error_code = core_error.error_code().to_string();
        let error_name = core_error.error_name().to_string();
        let error_msg = core_error.to_string();
        let status_code = core_error.status_code();

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
    })
}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(cx: &mut FunctionContext<'cx>, options: Handle<'cx, JsObject>) -> JsResult<'cx, JsBox<AgentInstance>> {
    let timeout: Handle<JsNumber> = options.get(cx, "timeout")?;
    let connect_timeout: Handle<JsNumber> = options.get(cx, "connectTimeout")?;
    let pool_idle_timeout: Handle<JsNumber> = options.get(cx, "poolIdleTimeout")?;

    let timeout_ms = timeout.value(cx) as u64;
    let connect_timeout_ms = connect_timeout.value(cx) as u64;
    let pool_idle_timeout_ms = pool_idle_timeout.value(cx) as u64;

    let config = AgentConfig {
        timeout: if timeout_ms > 0 { Some(Duration::from_millis(timeout_ms)) } else { None },
        connect_timeout: if connect_timeout_ms > 0 { Some(Duration::from_millis(connect_timeout_ms)) } else { None },
        pool_idle_timeout: if pool_idle_timeout_ms > 0 { Some(Duration::from_millis(pool_idle_timeout_ms)) } else { None },
    };
    
    let runtime = tokio::runtime::Handle::try_current()
        .or_else(|_| {
            tokio::runtime::Runtime::new()
                .map(|rt| {
                    let handle = rt.handle().clone();
                    std::mem::forget(rt);
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

## Lib (packages/node/src/lib.rs)

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

## Tests (packages/node/tests/vitest/addon-smoke.test.ts)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, expect } from 'vitest';
import Addon from '../../index.node';

describe('Addon Smoke Tests', () => {
  it('should load the addon', () => {
    expect(Addon).toBeDefined();
  });

  it('should call hello()', () => {
    expect(Addon.hello()).toBe('hello');
  });

  it('should create an agent', () => {
    const agent = Addon.agentCreate({
      timeout: 5000,
      connectTimeout: 2000,
      poolIdleTimeout: 30000,
    });
    expect(agent).toBeDefined();
  });

  it('should dispatch a request with callbacks', async () => {
    const agent = Addon.agentCreate({
      timeout: 5000,
      connectTimeout: 2000,
      poolIdleTimeout: 0,
    });

    const events: string[] = [];
    let statusCode = 0;

    const handle = Addon.agentDispatch(
      agent,
      {
        origin: 'https://httpbin.org',
        path: '/status/200',
        method: 'GET',
        headers: {},
      },
      {
        onResponseStart: (code, headers, statusMsg) => {
          events.push('start');
          statusCode = code;
        },
        onResponseData: (chunk) => {
          events.push('data');
        },
        onResponseEnd: (trailers) => {
          events.push('end');
        },
        onResponseError: (error) => {
          events.push('error');
        },
      }
    );

    expect(handle).toBeDefined();

    // Wait for response
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(events).toContain('start');
    expect(statusCode).toBe(200);
  });
});
```

## File Structure

```text
packages/node/
├── Cargo.toml              # Dependencies
├── export/
│   └── addon-def.ts        # TypeScript interface definitions
├── src/
│   ├── lib.rs             # Neon module registration
│   └── agent.rs           # NEW: All Neon bindings
└── tests/vitest/
    └── addon-smoke.test.ts # NEW: FFI smoke tests
```

## Verification

```bash
cd packages/node
pnpm build
pnpm test addon-smoke.test.ts
```
