# Request Handle Bindings + Tests (Chunk 03c)

## Purpose

Expose abort/pause/resume controls for in-flight requests to JS, and wire up
`agentDispatch` with callback marshaling.

## Approach

- Box `RequestController` as `RequestHandleBox` (`JsBox` + `Finalize`).
- Drive async lifecycle (`close`/`destroy`) and `dispatch` through
  `neon::macro_internal::spawn`. `tokio::runtime::Handle::current()` panics on
  the JS thread, so all runtime access goes through Neon's accessor.

## GC Anchor Contract

The JS `DispatchControllerImpl` keeps the `JsBox<RequestHandleBox>` reachable
through `#requestHandle` for the request's lifetime. When the controller is
dropped, `Finalize` on the `JsBox` triggers `Drop` on `RequestController`,
which cancels the underlying `CancellationToken`. Callers must therefore hold
the controller as long as they want the request to live.

## Architecture

```text
JavaScript
  └─► agentDispatch(agent, options, callbacks)
       └─► FFI
            └─► spawn(cx, async { agent.dispatch(...) })
                 └─► RequestController ──► JsBox<RequestHandleBox>
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

use core::{Agent, AgentConfig, RequestController};
use neon::prelude::*;

use crate::dispatch::parse_dispatch_options;
use crate::handler::JsDispatchHandler;

/// JsBox wrapper for `core::Agent`. Arc so async close/destroy can clone.
pub struct AgentBox {
    pub inner: Arc<Agent>,
}

impl Finalize for AgentBox {}

/// JsBox wrapper for `RequestController`. `Drop` on the inner controller
/// cancels the request token; see "GC Anchor Contract" above.
pub struct RequestHandleBox {
    pub inner: RequestController,
}

impl Finalize for RequestHandleBox {}

// agentCreate: see 03a-ffi-types.md for full option parsing
// (timeouts, CA bundle, TLS flags, localAddress, redirect cap, etc.).

#[neon::export(name = "agentDispatch", context)]
fn agent_dispatch<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentBox>>,
    options: Handle<'cx, JsObject>,
    callbacks: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<RequestHandleBox>> {
    let dispatch_options = parse_dispatch_options(cx, options)?;

    let handler = Arc::new(JsDispatchHandler::new(
        cx.channel(),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseStart")?.root(cx),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseData")?.root(cx),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseEnd")?.root(cx),
        callbacks.get::<JsFunction, _, _>(cx, "onResponseError")?.root(cx),
    ));

    // Enter Neon's runtime to start the dispatch task. `Handle::current()`
    // would panic here because we are on the JS thread.
    use neon::macro_internal::runtime;
    let runtime = runtime(cx).handle().clone();
    let controller = agent
        .inner
        .dispatch(runtime, dispatch_options, handler)
        .or_else(|e| cx.throw_error(e.to_string()))?;

    Ok(cx.boxed(RequestHandleBox { inner: controller }))
}

#[neon::export(name = "agentClose", context)]
fn agent_close<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentBox>>,
) -> JsResult<'cx, JsPromise> {
    use core::Lifecycle;
    use neon::macro_internal::spawn;

    let agent = Arc::clone(&agent.inner);
    spawn(
        cx,
        async move {
            agent.close().await;
            Ok(())
        },
        |mut cx, result: Result<(), String>| match result {
            Ok(()) => Ok(cx.undefined()),
            Err(e) => cx.throw_error(e),
        },
    )
}

#[neon::export(name = "agentDestroy", context)]
fn agent_destroy<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentBox>>,
) -> JsResult<'cx, JsPromise> {
    use core::{CoreError, Lifecycle};
    use neon::macro_internal::spawn;

    let agent = Arc::clone(&agent.inner);
    spawn(
        cx,
        async move {
            agent.destroy(CoreError::ClientDestroyed).await;
            Ok(())
        },
        |mut cx, result: Result<(), String>| match result {
            Ok(()) => Ok(cx.undefined()),
            Err(e) => cx.throw_error(e),
        },
    )
}

#[neon::export(name = "requestHandleAbort", context)]
fn request_handle_abort<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandleBox>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.abort();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandlePause", context)]
fn request_handle_pause<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandleBox>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.pause();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandleResume", context)]
fn request_handle_resume<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandleBox>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.resume();
    Ok(cx.undefined())
}
```

