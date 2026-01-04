# Implementation Roadmap - Visual Guide

## 🎯 Total: 20.5 hours across 13 chunks

```text
Part 1: Core Foundation (3h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
├─ 1A: Core Types [1.5h] ████████░░░░░░░░
│  └─ ✓ Types compile
├─ 1B: Request Execution [1.5h] ████████░
│  └─ ✓ 3 tests passing

Part 2: Core Backpressure (3h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
├─ 2A: Pause & Cancellation [1.5h] ██████
│  └─ ✓ Backpressure types compile
├─ 2B: Integration [1.5h] █████████░░░░░░
│  └─ ✓ 7 tests passing (3+4)

Part 3: Error Handling (2.5h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
├─ 3A: Core Errors [1h] █████░░░░░░░░░░░░
│  └─ ✓ Error traits work
├─ 3B: TypeScript Errors [1.5h] ████████░
│  └─ ✓ 6 error tests passing

Part 4: FFI Boundary (5h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
├─ 4A: FFI Types [2h] ███████████████░░░░
│  └─ ✓ 2 addon tests passing
├─ 4B: Dispatch Handler [1.5h] ████████░░
│  └─ ✓ Handler compiles
├─ 4C: Request Handles [1.5h] ████████░░░
│  └─ ✓ 3 FFI tests passing

Part 5: TypeScript Integration (4h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
├─ 5A: DispatchController [2h] ██████████
│  └─ ✓ 5 controller tests passing
├─ 5B: Agent Integration [2h] ███████████
│  └─ ✓ 3 E2E tests passing

Part 6: Performance Benchmarking (3h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
├─ 6A: Infrastructure [1.5h] ████████░░░░
│  └─ ✓ All servers start
└─ 6B: Benchmarks + CI [1.5h] █████████░░
   └─ ✓ Performance ≥ 95% undici
```

## 📊 Progress Tracker

Mark chunks as you complete them:

```text
Day 1 (4-6 hours)
  [ ] 1A: Core Types (1.5h)
  [ ] 1B: Request Execution (1.5h)
  [ ] 2A: Pause & Cancellation (1.5h)
  
Day 2 (4-5 hours)
  [ ] 2B: Backpressure Integration (1.5h)
  [ ] 3A: Core Errors (1h)
  [ ] 3B: TypeScript Errors (1.5h)
  [ ] 4A: FFI Types (start, 2h)
  
Day 3 (5 hours)
  [ ] 4A: FFI Types (finish if needed)
  [ ] 4B: Dispatch Handler (1.5h)
  [ ] 4C: Request Handles (1.5h)
  [ ] 5A: DispatchController (start, 2h)

Day 4 (4 hours)
  [ ] 5A: DispatchController (finish if needed)
  [ ] 5B: Agent Integration (2h)
  [ ] 6A: Benchmark Infrastructure (start, 1.5h)

Day 5 (3 hours)
  [ ] 6A: Benchmark Infrastructure (finish if needed)
  [ ] 6B: Benchmarks + CI (1.5h)
  [ ] 🎉 PROJECT COMPLETE!
```

## 🎯 Milestones Map

```text
Chunk → Milestone → Files Changed → Tests
═══════════════════════════════════════════════════════

1A  → Types compile
     ├─ src/dispatcher.rs ⭐
     ├─ src/agent.rs ⭐
     └─ src/lib.rs ⭐
     
1B  → 3 tests passing
     ├─ src/agent.rs (updated)
     ├─ tests/support/mock_handler.rs ⭐
     └─ tests/agent_dispatch.rs ⭐
     └─ Tests: ✓✓✓

2A  → Backpressure types compile
     ├─ src/dispatcher.rs (updated)
     └─ src/lib.rs (updated)
     
2B  → 7 tests passing (3+4 new)
     ├─ src/agent.rs (updated)
     └─ tests/backpressure.rs ⭐
     └─ Tests: ✓✓✓✓✓✓✓

3A  → Error types with traits
     ├─ src/error.rs ⭐
     └─ src/lib.rs (updated)
     
3B  → 6 error tests passing
     ├─ export/errors.ts ⭐
     └─ tests/vitest/errors.test.ts ⭐
     └─ Tests: ✓✓✓✓✓✓

4A  → 2 addon tests passing
     ├─ export/addon-def.ts ⭐
     ├─ src/agent.rs ⭐ (Neon)
     ├─ src/lib.rs (updated)
     └─ tests/vitest/addon-smoke.test.ts ⭐
     └─ Tests: ✓✓

4B  → Handler compiles
     └─ src/agent.rs (updated)
     
4C  → 3 FFI tests passing
     ├─ src/agent.rs (updated)
     └─ tests/vitest/addon-smoke.test.ts (updated)
     └─ Tests: ✓✓✓

5A  → 5 controller tests passing
     ├─ export/agent.ts ⭐ (partial)
     └─ tests/vitest/controller.test.ts ⭐
     └─ Tests: ✓✓✓✓✓

5B  → 3 E2E tests passing
     ├─ export/agent.ts (complete)
     └─ tests/vitest/dispatch-integration.test.ts ⭐
     └─ Tests: ✓✓✓

6A  → All servers start
     ├─ benchmarks/config.js ⭐
     ├─ benchmarks/_util/index.js ⭐
     ├─ benchmarks/servers/*.js ⭐⭐⭐⭐
     └─ package.json (updated)
     
6B  → Performance ≥ 95%
     ├─ benchmarks/http1.js ⭐
     ├─ benchmarks/http2.js ⭐
     ├─ benchmarks/websocket.mjs ⭐
     ├─ package.json (updated)
     └─ .github/workflows/benchmark.yml ⭐
     └─ Benchmarks: ✓✓✓

⭐ = New file
```

## 🚀 Quick Reference

### Commands by Chunk

```bash
# Chunk 1A-2B (Rust Core)
cd packages/core
cargo build  # After each chunk
cargo test   # Verify milestones

# Chunk 3B, 4A-6B (Node/TypeScript)
cd packages/node
pnpm build   # After 4A onwards
pnpm test    # Verify milestones
```

### Test Count Evolution

```text
After 1B: 3 tests   ████████████░░░░░░░░░░░░░░░░░░░░
After 2B: 7 tests   ████████████████████░░░░░░░░░░░░
After 3B: 13 tests  ████████████████████████████████░
After 4C: 16 tests  ███████████████████████████████░░
After 5A: 21 tests  ████████████████████████████████░
After 5B: 24 tests  ████████████████████████████████░
After 6B: 27+ tests ████████████████████████████████ + benchmarks
```

## 💡 Success Tips

1. **⏱️ Time boxing**: Set 2-hour timer per chunk
2. **✅ Test first**: Verify previous chunk before starting next
3. **📝 Track it**: Update checklist after each chunk
4. **🔄 If stuck**: Re-read chunk goals, check prerequisites
5. **🎯 One at a time**: Don't skip ahead

## 🏁 Completion Criteria

```text
✓ All 13 chunks completed
✓ 27+ tests passing
✓ Benchmarks show ≥ 95% undici performance
✓ CI workflow green
✓ Documentation updated
```

---

**Ready to start? → Open `plans/01a-core-types.md` and begin!**
