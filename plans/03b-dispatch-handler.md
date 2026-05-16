# Dispatch Handler + Request Body Streaming (Chunk 03b)

## Purpose

Bridge Rust async lifecycle events to JS callbacks and stream request bodies
from a default `ReadableStreamDefaultReader<Uint8Array>` into reqwest with
per-chunk backpressure.

## Approach

- Response data: push from Rust, ack from JS (oneshot). Ack signals "callback
  returned"; it does NOT prove the consumer drained the chunk. JS-paced.
- Request body: pull from JS (oneshot reply per chunk). One in-flight chunk.
- Reader errors (`read()` rejects) propagate as `std::io::Error` to the
  reqwest body stream — never swallowed as EOF.
- Channel-closure bodies are wrapped in `std::panic::catch_unwind` so a
  user-callback panic cannot unwind across the FFI boundary.

## Architecture

See `00-overview.md` for the cross-plan diagram.

## Implementation

### packages/node/src/handler.rs

````rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Bridges Rust async lifecycle to JS callbacks via Neon `Channel`.
//!
//! Response data uses ack-gated push: Rust sends a chunk, JS replies via
//! oneshot once the callback returns. Ack ≠ consumer drained — it only
//! proves the synchronous callback finished. Honest JS pacing, no
//! unbounded buffering: at most one chunk is in flight per request.
//! `Set-Cookie` is always delivered as an array per undici Dispatcher spec.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use neon::prelude::*;
use tokio::sync::oneshot;

use core::{CoreError, DispatchHandler, ResponseStart};

/// Convert headers to a JS object. Always emits arrays for multi-value
/// headers and for `Set-Cookie` (undici Dispatcher contract).
fn headers_to_js<'a>(
    cx: &mut Cx<'a>,
    headers: &HashMap<String, Vec<String>>,
) -> JsResult<'a, JsObject> {
    let obj = cx.empty_object();
    for (key, values) in headers {
        let always_array = key.eq_ignore_ascii_case("set-cookie");
        if values.len() == 1 && !always_array {
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

pub struct JsDispatchHandler {
    channel: Channel,
    on_start: Arc<Root<JsFunction>>,
    on_data: Arc<Root<JsFunction>>,
    on_end: Arc<Root<JsFunction>>,
    on_error: Arc<Root<JsFunction>>,
}

impl JsDispatchHandler {
    pub fn new(
        channel: Channel,
        on_start: Root<JsFunction>,
        on_data: Root<JsFunction>,
        on_end: Root<JsFunction>,
        on_error: Root<JsFunction>,
    ) -> Self {
        Self {
            channel,
            on_start: Arc::new(on_start),
            on_data: Arc::new(on_data),
            on_end: Arc::new(on_end),
            on_error: Arc::new(on_error),
        }
    }
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
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| -> NeonResult<()> {
                let headers_obj = headers_to_js(&mut cx, &headers)?;
                on_start
                    .to_inner(&mut cx)
                    .call_with(&cx)
                    .arg(cx.number(status_code as f64))
                    .arg(headers_obj)
                    .arg(cx.string(&status_message))
                    .exec(&mut cx)
            }));
            match result {
                Ok(r) => r,
                Err(_) => cx.throw_error("panic in onResponseStart callback"),
            }
        });
    }

    async fn on_response_data(&self, chunk: Bytes) {
        let (tx, rx) = oneshot::channel::<()>();
        let channel = self.channel.clone();
        let on_data = Arc::clone(&self.on_data);

        channel.send(move |mut cx| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| -> NeonResult<()> {
                let buffer = JsBuffer::from_slice(&mut cx, &chunk)?;
                on_data
                    .to_inner(&mut cx)
                    .call_with(&cx)
                    .arg(buffer)
                    .exec(&mut cx)?;
                let _ = tx.send(());
                Ok(())
            }));
            match result {
                Ok(r) => r,
                Err(_) => cx.throw_error("panic in onResponseData callback"),
            }
        });

        let _ = rx.await;
    }

    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>) {
        let channel = self.channel.clone();
        let on_end = Arc::clone(&self.on_end);

        channel.send(move |mut cx| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| -> NeonResult<()> {
                let trailers_obj = headers_to_js(&mut cx, &trailers)?;
                on_end
                    .to_inner(&mut cx)
                    .call_with(&cx)
                    .arg(trailers_obj)
                    .exec(&mut cx)
            }));
            match result {
                Ok(r) => r,
                Err(_) => cx.throw_error("panic in onResponseEnd callback"),
            }
        });
    }

    async fn on_response_error(&self, error: CoreError) {
        let channel = self.channel.clone();
        let on_error = Arc::clone(&self.on_error);
        let error_code = error.error_code().to_string();
        let error_msg = error.to_string();
        let status_code = error.status_code();

        channel.send(move |mut cx| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| -> NeonResult<()> {
                let error_info = cx.empty_object();
                error_info.set(&mut cx, "code", cx.string(&error_code))?;
                error_info.set(&mut cx, "message", cx.string(&error_msg))?;
                if let Some(code) = status_code {
                    error_info.set(&mut cx, "statusCode", cx.number(code as f64))?;
                }
                on_error
                    .to_inner(&mut cx)
                    .call_with(&cx)
                    .arg(error_info)
                    .exec(&mut cx)
            }));
            match result {
                Ok(r) => r,
                Err(_) => cx.throw_error("panic in onResponseError callback"),
            }
        });
    }
}
````

