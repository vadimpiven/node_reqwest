# Benchmarks + CI (Chunk 05b)

Four `cronometro` benchmark scripts (HTTP/1 GET, HTTP/1 POST stream, HTTP/2 GET, HTTP/2
POST stream) compare `node_reqwest` against undici. CI fails when `node_reqwest`
median + p95 latency exceed the documented threshold versus `undici.Agent`.

## Methodology

- **Comparator**: `undici.Agent` is the default-config peer of `node_reqwest`'s
  `Agent` and is used for every benchmark in this chunk. `undici.Pool` /
  `undici.Client` ship explicit connection-limit + pipelining knobs we do not
  expose; comparing against them is apples-to-oranges. (A separate `Pool` /
  `Client` benchmark may be added later as an explicit pool-tuning scenario;
  it does not gate CI.)
- **Warmup**: 100 sequential requests before each cronometro invocation
  (`config.warmupRequests`), plus `warmup: true` in cronometro options. Primes the
  connection pool, TLS handshake, and V8 JIT before timed samples.
- **Samples**: 30 iterations (`SAMPLES=30`) × `PARALLEL=100` requests each.
- **Metrics**: cronometro reports `mean`, `standardError`, `percentiles[50]`,
  `percentiles[95]`. The regression check uses **median (p50) and p95 latency
  ratios**, not raw mean.
- **Threshold (shared `ubuntu-latest`)**: soft fail (warn) at 10%, hard fail at
  15%. Both p50 and p95 must satisfy `node_reqwest / undici ≤ 1.15`. Variance
  on shared runners commonly hits 10% — a tighter bound flaps. Equivalent
  throughput ratio: `node_reqwest_throughput / undici_throughput ≥ 0.87` on
  median. The 00-overview "≥95% throughput" headline target is the goal on
  dedicated hardware; CI tracks the looser shared-runner bound.
- **No `errorThreshold`**: zero tolerated request failures. Masked errors hide
  connection-reset bugs.
- **TLS**: HTTP/2 benchmarks run two variants — `rejectUnauthorized: false` for
  perf, and a `rejectUnauthorized: true` smoke variant that exercises the cert
  trust path (skipped from regression gating, asserted only to succeed). This
  catches silent TLS bypass where `ca:` is accepted but ignored.

## Flow

```text
GitHub Action (Node 20 + 22 matrix)
  └─► Build cache restore (or build)
       └─► pnpm run bench:setup (TLS certs)
            └─► Per-benchmark job (if: always())
                 ├─► Start server (background, PID captured)
                 ├─► curl --retry readiness probe
                 ├─► Run cronometro (warmup → 30 samples)
                 ├─► Compare p50 + p95 vs undici.Agent
                 ├─► Cleanup (close agents) → upload artifact
                 └─► kill $(cat server.pid)
```

## Implementation

### packages/node/benchmarks/http1.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";
import { Agent as UndiciAgent } from "undici";
import { Agent as NodeReqwestAgent } from "../dist/index.ts";
import { cronometro } from "cronometro";
import { makeParallelRequests, printResults, warmup } from "./_util/index.ts";
import { config } from "./config.ts";

const serverUrl = process.env.SERVER_URL ?? "http://localhost:3000";

const undiciAgent = new UndiciAgent();
const nodeReqwestAgent = new NodeReqwestAgent();

const requestOptions = {
    path: "/",
    method: "GET" as const,
    headersTimeout: config.headersTimeout,
    bodyTimeout: config.bodyTimeout,
};

function runUndici(resolve: () => void, reject: (err: Error) => void): void {
    undiciAgent.dispatch(
        { origin: serverUrl, ...requestOptions },
        {
            onRequestStart() {},
            onResponseStart() {},
            onResponseData() {},
            onResponseEnd() { resolve(); },
            onResponseError(_c, err) { reject(err); },
        },
    );
}

function runReqwest(resolve: () => void, reject: (err: Error) => void): void {
    nodeReqwestAgent.dispatch(
        { origin: serverUrl, ...requestOptions },
        {
            onRequestStart() {},
            onResponseStart() {},
            onResponseData() {},
            onResponseEnd() { resolve(); },
            onResponseError(_c, err) { reject(err); },
        },
    );
}

