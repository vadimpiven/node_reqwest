# Dispatcher Implementation - Master Plan

Complete implementation roadmap for undici-compatible dispatcher with
backpressure, error handling, and benchmarking.

## Overview

This plan is split into 6 sequential parts, each building on the previous
ones. Each part can be implemented and **tested independently** before moving
to the next, allowing early problem detection.

## Implementation Sequence

All parts are split into **2-hour chunks** with clear milestones for better progress tracking.

### ✅ Part 1: Core Foundation (3 hours total)

#### Chunk 1A: Core Types + Basic Agent (1.5 hours)

**File**: `01a-core-types.md`  
**Goal**: Define dispatcher types and basic Agent structure

- [ ] Core dispatcher types (`DispatchOptions`, `ResponseStart`, `Method`)
- [ ] `DispatchError` enum (basic version)
- [ ] `DispatchHandler` async trait
- [ ] Basic `Agent` struct with `AgentConfig`
- [ ] `Agent::new()` constructor

**Milestone**: Types compile, basic agent can be created

---

#### Chunk 1B: Request Execution + Tests (1.5 hours)

**File**: `01b-request-execution.md`  
**Goal**: Implement HTTP request/response flow with tests

**Prerequisites**: Chunk 1A complete

- [ ] `Agent::dispatch()` spawning async task
- [ ] `execute_request()` with reqwest integration
- [ ] Mock handler test utilities
- [ ] **Tests**: Basic GET (200 OK), network errors, multi-value headers

**Verification**: `cd packages/core && cargo test` (3 tests passing)

---

### ✅ Part 2: Core Backpressure (3 hours total)

#### Chunk 2A: Pause & Cancellation (1.5 hours)

**File**: `02a-pause-cancellation.md`  
**Goal**: Add backpressure primitives

**Prerequisites**: Part 1 (1A-1B) complete

- [ ] `PauseState` with atomic operations
- [ ] `RequestController` with `CancellationToken`
- [ ] Update `DispatchError` (add `Aborted`, `Timeout`)
- [ ] Export new types from `lib.rs`

**Milestone**: Backpressure types compile and can be instantiated

---

#### Chunk 2B: Backpressure Integration + Tests (1.5 hours)

**File**: `02b-backpressure-integration.md`  
**Goal**: Wire backpressure into request execution

**Prerequisites**: Chunk 2A complete

- [ ] Update `Agent::dispatch()` to return `RequestController`
- [ ] Update `execute_request()` with `select!` and `wait_if_paused()`
- [ ] Timeout handling with `reqwest::Error::is_timeout()`
- [ ] **Tests**: Abort before/during response, pause/resume, timeout

**Verification**: `cd packages/core && cargo test` (7 tests passing: 3 from Part 1 + 4 new)

---

### ✅ Part 3: Error Handling (2.5 hours total)

#### Chunk 3A: Core Error Types (1 hour)

**File**: `03a-core-errors.md`  
**Goal**: Define comprehensive Rust error types

**Prerequisites**: Part 2 complete

- [ ] `CoreError` enum with all Undici error variants
- [ ] `error_code()` method returning error codes
- [ ] `error_name()` method returning error names
- [ ] `status_code()` method for response errors
- [ ] Add `thiserror` dependency

**Milestone**: Core error types compile with proper Display/Error traits

---

#### Chunk 3B: TypeScript Errors + Tests (1.5 hours)

**File**: `03b-typescript-errors.md`  
**Goal**: Map Core errors to Undici-compatible JS errors

**Prerequisites**: Chunk 3A complete

- [ ] All 13 Undici error classes using `Symbol.for`
- [ ] `CoreErrorInfo` interface
- [ ] `createUndiciError()` factory function
- [ ] **Tests**: Error instanceof checks, cross-library Symbol.for compatibility

**Verification**:

```bash
cd packages/core && cargo test
cd packages/node && pnpm test errors.test.ts  # 6 tests passing
```

---

### ✅ Part 4: FFI Boundary (5 hours total)

#### Chunk 4A: FFI Types + Basic Bindings (2 hours)

**File**: `04a-ffi-types.md`  
**Goal**: Set up Neon project with basic addon interface

**Prerequisites**: Part 3 complete

- [ ] Addon interface types (`addon-def.ts`)
- [ ] `AgentInstance` wrapper struct
- [ ] Neon module setup with `hello()` export
- [ ] `agentCreate()` export
- [ ] Basic smoke test: addon loads and creates agent

**Verification**: `cd packages/node && pnpm build && pnpm test addon-smoke.test.ts` (2 tests)

---

#### Chunk 4B: Dispatch Handler + Marshaling (1.5 hours)

**File**: `04b-dispatch-handler.md`  
**Goal**: Bridge Rust async trait to JS callbacks

**Prerequisites**: Chunk 4A complete

