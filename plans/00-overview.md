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

| Phase | Part | Focus | Time |
| :--- | :--- | :--- | :--- |
| **1** | Core Foundation | Types & execution flow | 3.0h |
| **2** | Backpressure | Pause/Resume/Abort | 3.0h |
| **3** | Error Handling | Undici parity errors | 2.5h |
| **4** | FFI Boundary | Rust/JS marshaling | 5.0h |
| **5** | TS Integration | Dispatcher API | 4.0h |
| **6** | Benchmarking | Perf verification | 3.0h |

## Tables

| Configuration | Value |
| :--- | :--- |
| **Target Runtime** | Node.js 18+ |
| **Rust Version** | 1.75+ |
| **Total Est. Time** | 20.5 hours |

## File Structure

```text
plans/
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
