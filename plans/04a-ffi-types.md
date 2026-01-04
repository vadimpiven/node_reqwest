# FFI Types + Basic Bindings (Chunk 4A)

## Problem/Purpose

Initialize the Neon-based FFI boundary and establish the core TypeScript interfaces for
the native addon.

## Solution

Define the `Addon` interface in TypeScript and implement the `agentCreate` binding in Rust
to bridge configuration data.

## Architecture

```text
TypeScript (AgentOptions) 
  └─ Neon Boundary 
       └─ Rust (AgentConfig -> Agent::new())
```

## Implementation

### packages/node/export/addon-def.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT
import type { IncomingHttpHeaders } from 'undici';
import type { CoreErrorInfo } from './errors';

export interface AgentInstance { readonly _: unique symbol; }
export interface RequestHandle { readonly _: unique symbol; }

export type DispatchCallbacks = {
  onResponseStart: (statusCode: number, headers: IncomingHttpHeaders, statusMessage: string) => void;
  onResponseData: (chunk: Buffer) => void;
  onResponseEnd: (trailers: IncomingHttpHeaders) => void;
  onResponseError: (error: CoreErrorInfo) => void;
};

export interface Addon {
  hello(): string;
  agentCreate(options: { timeout: number, connectTimeout: number, poolIdleTimeout: number }): AgentInstance;
  agentDispatch(agent: AgentInstance, options: any, callbacks: DispatchCallbacks): RequestHandle;
}
```

### packages/node/src/agent.rs

```rust
use core::{Agent, AgentConfig};
use neon::prelude::*;
use std::time::Duration;

pub struct AgentInstance {
    pub inner: Agent,
    pub runtime: tokio::runtime::Handle,
}

impl Finalize for AgentInstance {}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(cx: &mut FunctionContext<'cx>, options: Handle<'cx, JsObject>) -> JsResult<'cx, JsBox<AgentInstance>> {
    let timeout: Handle<JsNumber> = options.get(cx, "timeout")?;
    let config = AgentConfig {
        timeout: Some(Duration::from_millis(timeout.value(cx) as u64)),
        ..Default::default()
    };
    
    let runtime = tokio::runtime::Handle::current();
    let agent = Agent::new(config).map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

    Ok(cx.boxed(AgentInstance { inner: agent, runtime }))
}
```

### packages/node/src/lib.rs

```rust
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

## Tables

| Metric | Value |
| :--- | :--- |
| **FFI Framework** | `Neon` |
| **Allocator** | `mimalloc` |
| **Est. Build Time** | < 2 minutes |

## File Structure

```text
packages/node/
├── export/
│   └── addon-def.ts
└── src/
    ├── lib.rs
    └── agent.rs
```
