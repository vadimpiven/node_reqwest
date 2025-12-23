# node-reqwest

Node.js bindings for [reqwest](https://crates.io/crates/reqwest) - Rust
HTTP client library. This library provides support for system proxy and
trusted system CA certificates without additional configuration.
The build is made in a fashion that allows usage by Electron-based applications.

## Usage

This library provides an `Agent` that is fully compatible with the
`undici.Dispatcher` interface. This allows it to be used as a global
dispatcher for `fetch` or with other `undici`-compatible APIs.

```typescript
import { Agent } from 'node-reqwest';
import { setGlobalDispatcher } from 'undici';

// Create an agent with system proxy enabled (default)
const agent = new Agent({
  connect: {
    timeout: 5000,
    rejectUnauthorized: true
  },
  proxy: 'system' // can also be null for direct
  // or { uri: '...' } for specific proxy
});

setGlobalDispatcher(agent);

// Now all fetch calls will use reqwest under the hood
const response = await fetch('https://example.com');
```

## Install script

Warning: this package uses install script to download precompiled binary
for the correct OS and architecture. All the binaries get attached to GitHub
release. The releases are made immutable to prevent supply chain attacks.
