[![GitHub repo][github-badge]][github-repo]
[![npm version][npm-badge]][npm-package]
[![API docs][docs-badge]][docs-site]
[![Ask DeepWiki][deepwiki-badge]][deepwiki-site]
[![CI status][status-badge]][status-dashboard]
[![Test coverage][coverage-badge]][coverage-dashboard]
[![Supply-chain score][socket-badge]][socket-dashboard]
[![CodSpeed][codspeed-badge]][codspeed-dashboard]

[github-badge]: https://img.shields.io/github/stars/vadimpiven/node_reqwest?style=flat&logo=github
[github-repo]: https://github.com/vadimpiven/node_reqwest
[npm-badge]: https://img.shields.io/npm/v/node-reqwest?logo=npm
[npm-package]: https://www.npmjs.com/package/node-reqwest
[docs-badge]: https://img.shields.io/badge/API_docs-typedoc-blue?logo=readthedocs
[docs-site]: https://vadimpiven.github.io/node_reqwest
[deepwiki-badge]: https://deepwiki.com/badge.svg
[deepwiki-site]: https://deepwiki.com/vadimpiven/node_reqwest
[status-badge]: https://img.shields.io/github/checks-status/vadimpiven/node_reqwest/main?logo=githubactions&label=CI
[status-dashboard]: https://github.com/vadimpiven/node_reqwest/actions?query=branch%3Amain
[coverage-badge]: https://img.shields.io/codecov/c/github/vadimpiven/node_reqwest/main?logo=codecov
[coverage-dashboard]: https://app.codecov.io/gh/vadimpiven/node_reqwest/tree/main
[socket-badge]: https://badge.socket.dev/npm/package/node-reqwest
[socket-dashboard]: https://socket.dev/npm/package/node-reqwest
[codspeed-badge]: https://img.shields.io/endpoint?url=https://codspeed.io/badge.json
[codspeed-dashboard]: https://codspeed.io/vadimpiven/node_reqwest?utm_source=badge

# node-reqwest

Node.js bindings for [reqwest][reqwest] — a Rust HTTP client library.
A drop-in replacement for `undici` with HTTP/2 multiplexing that
decisively outperforms it, system proxy, trusted system CA certificates,
and Electron compatibility out of the box.

Implements the full `undici.Dispatcher` interface — including its
error classes — and is verified against the same web-platform tests
that undici uses for standards compliance.

[reqwest]: https://crates.io/crates/reqwest

## Why node-reqwest?

| Feature                | node-reqwest                             | Node.js / undici                                                          |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| DNS resolver           | Async pure-Rust ([hickory-dns][hickory]) | C ([c-ares][cares]) — crashes Electron on Windows for nonexistent domains |
| System CA certificates | Built-in                                 | Requires [win-ca][win-ca], [mac-ca][mac-ca]                               |
| System proxy           | Built-in                                 | Not available (complex Electron [workaround][electron-proxy])             |
| SOCKS proxy            | Built-in                                 | Not available                                                             |
| HTTP/2                 | Multiplexed via [hyper][hyper]           | Implemented, but materially slower (see benchmarks)                       |
| TLS                    | [rustls][rustls]                         | OpenSSL                                                                   |

## Benchmarks

Throughput vs. `undici` on the same workload. The conservative number
between two timed runs (with a warm-up run discarded):

| Scenario                  | node-reqwest vs. undici |
| ------------------------- | ----------------------- |
| HTTP/1 GET                | at parity               |
| HTTP/1 POST (stream body) | +5%                     |
| HTTP/2 GET                | +50%                    |
| HTTP/2 POST (stream body) | +55%                    |

HTTP/2's multiplexing advantage is decisive — and every real-world
server supports it. HTTP/1 GET, the tightest hot path, lands within
run-to-run noise of undici (mean throughput; p50 favors node-reqwest by
3–7% but tail latency is GC-jittery on both sides).

<details>
<summary>Reproduce the benchmarks</summary>

The benchmark suite lives in [`packages/node/benchmarks/`][bench-src].
Each scenario starts a loopback HTTP/1 or HTTP/2 server (using
`selfsigned` for HTTP/2 TLS) and drives 100 parallel dispatches per
iteration via vitest's [`bench()`][vitest-bench] runner; warm-up dispatches
prime the connection pool and JIT before timed samples.

To reproduce locally:

```sh
git clone --recurse-submodules https://github.com/vadimpiven/node_reqwest.git
cd node_reqwest
mise install           # installs Node, Rust, pnpm via the pinned toolchain
pnpm install
pnpm --filter node-reqwest run bench
```

`pnpm run bench` builds the Rust addon first (via `prebench`), then
executes every `*.bench.ts` file in `packages/node/benchmarks/`. Each
run prints per-bench `hz` (ops/sec), latency percentiles, and a
"Nx faster than" summary comparing the two dispatchers.

The README numbers are the conservative result between two consecutive
runs (the worst-for-`node-reqwest` ratio), with a discarded warm-up run
preceding them. Absolute throughput depends on your machine; the
ratio between the two dispatchers is what's stable across hardware.

[bench-src]: https://github.com/vadimpiven/node_reqwest/tree/main/packages/node/benchmarks
[vitest-bench]: https://vitest.dev/api/#bench

</details>

[hickory]: https://github.com/hickory-dns/hickory-dns
[cares]: https://c-ares.org/
[win-ca]: https://www.npmjs.com/package/win-ca
[mac-ca]: https://www.npmjs.com/package/mac-ca
[electron-proxy]: https://www.electronjs.org/docs/latest/api/session#sesresolveproxyurl
[hyper]: https://github.com/hyperium/hyper
[rustls]: https://github.com/rustls/rustls

## Usage

This library provides an `Agent` that implements the
`undici.Dispatcher` interface. Use it as a global dispatcher for
`fetch` or with any `undici`-compatible API.

```typescript
import { Agent } from "node-reqwest";
import { setGlobalDispatcher } from "undici";

const agent = new Agent({
    allowH2: true,
    proxy: "system", // also accepts "none" or { type: "custom", uri, auth? }
});

setGlobalDispatcher(agent);

// All fetch calls now use reqwest under the hood
const response = await fetch("https://example.com");
```

## Installation safety

This package downloads a precompiled binary during `npm install`.
GitHub releases for this project are
[immutable][gh-immutable-releases] — once published, release
assets cannot be modified or replaced, ensuring that the binary
you download is the same one that was originally published.

In addition, the postinstall script uses
[node-addon-slsa][slsa] to cryptographically verify that the
binary was built in the same GitHub Actions workflow run as this
npm package, using [sigstore][sigstore] provenance attestations
and the [GitHub Attestations API][gh-attestations].

Installation aborts with a `SECURITY` error if any check fails.

[gh-immutable-releases]: https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
[slsa]: https://www.npmjs.com/package/node-addon-slsa
[sigstore]: https://www.sigstore.dev/
[gh-attestations]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations

## License

[Apache-2.0](../../LICENSE-APACHE.txt) OR
[MIT](../../LICENSE-MIT.txt)
