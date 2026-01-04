# Dispatch Handler + Marshaling (Chunk 4B)

**Part**: 4 of 6 (FFI Boundary)  
**Chunk**: 4B of 3  
**Time**: 1.5 hours  
**Prerequisites**: Chunk 4A complete (addon builds, basic types work)

## Goal

Implement `JsDispatchHandler` that bridges Rust `DispatchHandler` trait to
JavaScript callbacks via Neon Channel.

## Reference

See `04-ffi-boundary.md`:

- **Lines 121-206**: `JsDispatchHandler` implementation
- **Lines 208-224**: `headers_to_js()` helper
- **Lines 176-205**: Error marshaling (DispatchError → CoreErrorInfo)

## Key Work

1. **`JsDispatchHandler` struct**:
   - Stores Neon Channel + 4 JS callback Roots
   - Implements `DispatchHandler` async trait
   - Marshals all callbacks through Channel

2. **Marshaling Functions**:
   - `headers_to_js()` - HashMap → JsObject (handles multi-value)
   - Error conversion - `DispatchError` → `CoreErrorInfo` object

3. **Zero-Copy Strategy**:
   - Headers: Single copy HashMap → JS
   - Body: Single copy Bytes → JsBuffer
   - No data duplication in marshaling layer

## Verification

```bash
cd packages/node
cargo build
```

Should compile with no errors. Handler can be instantiated but not yet used in dispatch (that's 4C).

## Milestone

- [ ] `JsDispatchHandler` compiles
- [ ] All 4 trait methods implemented
- [ ] Marshaling functions work
- [ ] Still passes chunk 4A tests
- [ ] Ready for Chunk 4C (wire into dispatch)

## Next

Move to `04c-request-handles.md` - Complete FFI with agentDispatch()
