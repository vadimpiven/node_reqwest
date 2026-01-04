# Request Handle Bindings + Tests (Chunk 4C)

## Problem/Purpose

Provide JavaScript with the ability to control in-flight requests via native bindings for
abort and backpressure operations.

## Solution

Expose the `RequestController` to JavaScript via a boxed `RequestHandleInstance` and export
functions to trigger its methods.

## Architecture

```text
JavaScript (Handle)
  └─ requestHandleAbort() 
       └─ FFI
            └─ RequestController::abort() -> CancellationToken.cancel()
```

## Implementation

### packages/node/src/agent.rs (Add Request Handles)

```rust
use core::RequestController;

pub struct RequestHandleInstance {
    pub inner: RequestController,
}

impl Finalize for RequestHandleInstance {}

#[neon::export(name = "agentDispatch", context)]
fn agent_dispatch<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentInstance>>,
    options: Handle<'cx, JsObject>,
    callbacks: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<RequestHandleInstance>> {
    // ... parse options and create JsDispatchHandler (from 4B) ...
    let controller = agent.inner.dispatch(agent.runtime.clone(), dispatch_options, handler);
    Ok(cx.boxed(RequestHandleInstance { inner: controller }))
}

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

### packages/node/tests/vitest/addon-smoke.test.ts

```typescript
import { describe, it, expect } from 'vitest';
import Addon from '../../index.node';

describe('FFI Control', () => {
  it('should dispatch and return a handle', () => {
    const agent = Addon.agentCreate({ timeout: 0, connectTimeout: 0, poolIdleTimeout: 0 });
    const handle = Addon.agentDispatch(agent, { path: '/', method: 'GET', headers: {} }, {
      onResponseStart: () => {}, onResponseData: () => {}, onResponseEnd: () => {}, onResponseError: () => {}
    });
    expect(handle).toBeDefined();
    Addon.requestHandleAbort(handle);
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Control Types** | Abort, Pause, Resume |
| **Handle Lifecycle** | JS Garbage Collected (via Finalize) |
| **Verification** | Smoke test for handle creation |

## File Structure

```text
packages/node/
└── src/
    └── agent.rs
```
