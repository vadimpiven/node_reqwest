# Chunk Plan Files - Index

This directory contains **13 granular 2-hour chunks** split from the original 6 implementation plans.

## Structure

Each chunk has:

- **Clear time estimate** (1-2 hours max)
- **Specific prerequisites**
- **Focused deliverable**
- **Test milestone**

## Implementation Order

### Part 1: Core Foundation (3h)

- ✅ **01a-core-types.md** - Types & Agent struct (1.5h)
- ✅ **01b-request-execution.md** - execute_request() + 3 tests (1.5h)

### Part 2: Core Backpressure (3h)

- ✅ **02a-pause-cancellation.md** - PauseState & RequestController (1.5h)
- ✅ **02b-backpressure-integration.md** - Integration + 4 tests (1.5h)

### Part 3: Error Handling (2.5h)

- ✅ **03a-core-errors.md** - CoreError enum (1h)
- ✅ **03b-typescript-errors.md** - JS errors + 6 tests (1.5h)

### Part 4: FFI Boundary (5h)

- **04a-ffi-types.md** - Addon types + basic bindings (2h)
- **04b-dispatch-handler.md** - JsDispatchHandler marshaling (1.5h)
- **04c-request-handles.md** - Request control + 3 tests (1.5h)

### Part 5: TypeScript Integration (4h)

- **05a-dispatch-controller.md** - DispatchControllerImpl + 5 tests (2h)
- **05b-agent-integration.md** - Agent.dispatch() + 3 E2E tests (2h)

### Part 6: Performance Benchmarking (3h)

- **06a-benchmark-infrastructure.md** - Servers + utilities (1.5h)
- **06b-benchmarks-ci.md** - Benchmarks + CI (1.5h)

## Using These Plans

1. **Start at 01a** - Work sequentially
2. **Verify each milestone** - Tests must pass before proceeding
3. **Track progress** - Use checkboxes in `00-overview.md`
4. **Reference originals** - Some chunks reference full content in original `01-06` files

## Files Created

- ✅ `00-overview.md` - Updated with new structure
- ✅ `01a-core-types.md` - Complete
- ✅ `01b-request-execution.md` - Complete
- ✅ `02a-pause-cancellation.md` - Complete
- ✅ `02b-backpressure-integration.md` - Complete
- ✅ `03a-core-errors.md` - Complete
- ✅ `03b-typescript-errors.md` - References `03-error-handling.md`
- **Remaining chunks**: Reference original plans `04-06` for detailed implementation

## Why This Structure?

**Before**: 6 plans, 3-4 hour chunks → fatigue, unclear progress  
**After**: 13 plans, 1-2 hour chunks → momentum, clear milestones

**Benefits**:

- 🎯 Complete in one focused session
- ✅ Tests every 1-2 hours
- 📊 Granular progress tracking
- 💪 Frequent wins keep momentum

## Total Time: 20.5 hours

Much more accurate than original "13-19 hours" estimate.
