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

## Design Decisions

| Decision | Choice | Rationale |
| :--- | :--- | :--- |
| Request body | `ReadableStreamBYOBReader` → Rust stream | Undici backpressure compliance |
| Handler API | New API only (`controller.pause()`) | Undici wraps legacy handlers |
| WebSocket/Upgrade | Deferred (not in MVP) | Will be added later |
| Tokio runtime | Neon's global shared runtime | Single runtime for all Agents |
| Error types | Unified `CoreError` | No duplication |
| Header processing | Pass-through, no logging | Security (no leaking) |
| Buffer copying | One copy per chunk | Electron compatibility |
| Context parameter | Empty `{}` in `onRequestStart` | No retries (stream bodies) |
| Response headers | `Record<string, string \| string[]>` | Match undici format exactly |
| Request ordering | No pipelining, no retries | All bodies are streams |

## Implementation Sequence

Implementation reordered to address critical/fragile parts first while maintaining testability:

### Part 1: Error Foundation (2.5h)

- [ ] **01-errors.md** (2.5h) - CoreError + TypeScript error classes + tests

### Part 2: Core Types (3.0h)

- [ ] **02a-core-types.md** (1.5h) - DispatchHandler trait, backpressure primitives
- [ ] **02b-request-execution.md** (1.5h) - Request execution + tests

### Part 3: FFI Boundary (5.0h)

- [ ] **03a-ffi-types.md** (2.0h) - TypeScript interfaces + Neon setup + tests
- [ ] **03b-dispatch-handler.md** (1.5h) - JsDispatchHandler + request body streaming
- [ ] **03c-request-handles.md** (1.5h) - Request control bindings + tests

### Part 4: TypeScript Integration (4.0h)

- [ ] **04a-dispatch-controller.md** (2.0h) - DispatchController + tests
- [ ] **04b-agent-integration.md** (2.0h) - Agent class + E2E tests

### Part 5: Performance Benchmarking (3.0h)

- [ ] **05a-benchmark-infrastructure.md** (1.5h) - Servers + utilities
- [ ] **05b-benchmarks-ci.md** (1.5h) - Benchmarks + CI workflow

## Tables

| Configuration | Value |
| :--- | :--- |
| **Target Runtime** | Node.js 18+ |
| **Rust Version** | 1.75+ |
| **Total Est. Time** | 20 hours |
| **Total Tests** | 25+ |

## File Structure

```text
plans/
├── 00-overview.md
├── 01-errors.md
├── 02a-core-types.md
├── 02b-request-execution.md
├── 03a-ffi-types.md
├── 03b-dispatch-handler.md
├── 03c-request-handles.md
├── 04a-dispatch-controller.md
├── 04b-agent-integration.md
├── 05a-benchmark-infrastructure.md
└── 05b-benchmarks-ci.md
```

## Security Considerations

- Headers passed through without logging or filtering
- Sensitive headers (Authorization, Cookie) not explicitly handled - application layer
- No credentials stored or cached beyond TLS session cache
