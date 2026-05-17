// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Neon bindings for `nrcore::Agent`.

use std::collections::HashMap as StdHashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use neon::prelude::*;
use nrcore::Agent;
use nrcore::AgentConfig;
use nrcore::CoreError;
use nrcore::ProxyAuth;
use nrcore::ProxyConfig;
use nrcore::RequestController;

use crate::dispatch::parse_dispatch_options;
use crate::ffi_util::opt_size;
use crate::ffi_util::opt_timeout_ms;
use crate::handler::JsDispatchHandler;
use crate::handler::SharedCallbacks;
use crate::runtime_handle;

/// Cap on proxy custom headers — bounded marshalling and `DoS` surface.
const MAX_PROXY_HEADERS: u32 = 64;

pub struct AgentHandle {
    pub inner: Arc<Agent>,
    pub callbacks: Arc<SharedCallbacks>,
}

impl Finalize for AgentHandle {}

pub struct RequestHandle {
    pub inner: RequestController,
}

impl Finalize for RequestHandle {}

fn parse_proxy<'cx>(
    cx: &mut FunctionContext<'cx>,
    obj: Handle<'cx, JsObject>,
) -> NeonResult<ProxyConfig> {
    let kind: Handle<'_, JsString> = obj.get(cx, "type")?;
    match kind.value(cx).as_str() {
        "no-proxy" => Ok(ProxyConfig::None),
        "system" => Ok(ProxyConfig::System),
        "custom" => {
            let uri: Handle<'_, JsString> = obj.get(cx, "uri")?;
            let uri = uri.value(cx);
            if uri.is_empty() {
                return cx.throw_error("proxy.uri must be a non-empty string");
            }

            let headers_obj: Handle<'_, JsObject> = obj.get(cx, "headers")?;
            let keys = headers_obj.get_own_property_names(cx)?;
            let len = keys.len(cx);
            if len > MAX_PROXY_HEADERS {
                return cx.throw_error(format!(
                    "proxy.headers: too many entries (max {MAX_PROXY_HEADERS})"
                ));
            }
            let mut headers = StdHashMap::new();
            for i in 0..len {
                let key: Handle<'_, JsString> = keys.get(cx, i)?;
                let key_str = key.value(cx);
                let value: Handle<'_, JsString> = headers_obj.get(cx, key)?;
                headers.insert(key_str, value.value(cx));
            }

            let auth = parse_proxy_auth(cx, obj)?;

            Ok(ProxyConfig::Custom { uri, headers, auth })
        },
        other => cx.throw_error(format!("invalid proxy.type: {other}")),
    }
}

