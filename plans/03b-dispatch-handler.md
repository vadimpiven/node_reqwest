# Dispatch Handler + Request Body Streaming (Chunk 03b)

## Problem/Purpose

Bridge Rust's async lifecycle events to JavaScript callbacks while handling request body
streaming from JS ReadableStreamBYOBReader to Rust with proper backpressure.

## Solution

Implement `JsDispatchHandler` using Neon's `Channel` for event marshaling and a
`JsBodyReader` that reads from the JS reader via channel callbacks. One copy per chunk
(Electron compatibility).

## Architecture

```text
JavaScript (ReadableStreamBYOBReader)
      │
      ▼
JsBodyReader ◄── channel.send() ── reader.read(buffer)
      │
      ▼
reqwest::Body (stream)
      │
      ▼
HTTP Request Upload
      │
Response Stream
      │
      ▼
JsDispatchHandler ── channel.send() ── callbacks.onResponseData(chunk)
      │
      ▼
JavaScript Handler
```

## Implementation

### packages/node/src/handler.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! JsDispatchHandler bridges Rust async trait to JS callbacks via Neon Channel.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use neon::prelude::*;

use core::{CoreError, DispatchHandler, ResponseStart};

/// Converts Response headers to JS object.
fn headers_to_js<'a>(
    cx: &mut Cx<'a>,
    headers: &HashMap<String, Vec<String>>,
) -> JsResult<'a, JsObject> {
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

/// DispatchHandler implementation that forwards events to JS callbacks.
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
            let headers_obj = headers_to_js(&mut cx, &headers)?;
            on_start
                .to_inner(&mut cx)
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
            on_data
                .to_inner(&mut cx)
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
            on_end
                .to_inner(&mut cx)
                .call_with(&cx)
                .arg(trailers_obj)
                .exec(&mut cx)
        });
    }

    async fn on_response_error(&self, error: CoreError) {
        let channel = self.channel.clone();
        let on_error = Arc::clone(&self.on_error);
        let error_code = error.error_code().to_string();
        let error_name = error.error_name().to_string();
        let error_msg = error.to_string();
        let status_code = error.status_code();

        channel.send(move |mut cx| {
            let error_info = cx.empty_object();
            error_info.set(&mut cx, "code", cx.string(&error_code))?;
            error_info.set(&mut cx, "name", cx.string(&error_name))?;
            error_info.set(&mut cx, "message", cx.string(&error_msg))?;
            if let Some(code) = status_code {
                error_info.set(&mut cx, "statusCode", cx.number(code as f64))?;
            }
            on_error
                .to_inner(&mut cx)
                .call_with(&cx)
                .arg(error_info)
                .exec(&mut cx)
        });
    }
}
```

### packages/node/src/body.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Request body streaming from JS ReadableStreamBYOBReader.
//!
//! Backpressure handling:
//! - Uses mpsc::channel with bounded capacity (4 chunks = ~256KB max buffer)
//! - When channel is full, the reader pauses until Rust consumes chunks
//! - This prevents unbounded memory growth during slow uploads
//!
//! Note: blocking_send() is used in JS callback context which is synchronous.
//! The bounded channel provides backpressure by blocking when full.

use bytes::Bytes;
use neon::prelude::*;
use tokio::sync::mpsc;

/// Reads body chunks from JS via bounded channel (backpressure via channel capacity).
pub struct JsBodyReader {
    receiver: mpsc::Receiver<Option<Bytes>>,
}

impl JsBodyReader {
    /// Create a new body reader that pulls from a JS ReadableStreamBYOBReader.
    ///
    /// The bounded channel (capacity 4) provides backpressure:
    /// - Each chunk is up to 64KB, so max 256KB buffered
    /// - When Rust is slower than JS, blocking_send blocks the JS read loop
    pub fn new(
        cx: &mut FunctionContext,
        reader: Handle<JsObject>,
    ) -> NeonResult<(Self, mpsc::Sender<Option<Bytes>>)> {
        // Bounded channel for backpressure (4 chunks * 64KB = 256KB max buffer)
        let (tx, rx) = mpsc::channel(4);
        let channel = cx.channel();
        let reader_root = reader.root(cx);

        // Start the read loop in JS context
        let tx_clone = tx.clone();
        channel.send(move |mut cx| {
            continue_reading(&mut cx, reader_root, tx_clone)
        });

        Ok((Self { receiver: rx }, tx))
    }

    /// Get the next chunk, None indicates EOF.
    pub async fn next(&mut self) -> Option<Bytes> {
        self.receiver.recv().await.flatten()
    }
}

/// Iteratively read from JS reader (avoids deep recursion).
/// Called from JS context (not async Rust).
fn continue_reading(
    cx: &mut Cx,
    reader_root: Root<JsObject>,
    tx: mpsc::Sender<Option<Bytes>>,
) -> NeonResult<()> {
    let reader = reader_root.to_inner(cx);
    let buffer = JsArrayBuffer::new(cx, 64 * 1024)?; // 64KB chunks
    let uint8 = JsTypedArray::<u8>::from_buffer(cx, buffer)?;

    let read_promise: Handle<JsPromise> = reader
        .call_method_with(cx, "read")?
        .arg(uint8)
        .apply(cx)?;

    let channel = cx.channel();
    let reader_root_clone = reader_root.clone(cx);

    read_promise.to_future(cx, move |mut cx, result| {
        match result {
            Ok(value) => {
                let obj = value.downcast_or_throw::<JsObject, _>(&mut cx)?;
                let done: Handle<JsBoolean> = obj.get(&mut cx, "done")?;

                if done.value(&mut cx) {
                    // EOF - signal end to Rust
                    // Note: blocking_send may block if buffer is full, providing backpressure
                    let _ = tx.blocking_send(None);
                } else {
                    let view: Handle<JsTypedArray<u8>> = obj.get(&mut cx, "value")?;
                    let data = view.as_slice(&cx).to_vec();

                    // blocking_send blocks if channel is full - this is the backpressure!
                    // When Rust is slow to consume, this naturally slows JS reading.
                    match tx.blocking_send(Some(Bytes::from(data))) {
                        Ok(()) => {
                            // Continue reading - schedule next iteration
                            channel.send(move |mut cx| {
                                continue_reading(&mut cx, reader_root_clone, tx)
                            });
                        }
                        Err(_) => {
                            // Channel closed - Rust side cancelled the request
                            // Do not continue reading
                        }
                    }
                }
                Ok(())
            }
            Err(e) => {
                // JS read error - signal EOF to Rust
                let _ = tx.blocking_send(None);
                Err(e)
            }
        }
    })
}

/// Convert JsBodyReader to bytes::Bytes stream for reqwest.
impl JsBodyReader {
    pub fn into_stream(mut self) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> {
        async_stream::stream! {
            while let Some(chunk) = self.next().await {
                yield Ok(chunk);
            }
        }
    }
}
```

