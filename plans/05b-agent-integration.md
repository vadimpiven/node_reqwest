# Agent Integration + E2E Tests (Chunk 5B)

**Part**: 5 of 6 (TypeScript Integration)  
**Chunk**: 5B of 2  
**Time**: 2 hours  
**Prerequisites**: Chunk 5A complete (DispatchController works)

## Goal

Complete `Agent` class with full `dispatch()` implementation, pending request tracking,
and drain events. Add E2E integration tests.

## Reference

See `05-typescript-integration.md`:

- **Lines 74-220**: Full `Agent` class implementation
- **Lines 335-448**: E2E integration tests

## Key Features

1. **Agent Class**:
   - Extends `EventEmitter`
   - Implements `Dispatcher` interface
   - Tracks `#pendingRequests`, `#needDrain`
   - Closed/destroyed state management

2. **dispatch() Method**:
   - Creates `DispatchControllerImpl`
   - Wires callbacks with error handling
   - Tracks pending requests
   - Returns busy/available status

3. **Drain Events**:
   - Emits 'drain' when drops below maxConcurrent
   - Uses `queueMicrotask` for async emission

## E2E Tests

Create `packages/node/tests/vitest/dispatch-integration.test.ts`:

1. Full request/response cycle (httpbin.org)
2. Abort mid-stream
3. Pause and resume

## Verification

```bash
cd packages/node
pnpm build
pnpm test dispatch-integration.test.ts
```

**Expected**: 3 E2E tests passing

## Milestone

- [ ] Agent extends EventEmitter
- [ ] dispatch() wires all callbacks
- [ ] Pending request tracking works
- [ ] Drain events emit correctly
- [ ] 3 E2E tests pass
- [ ] Part 5 complete! 🎉
- [ ] Ready for Part 6 (benchmarks)

## Next

Move to `06a-benchmark-infrastructure.md` - Set up benchmark framework
