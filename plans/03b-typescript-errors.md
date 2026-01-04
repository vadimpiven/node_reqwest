# TypeScript Errors + Tests (Chunk 3B)

**Part**: 3 of 6 (Error Handling)  
**Chunk**: 3B of 2  
**Time**: 1.5 hours  
**Prerequisites**: Chunk 3A complete (CoreError types compile)

## Goal

Create all Undici error classes with `Symbol.for` for cross-library compatibility and
add comprehensive tests. This maps Rust `CoreError` to JavaScript error instances.

## Implementation

See the complete implementation in the original `03-error-handling.md`:

- **Lines 129-338**: All Undici error classes with Symbol.for
- **Lines 342-410**: Test suite with 6 test cases

**Key Files to Create:**

1. `packages/node/export/errors.ts` - 13 error classes + factory
2. `packages/node/tests/vitest/errors.test.ts` - 6 tests

## Verification

```bash
cd packages/node
pnpm test errors.test.ts
```

**Expected**: 6 tests passing

1. Create correct error instances
2. Support instanceof checks  
3. Cross-library instanceof via Symbol.for
4. Create errors from CoreErrorInfo
5. Handle ResponseError with status code
6. Fallback to UndiciError for unknown codes

## Milestone

- [ ] 13+ error classes with Symbol.for
- [ ] CoreErrorInfo interface defined
- [ ] createUndiciError() factory works
- [ ] 6 error tests passing
- [ ] Ready for Part 4 (FFI)

## Next: Chunk 4A

Move to `04a-ffi-types.md` - Set up Neon bindings
