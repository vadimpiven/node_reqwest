//! Node.js bindings for reqwest - Rust HTTP client library
use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

use neon::prelude::*;

#[neon::export(name = "hello", context)]
fn hello<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsString> {
    Ok(cx.string("hello"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn hello_test() {
        let expected = "hello";
        assert_eq!(expected, "hello");
    }
}