### packages/node/tests/vitest/addon-smoke.test.ts (Complete)

Smoke targets use `http://127.0.0.1:1/` (port 1 is always refused on
Linux/macOS) instead of `localhost:9999` to avoid collision with real
local services. Each dispatch awaits `onResponseError` so a regression that
fails to invoke the callback is caught.

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, expect, vi } from "vitest";

import { Addon } from "../../export/addon.ts";

const baseOptions = {
    allowH2: true,
    autoSelectFamily: true,
    bodyTimeout: 300000 as number | null,
    ca: [] as string[],
    connectTimeout: 10000 as number | null,
    headersTimeout: 300000 as number | null,
    keepAliveTimeout: 4000 as number | null,
    localAddress: null,
    maxRedirections: 0,
    maxResponseSize: null,
    proxy: { type: "no-proxy" as const },
    rejectInvalidHostnames: true,
    rejectUnauthorized: true,
    timeout: 10000 as number | null,
};

const baseDispatch = {
    body: null,
    bodyTimeout: null,
    headers: {},
    headersTimeout: null,
    method: "GET",
    origin: "http://127.0.0.1:1",
    path: "/",
    query: "",
    throwOnError: false,
};

describe("Addon Smoke Tests", () => {
    it("should load the addon", () => {
        expect(Addon).toBeDefined();
        expect(Addon.hello).toBeInstanceOf(Function);
    });

    it("should call hello() and return greeting", () => {
        expect(Addon.hello()).toBe("hello");
    });

    it("should create an agent instance", () => {
        const agent = Addon.agentCreate(baseOptions);
        expect(agent).toBeDefined();
    });

    it("should dispatch and surface error from refused port", async () => {
        const agent = Addon.agentCreate(baseOptions);
        await new Promise<void>((resolve, reject) => {
            const handle = Addon.agentDispatch(agent, baseDispatch, {
                onResponseStart: vi.fn(),
                onResponseData: vi.fn(),
                onResponseEnd: vi.fn(),
                onResponseError: (err) => {
                    try {
                        expect(err.code).toBeDefined();
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                },
            });
            expect(handle).toBeDefined();
        });
    });

    it("should support pause and resume without throwing", () => {
        const agent = Addon.agentCreate(baseOptions);
        const handle = Addon.agentDispatch(agent, baseDispatch, {
            onResponseStart: vi.fn(),
            onResponseData: vi.fn(),
            onResponseEnd: vi.fn(),
            onResponseError: vi.fn(),
        });
        Addon.requestHandlePause(handle);
        Addon.requestHandleResume(handle);
        Addon.requestHandleAbort(handle);
    });

    it("should close agent gracefully", async () => {
        const agent = Addon.agentCreate(baseOptions);
        await Addon.agentClose(agent);
    });

    it("should destroy agent", async () => {
        const agent = Addon.agentCreate(baseOptions);
        await Addon.agentDestroy(agent);
    });
});
```

## Key Choices

| Item                 | Value                                                |
| :------------------- | :--------------------------------------------------- |
| **Control Types**    | Abort, Pause, Resume                                 |
| **Handle Lifecycle** | JS-GC via `Finalize`; controller anchors handle      |
| **Runtime Access**   | `neon::macro_internal::{runtime, spawn}` (JS thread) |
| **Lifecycle**        | close/destroy via Lifecycle trait                    |
| **Naming**           | `AgentBox` / `RequestHandleBox`                      |
| **Tests**            | 6 smoke tests; target `http://127.0.0.1:1/`          |

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
