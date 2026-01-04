# Benchmark Strategy

Verify node_reqwest performance matches or exceeds undici across HTTP/1, HTTP/2, WebSocket,
with/without proxy.

## Solution

Adapt undici's benchmark suite using `cronometro` for statistical rigor. Test node_reqwest alongside
undici using identical test conditions and servers.

## Architecture

```text
Test Server          Benchmark Runner       Libraries Under Test
┌──────────┐         ┌───────────────┐      ┌────────────────────┐
│ HTTP/1   │◀───────▶│ cronometro    │◀────▶│ undici             │
│ HTTP/2   │         │ + _util       │      │ node_reqwest       │
│ WebSocket│         │               │      │ (http, axios, got) │
│          │         │ Statistics:   │      └────────────────────┘
│ ± Proxy  │         │ - mean/stddev │
└──────────┘         │ - req/sec     │
                     │ - percentile  │
                     └───────────────┘
```

## Test Matrix

| Protocol   | Proxy      | Methods Tested                                   |
| :--------- | :--------- | :----------------------------------------------- |
| HTTP/1     | No         | request, stream, dispatch, pipeline, fetch       |
| HTTP/1     | HTTP Proxy | request, stream, dispatch, pipeline, fetch       |
| HTTP/2     | No         | request, stream, dispatch, pipeline, fetch       |
| HTTP/2     | HTTP Proxy | request, stream, dispatch, pipeline, fetch       |
| WebSocket  | No         | send/receive (binary, string)                    |
| WebSocket  | HTTP Proxy | send/receive (binary, string)                    |

## Benchmark Configuration

```javascript
// packages/node/benchmarks/config.js
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

## HTTP/1 Benchmark (packages/node/benchmarks/http1.js)

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { Pool as UndiciPool, request as undiciRequest } from 'undici';
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
  'undici - request': () => {
    return makeParallelRequests((resolve) => {
      undiciPool.request(requestOptions).then(({ body }) => {
        body
          .pipe(new Writable({ write(chunk, enc, cb) { cb(); } }))
          .on('finish', resolve);
      });
    });
  },

  'node_reqwest - request': () => {
    return makeParallelRequests((resolve) => {
      nodeReqwestAgent.request(requestOptions).then(({ body }) => {
        body
          .pipe(new Writable({ write(chunk, enc, cb) { cb(); } }))
          .on('finish', resolve);
      });
    });
  },

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
        onConnect() {},
        onHeaders() {},
        onData() { return true; },
        onComplete() { resolve(); },
        onError(err) { throw err; },
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
  undiciPool.close();
  nodeReqwestAgent.close();
});
```

## HTTP/2 Benchmark (packages/node/benchmarks/http2.js)

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { Pool as UndiciPool } from 'undici';
import { Agent as NodeReqwestAgent } from '../export/agent.js';
import { cronometro } from 'cronometro';
import { makeParallelRequests, printResults } from './_util/index.js';
import { config } from './config.js';
import { readFileSync } from 'node:fs';

const serverUrl = process.env.SERVER_URL || 'https://localhost:3001';
const proxyUrl = process.env.PROXY_URL || null;
const ca = readFileSync('./test/fixtures/ca.pem', 'utf8');

const undiciPool = new UndiciPool(serverUrl, {
  allowH2: true,
  connections: config.connections,
  pipelining: config.pipelining,
  connect: { rejectUnauthorized: false, ca },
  ...(proxyUrl && { proxy: proxyUrl }),
});

const nodeReqwestAgent = new NodeReqwestAgent(serverUrl, {
  allowH2: true,
  connections: config.connections,
  pipelining: config.pipelining,
  ca: [ca],
  rejectUnauthorized: false,
  ...(proxyUrl && { proxy: proxyUrl }),
});

// Similar experiments as HTTP/1...
```

## WebSocket Benchmark (packages/node/benchmarks/websocket.mjs)

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { WebSocket as UndiciWebSocket } from 'undici';
import { WebSocket as NodeReqwestWebSocket } from '../export/websocket.js';
import { bench } from './_util/runner.js';

const binary = Buffer.alloc(256 * 1024, '_');
const binaries = [binary, binary.toString('utf-8')];

const url = process.env.WS_URL || 'ws://localhost:8080';
const proxyUrl = process.env.PROXY_URL || null;

const experiments = {
  'undici': {
    fn: (ws, binary) => (ev) => {
      ws.addEventListener('message', () => ev.end(), { once: true });
      ev.start();
      ws.send(binary);
    },
    connect: async () => {
      const ws = new UndiciWebSocket(url);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      ws.binaryType = 'arraybuffer';
      return ws;
    },
    binaries,
  },

  'node_reqwest': {
    fn: (ws, binary) => (ev) => {
      ws.addEventListener('message', () => ev.end(), { once: true });
      ev.start();
      ws.send(binary);
    },
    connect: async () => {
      const ws = new NodeReqwestWebSocket(url, {
        ...(proxyUrl && { proxy: proxyUrl }),
      });
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      ws.binaryType = 'arraybuffer';
      return ws;
    },
    binaries,
  },
};

// Run benchmarks...
```

