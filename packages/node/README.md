# node-reqwest

Node.js bindings for [reqwest](https://crates.io/crates/reqwest) - Rust
HTTP client library. This library provides support for system proxy and
trusted system CA certificates without additional configuration.
The build is made in a fashion that allows usage by Electron-based applications.

## Why you want to use this library?

1. DNS resolution using recursive DNS resolver
   <https://github.com/hickory-dns/hickory-dns> instead of
   non-recursive <https://github.com/c-ares/c-ares> used by Node.js
   (and Undici) which crashes Electron on Windows if you try
   to resolve nonexistent domain `fetch('http://example.lan')`
2. System CA certificates are used by default without additional
   libraries like <https://www.npmjs.com/package/win-ca> and
   <https://www.npmjs.com/package/mac-ca>
3. System proxy is used by default, while it is not obtainable with
   Node.js and in Electron you have to use very complex interface
   <https://www.electronjs.org/docs/latest/api/session#sesresolveproxyurl>
4. Socks proxy is supported out of the box
5. HTTP/2 performance and support is much better than in Node.js
6. Rustls <https://github.com/rustls/rustls> is used for TLS

## Usage

This library provides an `Agent` that is fully compatible with the
`undici.Dispatcher` interface. This allows it to be used as a global
dispatcher for `fetch` or with other `undici`-compatible APIs.

```typescript
import { Agent } from "node-reqwest";
import { setGlobalDispatcher } from "undici";

// Create an agent with system proxy enabled (default)
const agent = new Agent({
    allowH2: true,
    proxy: "system",
});

setGlobalDispatcher(agent);

// Now all fetch calls will use reqwest under the hood
const response = await fetch("https://example.com");
```

## Postinstall Script

This package downloads a precompiled binary during installation. The
[postinstall script](./scripts/postinstall.js) cryptographically verifies that
the binary was built in the same GitHub Actions workflow run as this npm package
using [Sigstore](https://www.sigstore.dev/) provenance attestations and the
public [Rekor](https://docs.sigstore.dev/logging/overview/) transparency log.
