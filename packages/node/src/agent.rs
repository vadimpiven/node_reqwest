//! Agent bindings

use crate::*;

pub struct AgentInstance;

impl Finalize for AgentInstance {}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsBox<AgentInstance>> {
    Ok(cx.boxed(AgentInstance))
}

#[neon::export(name = "agentDispatch", context)]
fn agent_dispatch<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentInstance>>,
    _options: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsString> {
    cx.throw_error("Not implemented")
}

#[neon::export(name = "agentClose", context)]
fn agent_close<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentInstance>>,
) -> JsResult<'cx, JsString> {
    cx.throw_error("Not implemented")
}

#[neon::export(name = "agentDestroy", context)]
fn agent_destroy<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentInstance>>,
) -> JsResult<'cx, JsString> {
    cx.throw_error("Not implemented")
}
