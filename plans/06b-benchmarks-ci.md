# Benchmarks + CI (Chunk 6B)

## Problem/Purpose

Automate performance verification and ensure `node_reqwest` remains competitive with native
Node.js solutions.

## Solution

Create high-concurrency benchmark scripts for HTTP/1.1 comparing node_reqwest vs undici,
and integrate them into a GitHub Actions workflow with strict pass/fail criteria.

## Architecture

```text
GitHub Action
  └─ Start Servers
       └─ Run cronometro
            └─ Compare node_reqwest vs undici
                 └─ Exit 1 if < 95% performance
```

## Implementation

### packages/node/benchmarks/http1.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { Pool as UndiciPool } from 'undici';
import { Agent as NodeReqwestAgent } from '../export/agent.js';
import { cronometro } from 'cronometro';
import { makeParallelRequests, printResults } from './_util/index.js';
import { config } from './config.js';
import { Writable } from 'node:stream';

const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
const proxyUrl = process.env.PROXY_URL || null;

const undiciPool = new UndiciPool(serverUrl, {
  connections: config.connections,
  pipelining: config.pipelining,
  ...(proxyUrl && { proxy: proxyUrl }),
});

const nodeReqwestAgent = new NodeReqwestAgent(serverUrl, {
  connections: config.connections,
  pipelining: config.pipelining,
  ...(proxyUrl && { proxy: proxyUrl }),
});

const requestOptions = {
  path: '/',
  method: 'GET',
  headersTimeout: config.headersTimeout,
  bodyTimeout: config.bodyTimeout,
};

const experiments = {
  'undici - dispatch': () => {
    return makeParallelRequests((resolve) => {
      undiciPool.dispatch(requestOptions, {
        onConnect() {},
        onHeaders() {},
        onData() { return true; },
        onComplete() { resolve(); },
        onError(err) { throw err; },
      });
    });
  },

  'node_reqwest - dispatch': () => {
    return makeParallelRequests((resolve) => {
      nodeReqwestAgent.dispatch(requestOptions, {
        onResponseStart() {},
        onResponseData() {},
        onResponseEnd() { resolve(); },
        onResponseError(controller, err) { throw err; },
      });
    });
  },
};

cronometro(experiments, {
  iterations: config.iterations,
  errorThreshold: config.errorThreshold,
  print: false,
}, (err, results) => {
  if (err) throw err;
  printResults(results, config.parallelRequests);
  
  const undiciResult = results['undici - dispatch'];
  const reqwestResult = results['node_reqwest - dispatch'];
  
  if (undiciResult.success && reqwestResult.success) {
    const ratio = reqwestResult.mean / undiciResult.mean;
    if (ratio > 1.05) {
      console.error(`Performance regression: node_reqwest is ${((ratio - 1) * 100).toFixed(2)}% slower than undici`);
      process.exit(1);
    }
    console.log(`Performance OK: node_reqwest is ${((1 - ratio) * 100).toFixed(2)}% of undici speed`);
  }
  
  undiciPool.close();
  nodeReqwestAgent.close();
});
```

### .github/workflows/benchmark.yml

```yaml
name: Benchmark

on:
  pull_request:
    paths:
      - 'packages/core/**'
      - 'packages/node/**'
      - '.github/workflows/benchmark.yml'

jobs:
  benchmark:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install

      - name: Build core package
        run: pnpm -F core build

      - name: Build node package
        run: pnpm -F node_reqwest build

      - name: Start test servers
        run: |
          node packages/node/benchmarks/servers/http1-server.js &
          sleep 2

      - name: Run HTTP/1 benchmarks
        run: node packages/node/benchmarks/http1.js
        env:
          SAMPLES: 10
          PARALLEL: 100
          CONNECTIONS: 50

      - name: Performance threshold check
        run: echo "Benchmark completed successfully"
```

### packages/node/package.json (Add Scripts)

```json
{
  "scripts": {
    "bench:servers": "concurrently \"node benchmarks/servers/http1-server.js\" \"node benchmarks/servers/http2-server.js\" \"node benchmarks/servers/websocket-server.mjs\" \"node benchmarks/servers/proxy-server.js\"",
    "bench:http1": "node benchmarks/http1.js",
    "bench:http2": "node benchmarks/http2.js",
    "bench:ws": "node benchmarks/websocket.mjs",
    "bench:all": "pnpm run bench:http1 && pnpm run bench:http2 && pnpm run bench:ws"
  }
}
```

## Tables

| Metric | Threshold |
| :--- | :--- |
| **Throughput** | ≥ 95% of Undici |
| **Mean Latency** | ≤ 105% of Undici |
| **Max Memory** | 120% of Undici base |

## File Structure

```text
packages/node/
├── benchmarks/
│   ├── http1.js
│   ├── http2.js
│   └── websocket.mjs
├── package.json
.github/workflows/
└── benchmark.yml
```
