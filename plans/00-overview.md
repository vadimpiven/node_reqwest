# Dispatcher Implementation - Master Plan

Complete implementation roadmap for undici-compatible dispatcher with
backpressure, error handling, and benchmarking.

## Overview

This plan is split into 6 sequential parts, each building on the previous
ones. Each part can be implemented and **tested independently** before moving
to the next, allowing early problem detection.

## Implementation Sequence

### ✅ Part 1: Core Foundation

**File**: `01-core-foundation.md`  
**Goal**: Basic HTTP request/response in Rust

- [ ] Core dispatcher types (`DispatchOptions`, `ResponseStart`, `Method`)
- [ ] `DispatchHandler` async trait
- [ ] Basic `Agent::new()` and `Agent::dispatch()`
- [ ] Mock handler test utilities
- [ ] **Tests**: Basic GET, network errors, multi-value headers

**Verification**: `cd packages/core && cargo test`

---

### ✅ Part 2: Core Backpressure

**File**: `02-core-backpressure.md`  
**Goal**: Add pause/resume/abort mechanisms

**Prerequisites**: Part 1 complete

- [ ] `PauseState` with atomic operations
- [ ] `RequestController` with `CancellationToken`
- [ ] Update `execute_request()` with backpressure loop
- [ ] Timeout support in `Agent::dispatch()`
- [ ] **Tests**: Abort before/during response, pause/resume, timeout

**Verification**: `cd packages/core && cargo test`

---

### ✅ Part 3: Error Handling

**File**: `03-error-handling.md`  
**Goal**: Map Core errors to Undici-compatible JS errors

**Prerequisites**: Parts 1-2 complete

- [ ] `CoreError` enum with error codes/names
- [ ] All Undici error classes using `Symbol.for`
- [ ] `createUndiciError()` factory function
- [ ] **Tests**: Error instanceof checks, cross-library compatibility

**Verification**:

```bash
cd packages/core && cargo test
cd packages/node && pnpm test errors.test.ts
```

---

### ✅ Part 4: FFI Boundary

**File**: `04-ffi-boundary.md`  
**Goal**: Neon bindings for Rust↔JS marshaling

**Prerequisites**: Parts 1-3 complete

- [ ] Addon interface types (`addon-def.ts`)
- [ ] `JsDispatchHandler` implementing `DispatchHandler`
- [ ] Neon exports: `agentCreate`, `agentDispatch`, `requestHandle*`
- [ ] Header/error marshaling
- [ ] **Tests**: Addon loads, agent creation, basic dispatch

**Verification**: `cd packages/node && pnpm build && pnpm test addon-smoke.test.ts`

---

### ✅ Part 5: TypeScript Integration

**File**: `05-typescript-integration.md`  
**Goal**: Complete undici Dispatcher interface

**Prerequisites**: Parts 1-4 complete

- [ ] `DispatchControllerImpl` class
- [ ] `Agent.dispatch()` with full callback wiring
- [ ] Pending request tracking + drain events
- [ ] Handle abort/pause before native handle set
- [ ] **Tests**: Controller state, closed/destroyed agents, E2E integration

**Verification**:

```bash
cd packages/node && pnpm build
pnpm test controller.test.ts
pnpm test dispatch-integration.test.ts
```

---

### ✅ Part 6: Performance Benchmarking

**File**: `06-performance-benchmarking.md`  
**Goal**: Verify performance matches/exceeds undici

**Prerequisites**: Parts 1-5 complete and working

- [ ] HTTP/1, HTTP/2, WebSocket benchmark scripts
- [ ] Test servers (HTTP/1, HTTP/2, WebSocket, Proxy)
- [ ] `cronometro` integration for statistics
- [ ] NPM scripts for all benchmark scenarios
- [ ] CI workflow integration
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
- [ ] 01-core-foundation.md
  - [ ] Implement
  - [ ] Test (3 tests passing)
- [ ] 02-core-backpressure.md
  - [ ] Implement
  - [ ] Test (4 new tests + previous 3 = 7 total)
- [ ] 03-error-handling.md
  - [ ] Implement Core errors
  - [ ] Implement TypeScript errors
  - [ ] Test (6 error tests)
- [ ] 04-ffi-boundary.md
  - [ ] Implement Neon bindings
  - [ ] Test (3 FFI smoke tests)
- [ ] 05-typescript-integration.md
  - [ ] Implement DispatchController
  - [ ] Implement Agent.dispatch()
  - [ ] Test (8 integration tests)
- [ ] 06-performance-benchmarking.md
  - [ ] Setup benchmark infrastructure
  - [ ] Run HTTP/1, HTTP/2, WebSocket benchmarks
  - [ ] Verify performance criteria
```

## Quick Start

```bash
# Start with Part 1
cd /Users/vadimpiven/Downloads/node_reqwest
cat plans/01-core-foundation.md

# Implement + test Part 1
cd packages/core
# ... implement dispatcher.rs, agent.rs, tests ...
cargo test

# Only proceed to Part 2 after Part 1 passes all tests
cat plans/02-core-backpressure.md
# ... and so on
```

## Estimated Timeline

| Part       | Complexity | Estimated Time  |
|:-----------|:-----------|:----------------|
| 1          | Medium     | 2-3 hours       |
| 2          | Medium     | 2-3 hours       |
| 3          | Low        | 1-2 hours       |
| 4          | High       | 3-4 hours       |
| 5          | High       | 3-4 hours       |
| 6          | Medium     | 2-3 hours       |
| **Total**  |            | **13-19 hours** |

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
