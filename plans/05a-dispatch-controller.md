# DispatchController (Chunk 5A)

**Part**: 5 of 6 (TypeScript Integration)  
**Chunk**: 5A of 2  
**Time**: 2 hours  
**Prerequisites**: Part 4 complete (FFI boundary works)

## Goal

Implement `DispatchControllerImpl` class conforming to undici's
`Dispatcher.DispatchController` interface with proper state management.

## Reference

See `05-typescript-integration.md`:

- **Lines 11-69**: `DispatchControllerImpl` class
- **Lines 223-302**: Controller tests

## Key Features

1. **State Management**:
   - `#aborted`, `#paused`, `#reason` private fields
   - Getters expose state readonly

2. **Pending State Handling**:
   - `setRequestHandle()` applies abort/pause if called before handle set
   - Handles race between `onRequestStart` and native dispatch

3. **Methods**:
   - `abort(reason)` - Sets aborted, stores reason
   - `pause()` - Sets paused
   - `resume()` - Clears paused

## Tests

Create `packages/node/tests/vitest/controller.test.ts`:

1. Abort before request handle set
2. Pause before request handle set  
3. Track pending requests and emit drain
4. Reject dispatch when closed
5. Reject dispatch when destroyed

## Verification

```bash
cd packages/node
pnpm build
pnpm test controller.test.ts
```

**Expected**: 5 tests passing

## Milestone

- [ ] `DispatchControllerImpl` class complete
- [ ] State transitions work correctly
- [ ] Pending state applies when handle set
- [ ] 5 controller tests pass
- [ ] Ready for Chunk 5B (Agent integration)

## Next

Move to `05b-agent-integration.md` - Complete Agent.dispatch()
