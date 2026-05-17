// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Node.js bindings for reqwest - Rust HTTP client library.

mod agent;
mod body;
mod dispatch;
mod ffi_util;
mod handler;

use std::sync::OnceLock;

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

use neon::prelude::*;

/// Process-singleton tokio runtime that drives every dispatch future. Also
/// registered as neon's global executor so any future neon-side spawning
/// lands on the same runtime. Initialized exactly once by `neon::main`.
static TOKIO_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub(crate) fn runtime_handle() -> tokio::runtime::Handle {
    // `neon::main` populates the slot before any export function can be
    // invoked — JS can't call into the addon until module init completes.
    #[expect(
        clippy::expect_used,
        reason = "post-init invariant: neon::main runs before any export"
    )]
    TOKIO_RUNTIME
        .get()
        .expect("tokio runtime initialized by neon::main")
        .handle()
        .clone()
}

#[neon::main]
fn main(mut cx: ModuleContext<'_>) -> NeonResult<()> {
    // Build the runtime here so a build failure propagates as a JS exception
    // out of module init, instead of panicking on first dispatch.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .or_else(|e| -> NeonResult<tokio::runtime::Runtime> {
            cx.throw_error(format!("failed to build tokio runtime: {e}"))
        })?;
    // `get_or_init`'s closure is only called if the slot is empty; on a
    // second module-init call (impossible in practice) the freshly-built
    // runtime is dropped and the existing one is kept.
    let rt = TOKIO_RUNTIME.get_or_init(|| runtime);
    let _ = neon::set_global_executor(&mut cx, rt);
    neon::registered().export(&mut cx)
}

#[cfg(test)]
mod tests {
    use anyhow::Context;
    use anyhow::Result;

    use super::*;

    #[test]
    fn runtime_handle_after_init() -> Result<()> {
        // Eager-init the slot the same way `neon::main` would, then assert
        // the handle accessor returns a stable process-singleton.
        if TOKIO_RUNTIME.get().is_none() {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .context("tokio runtime build")?;
            let _ = TOKIO_RUNTIME.set(rt);
        }
        let a = runtime_handle();
        let b = runtime_handle();
        assert_eq!(a.id(), b.id(), "runtime handle must be process-singleton");
        Ok(())
    }
}
