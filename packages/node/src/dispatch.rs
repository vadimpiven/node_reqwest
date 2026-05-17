// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Parses `DispatchOptions` from a JS object. Method validation and
//! supported-method policy live in `nrcore`; this layer only marshals.

use std::collections::HashMap;

use bytes::Bytes;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use nrcore::DispatchOptions;
use nrcore::MAX_HEADERS;
use nrcore::parse_method;

use crate::body::JsBodyReader;
use crate::ffi_util::opt_timeout_ms;

pub fn parse_dispatch_options<'cx>(
    cx: &mut FunctionContext<'cx>,
    obj: Handle<'cx, JsObject>,
) -> NeonResult<DispatchOptions> {
    let path: Handle<'_, JsString> = obj.get(cx, "path")?;
    let method_str: Handle<'_, JsString> = obj.get(cx, "method")?;
    let origin: Handle<'_, JsValue> = obj.get(cx, "origin")?;
    let query: Handle<'_, JsString> = obj.get(cx, "query")?;

    let method = match parse_method(&method_str.value(cx)) {
        Ok(m) => m,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    let origin_str = if origin.is_a::<JsString, _>(cx) {
        Some(origin.downcast_or_throw::<JsString, _>(cx)?.value(cx))
    } else {
        None
    };

    let headers_obj: Handle<'_, JsObject> = obj.get(cx, "headers")?;
    let headers_keys = headers_obj.get_own_property_names(cx)?;
    let len = headers_keys.len(cx);
    if (len as usize) > MAX_HEADERS {
        return cx.throw_error(format!("headers: too many entries (max {MAX_HEADERS})"));
    }
    let mut headers: HashMap<String, Vec<String>> = HashMap::new();
    for i in 0..len {
        let key: Handle<'_, JsString> = headers_keys.get(cx, i)?;
        let key_str = key.value(cx);
        let value: Handle<'_, JsString> = headers_obj.get(cx, key)?;
        headers.insert(key_str, vec![value.value(cx)]);
    }

    let headers_timeout = opt_timeout_ms(cx, obj, "headersTimeout")?;
    let body_timeout = opt_timeout_ms(cx, obj, "bodyTimeout")?;

    // `bodyBytes` (materialized) is the fast path — one `Bytes` clone, no
    // per-chunk Channel::send round-trip. `body` (reader) is the streaming path.
    let body_bytes_value: Handle<'_, JsValue> = obj.get(cx, "bodyBytes")?;
    let body = if !body_bytes_value.is_a::<JsNull, _>(cx)
        && !body_bytes_value.is_a::<JsUndefined, _>(cx)
    {
        let view: Handle<'_, JsTypedArray<u8>> = body_bytes_value.downcast_or_throw(cx)?;
        let bytes = Bytes::copy_from_slice(view.as_slice(cx));
        Some(reqwest::Body::from(bytes))
    } else {
        let body_value: Handle<'_, JsValue> = obj.get(cx, "body")?;
        if body_value.is_a::<JsNull, _>(cx) || body_value.is_a::<JsUndefined, _>(cx) {
            None
        } else {
            let reader = body_value.downcast_or_throw::<JsObject, _>(cx)?;
            let js_body_reader = JsBodyReader::new(cx, reader)?;
            Some(reqwest::Body::wrap_stream(js_body_reader.into_stream()))
        }
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
        connect_timeout_ms: None,
    })
}
