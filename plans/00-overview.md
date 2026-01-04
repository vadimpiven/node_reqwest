# Dispatcher Implementation - Master Plan

## Problem/Purpose

Provide an undici-compatible HTTP dispatcher for Node.js implemented in Rust using
`reqwest`. Full Dispatcher API compliance with performance matching undici.

## Solution

Multi-layered architecture: Rust core engine → Neon FFI → TypeScript integration.
Ordered implementation ensures each chunk builds on previous ones with testable results.

## Architecture

```text
TypeScript Layer (undici Dispatcher API)
       │
       ├── Agent extends Dispatcher
       ├── DispatchController (pause/resume/abort)
       └── Error classes (Symbol.for instanceof)
       │
FFI Boundary (Neon / Channel) — All operations non-blocking
       │
       ├── JsDispatchHandler (callback marshaling via Channel)
       ├── JsBodyReader (pull-based: Rust requests → JS reads → oneshot response)
       └── RequestHandleInstance (control)
       │
Rust Core (reqwest / tokio)
       │
       ├── Agent (reqwest::Client wrapper)
       ├── DispatchHandler trait
       ├── RequestController (cancel + backpressure)
       └── CoreError (undici-compatible codes)

Body Streaming Flow (non-blocking):
┌──────────┐                          ┌──────────┐
│  Rust    │  Channel::send(request)  │    JS    │
│  async   │ ───────────────────────► │  event   │
│  task    │                          │  loop    │
│          │  oneshot::send(chunk)    │          │
│          │ ◄─────────────────────── │          │
│  await   │                          │ read()   │
└──────────┘                          └──────────┘
```

## Implementation Sequence

Each chunk is self-contained with testable output. Later chunks depend on earlier ones.

### Phase 1: Core Rust (01 → 02a → 02b)

| Chunk | Purpose | Depends On | Testable Result |
| :--- | :--- | :--- | :--- |
| **01-errors.md** | Error types with undici codes | - | Rust unit tests pass |
| **02a-core-types.md** | Types, traits, backpressure primitives | 01 | Unit tests for PauseState, RequestController |
| **02b-request-execution.md** | Agent::dispatch with timeout/abort | 02a | Integration tests with wiremock |

### Phase 2: FFI Bridge (03a → 03b → 03c)

| Chunk | Purpose | Depends On | Testable Result |
| :--- | :--- | :--- | :--- |
| **03a-ffi-types.md** | Neon setup, addon-def.ts | 02b | `pnpm build` succeeds, hello() works |
| **03b-dispatch-handler.md** | JsDispatchHandler + body streaming | 03a | Callbacks receive events |
| **03c-request-handles.md** | agentDispatch + control bindings | 03b | Smoke tests for dispatch/abort/pause |

### Phase 3: TypeScript Integration (04a → 04b)

| Chunk | Purpose | Depends On | Testable Result |
| :--- | :--- | :--- | :--- |
| **04a-dispatch-controller.md** | DispatchControllerImpl | 03c | Controller state tests |
| **04b-agent-integration.md** | Agent class + E2E tests | 04a | Real HTTP requests complete |

### Phase 4: Performance Verification (05a → 05b)

| Chunk | Purpose | Depends On | Testable Result |
| :--- | :--- | :--- | :--- |
| **05a-benchmark-infrastructure.md** | Test servers + utilities | 04b | Servers start, respond |
| **05b-benchmarks-ci.md** | Comparison + CI workflow | 05a | ≥95% of undici performance |

## Design Decisions

| Decision | Choice | Rationale |
| :--- | :--- | :--- |
| Request body | Pull-based via oneshot channels | JS never blocked, natural backpressure |
| Response data | Acknowledgment-based via oneshot | Rust waits for JS to process each chunk |
| Handler API | New controller API only | Undici wraps legacy handlers |
| WebSocket/Upgrade | NotSupportedError | Post-undici-compliance |
| Tokio runtime | Neon's global shared runtime | Single runtime, no custom init |
| Error types | CoreError + from_reqwest() | Unified mapping to undici codes |
| User pause/resume | PauseState + watch channel | Manual backpressure control |
| Request body cleanup | Drop impl releases JS reader | Proper abort handling |
| dispatch() return | Always true | No internal queue limit |
| Events | connect, disconnect, connectionError | Per undici Dispatcher spec |

## Undici Dispatcher Compliance Checklist

| Feature | Status | Notes |
| :--- | :--- | :--- |
| dispatch() method | ✅ | Core functionality |
| DispatchOptions | ✅ | All fields mapped |
| DispatchHandler callbacks | ✅ | onRequestStart, onResponseStart, etc. |
| DispatchController | ✅ | abort(), pause(), resume() |
| Error codes (UND_ERR_*) | ✅ | Symbol.for instanceof |
| close() / destroy() | ✅ | Placeholder (reqwest manages) |
| connect event | ✅ | On first successful response |
| disconnect event | ✅ | On connection loss after established |
| connectionError event | ✅ | On initial connection failure |
| drain event | ⚠️ | Not emitted (dispatch always returns true) |
| CONNECT method | ❌ | NotSupportedError |
| Upgrade requests | ❌ | NotSupportedError |
| HTTP trailers | ❌ | reqwest doesn't expose |

## Tables

| Configuration | Value |
| :--- | :--- |
| **Target Runtime** | Node.js 20+ |
| **Rust Version** | 1.75+ |
| **Total Est. Time** | ~16-20 hours |
| **Total Tests** | ~31 |

## File Structure (Final)

```text
packages/core/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── error.rs
│   ├── agent.rs
│   └── dispatcher.rs
└── tests/
    ├── support/
    │   ├── mod.rs
    │   └── mock_handler.rs
    ├── agent_dispatch.rs
    └── backpressure.rs

packages/node/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── agent.rs
│   ├── body.rs
│   ├── dispatch.rs
│   └── handler.rs
├── export/
│   ├── addon.ts
│   ├── addon-def.ts
│   ├── agent.ts
│   ├── agent-def.ts
│   ├── dispatch-controller.ts
│   └── errors.ts
├── tests/vitest/
│   ├── addon-smoke.test.ts
│   ├── controller.test.ts
│   ├── dispatch-integration.test.ts
│   └── errors.test.ts
└── benchmarks/
    ├── config.js
    ├── http1.js
    ├── http2.js
    ├── _util/index.js
    └── servers/
        ├── http1-server.js
        ├── http2-server.js
        └── setup-certs.sh

.github/workflows/
└── benchmark.yml
```

## Security Considerations

- Headers passed through without filtering or logging (security-sensitive)
- No credentials stored beyond reqwest's internal TLS session cache
- Sensitive headers (Authorization, Cookie) handled at application layer
