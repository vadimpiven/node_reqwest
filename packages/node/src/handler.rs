// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Bridges Rust async lifecycle to JS via Neon `Channel`. Callbacks live in
//! [`SharedCallbacks`] (rooted once per Agent); each event prepends a
//! `requestId: u32` that the JS side routes to a per-request handler.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use bytes::Bytes;
use neon::prelude::*;
use nrcore::CoreError;
use nrcore::DispatchHandler;
use nrcore::ResponseStart;

/// Lifecycle callbacks rooted once at Agent construction; the four
/// `Root<JsFunction>` handles are reused across every dispatch on the Agent,
/// saving 8 `napi_create_reference`/`napi_delete_reference` crossings per
/// request vs. per-dispatch rooting.
pub struct SharedCallbacks {
    pub channel: Channel,
    pub on_start: Arc<Root<JsFunction>>,
    pub on_data: Arc<Root<JsFunction>>,
    pub on_end: Arc<Root<JsFunction>>,
    pub on_error: Arc<Root<JsFunction>>,
}

/// Fire-and-forget delivery of one callback invocation to the JS thread.
///
/// Back-pressure is owned by `RequestController` (explicit pause/resume); the
/// JS event loop already serializes callbacks. A per-chunk ack-gate (oneshot)
/// would only add Rust↔JS↔Rust round-trips without buying anything.
fn fire_js_callback<F>(channel: &Channel, label: &'static str, build_and_call: F)
where
    F: FnOnce(&mut Cx<'_>) -> NeonResult<()> + Send + 'static,
{
    channel.clone().send(move |mut cx| {
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| build_and_call(&mut cx)));
        match result {
            Ok(r) => r,
            Err(_) => cx.throw_error(format!("panic in {label} callback")),
        }
    });
}

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
                let Ok(idx) = u32::try_from(i) else {
                    return cx.throw_error(format!("header {key:?}: too many values"));
                };
                let val = cx.string(v);
                arr.set(cx, idx, val)?;
            }
            obj.set(cx, key.as_str(), arr)?;
        }
    }
    Ok(obj)
}

pub struct JsDispatchHandler {
    callbacks: Arc<SharedCallbacks>,
    req_id: u32,
}

impl JsDispatchHandler {
    pub fn new(callbacks: Arc<SharedCallbacks>, req_id: u32) -> Self {
        Self { callbacks, req_id }
    }
}

impl DispatchHandler for JsDispatchHandler {
    async fn on_response_start(&self, response: ResponseStart) {
        let cbs = Arc::clone(&self.callbacks);
        let req_id = self.req_id;
        let ResponseStart {
            status_code,
            status_message,
            headers,
        } = response;

        fire_js_callback(&cbs.channel.clone(), "onResponseStart", move |cx| {
            let headers_obj = headers_to_js(cx, &headers)?;
            cbs.on_start
                .to_inner(cx)
                .call_with(cx)
                .arg(cx.number(f64::from(req_id)))
                .arg(cx.number(f64::from(status_code)))
                .arg(headers_obj)
                .arg(cx.string(&status_message))
                .exec(cx)
        });
    }

    async fn on_response_data(&self, chunk: Bytes) {
        let cbs = Arc::clone(&self.callbacks);
        let req_id = self.req_id;

        fire_js_callback(&cbs.channel.clone(), "onResponseData", move |cx| {
            let buffer = JsBuffer::from_slice(cx, &chunk)?;
            cbs.on_data
                .to_inner(cx)
                .call_with(cx)
                .arg(cx.number(f64::from(req_id)))
                .arg(buffer)
                .exec(cx)
        });
    }

    async fn on_response_end(&self, trailers: HashMap<String, Vec<String>>) {
        let cbs = Arc::clone(&self.callbacks);
        let req_id = self.req_id;

        fire_js_callback(&cbs.channel.clone(), "onResponseEnd", move |cx| {
            let trailers_obj = headers_to_js(cx, &trailers)?;
            cbs.on_end
                .to_inner(cx)
                .call_with(cx)
                .arg(cx.number(f64::from(req_id)))
                .arg(trailers_obj)
                .exec(cx)
        });
    }

    async fn on_response_error(&self, error: CoreError) {
        let cbs = Arc::clone(&self.callbacks);
        let req_id = self.req_id;
        let error_code = error.error_code().to_string();
        let error_msg = error.to_string();
        let status_code = error.status_code();

        fire_js_callback(&cbs.channel.clone(), "onResponseError", move |cx| {
            let error_info = cx.empty_object();
            let code_str = cx.string(&error_code);
            error_info.set(cx, "code", code_str)?;
            let msg_str = cx.string(&error_msg);
            error_info.set(cx, "message", msg_str)?;
            if let Some(code) = status_code {
                let n = cx.number(f64::from(code));
                error_info.set(cx, "statusCode", n)?;
            }
            cbs.on_error
                .to_inner(cx)
                .call_with(cx)
                .arg(cx.number(f64::from(req_id)))
                .arg(error_info)
                .exec(cx)
        });
    }
}
