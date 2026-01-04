# Request Handle Bindings + Tests (Chunk 4C)

**Part**: 4 of 6 (FFI Boundary)  
**Chunk**: 4C of 3  
**Time**: 1.5 hours  
**Prerequisites**: Chunk 4B complete (handler marshaling works)

## Goal

Complete FFI boundary by wiring `agentDispatch()` and request control methods.
Add full dispatch callback test.

## Reference

See `04-ffi-boundary.md`:

- **Lines 226-267**: `parse_dispatch_options()` helper
- **Lines 302-321**: `agentDispatch()` export
- **Lines 323-342**: `agentClose()` and `agentDestroy()` stubs
- **Lines 344-369**: Request handle control methods
- **Lines 420-462**: Full dispatch test with callbacks

## Key Exports

1. **`agentDispatch(agent, options, callbacks)`**:
   - Parse options → DispatchOptions
   - Create JsDispatchHandler from callbacks
   - Call `agent.dispatch()`
   - Return RequestHandleInstance

2. **Request Control**:
   - `requestHandleAbort(handle)`
   - `requestHandlePause(handle)`
   - `requestHandleResume(handle)`

3. **Lifecycle Stubs**:
   - `agentClose(agent)` - Returns resolved promise
   - `agentDestroy(agent, error)` - Returns resolved promise

## New Test

Add to `addon-smoke.test.ts`:

```typescript
it('should dispatch a request with callbacks', async () => {
  const agent = Addon.agentCreate({ /* config */ });
  const events: string[] = [];
  
  const handle = Addon.agentDispatch(agent, 
    { origin: 'https://httpbin.org', path: '/status/200', method: 'GET', headers: {} },
    {
      onResponseStart: () => events.push('start'),
      onResponseData: () => events.push('data'),
      onResponseEnd: () => events.push('end'),
      onResponseError: () => events.push('error'),
    }
  );
  
  await new Promise(r => setTimeout(r, 2000));
  expect(events).toContain('start');
});
```

## Verification

```bash
cd packages/node
pnpm build
pnpm test addon-smoke.test.ts
```

**Expected**: 3-4 tests passing (including new dispatch test)

## Milestone

- [ ] `agentDispatch()` wires callbacks correctly
- [ ] Request handles control pause/resume/abort
- [ ] Full dispatch test passes with real HTTP request
- [ ] Part 4 complete! 🎉
- [ ] Ready for Part 5 (TypeScript)

## Next

Move to `05a-dispatch-controller.md` - Implement DispatchControllerImpl
