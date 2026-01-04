# Dispatcher Implementation - Master Plan

## Problem/Purpose

Provide a high-performance, undici-compatible HTTP dispatcher for Node.js implemented in
Rust, supporting backpressure, comprehensive error handling, and optimized FFI.

## Solution

Implement a multi-layered architecture: a core Rust engine using `reqwest`, a Neon-based
FFI boundary, and a TypeScript integration layer that conforms to the `undici.Dispatcher`
interface.

## Architecture

```text
TypeScript Layer (undici API)
       │
FFI Boundary (Neon / Channel)
       │
Rust Core (reqwest / tokio)
```

## Implementation Sequence

All implementation is split into **13 chunks** of 1-2 hours each. Each chunk is fully
copy-paste ready with complete code and tests. Dependencies are already configured in
workspace `Cargo.toml`.

### Part 1: Core Foundation (3.0h)

- [ ] **01a-core-types.md** (1.5h) - Core types and basic Agent structure
- [ ] **01b-request-execution.md** (1.5h) - Request execution + 1 test

### Part 2: Core Backpressure (3.0h)

- [ ] **02a-pause-cancellation.md** (1.5h) - PauseState and RequestController types
- [ ] **02b-backpressure-integration.md** (1.5h) - Integration + 4 tests

### Part 3: Error Handling (2.5h)

- [ ] **03a-core-errors.md** (1.0h) - CoreError enum with Undici mapping
- [ ] **03b-typescript-errors.md** (1.5h) - 14 error classes + 6 tests

### Part 4: FFI Boundary (5.0h)

- [ ] **04a-ffi-types.md** (2.0h) - TypeScript interfaces + basic Neon + 3 tests
- [ ] **04b-dispatch-handler.md** (1.5h) - JsDispatchHandler marshaling
- [ ] **04c-request-handles.md** (1.5h) - Request control bindings + 4 tests

### Part 5: TypeScript Integration (4.0h)

- [ ] **05a-dispatch-controller.md** (2.0h) - DispatchController + 5 tests
- [ ] **05b-agent-integration.md** (2.0h) - Agent class + 3 E2E tests

### Part 6: Performance Benchmarking (3.0h)

- [ ] **06a-benchmark-infrastructure.md** (1.5h) - Servers + utilities
- [ ] **06b-benchmarks-ci.md** (1.5h) - Benchmarks + CI workflow

## Tables

| Configuration | Value |
| :--- | :--- |
| **Target Runtime** | Node.js 18+ |
| **Rust Version** | 1.75+ |
| **Total Est. Time** | 20.5 hours |
| **Total Tests** | 27+ |

## File Structure

```text
plans/
├── 00-overview.md
├── 01a-core-types.md
├── 01b-request-execution.md
├── 02a-pause-cancellation.md
├── 02b-backpressure-integration.md
├── 03a-core-errors.md
├── 03b-typescript-errors.md
├── 04a-ffi-types.md
├── 04b-dispatch-handler.md
├── 04c-request-handles.md
├── 05a-dispatch-controller.md
├── 05b-agent-integration.md
├── 06a-benchmark-infrastructure.md
└── 06b-benchmarks-ci.md
```
