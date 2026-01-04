# Benchmark Infrastructure (Chunk 6A)

**Part**: 6 of 6 (Performance Benchmarking)  
**Chunk**: 6A of 2  
**Time**: 1.5 hours  
**Prerequisites**: Part 5 complete (full dispatcher working)

## Goal

Set up benchmark framework with test servers, utilities, and cronometro integration.
No actual benchmarks yet.

## Reference

See `06-performance-benchmarking.md`:

- **Lines 40-54**: Benchmark config
- **Lines 242-287**: Utility functions
- **Lines 290-380**: Test servers (HTTP/1, HTTP/2, WebSocket, Proxy)

## Infrastructure

1. **Config** (`benchmarks/config.js`):
   - iterations, connections, pipelining settings
   - Environment variable overrides

2. **Utilities** (`benchmarks/_util/index.js`):
   - `makeParallelRequests(cb, count)`
   - `printResults(results, parallelRequests)`
   - `formatBytes(num)`

3. **Test Servers**:
   - `servers/http1-server.js` - Simple HTTP/1.1 on port 3000
   - `servers/http2-server.js` - HTTP/2 with TLS on port 3001
   - `servers/websocket-server.mjs` - WebSocket echo on port 8080
   - `servers/proxy-server.js` - HTTP/HTTPS/WS proxy on port 8888

4. **Dependencies**:
   - Add `cronometro`, `http-proxy`, `ws`, `concurrently`

## Verification

```bash
cd packages/node

# Add dependencies
pnpm add -D cronometro http-proxy ws concurrently

# Start servers
pnpm bench:servers
```

Should see:

```bash
HTTP/1 server listening on http://localhost:3000
HTTP/2 server listening on https://localhost:3001  
WebSocket server listening on ws://localhost:8080
```

## Milestone

- [ ] All 4 test servers start successfully
- [ ] Utility functions compile
- [ ] Config loads from environment
- [ ] Dependencies installed
- [ ] Ready for Chunk 6B (actual benchmarks)

## Next

Move to `06b-benchmarks-ci.md` - Implement benchmark scripts + CI