fn parse_proxy_auth<'cx>(
    cx: &mut FunctionContext<'cx>,
    obj: Handle<'cx, JsObject>,
) -> NeonResult<Option<ProxyAuth>> {
    let auth_val: Handle<'_, JsValue> = obj.get(cx, "auth")?;
    if auth_val.is_a::<JsNull, _>(cx) || auth_val.is_a::<JsUndefined, _>(cx) {
        return Ok(None);
    }
    let auth_obj = auth_val.downcast_or_throw::<JsObject, _>(cx)?;
    let username: Handle<'_, JsString> = auth_obj.get(cx, "username")?;
    let password: Handle<'_, JsString> = auth_obj.get(cx, "password")?;
    Ok(Some(ProxyAuth {
        username: username.value(cx),
        password: password.value(cx),
    }))
}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(
    cx: &mut FunctionContext<'cx>,
    options: Handle<'cx, JsObject>,
    callbacks: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<AgentHandle>> {
    let timeout = opt_timeout_ms(cx, options, "timeout")?;
    let headers_timeout = opt_timeout_ms(cx, options, "headersTimeout")?;
    let body_timeout = opt_timeout_ms(cx, options, "bodyTimeout")?;
    let connect_timeout = opt_timeout_ms(cx, options, "connectTimeout")?;
    let keep_alive = opt_timeout_ms(cx, options, "keepAliveTimeout")?;

    let max_redirections: Handle<'_, JsNumber> = options.get(cx, "maxRedirections")?;
    let Some(max_redirections) = num_traits::cast::<f64, u32>(max_redirections.value(cx).max(0.0))
    else {
        return cx.throw_error("maxRedirections: value out of u32 range");
    };

    let max_response_size = opt_size(cx, options, "maxResponseSize")?;

    let allow_h2: Handle<'_, JsBoolean> = options.get(cx, "allowH2")?;
    let allow_h2 = allow_h2.value(cx);

    let reject_unauthorized: Handle<'_, JsBoolean> = options.get(cx, "rejectUnauthorized")?;
    let reject_invalid_hostnames: Handle<'_, JsBoolean> =
        options.get(cx, "rejectInvalidHostnames")?;
    let reject_unauthorized = reject_unauthorized.value(cx);
    let reject_invalid_hostnames = reject_invalid_hostnames.value(cx);

    let ca: Handle<'_, JsArray> = options.get(cx, "ca")?;
    let ca_len = ca.len(cx);
    if ca_len > 32 {
        return cx.throw_error("ca: too many entries (max 32)");
    }
    let mut ca_pems: Vec<String> = Vec::with_capacity(ca_len as usize);
    for i in 0..ca_len {
        let pem: Handle<'_, JsString> = ca.get(cx, i)?;
        let pem_str = pem.value(cx);
        if pem_str.len() > 256 * 1024 {
            return cx.throw_error(format!("ca[{i}]: entry too large (max 256 KiB)"));
        }
        ca_pems.push(pem_str);
    }

    let local_address: Handle<'_, JsValue> = options.get(cx, "localAddress")?;
    let local_address: Option<IpAddr> =
        if local_address.is_a::<JsNull, _>(cx) || local_address.is_a::<JsUndefined, _>(cx) {
            None
        } else {
            let s = local_address
                .downcast_or_throw::<JsString, _>(cx)?
                .value(cx);
            match s.parse() {
                Ok(addr) => Some(addr),
                Err(_) => return cx.throw_error("localAddress: invalid IP"),
            }
        };

    let auto_select_family: Handle<'_, JsBoolean> = options.get(cx, "autoSelectFamily")?;
    let auto_select_family = auto_select_family.value(cx);

    let proxy_obj: Handle<'_, JsObject> = options.get(cx, "proxy")?;
    let proxy = parse_proxy(cx, proxy_obj)?;

    let config = AgentConfig {
        timeout: timeout.map(Duration::from_millis),
        headers_timeout: headers_timeout.map(Duration::from_millis),
        body_timeout: body_timeout.map(Duration::from_millis),
        connect_timeout: connect_timeout.map(Duration::from_millis),
        pool_idle_timeout: keep_alive.map(Duration::from_millis),
        max_redirections,
        max_response_size,
        allow_h2,
        auto_select_family,
        reject_unauthorized,
        reject_invalid_hostnames,
        ca: ca_pems,
        local_address,
        proxy,
    };

    let agent = match Agent::new(config) {
        Ok(a) => a,
        Err(e) => {
            // Share the core's UTF-8-safe capper so a multi-byte codepoint
            // straddling byte 256 can't panic the Neon runtime.
            return cx.throw_error(nrcore::error::cap_message_len(&e.to_string()));
        },
    };

    let on_start: Handle<'_, JsFunction> = callbacks.get(cx, "onResponseStart")?;
    let on_data: Handle<'_, JsFunction> = callbacks.get(cx, "onResponseData")?;
    let on_end: Handle<'_, JsFunction> = callbacks.get(cx, "onResponseEnd")?;
    let on_error: Handle<'_, JsFunction> = callbacks.get(cx, "onResponseError")?;

    let shared = SharedCallbacks {
        channel: cx.channel(),
        on_start: Arc::new(on_start.root(cx)),
        on_data: Arc::new(on_data.root(cx)),
        on_end: Arc::new(on_end.root(cx)),
        on_error: Arc::new(on_error.root(cx)),
    };

    Ok(cx.boxed(AgentHandle {
        inner: Arc::new(agent),
        callbacks: Arc::new(shared),
    }))
}

#[neon::export(name = "agentDispatch", context)]
fn agent_dispatch<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentHandle>>,
    options: Handle<'cx, JsObject>,
    req_id: Handle<'cx, JsNumber>,
) -> JsResult<'cx, JsBox<RequestHandle>> {
    let Some(req_id) = num_traits::cast::<f64, u32>(req_id.value(cx)) else {
        return cx.throw_error("requestId: value out of u32 range");
    };

    let dispatch_options = parse_dispatch_options(cx, options)?;

    let handler = JsDispatchHandler::new(Arc::clone(&agent.callbacks), req_id);

    let (controller, fut) = match agent.inner.dispatch(dispatch_options, handler) {
        Ok(pair) => pair,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    // No JsPromise here: JS gets the synchronous handle and observes the
    // request via the Agent's shared callbacks.
    runtime_handle().spawn(fut);

    Ok(cx.boxed(RequestHandle { inner: controller }))
}

#[neon::export(name = "agentClose", context)]
fn agent_close<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentHandle>>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    let channel = cx.channel();
    let agent = Arc::clone(&agent.inner);
    runtime_handle().spawn(async move {
        agent.close().await;
        deferred.settle_with(&channel, move |mut cx| Ok(cx.undefined()));
    });
    Ok(promise)
}

#[neon::export(name = "agentDestroy", context)]
fn agent_destroy<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentHandle>>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    let channel = cx.channel();
    let agent = Arc::clone(&agent.inner);
    runtime_handle().spawn(async move {
        agent.destroy(CoreError::ClientDestroyed).await;
        deferred.settle_with(&channel, move |mut cx| Ok(cx.undefined()));
    });
    Ok(promise)
}

#[neon::export(name = "requestHandleAbort", context)]
fn request_handle_abort<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandle>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.abort();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandlePause", context)]
fn request_handle_pause<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandle>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.pause();
    Ok(cx.undefined())
}

#[neon::export(name = "requestHandleResume", context)]
fn request_handle_resume<'cx>(
    cx: &mut FunctionContext<'cx>,
    handle: Handle<'cx, JsBox<RequestHandle>>,
) -> JsResult<'cx, JsUndefined> {
    handle.inner.resume();
    Ok(cx.undefined())
}
