# Benchmark Infrastructure (Chunk 05a)

Local HTTP/1 (port 3000) and HTTP/2 (port 3001, TLS) test servers plus a `cronometro`
harness with parallel-request, warmup, and result-formatting utilities. Provides a
reproducible environment for comparing `node_reqwest` against undici. TypeScript only;
run via `tsx`.

## Layout

```text
Test Suite
  ├─► HTTP/1 Server (Port 3000)
  ├─► HTTP/2 Server (Port 3001)
  └─► Utils (parseEnvInt, makeParallelRequests, warmup, printResults, runServer)
```

## Implementation

### packages/node/benchmarks/config.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";

function parseEnvInt(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
    iterations: parseEnvInt(process.env.SAMPLES, 30),
    warmupRequests: parseEnvInt(process.env.WARMUP, 100),
    connections: parseEnvInt(process.env.CONNECTIONS, 50),
    pipelining: parseEnvInt(process.env.PIPELINING, 10),
    parallelRequests: parseEnvInt(process.env.PARALLEL, 100),
    headersTimeout: parseEnvInt(process.env.HEADERS_TIMEOUT, 0),
    bodyTimeout: parseEnvInt(process.env.BODY_TIMEOUT, 0),
};
```

`SAMPLES` defaults to 30 to enable median/p95 comparison with sufficient statistical
power. `WARMUP` primes connection pool + V8 JIT before cronometro samples. No
`errorThreshold`: any failed request fails the benchmark — masking errors hides real
connection bugs.

### packages/node/benchmarks/\_util/index.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { performance } from "node:perf_hooks";

export type RequestRunner = (resolve: () => void, reject: (err: Error) => void) => void;

/** Run `cb` `count` times in parallel; resolves when all complete. */
export function makeParallelRequests(cb: RequestRunner, count = 100): Promise<void[]> {
    return Promise.all(Array.from({ length: count }, () => new Promise<void>(cb)));
}

/** Sequentially issue `count` requests to prime pool + JIT before timed samples. */
export async function warmup(cb: RequestRunner, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await new Promise<void>(cb);
    }
}

interface CronometroResult {
    success: boolean;
    size: number;
    mean: number;
    standardError: number;
    percentiles?: Record<string, number>;
}

/** Print cronometro results as a table. `parallelRequests` computes req/sec. */
export function printResults(
    results: Record<string, CronometroResult>,
    parallelRequests = 100,
): void {
    let slowest: number | undefined;
    const rows = Object.entries(results)
        .sort((a, b) => (!a[1].success ? -1 : b[1].mean - a[1].mean))
        .map(([name, result]) => {
            if (!result.success) {
                return { Test: name, Samples: result.size, Result: "Errored" };
            }
            const { size, mean, standardError, percentiles } = result;
            slowest ??= mean;
            const relative = slowest !== mean ? (slowest / mean - 1) * 100 : 0;
            const p50 = percentiles?.["50"] ?? mean;
            const p95 = percentiles?.["95"] ?? mean;
            return {
                Test: name,
                Samples: size,
                Throughput: `${((parallelRequests * 1e9) / mean).toFixed(2)} req/sec`,
                "p50 (ns)": p50.toFixed(0),
                "p95 (ns)": p95.toFixed(0),
                Tolerance: `± ${((standardError / mean) * 100).toFixed(2)} %`,
                Difference: relative > 0 ? `+${relative.toFixed(2)}%` : "-",
            };
        });
    console.table(rows);
}
```

### packages/node/benchmarks/servers/run-server.ts

Shared helper for graceful shutdown. Servers register a `close` callback and exit on
`SIGTERM`/`SIGINT`.

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";

export interface ClosableServer {
    close(cb?: (err?: Error) => void): void;
}

