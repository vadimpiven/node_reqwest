# Benchmarks + CI (Chunk 6B)

**Part**: 6 of 6 (Performance Benchmarking)  
**Chunk**: 6B of 2  
**Time**: 1.5 hours  
**Prerequisites**: Chunk 6A complete (infrastructure ready)

## Goal

Implement actual benchmark scripts comparing node_reqwest vs undici,
add NPM scripts, and create CI workflow.

## Reference

See `06-performance-benchmarking.md`:

- **Lines 56-145**: HTTP/1 benchmark
- **Lines 147-182**: HTTP/2 benchmark  
- **Lines 184-239**: WebSocket benchmark
- **Lines 383-406**: NPM scripts
- **Lines 421-462**: CI workflow

## Benchmark Scripts

1. **`benchmarks/http1.js`**:
   - Compare undici vs node_reqwest
   - Tests: request, dispatch methods
   - Uses cronometro for statistics

2. **`benchmarks/http2.js`**:
   - Same as HTTP/1 but with allowH2
   - SSL/TLS configuration

3. **`benchmarks/websocket.mjs`**:
   - Binary and string message benchmarks
   - Send/receive latency

## NPM Scripts

Add to `package.json`:

```json
{
  "bench:http1": "node benchmarks/http1.js",
  "bench:http2": "node benchmarks/http2.js",
  "bench:ws": "node benchmarks/websocket.mjs",
  "bench:all": "npm run bench:http1 && npm run bench:http2 && npm run bench:ws",
  "bench:servers": "concurrently \"node benchmarks/servers/http1-server.js\" ..."
}
```

## CI Workflow

Create `.github/workflows/benchmark.yml`:

- Runs on PR to packages/core or packages/node
- Starts servers, runs benchmarks
- Fails if performance < 95% of undici

## Verification

```bash
# Terminal 1
pnpm bench:servers

# Terminal 2
pnpm bench:http1
```

Should see table output:

```text
┌─────────────────────┬─────────┬──────────────┬──────────┬────────────┐
│ Test                │ Samples │ Result       │ Tolerance│ Difference │
├─────────────────────┼─────────┼──────────────┼──────────┼────────────┤
│ undici - request    │ 10      │ 15234 req/sec│ ± 2.34 % │ -          │
│ node_reqwest - req  │ 10      │ 14832 req/sec│ ± 2.67 % │ +2.78%     │
└─────────────────────┴─────────┴──────────────┴──────────┴────────────┘
```

## Success Criteria

- ✅ Throughput ≥ 95% of undici
- ✅ Latency (mean) ≤ 105% of undici
- ✅ All benchmarks run without errors

## Milestone

- [ ] HTTP/1 benchmark runs
- [ ] HTTP/2 benchmark runs
- [ ] WebSocket benchmark runs
- [ ] Performance meets criteria (≥ 95%)
- [ ] CI workflow configured
- [ ] **PROJECT COMPLETE!** 🎉🎉🎉

## Final Steps

1. Run full benchmark suite
2. Document results
3. Update README with performance numbers
4. Celebrate completion of all 13 chunks!