const experiments = {
    "undici.Agent - dispatch": () =>
        makeParallelRequests(runUndici, config.parallelRequests),
    "node_reqwest - dispatch": () =>
        makeParallelRequests(runReqwest, config.parallelRequests),
};

await warmup(runUndici, config.warmupRequests);
await warmup(runReqwest, config.warmupRequests);

cronometro(
    experiments,
    { iterations: config.iterations, warmup: true, print: false },
    async (err, results) => {
        let exitCode = 0;
        try {
            if (err) throw err;
            printResults(results, config.parallelRequests);
            exitCode = checkRegression(results, "undici.Agent - dispatch",
                "node_reqwest - dispatch");
        } finally {
            await Promise.allSettled([undiciAgent.close(), nodeReqwestAgent.close()]);
            process.exit(exitCode);
        }
    },
);

function checkRegression(
    results: Record<string, { success: boolean; percentiles?: Record<string, number> }>,
    baseline: string,
    candidate: string,
): number {
    const b = results[baseline];
    const c = results[candidate];
    if (!b?.success || !c?.success) {
        console.error("One or more benchmarks failed");
        return 1;
    }
    const bP50 = b.percentiles?.["50"] ?? 0;
    const bP95 = b.percentiles?.["95"] ?? 0;
    const cP50 = c.percentiles?.["50"] ?? 0;
    const cP95 = c.percentiles?.["95"] ?? 0;
    const r50 = cP50 / bP50;
    const r95 = cP95 / bP95;
    console.log(`p50 ratio: ${r50.toFixed(3)} | p95 ratio: ${r95.toFixed(3)}`);
    if (r50 > 1.15 || r95 > 1.15) {
        console.error(`Hard regression: p50=${r50.toFixed(3)} p95=${r95.toFixed(3)}`);
        return 1;
    }
    if (r50 > 1.10 || r95 > 1.10) {
        console.warn(`Soft regression: p50=${r50.toFixed(3)} p95=${r95.toFixed(3)}`);
    }
    return 0;
}
```

Cleanup happens in `finally` **before** `process.exit`, so sockets close even on
regression. `await` is used on agent `close()` calls (Node-review: `nodeReqwestAgent.close()`
was previously fire-and-forget).

### packages/node/benchmarks/http1-post.ts

Structurally identical to `http1.ts`, with POST + streaming body:

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";
import { Agent as UndiciAgent } from "undici";
import { Agent as NodeReqwestAgent } from "../dist/index.ts";
import { cronometro } from "cronometro";
import { Readable } from "node:stream";
import { makeParallelRequests, printResults, warmup } from "./_util/index.ts";
import { config } from "./config.ts";

const serverUrl = process.env.SERVER_URL ?? "http://localhost:3000";
const bodySize = Number.parseInt(process.env.BODY_SIZE ?? "", 10);
const BODY_SIZE = Number.isFinite(bodySize) ? bodySize : 1024;

const undiciAgent = new UndiciAgent();
const nodeReqwestAgent = new NodeReqwestAgent();

function createStreamBody(): Readable {
    const chunk = Buffer.alloc(BODY_SIZE, "x");
    return new Readable({
        read() {
            this.push(chunk);
            this.push(null);
        },
    });
}

const dispatchOpts = {
    path: "/upload",
    method: "POST" as const,
    headers: { "content-type": "application/octet-stream" },
    headersTimeout: config.headersTimeout,
    bodyTimeout: config.bodyTimeout,
};

// (runUndici, runReqwest, warmup, cronometro, checkRegression, finally-cleanup:
// identical pattern to http1.ts. Each dispatch() builds a fresh stream body.)
```

### packages/node/benchmarks/http2.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent as UndiciAgent } from "undici";
import { Agent as NodeReqwestAgent } from "../dist/index.ts";
import { cronometro } from "cronometro";
import { makeParallelRequests, printResults, warmup } from "./_util/index.ts";
import { config } from "./config.ts";

