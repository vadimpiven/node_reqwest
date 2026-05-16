# FFI Types + Basic Bindings (Chunk 03a)

## Purpose

Stand up the Neon FFI boundary on Neon's global tokio runtime and define the
TypeScript addon interface.

## Approach

- Use `neon::macro_internal::spawn` (backed by Neon's shared tokio runtime via
  the `tokio-rt-multi-thread` feature).
- Mirror the existing `addon-def.ts` shape for TypeScript types.

## Architecture

```text
TypeScript (AgentDispatchOptions)
   └─► Neon Boundary (neon::macro_internal::spawn)
        └─► Neon's Global Tokio Runtime
             └─► Rust (Agent::dispatch)
```

## Implementation

### packages/node/Cargo.toml

```toml
[package]
name = "node_reqwest"
edition.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
async-stream = { workspace = true }
async-trait = { workspace = true }
bytes = { workspace = true }
# TLS backend pinned at workspace level: reqwest features = [..., "rustls-tls-native-roots"].
# Single stack across targets, no glibc OpenSSL drift, honors system root store.
core = { path = "../core" }
mimalloc = { workspace = true }
neon = { workspace = true, features = ["tokio-rt-multi-thread"] }
parking_lot = { workspace = true }
tokio = { workspace = true }

[build-dependencies]
neon-build = { workspace = true }
```

### packages/node/src/lib.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Node.js bindings for reqwest - Rust HTTP client library.

mod agent;

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

use neon::prelude::*;

