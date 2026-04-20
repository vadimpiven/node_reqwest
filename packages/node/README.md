[![GitHub repo][github-badge]][github-repo]
[![npm version][npm-badge]][npm-package]
[![API docs][docs-badge]][docs-site]
[![Ask DeepWiki][deepwiki-badge]][deepwiki-site]
[![CI status][status-badge]][status-dashboard]
[![Test coverage][coverage-badge]][coverage-dashboard]

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

# node-reqwest

Node.js bindings for [reqwest][reqwest] — a Rust HTTP client library.
Provides system proxy, trusted system CA certificates, and HTTP/2
out of the box, with no additional configuration. Compatible with
Electron.

[reqwest]: https://crates.io/crates/reqwest

## Why node-reqwest?

| Feature                | node-reqwest                       | Node.js / undici                                                             |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| DNS resolver           | Recursive ([hickory-dns][hickory]) | Non-recursive (c-ares) — crashes Electron on Windows for nonexistent domains |
| System CA certificates | Built-in                           | Requires [win-ca][win-ca], [mac-ca][mac-ca]                                  |
| System proxy           | Built-in                           | Not available (complex Electron [workaround][electron-proxy])                |
| SOCKS proxy            | Built-in                           | Not available                                                                |
| HTTP/2                 | Full support via [hyper][hyper]    | Limited                                                                      |
| TLS                    | [rustls][rustls]                   | OpenSSL                                                                      |

[hickory]: https://github.com/hickory-dns/hickory-dns
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
    proxy: "system",
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

## Requirements

- Node.js `^20.19.0 || >=22.12.0`

## License

[Apache-2.0](../../LICENSE-APACHE.txt) OR
[MIT](../../LICENSE-MIT.txt)
