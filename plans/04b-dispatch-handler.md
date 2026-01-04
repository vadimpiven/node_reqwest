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
use core::{CoreError, DispatchHandler, DispatchOptions, Method, RequestController, ResponseStart};
use std::collections::HashMap;
use std::sync::Arc;

/// Wrapper for RequestController
pub struct RequestHandleInstance {
    pub inner: RequestController,
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