#[neon::export(name = "hello", context)]
fn hello<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsString> {
    Ok(cx.string("hello"))
}
```

### packages/node/src/agent.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Neon bindings for core::Agent - NO business logic, only JS↔Rust marshaling.

use std::net::IpAddr;
use std::time::Duration;

use core::{Agent, AgentConfig};
use neon::prelude::*;

/// JsBox wrapper around `core::Agent`.
pub struct AgentBox {
    pub inner: Agent,
}

impl Finalize for AgentBox {}

/// Coerce a JS number to `Option<u64>` milliseconds: `null` means no timeout,
/// `0` is rejected as invalid, NaN/negative are clamped to error.
fn js_timeout_ms<'cx>(
    cx: &mut FunctionContext<'cx>,
    options: Handle<'cx, JsObject>,
    key: &str,
) -> NeonResult<Option<u64>> {
    let v: Handle<JsValue> = options.get(cx, key)?;
    if v.is_a::<JsNull, _>(cx) || v.is_a::<JsUndefined, _>(cx) {
        return Ok(None);
    }
    let n = v.downcast_or_throw::<JsNumber, _>(cx)?.value(cx);
    if n.is_nan() || n < 0.0 {
        return cx.throw_error(format!("invalid {key}: must be >= 0 or null"));
    }
    if n == 0.0 {
        return cx.throw_error(format!("invalid {key}: 0 is invalid; use null for no timeout"));
    }
    Ok(Some(n as u64))
}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(
    cx: &mut FunctionContext<'cx>,
    options: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<AgentBox>> {
    // Agent-level timeouts and pool tuning (undici parity).
    let timeout = js_timeout_ms(cx, options, "timeout")?;
    let headers_timeout = js_timeout_ms(cx, options, "headersTimeout")?;
    let body_timeout = js_timeout_ms(cx, options, "bodyTimeout")?;
    let connect_timeout = js_timeout_ms(cx, options, "connectTimeout")?;
    let keep_alive = js_timeout_ms(cx, options, "keepAliveTimeout")?;

    // Redirect cap. 0 = no follow (undici default).
    let max_redirections: Handle<JsNumber> = options.get(cx, "maxRedirections")?;
    let max_redirections = max_redirections.value(cx).max(0.0) as u32;

    // Response body cap (bytes). null = uncapped.
    let max_response_size: Handle<JsValue> = options.get(cx, "maxResponseSize")?;
    let max_response_size = if max_response_size.is_a::<JsNull, _>(cx) {
        None
    } else {
        Some(max_response_size.downcast_or_throw::<JsNumber, _>(cx)?.value(cx).max(0.0) as u64)
    };

    let allow_h2: Handle<JsBoolean> = options.get(cx, "allowH2")?;
    let allow_h2 = allow_h2.value(cx);

    // TLS verification flags. Defaults true; false triggers a loud console.warn
    // dispatched via the Channel callback wired at construction.
    let reject_unauthorized: Handle<JsBoolean> = options.get(cx, "rejectUnauthorized")?;
    let reject_invalid_hostnames: Handle<JsBoolean> = options.get(cx, "rejectInvalidHostnames")?;
    let reject_unauthorized = reject_unauthorized.value(cx);
    let reject_invalid_hostnames = reject_invalid_hostnames.value(cx);

    // CA bundle: cap entry count and size; sanitize parse errors before surfacing.
    let ca: Handle<JsArray> = options.get(cx, "ca")?;
    let ca_len = ca.len(cx);
    if ca_len > 32 {
        return cx.throw_error("ca: too many entries (max 32)");
    }
    let mut ca_pems = Vec::with_capacity(ca_len as usize);
    for i in 0..ca_len {
        let pem: Handle<JsString> = ca.get(cx, i)?;
        let pem_str = pem.value(cx);
        if pem_str.len() > 256 * 1024 {
            return cx.throw_error(format!("ca[{i}]: entry too large (max 256 KiB)"));
        }
        ca_pems.push(pem_str);
    }

    // Bind address: parse as IpAddr at FFI boundary; reject malformed strings.
    let local_address: Handle<JsValue> = options.get(cx, "localAddress")?;
    let local_address: Option<IpAddr> = if local_address.is_a::<JsNull, _>(cx) {
        None
    } else {
        let s = local_address.downcast_or_throw::<JsString, _>(cx)?.value(cx);
        Some(s.parse().or_else(|_| cx.throw_error("localAddress: invalid IP"))?)
    };

    let config = AgentConfig {
        timeout: timeout.map(Duration::from_millis),
        headers_timeout: headers_timeout.map(Duration::from_millis),
        body_timeout: body_timeout.map(Duration::from_millis),
        connect_timeout: connect_timeout.map(Duration::from_millis),
        pool_idle_timeout: keep_alive.map(Duration::from_millis),
        max_redirections,
        max_response_size,
        allow_h2,
        reject_unauthorized,
        reject_invalid_hostnames,
        ca: ca_pems,
        local_address,
    };

    // builder construction (in core::Agent::new):
    //   builder
    //     .danger_accept_invalid_certs(!cfg.reject_unauthorized)
    //     .danger_accept_invalid_hostnames(!cfg.reject_invalid_hostnames)
    //     .http2_max_concurrent_reset_streams(100)  // CVE-2023-44487 rapid-reset
    // Errors from reqwest are truncated to 256 chars and never echo input PEM.

    let agent = Agent::new(config).or_else(|e| {
        let msg = e.to_string();
        let safe = if msg.len() > 256 { &msg[..256] } else { &msg };
        cx.throw_error(safe)
    })?;

    if !reject_unauthorized || !reject_invalid_hostnames {
        // Loud-by-default warning, mirrors NODE_TLS_REJECT_UNAUTHORIZED=0.
        let channel = cx.channel();
        channel.send(move |mut cx| {
            let global = cx.global_object();
            let console: Handle<JsObject> = global.get(&mut cx, "console")?;
            let warn: Handle<JsFunction> = console.get(&mut cx, "warn")?;
            let msg = cx.string("node_reqwest: TLS verification disabled on Agent");
            warn.call_with(&cx).this(console).arg(msg).exec(&mut cx)
        });
    }

    Ok(cx.boxed(AgentBox { inner: agent }))
}

#[neon::export(name = "agentClose", context)]
fn agent_close<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentBox>>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    deferred.settle_with(&cx.channel(), move |mut cx| Ok(cx.undefined()));
    Ok(promise)
}

#[neon::export(name = "agentDestroy", context)]
fn agent_destroy<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentBox>>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    deferred.settle_with(&cx.channel(), move |mut cx| Ok(cx.undefined()));
    Ok(promise)
}
```

### packages/node/export/addon-def.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ReadableStreamDefaultReader } from "node:stream/web";

import type { CoreErrorInfo } from "./errors.ts";

export type AgentCreationOptions = {
    /** Enable HTTP/2. When true, h2 reset-stream cap is set to 100 (CVE-2023-44487). */
    allowH2: boolean;
    /** Auto Happy-Eyeballs / family selection (default true via reqwest hickory-dns). */
    autoSelectFamily: boolean;
    /** Body idle-timeout in ms (null = no timeout, 0 = invalid). */
    bodyTimeout: number | null;
    /** Custom CA certificates (PEM strings). Max 32 entries, each ≤256 KiB. */
    ca: string[];
    /** TCP connect timeout in ms (null = no timeout, 0 = invalid). */
    connectTimeout: number | null;
    /** Headers receive timeout in ms (null = no timeout, 0 = invalid). */
    headersTimeout: number | null;
    /** Idle-socket close timeout in ms (null = no timeout, 0 = invalid). */
    keepAliveTimeout: number | null;
    /** Local IP to bind. Parsed as `IpAddr` at FFI boundary; null = OS default. */
    localAddress: string | null;
    /** Max auto-followed redirects. 0 = no follow (undici default). */
    maxRedirections: number;
    /** Response-body byte cap (null = uncapped). */
    maxResponseSize: number | null;
    proxy:
        | { type: "no-proxy" | "system" }
        | {
              type: "custom";
              uri: string;
              headers: Record<string, string>;
              token: string | null;
          };
    rejectInvalidHostnames: boolean;
    rejectUnauthorized: boolean;
    /** Total request timeout in ms (null = no timeout, 0 = invalid). */
    timeout: number | null;
    // pipelining: not supported (HTTP/2 multiplexing replaces it).
    // maxCachedSessions / keepAliveInitialDelay: not directly configurable.
};