- [ ] `JsDispatchHandler` struct with Neon `Channel`
- [ ] Implement `DispatchHandler` trait (all 4 callbacks)
- [ ] `headers_to_js()` helper for multi-value headers
- [ ] `DispatchError` to `CoreErrorInfo` conversion

**Milestone**: Handler compiles and can marshal data through Channel

---

#### Chunk 4C: Request Handle Bindings + Tests (1.5 hours)

**File**: `04c-request-handles.md`  
**Goal**: Complete FFI boundary with request control

**Prerequisites**: Chunk 4B complete

- [ ] `RequestHandleInstance` wrapper struct
- [ ] `agentDispatch()` export with callback wiring
- [ ] `requestHandleAbort/Pause/Resume()` exports
- [ ] `agentClose()` and `agentDestroy()` stubs
- [ ] `parse_dispatch_options()` helper
- [ ] **Tests**: Full dispatch with callbacks test

**Verification**: `cd packages/node && pnpm build && pnpm test addon-smoke.test.ts` (3 tests)

---

### ✅ Part 5: TypeScript Integration (4 hours total)

#### Chunk 5A: DispatchController (2 hours)

**File**: `05a-dispatch-controller.md`  
**Goal**: Implement Dispatcher.DispatchController interface

**Prerequisites**: Part 4 complete

- [ ] `DispatchControllerImpl` class
- [ ] State management (`#aborted`, `#paused`, `#reason`)
- [ ] `setRequestHandle()` with pending state application
- [ ] `abort()`, `pause()`, `resume()` methods
- [ ] **Tests**: Abort/pause before handle set, controller state transitions

**Verification**: `cd packages/node && pnpm build && pnpm test controller.test.ts` (5 tests)

---

#### Chunk 5B: Agent Integration + E2E Tests (2 hours)

**File**: `05b-agent-integration.md`  
**Goal**: Complete Agent.dispatch() with drain events

**Prerequisites**: Chunk 5A complete

- [ ] `Agent` class extending `EventEmitter`
- [ ] `dispatch()` with full callback wiring
- [ ] Pending request tracking (`#pendingRequests`, `#needDrain`)
- [ ] Drain event emission
- [ ] `close()` and `destroy()` methods
- [ ] **Tests**: Full request/response cycle, abort mid-stream, pause/resume E2E

**Verification**: `cd packages/node && pnpm test dispatch-integration.test.ts` (3 E2E tests)

---

### ✅ Part 6: Performance Benchmarking (3 hours total)

#### Chunk 6A: Benchmark Infrastructure (1.5 hours)

**File**: `06a-benchmark-infrastructure.md`  
**Goal**: Set up benchmark framework and test servers

**Prerequisites**: Part 5 complete

- [ ] `config.js` with benchmark configuration
- [ ] Utility functions (`makeParallelRequests`, `printResults`)
- [ ] HTTP/1 test server
- [ ] HTTP/2 test server (with SSL certs)
- [ ] WebSocket echo server
- [ ] Proxy server
- [ ] Add `cronometro`, `http-proxy`, `ws`, `concurrently` dependencies

**Milestone**: All servers start successfully, utilities compile

---

#### Chunk 6B: Benchmarks + CI (1.5 hours)

**File**: `06b-benchmarks-ci.md`  
**Goal**: Implement benchmarks and verify performance

**Prerequisites**: Chunk 6A complete

- [ ] `http1.js` benchmark (undici vs node_reqwest)
- [ ] `http2.js` benchmark
- [ ] `websocket.mjs` benchmark
- [ ] NPM scripts for all scenarios
- [ ] CI workflow (`.github/workflows/benchmark.yml`)
- [ ] **Verification**: Performance ≥ 95% of undici throughput

**Verification**: `cd packages/node && pnpm bench:all`

---

## Architecture Summary

```text
┌─────────────────────────────────────────────────────────────────┐
│                        TypeScript Layer                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Agent.dispatch() → DispatchControllerImpl                 │  │
│  │   - Tracks pending requests                               │  │
│  │   - Emits drain events                                    │  │
│  │   - Handles abort/pause before native handle              │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         FFI Boundary (Neon)                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ JsDispatchHandler                                         │  │
│  │   - Marshals callbacks via Channel                        │  │
│  │   - Converts CoreError → CoreErrorInfo                    │  │
│  │   - Zero-copy (except Bytes → JsBuffer)                   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                          Core (Rust)                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Agent::dispatch()                                         │  │
│  │   - Spawns task with RequestController                    │  │
│  │   - CancellationToken for abort                           │  │
│  │   - PauseState for backpressure                           │  │
│  │   - Streams response with reqwest                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Critical Design Principles

1. **Core = Business Logic**: All HTTP logic stays in Rust
2. **Node = Marshaling Only**: FFI layer just converts types
3. **Test Each Layer**: Every part has its own test suite
4. **No Unbounded Queues**: Backpressure blocks at source
5. **Minimal Copying**: `Bytes` arc-backed, single copy at FFI boundary
6. **Undici Compatibility**: Symbol.for ensures cross-library instanceof

## Progress Tracking

Create a checklist in your project management tool:

```markdown
- [ ] Part 1: Core Foundation (3h total)
  - [ ] 1A: Core Types + Basic Agent (1.5h)
    - [ ] Types compile
  - [ ] 1B: Request Execution + Tests (1.5h)
    - [ ] 3 tests passing