const ca = readFileSync(join(import.meta.dirname, "../test/fixtures/cert.pem"));
const serverUrl = process.env.SERVER_URL ?? "https://localhost:3001";
const verifyTls = process.env.BENCH_VERIFY_TLS === "1";

// undici.Agent options: connect.ca passes the trust anchor; rejectUnauthorized
// stays true when verifyTls=1 so we exercise the cert path.
const undiciAgent = new UndiciAgent({
    allowH2: true,
    connect: { ca, rejectUnauthorized: verifyTls },
});

// node_reqwest accepts `ca` as PEM string(s) at the top-level options bag,
// matching the AgentOptions shape (see 04b). When verifyTls=1, the bench
// asserts the cert is actually checked (no silent bypass).
const nodeReqwestAgent = new NodeReqwestAgent({
    allowH2: true,
    rejectUnauthorized: verifyTls,
    ca: [ca.toString("utf8")],
});

// (runUndici, runReqwest, warmup, cronometro, checkRegression, finally-cleanup:
// identical pattern to http1.ts.)
```

Both clients receive the same CA trust anchor. The `BENCH_VERIFY_TLS=1` variant
runs the bench with `rejectUnauthorized: true` to confirm `ca:` is honored —
without this, an implementation that silently treats `ca` as a no-op and skips
verification would pass the perf bench unnoticed.

### packages/node/benchmarks/http2-post.ts

Combines the http2.ts TLS setup with the http1-post.ts streaming-body pattern.
Same `verifyTls` smoke variant. Cleanup in `finally` before exit.

### .github/workflows/benchmark.yml

```yaml
name: Benchmark

on:
    pull_request:
        paths:
            - "packages/core/**"
            - "packages/node/**"
            - ".github/workflows/benchmark.yml"

