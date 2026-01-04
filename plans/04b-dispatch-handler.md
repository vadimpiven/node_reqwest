# Dispatch Handler + Marshaling (Chunk 4B)

## Problem/Purpose

Bridge Rust's asynchronous lifecycle events to JavaScript callbacks while ensuring thread
safety and minimal data copying.

## Solution

Implement `JsDispatchHandler` using Neon's `Channel` to marshal events (start, data, end,
error) from the Rust background thread to the JavaScript main thread.

## Architecture

```text
Rust Task (Background Thread)
  └─ JsDispatchHandler (calls)
       └─ channel.send() 
            └─ JavaScript Callback (Main Thread)
```

## Implementation

### packages/node/src/agent.rs (Add JsDispatchHandler)

```rust
use async_trait::async_trait;
use bytes::Bytes;
use core::{CoreError, DispatchHandler, ResponseStart};
use std::collections::HashMap;
use std::sync::Arc;

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
        let status = response.status_code;
        channel.send(move |mut cx| {
            on_start.to_inner(&mut cx).call_with(&cx).arg(cx.number(status)).exec(&mut cx)
        });
    }

    async fn on_response_data(&self, chunk: Bytes) {
        let channel = self.channel.clone();
        let on_data = Arc::clone(&self.on_data);
        channel.send(move |mut cx| {
            let buffer = JsBuffer::from_slice(&mut cx, &chunk)?;
            on_data.to_inner(&mut cx).call_with(&cx).arg(buffer).exec(&mut cx)
        });
    }

    async fn on_response_error(&self, error: core::DispatchError) {
        let channel = self.channel.clone();
        let on_error = Arc::clone(&self.on_error);
        let msg = error.to_string();
        channel.send(move |mut cx| {
            let error_info = cx.empty_object();
            // Simple mapping for now
            error_info.set(&mut cx, "message", cx.string(msg))?;
            on_error.to_inner(&mut cx).call_with(&cx).arg(error_info).exec(&mut cx)
        });
    }

    async fn on_response_end(&self, _trailers: HashMap<String, Vec<String>>) {
        let channel = self.channel.clone();
        let on_end = Arc::clone(&self.on_end);
        channel.send(move |mut cx| {
            on_end.to_inner(&mut cx).call_with(&cx).exec(&mut cx)
        });
    }
}
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Communication** | `neon::event::Channel` |
| **Data Flow** | 1 Copy for Body Chunks |
| **Thread Safety** | Arc-wrapped JS Functions |

## File Structure

```text
packages/node/
└── src/
    └── agent.rs
```
