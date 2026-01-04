# Request Handle Bindings + Tests (Chunk 4C)

## Problem/Purpose

Provide JavaScript with the ability to control in-flight requests via native bindings for
abort and backpressure operations.

## Solution

Expose the `RequestController` to JavaScript via a boxed `RequestHandleInstance` and export
functions to trigger its methods. Uses `JsDispatchHandler` from chunk 4B.

## Architecture

```text
JavaScript (Handle)
  └─ requestHandleAbort() 
       └─ FFI
            └─ RequestController::abort() -> CancellationToken.cancel()
```

## Implementation

### packages/node/src/agent.rs (Add Dispatch and Control Functions)

```rust
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

### packages/node/tests/vitest/addon-smoke.test.ts (Add Dispatch Test)

```typescript
import { describe, it, expect, vi } from 'vitest';
import Addon from '../../index.node';

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
      timeout: 0,
      connectTimeout: 0,
      poolIdleTimeout: 0,
    });
    expect(agent).toBeDefined();
  });

  it('should dispatch and return a handle', () => {
    const agent = Addon.agentCreate({
      timeout: 0,
      connectTimeout: 0,
      poolIdleTimeout: 0,
    });

    const handle = Addon.agentDispatch(
      agent,
      {
        path: '/',
        method: 'GET',
        headers: {},
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
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Control Types** | Abort, Pause, Resume |
| **Handle Lifecycle** | JS Garbage Collected (via Finalize) |
| **Verification** | 4 smoke tests |

## File Structure

```text
packages/node/
├── src/
│   └── agent.rs
└── tests/vitest/
    └── addon-smoke.test.ts
```
