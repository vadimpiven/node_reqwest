# Benchmark Infrastructure (Chunk 6A)

## Problem/Purpose

Establish a controlled, reproducible environment for performance testing to ensure
`node_reqwest` meets latency and throughput goals.

## Solution

Deploy local test servers covering multiple protocols (HTTP/1, HTTP/2, WS) and implement
a benchmarking harness using `cronometro`.

## Architecture

```text
Test Suite
  ├─ HTTP/1 Server (Port 3000)
  ├─ HTTP/2 Server (Port 3001)
  └─ Utils (makeParallelRequests)
```

## Implementation

### packages/node/benchmarks/_util/index.js

```javascript
export function makeParallelRequests(cb, count = 100) {
  const promises = Array.from({ length: count }, () => new Promise(cb));
  return Promise.all(promises);
}

export function printResults(results, parallelRequests = 100) {
  const rows = Object.entries(results).map(([name, result]) => ({
    Test: name,
    'Req/Sec': `${((parallelRequests * 1e9) / result.mean).toFixed(2)}`,
    Tolerance: `± ${((result.standardError / result.mean) * 100).toFixed(2)}%`
  }));
  console.table(rows);
}
```

### packages/node/benchmarks/servers/http1-server.js

```javascript
import http from 'node:http';
const body = Buffer.from('Hello');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
  res.end(body);
}).listen(3000);
```

### packages/node/benchmarks/config.js

```javascript
export const config = {
  iterations: 10,
  parallelRequests: 100,
};
```

## Tables

| Resource | Version | Purpose |
| :--- | :--- | :--- |
| `cronometro` | `^3.0.2` | Stats Engine |
| `ws` | `^8.18.0` | WS Reference |
| `http-proxy` | `^1.18.1` | Proxy Reference |

## File Structure

```text
packages/node/
└── benchmarks/
    ├── _util/
    │   └── index.js
    ├── servers/
    │   └── http1-server.js
    └── config.js
```