/** Wire SIGTERM/SIGINT to graceful server.close() with a hard-exit fallback. */
export function runServer(server: ClosableServer, label: string): void {
    const shutdown = (signal: string): void => {
        console.log(`${label}: received ${signal}, closing`);
        const timeout = setTimeout(() => process.exit(1), 5000).unref();
        server.close((err) => {
            clearTimeout(timeout);
            process.exit(err ? 1 : 0);
        });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}
```

### packages/node/benchmarks/servers/http1-server.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import http from "node:http";
import process from "node:process";
import { runServer } from "./run-server.ts";

const responseBody = Buffer.from("Hello, World!");

const server = http.createServer((req, res) => {
    if (req.method === "POST") {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 2 });
            res.end("OK");
        });
        return;
    }
    res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": responseBody.length,
    });
    res.end(responseBody);
});

const portEnv = Number.parseInt(process.env.PORT ?? "", 10);
const port = Number.isFinite(portEnv) ? portEnv : 3000;

server.listen(port, () => {
    console.log(`HTTP/1 server listening on http://localhost:${port}`);
});

runServer(server, "http1-server");
```

### packages/node/benchmarks/servers/http2-server.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import http2 from "node:http2";
import process from "node:process";
import { generate } from "selfsigned";
import { runServer } from "./run-server.ts";

// In-memory self-signed cert at server startup. No fixture files, no
// setup step.
const { cert, private: key } = generate(
    [{ name: "commonName", value: "localhost" }],
    {
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
            {
                name: "subjectAltName",
                altNames: [
                    { type: 2, value: "localhost" },
                    { type: 7, ip: "127.0.0.1" },
                    { type: 7, ip: "::1" },
                ],
            },
        ],
    },
);

// Expose the CA so the bench client can trust it without
// rejectUnauthorized: false (BENCH_VERIFY_TLS=1 mode).
if (process.env.BENCH_EMIT_CA === "1") {
    process.stdout.write(`__BENCH_CA__${Buffer.from(cert).toString("base64")}\n`);
}

const responseBody = Buffer.from("Hello, World!");

const server = http2.createSecureServer({ key, cert }, (req, res) => {
    if (req.method === "POST") {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/plain", "content-length": 2 });
            res.end("OK");
        });
        return;
    }
    res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": responseBody.length,
    });
    res.end(responseBody);
});

const portEnv = Number.parseInt(process.env.PORT ?? "", 10);
const port = Number.isFinite(portEnv) ? portEnv : 3001;

server.listen(port, () => {
    console.log(`HTTP/2 server listening on https://localhost:${port}`);
});

runServer(server, "http2-server");
```

Minimum Node target is 20.11+ (project requirement); `import.meta.dirname` is
available since Node 20.11 / 22+.

TLS certs are generated in-memory by the HTTP/2 server at startup via the
`selfsigned` npm package — no `openssl` invocation, no on-disk fixtures, no
`bench:setup` step. The HTTP/2 client uses `rejectUnauthorized: false` by
default; setting `BENCH_VERIFY_TLS=1` flips the server to emit its CA cert on
stdout (parsed by CI) and the client to pass it via `tls.ca`, exercising the
verification path that catches a silent TLS bypass.

### packages/node/package.json (scripts)

```json
{
    "scripts": {
        "bench:server:http1": "tsx benchmarks/servers/http1-server.ts",
        "bench:server:http2": "tsx benchmarks/servers/http2-server.ts",
        "bench:http1": "tsx benchmarks/http1.ts",
        "bench:http1:post": "tsx benchmarks/http1-post.ts",
        "bench:http2": "tsx benchmarks/http2.ts",
        "bench:http2:post": "tsx benchmarks/http2-post.ts"
    }
}
```

CI orchestrates servers and benchmarks individually (see 05b); no `bench:all` /
`concurrently` aggregator — splitting per-step in CI gives per-bench artifacts and
isolates flakes.

## Summary

| Resource        | Version  | Purpose                  |
| :-------------- | :------- | :----------------------- |
| `cronometro`    | `^3.0.2` | Benchmark statistics     |
| `tsx`           | catalog  | TS execution             |
| **HTTP/1 Port** | 3000     | Default benchmark server |
| **HTTP/2 Port** | 3001     | TLS benchmark server     |

## File Structure

```text
packages/node/
├── benchmarks/
│   ├── config.ts
│   ├── _util/
│   │   └── index.ts
│   └── servers/
│       ├── http1-server.ts
│       ├── http2-server.ts
│       └── run-server.ts
└── package.json
```
