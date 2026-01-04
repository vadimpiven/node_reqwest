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
//!
//! ## Response Backpressure Design
//!
//! Response data delivery uses **acknowledgment-based flow control**:
//!
//! 1. Rust sends chunk to JS via `Channel::send`
//! 2. JS callback runs, delivers chunk to user handler
//! 3. JS sends acknowledgment via oneshot channel
//! 4. Rust awaits acknowledgment before reading next chunk
//!
//! ```text
//! Rust (async)                    JS (event loop)
//!     │                                │
//!     ├─► Channel::send(chunk) ───────►│
//!     │                                ├─► onResponseData(chunk)
//!     │                                │
//!     │◄── oneshot::send(ack) ◄───────┤
//!     ▼                                │
//!  await ack                           │
//!     │                                │
//!  read next chunk                     │
//! ```
//!
//! This ensures:
//! - No unbounded buffering in Rust
//! - Rust reads at exactly the pace JS can process
//! - JS event loop never blocked
//! - Natural backpressure
//!
//! ## Oneshot Channel Allocation Note
//!
//! We use oneshot channels per-chunk rather than reusable mpsc channels.
//! Each oneshot is ~48 bytes and mimalloc handles small allocations efficiently.
//! For typical responses (10 chunks), this is ~480 bytes quickly freed.
//!
//! Alternatives considered:
//! - `mpsc::channel(1)` per request: Adds `Arc<Mutex<Receiver>>` complexity
//! - `watch` channel: More complex signaling logic
//!
//! If profiling shows allocation pressure, optimize with object pooling.
//! In practice, network I/O and JS callbacks dominate latency.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use neon::prelude::*;
use tokio::sync::oneshot;

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
///
/// Uses acknowledgment-based flow control for response data to prevent
/// unbounded memory growth when JS is slower than the network.
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
        // Response start is fire-and-forget (small, infrequent)
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
        // Use acknowledgment-based flow control to prevent unbounded buffering
        let (tx, rx) = oneshot::channel::<()>();
        let channel = self.channel.clone();
        let on_data = Arc::clone(&self.on_data);

        // Send chunk to JS with acknowledgment callback
        channel.send(move |mut cx| {
            let buffer = JsBuffer::from_slice(&mut cx, &chunk)?;
            on_data
                .to_inner(&mut cx)
                .call_with(&cx)
                .arg(buffer)
                .exec(&mut cx)?;

            // Acknowledge that JS has processed the chunk
            // This unblocks Rust to read the next chunk
            let _ = tx.send(());
            Ok(())
        });

        // Wait for acknowledgment before returning (allows reading next chunk)
        // This is async and non-blocking - it yields control to the tokio runtime
        let _ = rx.await;
    }

    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>) {
        // Response end is fire-and-forget (small, infrequent)
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
        // Errors are fire-and-forget (terminal event)
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
//! ## Architecture: Pull-Based Non-Blocking Design
//!
//! This module uses a **pull-based** architecture to ensure the JS event loop
//! is NEVER blocked:
//!
//! 1. Rust requests chunks only when ready (via `Channel::send`)
//! 2. JS reads from the stream and responds via oneshot channel
//! 3. Rust awaits the oneshot (async, non-blocking)
//!
//! ```text
//! Rust (async)                    JS (event loop)
//!     │                                │
//!     ├─► Channel::send(request) ─────►│
//!     │                                ├─► reader.read(buffer)
//!     │                                │   (async, non-blocking)
//!     │                                │
//!     │◄── oneshot.send(chunk) ◄──────┤
//!     ▼                                │
//!  await rx                            │
//! ```
//!
//! ## Backpressure
//! Natural! Rust only requests chunks when the HTTP body stream is polled.
//! JS never reads ahead - it only reads when explicitly requested.
//!
//! ## Cleanup on Abort
//! When a request is aborted:
//! 1. The Rust request task is cancelled (CancellationToken)
//! 2. JsBodyReader is dropped
//! 3. Drop impl releases the JS reader reference via Channel::send
//! 4. Any pending oneshot::Receiver gets an error (sender dropped)
//! 5. The JS stream read (if in progress) completes but response is discarded

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use neon::prelude::*;
use tokio::sync::oneshot;

/// Reads body chunks from JS ReadableStreamBYOBReader on demand.
///
/// Uses a pull-based model: Rust requests chunks, JS responds.
/// The JS event loop is never blocked.
pub struct JsBodyReader {
    channel: Channel,
    reader_root: Arc<Mutex<Option<Root<JsObject>>>>,
    /// Set to true when EOF or error encountered
    finished: bool,
}

impl JsBodyReader {
    /// Create a new body reader wrapping a JS ReadableStreamBYOBReader.
    pub fn new(cx: &mut FunctionContext, reader: Handle<JsObject>) -> NeonResult<Self> {
        let channel = cx.channel();
        let reader_root = Arc::new(Mutex::new(Some(reader.root(cx))));

        Ok(Self {
            channel,
            reader_root,
            finished: false,
        })
    }

    /// Get the next chunk. Returns None on EOF or error.
    ///
    /// This method is fully async and never blocks the JS event loop:
    /// 1. Sends a read request to JS via Channel::send
    /// 2. JS reads from the stream (async)
    /// 3. JS sends result back via oneshot channel
    /// 4. Rust awaits the oneshot (async)
    pub async fn next(&mut self) -> Option<Bytes> {
        if self.finished {
            return None;
        }

        // Create oneshot for this chunk request
        let (tx, rx) = oneshot::channel::<Option<Bytes>>();

        let reader_root = Arc::clone(&self.reader_root);
        let channel = self.channel.clone();

        // Request JS to read a chunk (non-blocking send to event queue)
        channel.send(move |mut cx| {
            // Get the reader, or signal EOF if already released
            let reader_guard = reader_root.lock().unwrap();
            let Some(root) = reader_guard.as_ref() else {
                let _ = tx.send(None);
                return Ok(());
            };
            let reader = root.to_inner(&mut cx);
            drop(reader_guard); // Release lock before async work

            // Create buffer for BYOB read (64KB chunks)
            let buffer = JsArrayBuffer::new(&mut cx, 64 * 1024)?;
            let uint8 = JsTypedArray::<u8>::from_buffer(&mut cx, buffer)?;

            // Call reader.read(buffer) - returns Promise
            let read_promise: Handle<JsPromise> = reader
                .call_method_with(&cx, "read")?
                .arg(uint8)
                .apply(&mut cx)?;

            // Handle promise resolution (runs on JS main thread, non-blocking)
            read_promise.to_future(&mut cx, move |mut cx, result| {
                match result {
                    Ok(value) => {
                        let obj = value.downcast_or_throw::<JsObject, _>(&mut cx)?;
                        let done: Handle<JsBoolean> = obj.get(&mut cx, "done")?;

                        if done.value(&mut cx) {
                            // EOF - stream exhausted
                            let _ = tx.send(None);
                        } else {
                            // Got data - copy to Bytes (one copy, Electron compatible)
                            let view: Handle<JsTypedArray<u8>> = obj.get(&mut cx, "value")?;
                            let chunk = Bytes::copy_from_slice(view.as_slice(&cx));
                            let _ = tx.send(Some(chunk));
                        }
                        Ok(())
                    }
                    Err(_) => {
                        // JS error (stream closed, network error, etc.)
                        let _ = tx.send(None);
                        Ok(())
                    }
                }
            })
        });

        // Await response from JS (async, non-blocking!)
        match rx.await {
            Ok(Some(chunk)) => Some(chunk),
            Ok(None) => {
                self.finished = true;
                None
            }
            Err(_) => {
                // Sender dropped (abort or cleanup)
                self.finished = true;
                None
            }
        }
    }

    /// Convert to a bytes stream for reqwest body.
    pub fn into_stream(mut self) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> {
        async_stream::stream! {
            while let Some(chunk) = self.next().await {
                yield Ok(chunk);
            }
        }
    }

    /// Convert to a reqwest::Body for use in Agent::dispatch.
    ///
    /// This is the primary integration point - call this when constructing
    /// DispatchOptions from a JS streaming body.
    pub fn into_body(self) -> reqwest::Body {
        reqwest::Body::wrap_stream(self.into_stream())
    }
}

impl Drop for JsBodyReader {
    fn drop(&mut self) {
        // Cancel and release the JS reader reference on the JS thread
        // This ensures proper cleanup even if dropped from any thread
        if let Ok(mut guard) = self.reader_root.lock() {
            if let Some(root) = guard.take() {
                let channel = self.channel.clone();
                // Schedule cancel + release on JS event loop (non-blocking)
                channel.send(move |mut cx| {
                    let reader = root.to_inner(&mut cx);
                    // Cancel the stream to release underlying resources
                    // This is fire-and-forget - we don't wait for the promise
                    let _ = reader
                        .call_method_with(&cx, "cancel")
                        .and_then(|m| m.exec(&mut cx));
                    // Dropping Root releases the reference
                    drop(root);
                    Ok(())
                });
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

use crate::body::JsBodyReader;

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

    // Body handling: null = no body, otherwise a ReadableStreamBYOBReader
    let body_value: Handle<JsValue> = obj.get(cx, "body")?;
    let body = if body_value.is_a::<JsNull, _>(cx) || body_value.is_a::<JsUndefined, _>(cx) {
        None
    } else {
        // It's a ReadableStreamBYOBReader - wrap it in JsBodyReader and convert to reqwest::Body
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
| **Communication** | `neon::event::Channel` (non-blocking) |
| **Request Body** | `reqwest::Body` (Bytes or streaming via JsBodyReader) |
| **Request Body Stream** | Pull-based via `tokio::sync::oneshot` |
| **Response Data** | Sync-ack via `tokio::sync::oneshot` in Channel closure |
| **Backpressure** | Natural - Rust controls read pace, waits for JS callback |
| **Memory Bounds** | 1 chunk in flight (request or response) |
| **JS Event Loop** | Never blocked |
| **Data Copy** | 1 copy per chunk (Electron compatible) |
| **Thread Safety** | Arc-wrapped JS function roots |
| **Cleanup on Abort** | Drop cancels stream + releases JS reader via Channel |

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
