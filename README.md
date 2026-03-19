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

[![Open in GitHub Codespaces][codespace-badge]][codespace-action]

[codespace-badge]: https://github.com/codespaces/badge.svg
[codespace-action]: https://codespaces.new/vadimpiven/node_reqwest?quickstart=1

# node-reqwest

Node.js bindings for [reqwest][reqwest] — a Rust HTTP client
library. Provides system proxy, trusted system CA certificates,
and HTTP/2 out of the box, with no additional configuration.
Compatible with Electron.

[reqwest]: https://crates.io/crates/reqwest

## Packages

| Package | Description |
| --- | --- |
| [`node-reqwest`](packages/node) | Published npm package with prebuilt native addon |
| [`core`](packages/core) | Rust HTTP client (reqwest wrapper) |
| [`meta`](packages/meta) | Build-time metadata and version tooling |

## Quick start

The only prerequisite is
[mise](https://mise.jdx.dev/getting-started.html).
It manages Node.js, Rust, Python, pnpm, and all other tooling
automatically.

```bash
git clone https://github.com/vadimpiven/node_reqwest.git
cd node_reqwest
mise trust
mise install
mise run test
```

Rerun tests without cache: `mise run -f t`

## Build requirements

### Required

- [mise](https://mise.jdx.dev/getting-started.html) for tool
  version management
- C++ development toolchain (required by Rust)
  - Windows: [Build Tools for Visual Studio][vs-build-tools]
  - macOS: `xcode-select --install`
  - Linux: preinstalled `g++`

[vs-build-tools]: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2026

### Optional

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  for dev container (or [OrbStack](https://orbstack.dev/download)
  for macOS)

## Environment setup

```bash
# GitHub token avoids rate limits during mise tool installation
# https://github.com/settings/personal-access-tokens/new
[ -f .env ] || cp .env.example .env
# Edit .env and set GITHUB_TOKEN
```

## Docker build and test

To verify glibc compatibility or test in a clean environment, use
VS Code [Dev Containers][devcontainers] extension to open the
project directly in the container.

[devcontainers]: https://code.visualstudio.com/docs/devcontainers/containers

For manual Docker usage:

```bash
[ -f .env ] || cp .env.example .env
grep -q "^USER_UID=" .env || echo "USER_UID=$(id -u)" >> .env
grep -q "^USER_GID=" .env || echo "USER_GID=$(id -g)" >> .env

mise run docker   # build, run and attach
mise install      # inside the container
mise run test     # inside the container
exit              # stop the container
```

## Mitmproxy

The Docker environment includes [mitmproxy](https://mitmproxy.org/)
for inspecting HTTP/HTTPS traffic. The
`docker-compose.proxied.yaml` is merged automatically by
`mise run docker`.

```bash
MITMPROXY_WEB_PASSWORD=example_password
echo "MITMPROXY_WEB_PASSWORD=${MITMPROXY_WEB_PASSWORD}" >> .env
mise run docker
open "http://127.0.0.1:8081/?token=${MITMPROXY_WEB_PASSWORD}"
```

## Troubleshooting

Reset the environment and free up disk space:

```bash
mise run clean
```

## License

[Apache-2.0](LICENSE-APACHE.txt) OR [MIT](LICENSE-MIT.txt)
