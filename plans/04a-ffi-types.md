# FFI Types + Basic Bindings (Chunk 4A)

## Problem/Purpose

Initialize the Neon-based FFI boundary and establish the core TypeScript interfaces for
the native addon.

## Solution

Define the `Addon` interface in TypeScript and implement the `agentCreate` binding in Rust
to bridge configuration data. Requires workspace dependencies: `neon`, `mimalloc`.

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

export interface AgentCreationOptions {
  timeout: number;
  connectTimeout: number;
  poolIdleTimeout: number;
}

export interface DispatchOptions {
  origin?: string;
  path: string;
  method: string;
  headers: Record<string, string>;
}

export interface Addon {
  hello(): string;
  agentCreate(options: AgentCreationOptions): AgentInstance;
  agentDispatch(agent: AgentInstance, options: DispatchOptions, callbacks: DispatchCallbacks): RequestHandle;
  agentClose(agent: AgentInstance): Promise<void>;
  agentDestroy(agent: AgentInstance, error?: Error): Promise<void>;
  requestHandleAbort(handle: RequestHandle): void;
  requestHandlePause(handle: RequestHandle): void;
  requestHandleResume(handle: RequestHandle): void;
}
```

### packages/node/src/lib.rs

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Node.js bindings for reqwest - Rust HTTP client library

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

//! Neon bindings for core::Agent - NO business logic, only JS↔Rust marshaling

use core::{Agent, AgentConfig};
use neon::prelude::*;
use std::time::Duration;

/// Wrapper for core::Agent
pub struct AgentInstance {
    pub inner: Agent,
    pub runtime: tokio::runtime::Handle,
}

impl Finalize for AgentInstance {}

#[neon::export(name = "agentCreate", context)]
fn agent_create<'cx>(cx: &mut FunctionContext<'cx>, options: Handle<'cx, JsObject>) -> JsResult<'cx, JsBox<AgentInstance>> {
    let timeout: Handle<JsNumber> = options.get(cx, "timeout")?;
    let connect_timeout: Handle<JsNumber> = options.get(cx, "connectTimeout")?;
    let pool_idle_timeout: Handle<JsNumber> = options.get(cx, "poolIdleTimeout")?;

    let timeout_ms = timeout.value(cx) as u64;
    let connect_timeout_ms = connect_timeout.value(cx) as u64;
    let pool_idle_timeout_ms = pool_idle_timeout.value(cx) as u64;

    let config = AgentConfig {
        timeout: if timeout_ms > 0 { Some(Duration::from_millis(timeout_ms)) } else { None },
        connect_timeout: if connect_timeout_ms > 0 { Some(Duration::from_millis(connect_timeout_ms)) } else { None },
        pool_idle_timeout: if pool_idle_timeout_ms > 0 { Some(Duration::from_millis(pool_idle_timeout_ms)) } else { None },
    };
    
    let runtime = tokio::runtime::Handle::try_current()
        .or_else(|_| {
            tokio::runtime::Runtime::new()
                .map(|rt| {
                    let handle = rt.handle().clone();
                    std::mem::forget(rt);
                    handle
                })
        })
        .map_err(|e| cx.throw_error::<_, ()>(format!("Failed to get tokio runtime: {e}")).unwrap_err())?;

    let agent = Agent::new(config)
        .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

    Ok(cx.boxed(AgentInstance { inner: agent, runtime }))
}
```

### packages/node/tests/vitest/addon-smoke.test.ts

```typescript
import { describe, it, expect } from 'vitest';
import Addon from '../../index.node';

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
      timeout: 0,
      connectTimeout: 0,
      poolIdleTimeout: 0,
    });
    expect(agent).toBeDefined();
  });
});
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
├── src/
│   ├── lib.rs
│   └── agent.rs
└── tests/vitest/
    └── addon-smoke.test.ts
```