export type AgentDispatchOptions = {
    /** Default reader. Rust calls `reader.read()` with no args; replies {value, done}. */
    body: ReadableStreamDefaultReader<Uint8Array> | null;
    /** Per-request body idle timeout in ms. null falls back to agent default. */
    bodyTimeout: number | null;
    headers: Record<string, string>;
    /** Per-request headers timeout in ms. null falls back to agent default. */
    headersTimeout: number | null;
    method: string;
    origin: string;
    path: string;
    query: string;
    throwOnError: boolean;
    // CONNECT and TRACE are rejected at FFI parse with NotSupportedError.
    // upgrade is deferred; expectContinue is not exposed.
    // blocking/idempotent/reset accepted but currently ignored — see 99-unsupported-features.md.
};

/** Opaque Neon JsBox handle for the Rust Agent. */
export interface AgentBox {
    readonly _: unique symbol;
}

/**
 * Opaque Neon JsBox handle for an in-flight request. Dropping the handle
 * cancels the underlying request via `Drop` on `RequestController`. The JS
 * `DispatchControllerImpl` must keep this handle alive for the lifetime of
 * the request to prevent premature GC-induced cancellation.
 */
export interface RequestHandleBox {
    readonly _: unique symbol;
}

export type DispatchCallbacks = {
    onResponseStart: (
        statusCode: number,
        headers: Record<string, string | string[]>,
        statusMessage: string,
    ) => void;
    /** chunk runtime type is Node `Buffer` (subclass of `Uint8Array`). */
    onResponseData: (chunk: Uint8Array) => void;
    onResponseEnd: (trailers: Record<string, string | string[]>) => void;
    onResponseError: (error: CoreErrorInfo) => void;
    /** WebSocket/upgrade — deferred, not in MVP. */
    onRequestUpgrade?: (
        statusCode: number,
        headers: Record<string, string | string[]>,
        socket: unknown,
    ) => void;
};

export interface Addon {
    hello(): string;

    agentCreate(options: AgentCreationOptions): AgentBox;
    agentDispatch(
        agent: AgentBox,
        options: AgentDispatchOptions,
        callbacks: DispatchCallbacks,
    ): RequestHandleBox;
    agentClose(agent: AgentBox): Promise<void>;
    agentDestroy(agent: AgentBox): Promise<void>;

    requestHandleAbort(handle: RequestHandleBox): void;
    requestHandlePause(handle: RequestHandleBox): void;
    requestHandleResume(handle: RequestHandleBox): void;
}
```

### packages/node/tests/vitest/addon-smoke.test.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, expect } from "vitest";

import { Addon } from "../../export/addon.ts";

describe("Addon Smoke Tests", () => {
    it("should load the addon", () => {
        expect(Addon).toBeDefined();
        expect(Addon.hello).toBeInstanceOf(Function);
    });

    it("should call hello() and return greeting", () => {
        const result = Addon.hello();
        expect(result).toBe("hello");
    });

    it("should create an agent instance", () => {
        const agent = Addon.agentCreate({
            allowH2: true,
            autoSelectFamily: true,
            bodyTimeout: 300000,
            ca: [],
            connectTimeout: 10000,
            headersTimeout: 300000,
            keepAliveTimeout: 4000,
            localAddress: null,
            maxRedirections: 0,
            maxResponseSize: null,
            proxy: { type: "no-proxy" },
            rejectInvalidHostnames: true,
            rejectUnauthorized: true,
            timeout: 10000,
        });
        expect(agent).toBeDefined();
    });
});
```

## Key Choices

| Item              | Value                                                |
| :---------------- | :--------------------------------------------------- |
| **FFI Framework** | Neon with `tokio-rt-multi-thread`                    |
| **Allocator**     | `mimalloc`                                           |
| **TLS**           | `rustls-tls-native-roots` (pinned at workspace)      |
| **Runtime**       | Neon's global shared tokio runtime                   |
| **Naming**        | `AgentBox` / `RequestHandleBox` (Neon convention)    |
| **Timeouts**      | `number \| null` across FFI; 0 rejected as invalid   |

## File Structure

```text
packages/node/
├── Cargo.toml
├── export/
│   └── addon-def.ts
├── src/
│   ├── lib.rs
│   └── agent.rs
└── tests/vitest/
    └── addon-smoke.test.ts
```