### packages/node/src/dispatch.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Dispatch options parsing from JS objects.

use std::collections::HashMap;

use neon::prelude::*;

use core::{DispatchOptions, Method};

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
    let len = headers_keys.len(cx);
    let mut headers = HashMap::new();
    for i in 0..len {
        let key: Handle<JsString> = headers_keys.get(cx, i)?;
        let key_str = key.value(cx);
        let value: Handle<JsString> = headers_obj.get(cx, key)?;
        headers.insert(key_str, vec![value.value(cx)]);
    }

    let headers_timeout: Handle<JsNumber> = obj.get(cx, "headersTimeout")?;
    let body_timeout: Handle<JsNumber> = obj.get(cx, "bodyTimeout")?;

    Ok(DispatchOptions {
        origin: origin_str,
        path: path.value(cx),
        query: query.value(cx),
        method,
        headers,
        body: None, // Body handling in 03c
        headers_timeout_ms: headers_timeout.value(cx) as u64,
        body_timeout_ms: body_timeout.value(cx) as u64,
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

## Tables

| Metric | Value |
| :--- | :--- |
| **Communication** | `neon::event::Channel` |
| **Body Streaming** | `mpsc::channel` + async read loop |
| **Data Copy** | 1 copy per chunk (Electron compatible) |
| **Thread Safety** | Arc-wrapped JS function roots |

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

## Security Considerations

- Headers passed through without filtering or logging
- No credentials cached beyond reqwest's internal TLS session cache
