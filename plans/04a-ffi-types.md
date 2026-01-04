# FFI Types + Basic Bindings (Chunk 4A)

**Part**: 4 of 6 (FFI Boundary)  
**Chunk**: 4A of 3  
**Time**: 2 hours  
**Prerequisites**: Part 3 complete (error types & tests)

## Goal

Set up Neon project with basic addon interface types and simple exports (`hello()`, `agentCreate()`).

## Reference

Full implementation details in `04-ffi-boundary.md`:

- **Lines 12-35**: Dependencies  
- **Lines 37-85**: Addon interface types (TypeScript)
- **Lines 87-119**: AgentInstance + RequestHandleInstance wrappers
- **Lines 269-299**: `agentCreate()` export
- **Lines 388-391**: `hello()` export

## Key Deliverables

1. **`packages/node/export/addon-def.ts`**:
   - `RequestHandle`, `DispatchCallbacks`, `AgentCreationOptions` types
   - `Addon` interface definition

2. **`packages/node/src/agent.rs`**:
   - `AgentInstance` struct wrapping `core::Agent`
   - `RequestHandleInstance` struct (empty for now)

3. **`packages/node/src/lib.rs`**:
   - `hello()` export
   - `agentCreate()` export

4. **`packages/node/tests/vitest/addon-smoke.test.ts`**:
   - Test: Addon loads
   - Test: `hello()` returns "hello"
   - Test: `agentCreate()` creates agent instance

## Verification

```bash
cd packages/node
pnpm build
pnpm test addon-smoke.test.ts
```

**Expected**: 3 tests passing (or 2 minimal: addon loads + creates agent)

## Milestone

- [ ] Neon builds successfully
- [ ] TypeScript types compile
- [ ] 2-3 addon smoke tests pass
- [ ] Ready for Chunk 4B (dispatch handler)

## Next

Move to `04b-dispatch-handler.md` - Implement JsDispatchHandler
