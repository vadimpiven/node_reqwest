# FFI Types + Basic Bindings (Chunk 03a)

## Problem/Purpose

Initialize the Neon-based FFI boundary using Neon's global tokio runtime and establish
core TypeScript interfaces for the native addon.

## Solution

Use `neon::macro_internal::spawn` which leverages the shared global tokio runtime
(automatically initialized by Neon with `tokio-rt-multi-thread` feature). Define
TypeScript interfaces matching the existing `addon-def.ts` structure.

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
core = { path = "../core" }
mimalloc = { workspace = true }
neon = { workspace = true, features = ["tokio-rt-multi-thread"] }
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

use std::time::Duration;

use core::{Agent, AgentConfig};
use neon::prelude::*;

/// Wrapper for core::Agent stored as JsBox.
pub struct AgentInstance {
    pub inner: Agent,
}

impl Finalize for AgentInstance {}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(
    cx: &mut FunctionContext<'cx>,
    options: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBox<AgentInstance>> {
    let timeout: Handle<JsNumber> = options.get(cx, "timeout")?;
    let connect_timeout: Handle<JsNumber> = options.get(cx, "keepAliveTimeout")?;
    let pool_idle_timeout: Handle<JsNumber> = options.get(cx, "keepAliveInitialDelay")?;

    let timeout_ms = timeout.value(cx) as u64;
    let connect_timeout_ms = connect_timeout.value(cx) as u64;
    let pool_idle_timeout_ms = pool_idle_timeout.value(cx) as u64;

    let config = AgentConfig {
        timeout: if timeout_ms > 0 {
            Some(Duration::from_millis(timeout_ms))
        } else {
            None
        },
        connect_timeout: if connect_timeout_ms > 0 {
            Some(Duration::from_millis(connect_timeout_ms))
        } else {
            None
        },
        pool_idle_timeout: if pool_idle_timeout_ms > 0 {
            Some(Duration::from_millis(pool_idle_timeout_ms))
        } else {
            None
        },
    };

    let agent = Agent::new(config)
        .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

    Ok(cx.boxed(AgentInstance { inner: agent }))
}

#[neon::export(name = "agentClose", context)]
fn agent_close<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentInstance>>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    deferred.settle_with(&cx.channel(), move |mut cx| Ok(cx.undefined()));
    Ok(promise)
}

#[neon::export(name = "agentDestroy", context)]
fn agent_destroy<'cx>(
    cx: &mut FunctionContext<'cx>,
    _agent: Handle<'cx, JsBox<AgentInstance>>,
) -> JsResult<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    deferred.settle_with(&cx.channel(), move |mut cx| Ok(cx.undefined()));
    Ok(promise)
}
```

### packages/node/export/addon-def.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ReadableStreamBYOBReader } from 'node:stream/web';

import type { CoreErrorInfo } from './errors.ts';

export type AgentCreationOptions = {
  allowH2: boolean;
  ca: string[];
  connections: number;
  keepAliveInitialDelay: number;
  keepAliveTimeout: number;
  localAddress: string | null;
  maxCachedSessions: number;
  pipelining: number;
  proxy:
    | { type: 'no-proxy' | 'system' }
    | {
        type: 'custom';
        uri: string;
        headers: Record<string, string>;
        token: string | null;
      };
  rejectInvalidHostnames: boolean;
  rejectUnauthorized: boolean;
  timeout: number;
};

export type AgentDispatchOptions = {
  blocking: boolean;
  body: ReadableStreamBYOBReader | null;
  bodyTimeout: number;
  expectContinue: boolean;
  headers: Record<string, string>;
  headersTimeout: number;
  idempotent: boolean;
  method: string;
  origin: string;
  path: string;
  query: string;
  reset: boolean;
  throwOnError: boolean;
  upgrade: string | null;
};

export interface AgentInstance {
  readonly _: unique symbol;
}

export interface RequestHandle {
  readonly _: unique symbol;
}

export type DispatchCallbacks = {
  onResponseStart: (statusCode: number, headers: Record<string, string | string[]>, statusMessage: string) => void;
  onResponseData: (chunk: Buffer) => void;
  onResponseEnd: (trailers: Record<string, string | string[]>) => void;
  onResponseError: (error: CoreErrorInfo) => void;
};

export interface Addon {
  hello(): string;

  agentCreate(options: AgentCreationOptions): AgentInstance;
  agentDispatch(agent: AgentInstance, options: AgentDispatchOptions, callbacks: DispatchCallbacks): RequestHandle;
  agentClose(agent: AgentInstance): Promise<void>;
  agentDestroy(agent: AgentInstance): Promise<void>;

  requestHandleAbort(handle: RequestHandle): void;
  requestHandlePause(handle: RequestHandle): void;
  requestHandleResume(handle: RequestHandle): void;
}
```

### packages/node/tests/vitest/addon-smoke.test.ts

```typescript
import { describe, it, expect } from 'vitest';

import { Addon } from '../../export/addon.ts';

describe('Addon Smoke Tests', () => {
  it('should load the addon', () => {
    expect(Addon).toBeDefined();
    expect(Addon.hello).toBeInstanceOf(Function);
  });

  it('should call hello() and return greeting', () => {
    const result = Addon.hello();
    expect(result).toBe('hello');
  });

  it('should create an agent instance', () => {
    const agent = Addon.agentCreate({
      allowH2: true,
      ca: [],
      keepAliveInitialDelay: 60000,
      keepAliveTimeout: 4000,
      localAddress: null,
      maxCachedSessions: 100,
      proxy: { type: 'system' },
      rejectInvalidHostnames: true,
      rejectUnauthorized: true,
      timeout: 10000,
    });
    expect(agent).toBeDefined();
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **FFI Framework** | Neon with `tokio-rt-multi-thread` |
| **Allocator** | `mimalloc` |
| **Runtime** | Neon's global shared tokio runtime |
| **Tests** | 3 smoke tests |

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