### packages/node/src/body.rs

````rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Streams request bodies from a JS `ReadableStreamDefaultReader<Uint8Array>`.
//!
//! Default reader (NOT BYOB): `reader.read()` is called with no arguments and
//! returns `{ value, done }`. We copy the returned `Uint8Array` into a `Bytes`
//! (single copy, Electron-compatible) and yield it. Errors from `read()`
//! propagate as `std::io::Error` so reqwest fails the request — never silently
//! truncated as EOF.
//!
//! Chunks larger than 64 KiB are rejected (DoS guard).
//! `Drop` releases the JS reader via `Channel::send`; pending oneshot senders
//! drop, the body stream ends with an error, reqwest cancels the upload.

use std::sync::Arc;

use bytes::Bytes;
use neon::prelude::*;
use parking_lot::Mutex;
use tokio::sync::oneshot;

const MAX_CHUNK: usize = 65536;

pub struct JsBodyReader {
    channel: Channel,
    reader_root: Arc<Mutex<Option<Root<JsObject>>>>,
    finished: bool,
}

type ChunkResult = Result<Option<Bytes>, std::io::Error>;

impl JsBodyReader {
    pub fn new(cx: &mut FunctionContext, reader: Handle<JsObject>) -> NeonResult<Self> {
        let channel = cx.channel();
        let reader_root = Arc::new(Mutex::new(Some(reader.root(cx))));

        Ok(Self {
            channel,
            reader_root,
            finished: false,
        })
    }

