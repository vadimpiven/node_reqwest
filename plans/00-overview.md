# Dispatcher Implementation - Master Plan

Undici-compatible HTTP dispatcher for Node.js, implemented in Rust via `reqwest`.
Performance targets vs. undici on the median across cronometro samples:
throughput ratio ≥ 0.95, latency ratio (median and p95) ≤ 1.05.

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
       ├── JsDispatchHandler (response: ack-gated push to JS via Channel)
       ├── JsBodyReader (request body: pull-based, Rust polls JS via oneshot)
       └── RequestHandleInstance (control)
       │
Rust Core (reqwest / tokio)
       │
       ├── Agent (reqwest::Client wrapper)
       ├── DispatchHandler trait
       ├── RequestController (cancel + backpressure)
       └── CoreError (undici-compatible codes)

Response data — ack-gated push (Rust → JS, with backpressure):
┌──────────┐                                ┌──────────┐
│  Rust    │  Channel::send(chunk, ack_tx)  │    JS    │
│  async   │ ─────────────────────────────► │  event   │
│  task    │                                │  loop    │
│          │  ack_tx.send(()) on callback   │          │
│  await   │ ◄───────────────────────────── │  return  │
└──────────┘                                └──────────┘

Request body — pull-based (Rust pulls from JS reader):
┌──────────┐                                ┌──────────┐
│  Rust    │  Channel::send(read, chunk_tx) │    JS    │
│  body    │ ─────────────────────────────► │  reader  │
│  stream  │                                │  .read() │
│          │  chunk_tx.send(bytes | done)   │          │
│  await   │ ◄───────────────────────────── │          │
└──────────┘                                └──────────┘
```

Both flows use a single oneshot per step; the directions differ. Response
chunks travel Rust→JS, gated on a JS→Rust ack. Request body chunks travel
JS→Rust, gated on a Rust→JS pull. Same primitive ("ack-gated oneshot"),
opposite producer/consumer roles.

## Implementation Sequence

Each chunk is self-contained with testable output. Later chunks depend on earlier ones.

### Phase 1: Core Rust (01 → 02a → 02b)

| Chunk                        | Purpose                                | Depends On | Testable Result                              |
| :--------------------------- | :------------------------------------- | :--------- | :------------------------------------------- |
| **01-errors.md**             | Error types with undici codes          | -          | Rust unit tests pass                         |
| **02a-core-types.md**        | Types, traits, backpressure primitives | 01         | Unit tests for PauseState, RequestController |
| **02b-request-execution.md** | Agent::dispatch with timeout/abort     | 02a        | Integration tests with wiremock              |

### Phase 2: FFI Bridge (03a → 03b → 03c)

| Chunk                       | Purpose                            | Depends On | Testable Result                      |
| :-------------------------- | :--------------------------------- | :--------- | :----------------------------------- |
| **03a-ffi-types.md**        | Neon setup, addon-def.ts           | 02b        | `pnpm build` succeeds, hello() works |
| **03b-dispatch-handler.md** | JsDispatchHandler + body streaming | 03a        | Callbacks receive events             |
| **03c-request-handles.md**  | agentDispatch + control bindings   | 03b        | Smoke tests for dispatch/abort/pause |

### Phase 3: TypeScript Integration (04a → 04b)

| Chunk                          | Purpose                 | Depends On | Testable Result             |
| :----------------------------- | :---------------------- | :--------- | :-------------------------- |
| **04a-dispatch-controller.md** | DispatchControllerImpl  | 03c        | Controller state tests      |
| **04b-agent-integration.md**   | Agent class + E2E tests | 04a        | Real HTTP requests complete |

### Phase 4: Performance Verification (05a → 05b)

| Chunk                               | Purpose                  | Depends On | Testable Result            |
| :---------------------------------- | :----------------------- | :--------- | :------------------------- |
| **05a-benchmark-infrastructure.md** | Test servers + utilities | 04b        | Servers start, respond     |
| **05b-benchmarks-ci.md**            | Comparison + CI workflow | 05a        | ≥95% of undici performance |

## Design Decisions

| Decision                  | Choice                                             | Rationale                                        |
| :------------------------ | :------------------------------------------------- | :----------------------------------------------- |
| Request body              | reqwest::Body (Bytes or Stream)                    | Supports both materialized and streaming bodies  |
| Request body stream       | Pull-based via oneshot channels                    | JS never blocked, Rust polls when ready          |
| Response data             | Sync-ack via oneshot in Channel closure            | Rust waits for JS callback execution per chunk   |
| Response body on error    | Drop without consuming                             | Avoids useless FFI copying; connection may close |
| Handler API               | New controller API only                            | Undici wraps legacy handlers                     |
| WebSocket/Upgrade         | NotSupportedError                                  | Post-undici-compliance                           |
| Tokio runtime             | Neon's global shared runtime                       | Single runtime, no custom init                   |
| Error types               | CoreError + from_reqwest()                         | Unified mapping to undici codes                  |
| User pause/resume         | PauseState + watch channel                         | Manual backpressure control                      |
| Request body cleanup      | Drop cancels stream + releases Root                | Proper abort handling, no resource leaks         |
| dispatch() return         | Always true                                        | No internal queue limit                          |
| Events                    | connect (per-origin), disconnect, connectionError  | Per undici Dispatcher spec                       |
| throwOnError              | ResponseError for 4xx/5xx                          | Matches undici behavior                          |
| AbortSignal               | Handled in dispatch(), triggers controller.abort() | Matches undici abort semantics                   |
| Lifecycle (close/destroy) | Rust trait with request tracking                   | Graceful shutdown + request cancellation         |
| expectContinue            | Not exposed                                        | reqwest handles internally for H2                |

## Undici Dispatcher Compliance

| Feature                     | Status | Notes                                                   |
| :-------------------------- | :----- | :------------------------------------------------------ |
| dispatch() method           | done   | Core functionality                                      |
| DispatchOptions             | done   | All fields mapped                                       |
| DispatchHandler callbacks   | done   | onRequestStart, onResponseStart, etc.                   |
| DispatchController          | done   | abort(), pause(), resume()                              |
| Error codes (UND_ERR_*)     | done   | Symbol.for instanceof                                   |
| close() / destroy()         | done   | Lifecycle trait with request tracking                   |
| request / stream / pipeline | done   | Inherit undici Dispatcher defaults on top of dispatch() |
| disconnect event            | done   | On connection loss after established                    |
| connectionError event       | done   | On initial connection failure                           |
| throwOnError                | done   | ResponseError for 4xx/5xx status codes                  |
| CONNECT method              | no     | NotSupportedError (rejected at FFI parse)               |
| Upgrade requests            | no     | NotSupportedError (rejected at FFI parse)               |

## Behavioral Differences

| Behavior                | Divergence                                                |
| :---------------------- | :-------------------------------------------------------- |
| connect event           | Fires on first response start, not socket establishment   |
| drain event             | Never emitted (dispatch always returns true)              |
| HTTP trailers           | Not exposed (reqwest limitation)                          |
| Status reason phrase    | Uses `canonical_reason`; server-supplied phrase discarded |
| maxRedirections default | `0` (matches undici); follows undici, not reqwest default |

See `99-unsupported-features.md` for full divergence table and rationale.

## Configuration

| Configuration       | Value        |
| :------------------ | :----------- |
| **Target Runtime**  | Node.js 20+  |
| **Rust Version**    | 1.75+        |
| **Total Est. Time** | ~16-20 hours |
| **Total Tests**     | ~40          |

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

## Security

- **TLS backend pinned**: reqwest configured with `rustls-tls-native-roots`
  only. Single stack across platforms; honors system root store; no
  OpenSSL/Schannel/SecureTransport drift.
- **Redirects disabled by default**: `redirect(Policy::none())` matches
  undici's `maxRedirections: 0`. No silent auto-follow, no protocol
  downgrade, no SSRF amplification. Callers opt in per-request.
- **No implicit cookie jar**: `cookie_store(false)` set explicitly even
  though the `cookies` reqwest feature is compiled in. Matches undici;
  prevents cross-tenant cookie leakage.
- **Header CRLF validation**: header names and values rejected at the TS
  layer (RFC 7230 token / VCHAR + obs-text) before crossing the FFI.
  Stops request smuggling and CRLF injection with a precise error
  identifying the offending header.
- **Error redaction**: URL userinfo and response body fragments stripped
  from error messages before crossing the FFI. Bearer tokens in
  `https://user:pass@host/` URLs never reach JS `Error.message`.
- **Panic safety across FFI**: release profile sets `panic = "abort"` and
  each Neon `Channel::send` closure runs inside `catch_unwind`. A panic
  inside a callback cannot unwind across the C ABI.
- **CA input caps**: `ca` option capped at 32 entries × 256 KiB each;
  oversize or malformed input rejected with a fixed `InvalidArgumentError`
  message that does not echo input bytes.