jobs:
    build:
        runs-on: ubuntu-latest
        strategy:
            matrix:
                node: ["20", "22"]
        outputs:
            cache-key: ${{ steps.cache-key.outputs.key }}
        steps:
            - uses: actions/checkout@v4
            - uses: pnpm/action-setup@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: ${{ matrix.node }}
                  cache: "pnpm"
            - uses: dtolnay/rust-toolchain@stable
            - id: cache-key
              run: echo "key=bench-${{ matrix.node }}-${{ hashFiles('**/Cargo.lock', '**/pnpm-lock.yaml') }}" >> "$GITHUB_OUTPUT"
            - uses: actions/cache@v4
              with:
                  path: |
                      packages/node/index.node
                      packages/node/dist
                      packages/core/target
                  key: ${{ steps.cache-key.outputs.key }}
            - run: pnpm install
            - run: pnpm -F core build
            - run: pnpm -F node_reqwest build
            - run: pnpm -F node_reqwest run bench:setup
            - uses: actions/upload-artifact@v4
              with:
                  name: bench-build-node${{ matrix.node }}
                  path: |
                      packages/node/index.node
                      packages/node/dist
                      packages/node/test/fixtures
                  retention-days: 1

    bench-http1-get:
        needs: build
        runs-on: ubuntu-latest
        strategy:
            fail-fast: false
            matrix:
                node: ["20", "22"]
        steps:
            - uses: actions/checkout@v4
            - uses: pnpm/action-setup@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: ${{ matrix.node }}
                  cache: "pnpm"
            - uses: actions/download-artifact@v4
              with:
                  name: bench-build-node${{ matrix.node }}
                  path: packages/node/
            - run: pnpm install
            - name: Start HTTP/1 server
              run: |
                  pnpm -F node_reqwest run bench:server:http1 &
                  echo $! > server.pid
                  for i in $(seq 1 30); do
                      curl -sf http://localhost:3000/ -o /dev/null && break
                      sleep 1
                  done
            - name: Run benchmark
              run: pnpm -F node_reqwest run bench:http1
              env: { SAMPLES: 30, PARALLEL: 100, CONNECTIONS: 50 }
            - name: Stop server
              if: always()
              run: kill "$(cat server.pid)" || true
            - uses: actions/upload-artifact@v4
              if: always()
              with:
                  name: bench-http1-get-node${{ matrix.node }}
                  path: packages/node/benchmarks/*.json
                  if-no-files-found: ignore

    bench-http1-post:
        needs: build
        runs-on: ubuntu-latest
        if: always()
        strategy:
            fail-fast: false
            matrix:
                node: ["20", "22"]
        # (identical shape to bench-http1-get; runs bench:http1:post with BODY_SIZE=4096
        # and uploads its artifact)

    bench-http2-get:
        needs: build
        runs-on: ubuntu-latest
        if: always()
        strategy:
            fail-fast: false
            matrix:
                node: ["20", "22"]
        # (boots bench:server:http2 on port 3001 with curl -k retry probe;
        # runs bench:http2 then bench:http2 with BENCH_VERIFY_TLS=1 smoke variant)

    bench-http2-post:
        needs: build
        runs-on: ubuntu-latest
        if: always()
        strategy:
            fail-fast: false
            matrix:
                node: ["20", "22"]
        # (identical to bench-http2-get for POST streaming)
```

Key CI properties:

- **Build job** compiles once per Node version, caches `index.node` + `dist`, and
  uploads as an artifact downloaded by every bench job. Avoids 4× Rust rebuilds.
- **Per-bench jobs** with `if: always()` and `fail-fast: false`: a flaky
  HTTP/1 GET does not block HTTP/2 results.
- **Server readiness**: `curl --retry`-style poll loop (`for i in $(seq 1 30);
  do curl -sf ... && break; sleep 1; done`) replaces blind `sleep 2`. HTTP/2
  jobs use `curl -k` (self-signed cert).
- **PID-based shutdown**: `echo $! > server.pid` then `kill $(cat server.pid)`
  in an `if: always()` step. No `pkill -f` foot-gun.
- **Node matrix**: 20 + 22. Project targets Node 20+ (per CLAUDE.md);
  regressions on 20 are caught.
- **Artifacts**: each bench uploads its results JSON. Historical baselines
  accumulate per-PR. Future work: `benchmark-action/github-action-benchmark`
  for trend tracking.

## Thresholds

| Metric                              | Threshold                  |
| :---------------------------------- | :------------------------- |
| **p50 latency (shared runner)**     | ≤ 1.10× soft, ≤ 1.15× hard |
| **p95 latency (shared runner)**     | ≤ 1.10× soft, ≤ 1.15× hard |
| **Throughput target (dedicated)**   | ≥ 95% of undici            |
| **Sample count**                    | 30 iterations × 100 par.   |
| **Warmup**                          | 100 requests pre-bench     |
| **CI Timeout per bench job**        | 10 minutes                 |

## Environment Variables

| Variable           | Default        | Purpose                              |
| :----------------- | :------------- | :----------------------------------- |
| `SAMPLES`          | 30             | Number of iterations                 |
| `WARMUP`           | 100            | Warmup requests before samples       |
| `PARALLEL`         | 100            | Parallel requests per iteration      |
| `CONNECTIONS`      | 50             | Connection pool size                 |
| `SERVER_URL`       | localhost      | Target server                        |
| `BODY_SIZE`        | 1024           | Size of POST body in bytes           |
| `BENCH_VERIFY_TLS` | unset          | `1` enables `rejectUnauthorized:true`|

## Dependency pinning

- `wiremock = "0.6.5"` workspace pin (unit/integration tests, not benchmarks).
- `undici` version comes from the project's pnpm catalog peer-range — bench
  scripts use whichever undici the consumer resolves.
- Any new dep introduced by these scripts (none expected beyond `tsx` already
  in catalog) must respect `minimumReleaseAge: 1440` (pnpm-workspace.yaml).

## File Structure

```text
packages/node/
├── benchmarks/
│   ├── config.ts
│   ├── http1.ts
│   ├── http1-post.ts
│   ├── http2.ts
│   ├── http2-post.ts
│   └── _util/
│       └── index.ts
.github/workflows/
└── benchmark.yml
```