    /// Pull next chunk. `Ok(None)` = EOF, `Err(_)` = JS read failed.
    pub async fn next(&mut self) -> ChunkResult {
        if self.finished {
            return Ok(None);
        }

        let (tx, rx) = oneshot::channel::<ChunkResult>();
        let reader_root = Arc::clone(&self.reader_root);
        let channel = self.channel.clone();

        channel.send(move |mut cx| {
            let reader_guard = reader_root.lock();
            let Some(root) = reader_guard.as_ref() else {
                let _ = tx.send(Ok(None));
                return Ok(());
            };
            let reader = root.to_inner(&mut cx);
            drop(reader_guard);

            // Default reader: read() takes no arguments.
            let read_promise: Handle<JsPromise> = reader
                .call_method_with(&cx, "read")?
                .apply(&mut cx)?;

            read_promise.to_future(&mut cx, move |mut cx, result| {
                match result {
                    Ok(value) => {
                        let obj = value.downcast_or_throw::<JsObject, _>(&mut cx)?;
                        let done: Handle<JsBoolean> = obj.get(&mut cx, "done")?;

                        if done.value(&mut cx) {
                            let _ = tx.send(Ok(None));
                            return Ok(());
                        }

                        let view: Handle<JsTypedArray<u8>> = obj.get(&mut cx, "value")?;
                        let slice = view.as_slice(&cx);
                        if slice.len() > MAX_CHUNK {
                            let _ = tx.send(Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                format!("body chunk exceeds {MAX_CHUNK} bytes"),
                            )));
                            return Ok(());
                        }
                        let chunk = Bytes::copy_from_slice(slice);
                        let _ = tx.send(Ok(Some(chunk)));
                        Ok(())
                    }
                    Err(e) => {
                        // Surface the JS error — DO NOT downgrade to EOF.
                        let _ = tx.send(Err(std::io::Error::other(format!(
                            "request body reader error: {e}"
                        ))));
                        Ok(())
                    }
                }
            })
        });

        match rx.await {
            Ok(Ok(Some(chunk))) => Ok(Some(chunk)),
            Ok(Ok(None)) => {
                self.finished = true;
                Ok(None)
            }
            Ok(Err(e)) => {
                self.finished = true;
                Err(e)
            }
            Err(_) => {
                // Sender dropped (Drop ran). End-of-stream with cancellation.
                self.finished = true;
                Err(std::io::Error::other("body reader cancelled"))
            }
        }
    }

    pub fn into_stream(mut self) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> {
        async_stream::stream! {
            loop {
                match self.next().await {
                    Ok(Some(chunk)) => yield Ok(chunk),
                    Ok(None) => break,
                    Err(e) => {
                        yield Err(e);
                        break;
                    }
                }
            }
        }
    }

    pub fn into_body(self) -> reqwest::Body {
        reqwest::Body::wrap_stream(self.into_stream())
    }
}

impl Drop for JsBodyReader {
    fn drop(&mut self) {
        let mut guard = self.reader_root.lock();
        if let Some(root) = guard.take() {
            let channel = self.channel.clone();
            // Channel::send is fire-and-forget after Neon shutdown.
            channel.send(move |mut cx| {
                let reader = root.to_inner(&mut cx);
                let _ = reader
                    .call_method_with(&cx, "cancel")
                    .and_then(|m| m.exec(&mut cx));
                drop(root);
                Ok(())
            });
        }
    }
}
````

### packages/node/src/dispatch.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Parse DispatchOptions from a JS object. CONNECT and TRACE are rejected
//! here as `NotSupportedError`; the TS layer does not re-check.

use std::collections::HashMap;

use neon::prelude::*;

use core::{DispatchOptions, Method};

use crate::body::JsBodyReader;

fn opt_timeout_ms<'cx>(
    cx: &mut FunctionContext<'cx>,
    obj: Handle<'cx, JsObject>,
    key: &str,
) -> NeonResult<Option<u64>> {
    let v: Handle<JsValue> = obj.get(cx, key)?;
    if v.is_a::<JsNull, _>(cx) || v.is_a::<JsUndefined, _>(cx) {
        return Ok(None);
    }
    let n = v.downcast_or_throw::<JsNumber, _>(cx)?.value(cx);
    if n.is_nan() || n < 0.0 {
        return cx.throw_error(format!("invalid {key}"));
    }
    if n == 0.0 {
        return cx.throw_error(format!("invalid {key}: 0; use null for no timeout"));
    }
    Ok(Some(n as u64))
}

