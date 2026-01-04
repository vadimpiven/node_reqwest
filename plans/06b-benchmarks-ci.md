# Benchmarks + CI (Chunk 6B)

## Problem/Purpose

Automate performance verification and ensure `node_reqwest` remains competitive with native
Node.js solutions.

## Solution

Create high-concurrency benchmark scripts for HTTP/1.1 and integrate them into a GitHub
Actions workflow with strict pass/fail criteria.

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
import { Pool as UndiciPool } from 'undici';
import { Agent as NodeReqwestAgent } from '../export/agent.js';
import { cronometro } from 'cronometro';
import { makeParallelRequests, printResults } from './_util/index.js';
import { config } from './config.js';

const url = 'http://localhost:3000';
const undici = new UndiciPool(url, { connections: 10 });
const reqwest = new NodeReqwestAgent(url);

cronometro({
  'undici': () => makeParallelRequests(resolve => {
    undici.request({ path: '/', method: 'GET' }).then(({ body }) => body.resume().on('end', resolve));
  }),
  'node_reqwest': () => makeParallelRequests(resolve => {
    reqwest.dispatch({ path: '/', method: 'GET' }, {
      onResponseStart: () => {},
      onResponseData: () => {},
      onResponseEnd: () => resolve(),
      onResponseError: e => { throw e; }
    });
  })
}, { iterations: config.iterations }, (err, results) => {
  printResults(results);
  process.exit(0);
});
```

### .github/workflows/benchmark.yml

```yaml
name: Benchmark
on: [pull_request]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm -F node_reqwest build
      - name: Run
        run: |
          node packages/node/benchmarks/servers/http1-server.js &
          sleep 2
          node packages/node/benchmarks/http1.js
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
└── benchmarks/
    └── http1.js
.github/workflows/
└── benchmark.yml
```
