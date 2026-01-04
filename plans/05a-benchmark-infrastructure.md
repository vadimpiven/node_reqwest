# Benchmark Infrastructure (Chunk 05a)

## Problem/Purpose

Establish a controlled, reproducible environment for performance testing to verify
`node_reqwest` meets latency and throughput goals compared to undici.

## Solution

Deploy local test servers for HTTP/1 and HTTP/2 protocols, implement a benchmarking
harness using `cronometro`, and provide utilities for parallel requests and result
formatting.

## Architecture

```text
Test Suite
  ├─► HTTP/1 Server (Port 3000)
  ├─► HTTP/2 Server (Port 3001)
  └─► Utils (makeParallelRequests, printResults)
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

/**
 * Execute a callback in parallel, returning a promise that resolves when all complete.
 * @param {function} cb - Callback receiving (resolve, reject)
 * @param {number} count - Number of parallel executions
 */
export function makeParallelRequests(cb, count = 100) {
  const promises = Array.from({ length: count }, () => new Promise(cb));
  return Promise.all(promises);
}

/**
 * Print benchmark results in a formatted table.
 * @param {object} results - Cronometro results object
 * @param {number} parallelRequests - Number of parallel requests per iteration
 */
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
          Difference: 'N/A',
        };
      }

      const { size, mean, standardError } = result;
      slowest ??= mean;
      const relative = slowest !== mean ? (slowest / mean - 1) * 100 : 0;

      return {
        Test: name,
        Samples: size,
        Result: `${((parallelRequests * 1e9) / mean).toFixed(2)} req/sec`,
        Tolerance: `± ${((standardError / mean) * 100).toFixed(2)} %`,
        Difference: relative > 0 ? `+${relative.toFixed(2)}%` : '-',
      };
    });

  console.table(rows);
}

/**
 * Format bytes to human readable string.
 * @param {number} num - Number of bytes
 */
export function formatBytes(num) {
  const prefixes = ['B', 'KiB', 'MiB', 'GiB'];
  const idx = Math.min(
    Math.floor(Math.log(num) / Math.log(1024)),
    prefixes.length - 1
  );
  return `${(num / Math.pow(1024, idx)).toFixed(2)}${prefixes[idx]}`;
}
```

### packages/node/benchmarks/servers/http1-server.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import http from 'node:http';

const responseBody = Buffer.from('Hello, World!');

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    // Consume request body and respond
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': 2,
      });
      res.end('OK');
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Content-Length': responseBody.length,
  });
  res.end(responseBody);
});

const port = parseInt(process.env.PORT, 10) || 3000;

server.listen(port, () => {
  console.log(`HTTP/1 server listening on http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
```

### packages/node/benchmarks/servers/http2-server.js

```javascript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import http2 from 'node:http2';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../test/fixtures');

// Generate self-signed cert if not exists
let key, cert;
if (existsSync(join(fixturesDir, 'key.pem'))) {
  key = readFileSync(join(fixturesDir, 'key.pem'));
  cert = readFileSync(join(fixturesDir, 'cert.pem'));
} else {
  console.error('TLS certificates not found. Run: pnpm run bench:setup');
  process.exit(1);
}

const responseBody = Buffer.from('Hello, World!');

const server = http2.createSecureServer({ key, cert }, (req, res) => {
  if (req.method === 'POST') {
    // Consume request body and respond
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': 2,
      });
      res.end('OK');
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/plain',
    'content-length': responseBody.length,
  });
  res.end(responseBody);
});

const port = parseInt(process.env.PORT, 10) || 3001;

server.listen(port, () => {
  console.log(`HTTP/2 server listening on https://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
```

### packages/node/benchmarks/servers/setup-certs.sh

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0 OR MIT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/../../test/fixtures"

mkdir -p "${FIXTURES_DIR}"

if [[ ! -f "${FIXTURES_DIR}/key.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 \
    -keyout "${FIXTURES_DIR}/key.pem" \
    -out "${FIXTURES_DIR}/cert.pem" \
    -days 365 -nodes \
    -subj "/CN=localhost"
  echo "Generated TLS certificates in ${FIXTURES_DIR}"
else
  echo "TLS certificates already exist"
fi
```

### packages/node/package.json (Scripts section)

```json
{
  "scripts": {
    "bench:setup": "bash benchmarks/servers/setup-certs.sh",
    "bench:server:http1": "node benchmarks/servers/http1-server.js",
    "bench:server:http2": "node benchmarks/servers/http2-server.js",
    "bench:servers": "concurrently \"pnpm run bench:server:http1\" \"pnpm run bench:server:http2\"",
    "bench:http1": "node benchmarks/http1.js",
    "bench:http1:post": "node benchmarks/http1-post.js",
    "bench:http2": "node benchmarks/http2.js",
    "bench:http2:post": "node benchmarks/http2-post.js",
    "bench:all": "pnpm run bench:http1 && pnpm run bench:http1:post && pnpm run bench:http2 && pnpm run bench:http2:post"
  }
}
```

## Tables

| Resource | Version | Purpose |
| :--- | :--- | :--- |
| `cronometro` | `^3.0.2` | Benchmark statistics |
| `concurrently` | `^9.1.2` | Server orchestration |
| **HTTP/1 Port** | 3000 | Default benchmark server |
| **HTTP/2 Port** | 3001 | TLS benchmark server |

## File Structure

```text
packages/node/
├── benchmarks/
│   ├── config.js
│   ├── _util/
│   │   └── index.js
│   └── servers/
│       ├── http1-server.js
│       ├── http2-server.js
│       └── setup-certs.sh
├── test/
│   └── fixtures/
│       ├── key.pem (generated)
│       └── cert.pem (generated)
└── package.json
```