pub fn parse_dispatch_options(
    cx: &mut FunctionContext<'_>,
    obj: Handle<'_, JsObject>,
) -> NeonResult<DispatchOptions> {
    let path: Handle<JsString> = obj.get(cx, "path")?;
    let method_str: Handle<JsString> = obj.get(cx, "method")?;
    let origin: Handle<JsValue> = obj.get(cx, "origin")?;
    let query: Handle<JsString> = obj.get(cx, "query")?;

    let method = match method_str.value(cx).to_uppercase().as_str() {
        "GET" => Method::Get,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "DELETE" => Method::Delete,
        "HEAD" => Method::Head,
        "OPTIONS" => Method::Options,
        "PATCH" => Method::Patch,
        "CONNECT" | "TRACE" => {
            return cx.throw_error("NotSupportedError: CONNECT/TRACE not supported");
        }
        _ => return cx.throw_error("InvalidArgumentError: invalid HTTP method"),
    };

    let origin_str = if origin.is_a::<JsString, _>(cx) {
        Some(origin.downcast_or_throw::<JsString, _>(cx)?.value(cx))
    } else {
        None
    };

    let headers_obj: Handle<JsObject> = obj.get(cx, "headers")?;
    let headers_keys = headers_obj.get_own_property_names(cx)?;
    let len = headers_keys.len(cx);
    let mut headers = HashMap::new();
    for i in 0..len {
        let key: Handle<JsString> = headers_keys.get(cx, i)?;
        let key_str = key.value(cx);
        let value: Handle<JsString> = headers_obj.get(cx, key)?;
        headers.insert(key_str, vec![value.value(cx)]);
    }

    let headers_timeout = opt_timeout_ms(cx, obj, "headersTimeout")?;
    let body_timeout = opt_timeout_ms(cx, obj, "bodyTimeout")?;

    let body_value: Handle<JsValue> = obj.get(cx, "body")?;
    let body = if body_value.is_a::<JsNull, _>(cx) || body_value.is_a::<JsUndefined, _>(cx) {
        None
    } else {
        let reader = body_value.downcast_or_throw::<JsObject, _>(cx)?;
        let js_body_reader = JsBodyReader::new(cx, reader)?;
        Some(js_body_reader.into_body())
    };

    Ok(DispatchOptions {
        origin: origin_str,
        path: path.value(cx),
        query: query.value(cx),
        method,
        headers,
        body,
        headers_timeout_ms: headers_timeout,
        body_timeout_ms: body_timeout,
    })
}
```

### packages/node/src/lib.rs (Updated)

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Node.js bindings for reqwest - Rust HTTP client library.

mod agent;
mod body;
mod dispatch;
mod handler;

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

use neon::prelude::*;

#[neon::export(name = "hello", context)]
fn hello<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsString> {
    Ok(cx.string("hello"))
}
```

## Key Choices

| Item                    | Value                                                  |
| :---------------------- | :----------------------------------------------------- |
| **Communication**       | `neon::event::Channel` (non-blocking)                  |
| **Request Body Stream** | Default reader, pull via oneshot reply per chunk       |
| **Response Data**       | Push from Rust, ack from JS via oneshot                |
| **Backpressure**        | Ack = callback returned (not consumer drained)         |
| **Memory Bounds**       | 1 chunk in flight; reject chunks > 64 KiB              |
| **JS Event Loop**       | Never blocked                                          |
| **Data Copy**           | 1 copy per chunk (Electron compatible)                 |
| **Panic Safety**        | Channel closures wrapped in `catch_unwind`             |
| **Reader Errors**       | Propagated as `std::io::Error` (never swallowed)       |
| **Headers**             | `Set-Cookie` and multi-value always emitted as arrays  |
| **Unsupported Methods** | CONNECT/TRACE rejected at FFI parse                    |

## Test Plan

`JsBodyReader` lifecycle (cover all in `body.rs` unit tests):

- Drop while a `Channel::send` is in-flight (rx sees sender dropped).
- Body object missing a `cancel` method (Drop silently ignores).
- Malformed reader result: `read()` resolves with `{}` (missing `value`/`done`)
  must surface as `Err`, not EOF.
- Reader `read()` rejects mid-stream → request fails with body error.
- Load test (mark `#[ignore]`): 10 000 dispatch+abort cycles, assert RSS bounded.

## File Structure

```text
packages/node/
└── src/
    ├── lib.rs
    ├── agent.rs
    ├── body.rs
    ├── dispatch.rs
    └── handler.rs
```

## Security

- Headers pass through without filtering; TS layer validates CRLF/CTL.
- No credentials cached beyond reqwest's internal TLS session cache.
- Chunk size capped at 64 KiB to bound JS-controlled memory pressure.
- Panic in user callback contained via `catch_unwind`.
