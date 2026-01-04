# Benchmarks + CI (Chunk 05b)

## Problem/Purpose

Automate performance verification and ensure `node_reqwest` remains competitive with
undici on HTTP/1 and HTTP/2.

## Solution

Create benchmark scripts comparing `node_reqwest` vs `undici` using `cronometro`, with
strict pass/fail criteria in GitHub Actions.

## Architecture

```text
GitHub Action
  └─► pnpm run bench:setup (TLS certs)
       └─► Start Servers (background)
            └─► Run cronometro
                 └─► Compare node_reqwest vs undici
                      └─► Exit 1 if < 95% performance
```

## Implementation

### packages/node/benchmarks/http1.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { Pool as UndiciPool } from 'undici';
// Note: This imports from the built output. Ensure `pnpm build` is run first.
import { Agent as NodeReqwestAgent } from '../dist/export/agent.js';
import { cronometro } from 'cronometro';
import { makeParallelRequests, printResults } from './_util/index.js';
import { config } from './config.js';

const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';

const undiciPool = new UndiciPool(serverUrl, {
  connections: config.connections,
  pipelining: config.pipelining,
});

const nodeReqwestAgent = new NodeReqwestAgent();

const requestOptions = {
  path: '/',
  method: 'GET',
  headersTimeout: config.headersTimeout,
  bodyTimeout: config.bodyTimeout,
};

const experiments = {
  'undici - dispatch': () => {
    return makeParallelRequests(
      (resolve, reject) => {
        undiciPool.dispatch(
          { origin: serverUrl, ...requestOptions },
          {
            onRequestStart() {},
            onResponseStart() {},
            onResponseData() {},
            onResponseEnd() {
              resolve();
            },
            onResponseError(_controller, err) {
              reject(err);
            },
          }
        );
      },
      config.parallelRequests
    );
  },

  'node_reqwest - dispatch': () => {
    return makeParallelRequests(
      (resolve, reject) => {
        nodeReqwestAgent.dispatch(
          { origin: serverUrl, ...requestOptions },
          {
            onRequestStart() {},
            onResponseStart() {},
            onResponseData() {},
            onResponseEnd() {
              resolve();
            },
            onResponseError(_controller, err) {
              reject(err);
            },
          }
        );
      },
      config.parallelRequests
    );
  },
};

cronometro(
  experiments,
  {
    iterations: config.iterations,
    errorThreshold: config.errorThreshold,
    print: false,
  },
  (err, results) => {
    if (err) throw err;

    printResults(results, config.parallelRequests);

    const undiciResult = results['undici - dispatch'];
    const reqwestResult = results['node_reqwest - dispatch'];

    if (undiciResult.success && reqwestResult.success) {
      const ratio = reqwestResult.mean / undiciResult.mean;
      if (ratio > 1.05) {
        console.error(
          `Performance regression: node_reqwest is ${((ratio - 1) * 100).toFixed(2)}% slower than undici`
        );
        process.exit(1);
      }
      console.log(
        `Performance OK: node_reqwest is within ${((ratio - 1) * 100).toFixed(2)}% of undici`
      );
    }

    undiciPool.close();
    nodeReqwestAgent.close();
  }
);
```

### packages/node/benchmarks/http2.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { Client as UndiciClient } from 'undici';
// Note: This imports from the built output. Ensure `pnpm build` is run first.
import { Agent as NodeReqwestAgent } from '../dist/export/agent.js';
import { cronometro } from 'cronometro';
import { makeParallelRequests, printResults } from './_util/index.js';
import { config } from './config.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ca = readFileSync(join(__dirname, '../test/fixtures/cert.pem'));

const serverUrl = process.env.SERVER_URL || 'https://localhost:3001';

const undiciClient = new UndiciClient(serverUrl, {
  connect: { ca, rejectUnauthorized: false },
  allowH2: true,
});

const nodeReqwestAgent = new NodeReqwestAgent({
  connection: {
    allowH2: true,
    rejectUnauthorized: false,
    ca: [ca.toString()],
  },
});

const requestOptions = {
  path: '/',
  method: 'GET',
  headersTimeout: config.headersTimeout,
  bodyTimeout: config.bodyTimeout,
};

const experiments = {
  'undici - dispatch (H2)': () => {
    return makeParallelRequests(
      (resolve, reject) => {
        undiciClient.dispatch(
          { origin: serverUrl, ...requestOptions },
          {
            onRequestStart() {},
            onResponseStart() {},
            onResponseData() {},
            onResponseEnd() {
              resolve();
            },
            onResponseError(_controller, err) {
              reject(err);
            },
          }
        );
      },
      config.parallelRequests
    );
  },

  'node_reqwest - dispatch (H2)': () => {
    return makeParallelRequests(
      (resolve, reject) => {
        nodeReqwestAgent.dispatch(
          { origin: serverUrl, ...requestOptions },
          {
            onRequestStart() {},
            onResponseStart() {},
            onResponseData() {},
            onResponseEnd() {
              resolve();
            },
            onResponseError(_controller, err) {
              reject(err);
            },
          }
        );
      },
      config.parallelRequests
    );
  },
};

cronometro(
  experiments,
  {
    iterations: config.iterations,
    errorThreshold: config.errorThreshold,
    print: false,
  },
  (err, results) => {
    if (err) throw err;

    printResults(results, config.parallelRequests);

    const undiciResult = results['undici - dispatch (H2)'];
    const reqwestResult = results['node_reqwest - dispatch (H2)'];

    if (undiciResult.success && reqwestResult.success) {
      const ratio = reqwestResult.mean / undiciResult.mean;
      if (ratio > 1.05) {
        console.error(
          `Performance regression: node_reqwest is ${((ratio - 1) * 100).toFixed(2)}% slower than undici (H2)`
        );
        process.exit(1);
      }
      console.log(
        `Performance OK: node_reqwest H2 is within ${((ratio - 1) * 100).toFixed(2)}% of undici`
      );
    }

    undiciClient.close();
    nodeReqwestAgent.close();
  }
);
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
    timeout-minutes: 15

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

      - name: Setup TLS certificates
        run: pnpm -F node_reqwest run bench:setup

      - name: Start HTTP/1 server
        run: |
          pnpm -F node_reqwest run bench:server:http1 &
          sleep 2

      - name: Run HTTP/1 benchmarks
        run: pnpm -F node_reqwest run bench:http1
        env:
          SAMPLES: 10
          PARALLEL: 100
          CONNECTIONS: 50

      - name: Stop HTTP/1, Start HTTP/2 server
        run: |
          pkill -f http1-server.js || true
          pnpm -F node_reqwest run bench:server:http2 &
          sleep 2

      - name: Run HTTP/2 benchmarks
        run: pnpm -F node_reqwest run bench:http2
        env:
          SAMPLES: 10
          PARALLEL: 100
          CONNECTIONS: 50
```

## Tables

| Metric | Threshold |
| :--- | :--- |
| **Throughput** | ≥ 95% of undici |
| **Mean Latency** | ≤ 105% of undici |
| **CI Timeout** | 15 minutes |

| Environment Variable | Default | Purpose |
| :--- | :--- | :--- |
| `SAMPLES` | 10 | Number of iterations |
| `PARALLEL` | 100 | Parallel requests per iteration |
| `CONNECTIONS` | 50 | Connection pool size |
| `SERVER_URL` | localhost:3000 | Target server |

## File Structure

```text
packages/node/
├── benchmarks/
│   ├── config.js
│   ├── http1.js
│   ├── http2.js
│   └── _util/
│       └── index.js
.github/workflows/
└── benchmark.yml
```
