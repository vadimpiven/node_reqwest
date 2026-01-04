# Request Handle Bindings + Tests (Chunk 03c)

## Problem/Purpose

Provide JavaScript with the ability to control in-flight requests via native bindings for
abort and backpressure operations.

## Solution

Expose `RequestController` to JavaScript via boxed `RequestHandleInstance` and export
`agentDispatch` with callback marshaling. Uses Neon's global runtime via `spawn`.

## Architecture

```text
JavaScript
  └─► agentDispatch(agent, options, callbacks)
       └─► FFI
            └─► Agent::dispatch(runtime, options, handler)
                 └─► RequestController ──► JsBox<RequestHandleInstance>
                                                │
JavaScript                                      ▼
  └─► requestHandleAbort(handle) ──► RequestController::abort()
  └─► requestHandlePause(handle) ──► RequestController::pause()
  └─► requestHandleResume(handle) ─► RequestController::resume()
```

## Implementation

### packages/node/src/agent.rs (Complete)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Neon bindings for core::Agent - NO business logic, only JS↔Rust marshaling.

use std::sync::Arc;
use std::time::Duration;

use core::{Agent, AgentConfig, RequestController};
use neon::prelude::*;

use crate::dispatch::parse_dispatch_options;
use crate::handler::JsDispatchHandler;

/// Wrapper for core::Agent stored as JsBox.
pub struct AgentInstance {
    pub inner: Agent,
}

impl Finalize for AgentInstance {}

/// Wrapper for RequestController stored as JsBox.
pub struct RequestHandleInstance {
    pub inner: RequestController,
}

impl Finalize for RequestHandleInstance {}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(
    cx: &mut FunctionContext<'cx>,
    options: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<AgentInstance>> {
    // timeout: Total request timeout (request start to response complete)
    let timeout: Handle<JsNumber> = options.get(cx, "timeout")?;
    // keepAliveTimeout: How long to keep idle connections alive (maps to pool_idle_timeout)
    let keep_alive_timeout: Handle<JsNumber> = options.get(cx, "keepAliveTimeout")?;

    let timeout_ms = timeout.value(cx) as u64;
    let pool_idle_timeout_ms = keep_alive_timeout.value(cx) as u64;

    // Note: reqwest doesn't expose direct connect_timeout separate from total timeout.
    // We use the keepAliveTimeout as pool_idle_timeout since that's the most appropriate mapping.
    let config = AgentConfig {
        timeout: if timeout_ms > 0 {
            Some(Duration::from_millis(timeout_ms))
        } else {
            None
        },
        connect_timeout: None, // Let reqwest use its default
        pool_idle_timeout: if pool_idle_timeout_ms > 0 {
            Some(Duration::from_millis(pool_idle_timeout_ms))
        } else {
            None
        },
    };

    let agent = Agent::new(config)
        .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

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

    let handler = Arc::new(JsDispatchHandler::new(
        cx.channel(),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseStart")?.root(cx),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseData")?.root(cx),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseEnd")?.root(cx),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseError")?.root(cx),
    ));

    // Use tokio's current runtime handle (Neon's global runtime)
    let runtime = tokio::runtime::Handle::current();
    let controller = agent.inner.dispatch(runtime, dispatch_options, handler);

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

### packages/node/tests/vitest/addon-smoke.test.ts (Complete)

```typescript
import { describe, it, expect, vi } from 'vitest';

import { Addon } from '../../export/addon.ts';

describe('Addon Smoke Tests', () => {
  it('should load the addon', () => {
    expect(Addon).toBeDefined();
    expect(Addon.hello).toBeInstanceOf(Function);
  });

  it('should call hello() and return greeting', () => {
    const result = Addon.hello();
    expect(result).toBe('hello');
  });

  it('should create an agent instance', () => {
    const agent = Addon.agentCreate({
      allowH2: true,
      ca: [],
      keepAliveTimeout: 4000,
      localAddress: null,
      proxy: { type: 'system' },
      rejectInvalidHostnames: true,
      rejectUnauthorized: true,
      timeout: 10000,
    });
    expect(agent).toBeDefined();
  });

  it('should dispatch and return a handle', () => {
    const agent = Addon.agentCreate({
      allowH2: true,
      ca: [],
      keepAliveTimeout: 4000,
      localAddress: null,
      proxy: { type: 'system' },
      rejectInvalidHostnames: true,
      rejectUnauthorized: true,
      timeout: 10000,
    });

    const handle = Addon.agentDispatch(
      agent,
      {
        blocking: false,
        body: null,
        bodyTimeout: 300000,
        expectContinue: false,
        headers: {},
        headersTimeout: 300000,
        idempotent: true,
        method: 'GET',
        origin: '',
        path: '/',
        query: '',
        reset: false,
        throwOnError: false,
        upgrade: null,
      },
      {
        onResponseStart: vi.fn(),
        onResponseData: vi.fn(),
        onResponseEnd: vi.fn(),
        onResponseError: vi.fn(),
      }
    );

    expect(handle).toBeDefined();
    Addon.requestHandleAbort(handle);
  });

  it('should support pause and resume', () => {
    const agent = Addon.agentCreate({
      allowH2: true,
      ca: [],
      keepAliveTimeout: 4000,
      localAddress: null,
      proxy: { type: 'system' },
      rejectInvalidHostnames: true,
      rejectUnauthorized: true,
      timeout: 10000,
    });

    const handle = Addon.agentDispatch(
      agent,
      {
        blocking: false,
        body: null,
        bodyTimeout: 300000,
        expectContinue: false,
        headers: {},
        headersTimeout: 300000,
        idempotent: true,
        method: 'GET',
        origin: '',
        path: '/',
        query: '',
        reset: false,
        throwOnError: false,
        upgrade: null,
      },
      {
        onResponseStart: vi.fn(),
        onResponseData: vi.fn(),
        onResponseEnd: vi.fn(),
        onResponseError: vi.fn(),
      }
    );

    // Should not throw
    Addon.requestHandlePause(handle);
    Addon.requestHandleResume(handle);
    Addon.requestHandleAbort(handle);
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Control Types** | Abort, Pause, Resume |
| **Handle Lifecycle** | JS garbage collected via `Finalize` |
| **Runtime Access** | `tokio::runtime::Handle::current()` |
| **Tests** | 5 smoke tests |

## File Structure

```text
packages/node/
├── src/
│   ├── lib.rs
│   ├── agent.rs
│   ├── body.rs
│   ├── dispatch.rs
│   └── handler.rs
└── tests/vitest/
    └── addon-smoke.test.ts
```