## Utility Functions (packages/node/benchmarks/_util/index.js)

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

## Test Servers

### HTTP/1 Server (packages/node/benchmarks/servers/http1-server.js)

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

### HTTP/2 Server (packages/node/benchmarks/servers/http2-server.js)

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

### WebSocket Server (packages/node/benchmarks/servers/websocket-server.mjs)

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    ws.send(data); // Echo back
  });
});

console.log('WebSocket server listening on ws://localhost:8080');
```

## Proxy Server (packages/node/benchmarks/servers/proxy-server.js)

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

## NPM Scripts (packages/node/package.json)

```json
{
  "scripts": {
    "bench:http1": "node benchmarks/http1.js",
    "bench:http1:proxy": "PROXY_URL=http://localhost:8888 node benchmarks/http1.js",
    "bench:http2": "node benchmarks/http2.js",
    "bench:http2:proxy": "PROXY_URL=http://localhost:8888 node benchmarks/http2.js",
    "bench:ws": "node benchmarks/websocket.mjs",
    "bench:ws:proxy": "PROXY_URL=http://localhost:8888 node benchmarks/websocket.mjs",
    "bench:all": "npm run bench:http1 && npm run bench:http2 && npm run bench:ws",
    "bench:all:proxy": "npm run bench:http1:proxy && npm run bench:http2:proxy && npm run bench:ws:proxy",
    "bench:servers": "concurrently \"node benchmarks/servers/http1-server.js\" \"node benchmarks/servers/http2-server.js\" \"node benchmarks/servers/websocket-server.mjs\"",
    "bench:servers:proxy": "concurrently \"npm run bench:servers\" \"node benchmarks/servers/proxy-server.js\""
  },
  "devDependencies": {
    "cronometro": "^3.0.2",
    "http-proxy": "^1.18.1",
    "ws": "^8.18.0",
    "concurrently": "^9.1.2"
  }
}
```

## Performance Criteria

| Metric              | Threshold                                              |
| :------------------ | :----------------------------------------------------- |
| Throughput          | ≥ 95% of undici req/sec                                |
| Latency (mean)      | ≤ 105% of undici mean                                  |
| Latency (p99)       | ≤ 110% of undici p99                                   |
| Memory (baseline)   | ≤ 120% of undici baseline                              |
| Memory (under load) | ≤ 130% of undici under load                            |
| Error rate          | 0% (same as undici)                                    |

## CI Integration

```yaml
# .github/workflows/benchmark.yml
name: Benchmark

on:
  pull_request:
    paths:
      - 'packages/core/**'
      - 'packages/node/**'
  workflow_dispatch:

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: dtolnay/rust-toolchain@stable
      
      - run: pnpm install
      - run: pnpm -F node_reqwest build
      
      - name: Start benchmark servers
        run: pnpm -F node_reqwest bench:servers &
        
      - name: Run HTTP/1 benchmarks
        run: pnpm -F node_reqwest bench:http1
        
      - name: Run HTTP/2 benchmarks
        run: pnpm -F node_reqwest bench:http2
        
      - name: Run WebSocket benchmarks
        run: pnpm -F node_reqwest bench:ws
        
      - name: Start proxy server
        run: pnpm -F node_reqwest bench:servers:proxy &
        
      - name: Run proxied benchmarks
        run: pnpm -F node_reqwest bench:all:proxy
```

## File Structure

```text
packages/node/
├── benchmarks/
│   ├── _util/
│   │   ├── index.js              # makeParallelRequests, printResults, formatBytes
│   │   └── runner.js             # WebSocket benchmark runner (from undici)
│   ├── servers/
│   │   ├── http1-server.js       # HTTP/1.1 test server
│   │   ├── http2-server.js       # HTTP/2 test server
│   │   ├── websocket-server.mjs  # WebSocket echo server
│   │   └── proxy-server.js       # HTTP/HTTPS/WS proxy server
│   ├── config.js                 # Shared benchmark configuration
│   ├── http1.js                  # HTTP/1.1 benchmarks
│   ├── http2.js                  # HTTP/2 benchmarks
│   └── websocket.mjs             # WebSocket benchmarks
└── package.json                  # Scripts + cronometro/http-proxy/ws/concurrently deps
```

## Usage

```bash
# Terminal 1: Start servers
pnpm -F node_reqwest bench:servers

# Terminal 2: Run benchmarks
pnpm -F node_reqwest bench:http1
pnpm -F node_reqwest bench:http2
pnpm -F node_reqwest bench:ws

# Run all at once
pnpm -F node_reqwest bench:all

# With proxy
pnpm -F node_reqwest bench:servers:proxy  # Terminal 1
pnpm -F node_reqwest bench:all:proxy       # Terminal 2
```

## Dependencies

| Package       | Version  | Purpose                                  |
| :------------ | :------- | :--------------------------------------- |
| `cronometro`  | `^3.0.2` | Statistical benchmarking framework       |
| `http-proxy`  | `^1.18.1`| HTTP/HTTPS/WebSocket proxy server        |
| `ws`          | `^8.18.0`| WebSocket reference implementation       |
| `concurrently`| `^9.1.2` | Run multiple servers simultaneously      |
