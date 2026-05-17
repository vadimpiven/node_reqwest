// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Shared FFI helpers for parsing JS option objects into Rust types.

use neon::prelude::*;
use num_traits::NumCast;

fn js_number_to_u64<T: NumCast>(cx: &mut FunctionContext<'_>, n: f64, key: &str) -> NeonResult<T> {
    num_traits::cast::<f64, T>(n).map_or_else(
        || cx.throw_error(format!("invalid {key}: value out of u64 range")),
        Ok,
    )
}

/// Optional millisecond timeout. `null` / `undefined` → `None`; `0` and
/// negatives throw (callers must use `null` to mean "no timeout").
pub fn opt_timeout_ms<'cx>(
    cx: &mut FunctionContext<'cx>,
    obj: Handle<'cx, JsObject>,
    key: &str,
) -> NeonResult<Option<u64>> {
    let v: Handle<'_, JsValue> = obj.get(cx, key)?;
    if v.is_a::<JsNull, _>(cx) || v.is_a::<JsUndefined, _>(cx) {
        return Ok(None);
    }
    let n = v.downcast_or_throw::<JsNumber, _>(cx)?.value(cx);
    if n.is_nan() || n < 0.0 {
        return cx.throw_error(format!("invalid {key}: must be >= 0 or null"));
    }
    if n == 0.0 {
        return cx.throw_error(format!(
            "invalid {key}: 0 is invalid; use null for no timeout"
        ));
    }
    js_number_to_u64::<u64>(cx, n, key).map(Some)
}

/// Optional non-negative size. `null` / `undefined` → `None`; `0` is accepted
/// (caps to zero bytes — pathological but not a misuse).
pub fn opt_size<'cx>(
    cx: &mut FunctionContext<'cx>,
    obj: Handle<'cx, JsObject>,
    key: &str,
) -> NeonResult<Option<u64>> {
    let v: Handle<'_, JsValue> = obj.get(cx, key)?;
    if v.is_a::<JsNull, _>(cx) || v.is_a::<JsUndefined, _>(cx) {
        return Ok(None);
    }
    let n = v.downcast_or_throw::<JsNumber, _>(cx)?.value(cx);
    if n.is_nan() || n < 0.0 {
        return cx.throw_error(format!("invalid {key}: must be >= 0 or null"));
    }
    js_number_to_u64::<u64>(cx, n, key).map(Some)
}
