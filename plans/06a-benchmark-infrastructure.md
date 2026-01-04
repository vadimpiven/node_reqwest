# Benchmark Infrastructure (Chunk 6A)

## Problem/Purpose

Establish a controlled, reproducible environment for performance testing to ensure
`node_reqwest` meets latency and throughput goals.

## Solution

Deploy local test servers covering multiple protocols (HTTP/1, HTTP/2, WS) and implement
a benchmarking harness using `cronometro`. Requires workspace dependencies: `cronometro`,
`http-proxy`, `ws`, `concurrently`.

## Architecture

```text
Test Suite
  ├─ HTTP/1 Server (Port 3000)
  ├─ HTTP/2 Server (Port 3001)
  ├─ WebSocket Server (Port 8080)
  └─ Utils (makeParallelRequests, printResults)
```

## Implementation

### packages/node/benchmarks/config.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

export const config = {
  iterations: parseInt(process.env.SAMPLES, 10) || 10,
  errorThreshold: parseInt(process.env.ERROR_THRESHOLD, 10) || 3,
  connections: parseInt(process.env.CONNECTIONS, 10) || 50,
  pipelining: parseInt(process.env.PIPELINING, 10) || 10,
  parallelRequests: parseInt(process.env.PARALLEL, 10) || 100,
  headersTimeout: parseInt(process.env.HEADERS_TIMEOUT, 10) || 0,
  bodyTimeout: parseInt(process.env.BODY_TIMEOUT, 10) || 0,
};
```

### packages/node/benchmarks/_util/index.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

export function makeParallelRequests(cb, count = 100) {
  const promises = Array.from({ length: count }, () => new Promise(cb));
  return Promise.all(promises);
}

export function printResults(results, parallelRequests = 100) {
  let slowest;
  const rows = Object.entries(results)
    .sort((a, b) => (!a[1].success ? -1 : b[1].mean - a[1].mean))
    .map(([name, result]) => {
      if (!result.success) {
        return {
          Test: name,
          Samples: result.size,
          Result: 'Errored',
          Tolerance: 'N/A',
          'Difference': 'N/A',
        };
      }

      const { size, mean, standardError } = result;
      slowest ??= mean;
      const relative = slowest !== mean ? ((slowest / mean - 1) * 100) : 0;

      return {
        Test: name,
        Samples: size,
        Result: `${((parallelRequests * 1e9) / mean).toFixed(2)} req/sec`,
        Tolerance: `± ${((standardError / mean) * 100).toFixed(2)} %`,
        'Difference': relative > 0 ? `+${relative.toFixed(2)}%` : '-',
      };
    });

  console.table(rows);
}

export function formatBytes(num) {
  const prefixes = ['B', 'KiB', 'MiB', 'GiB'];
  const idx = Math.min(Math.floor(Math.log(num) / Math.log(1024)), prefixes.length - 1);
  return `${(num / Math.pow(1024, idx)).toFixed(2)}${prefixes[idx]}`;
}
```

### packages/node/benchmarks/servers/http1-server.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import http from 'node:http';

const responseBody = Buffer.from('Hello, World!');

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Content-Length': responseBody.length,
  });
  res.end(responseBody);
});

server.listen(3000, () => {
  console.log('HTTP/1 server listening on http://localhost:3000');
});
```

### packages/node/benchmarks/servers/http2-server.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import http2 from 'node:http2';
import { readFileSync } from 'node:fs';

const key = readFileSync('./test/fixtures/key.pem');
const cert = readFileSync('./test/fixtures/cert.pem');
const responseBody = Buffer.from('Hello, World!');

const server = http2.createSecureServer({ key, cert }, (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/plain',
    'content-length': responseBody.length,
  });
  res.end(responseBody);
});

server.listen(3001, () => {
  console.log('HTTP/2 server listening on https://localhost:3001');
});
```

### packages/node/benchmarks/servers/websocket-server.mjs

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    ws.send(data);
  });
});

console.log('WebSocket server listening on ws://localhost:8080');
```

### packages/node/benchmarks/servers/proxy-server.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import http from 'node:http';
import httpProxy from 'http-proxy';

const proxy = httpProxy.createProxyServer({});

const server = http.createServer((req, res) => {
  proxy.web(req, res, {
    target: req.url.startsWith('https') ? 'https://localhost:3001' : 'http://localhost:3000',
    changeOrigin: true,
  });
});

server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, { target: 'ws://localhost:8080' });
});

server.listen(8888, () => {
  console.log('Proxy server listening on http://localhost:8888');
});
```

## Tables

| Resource | Version | Purpose |
| :--- | :--- | :--- |
| `cronometro` | `^3.0.2` | Stats Engine |
| `ws` | `^8.18.0` | WS Reference |
| `http-proxy` | `^1.18.1` | Proxy Reference |
| `concurrently` | `^9.1.2` | Server orchestration |

## File Structure

```text
packages/node/
└── benchmarks/
    ├── config.js
    ├── _util/
    │   └── index.js
    └── servers/
        ├── http1-server.js
        ├── http2-server.js
        ├── websocket-server.mjs
        └── proxy-server.js
```