- [ ] Part 2: Core Backpressure (3h total)
  - [ ] 2A: Pause & Cancellation (1.5h)
    - [ ] Backpressure types compile
  - [ ] 2B: Backpressure Integration + Tests (1.5h)
    - [ ] 7 tests passing (3 + 4 new)
- [ ] Part 3: Error Handling (2.5h total)
  - [ ] 3A: Core Error Types (1h)
    - [ ] Error types with Display/Error traits
  - [ ] 3B: TypeScript Errors + Tests (1.5h)
    - [ ] 6 error tests passing
- [ ] Part 4: FFI Boundary (5h total)
  - [ ] 4A: FFI Types + Basic Bindings (2h)
    - [ ] 2 addon smoke tests passing
  - [ ] 4B: Dispatch Handler + Marshaling (1.5h)
    - [ ] Handler compiles
  - [ ] 4C: Request Handle Bindings + Tests (1.5h)
    - [ ] 3 FFI tests passing
- [ ] Part 5: TypeScript Integration (4h total)
  - [ ] 5A: DispatchController (2h)
    - [ ] 5 controller tests passing
  - [ ] 5B: Agent Integration + E2E (2h)
    - [ ] 3 E2E integration tests passing
- [ ] Part 6: Performance Benchmarking (3h total)
  - [ ] 6A: Benchmark Infrastructure (1.5h)
    - [ ] All servers start successfully
  - [ ] 6B: Benchmarks + CI (1.5h)
    - [ ] Performance ≥ 95% of undici
```

## Quick Start

```bash
# Start with Chunk 1A
cd /Users/vadimpiven/Downloads/node_reqwest
cat plans/01a-core-types.md

# Implement types
cd packages/core
# ... implement dispatcher.rs, agent.rs (types only) ...
cargo build  # Verify types compile

# Move to Chunk 1B
cat plans/01b-request-execution.md
# ... implement execute_request(), tests ...
cargo test  # Must see 3 tests passing before proceeding

# Only proceed to Chunk 2A after all Part 1 tests pass
cat plans/02a-pause-cancellation.md
# ... and so on
```

**Workflow Tips:**

- ⏱️ Set a timer for each chunk to stay focused
- ✅ Never skip to next chunk until current tests pass
- 📝 Mark chunks complete in progress tracker
- 🎯 Each chunk should be completable in one sitting
- 🔄 If a chunk takes > 2.5 hours, reassess approach

## Estimated Timeline

| Chunk      | Focus                        | Estimated Time |
|:-----------|:-----------------------------|:---------------|
| **1A**     | Core Types + Basic Agent     | 1.5 hours      |
| **1B**     | Request Execution + Tests    | 1.5 hours      |
| **2A**     | Pause & Cancellation         | 1.5 hours      |
| **2B**     | Backpressure Integration     | 1.5 hours      |
| **3A**     | Core Error Types             | 1 hour         |
| **3B**     | TypeScript Errors + Tests    | 1.5 hours      |
| **4A**     | FFI Types + Basic Bindings   | 2 hours        |
| **4B**     | Dispatch Handler Marshaling  | 1.5 hours      |
| **4C**     | Request Handle Bindings      | 1.5 hours      |
| **5A**     | DispatchController           | 2 hours        |
| **5B**     | Agent Integration + E2E      | 2 hours        |
| **6A**     | Benchmark Infrastructure     | 1.5 hours      |
| **6B**     | Benchmarks + CI              | 1.5 hours      |
| **Total**  |                              | **20.5 hours** |

**Key Benefits of 2-Hour Chunks:**

- ✅ Complete a chunk in a single focused session
- ✅ Clear stopping points with passing tests as milestones
- ✅ Faster feedback loop - see progress every 1-2 hours
- ✅ Easier to estimate and track remaining work
- ✅ Natural breakpoints prevent burnout

## Success Criteria

- ✅ All Rust tests pass (core package)
- ✅ All TypeScript tests pass (node package)
- ✅ FFI boundary handles errors gracefully
- ✅ Backpressure prevents unbounded memory growth
- ✅ Performance ≥ 95% of undici throughput
- ✅ Zero memory leaks under sustained load

## Notes

- Each part assumes previous parts are **complete and tested**
- Do not skip testing - it's critical for early problem detection
- If a test fails, fix it before proceeding to next part
- Backpressure verification is in Part 2 tests - very important!
