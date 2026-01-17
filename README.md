![NPM Version](https://img.shields.io/npm/v/node-reqwest)
![GitHub branch status](https://img.shields.io/github/checks-status/vadimpiven/node_reqwest/main)
![Codecov](https://img.shields.io/codecov/c/github/vadimpiven/node_reqwest/main)

# node-reqwest

Node.js bindings for [reqwest](https://crates.io/crates/reqwest) - Rust
HTTP client library. This library provides support for system proxy and
trusted system CA certificates without additional configuration.
The build is made in a fashion that allows usage by Electron-based applications.

## Build requirements

### Required

- C++ development toolchain (required by Rust)
  - Windows: [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
  - macOS: `xcode-select --install`
  - Linux: preinstalled `g++`
- [mise](https://mise.jdx.dev/getting-started.html) for tool version management

### Optional

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) for dev container
  (or [OrbStack](https://orbstack.dev/download) for macOS)

## Build and test

For native build run:

```bash
# Set GitHub token for mise tools installation (to avoid rate limits)
# <https://github.com/settings/personal-access-tokens/new?name=node_reqwest-env>
GITHUB_TOKEN=github_token_with_read_only_access_to_public_repositories

# Setup .env file (better to do that manually, but here is some automation)
[ -f .env ] || cp .env.example .env
grep -q "^GITHUB_TOKEN=" .env || echo "GITHUB_TOKEN=${GITHUB_TOKEN}" >> .env

mise trust # Trust the project
mise install # Install tools
mise test # Run tests
```

VSCode [recommended extensions](.vscode/extensions.json) make development experience
better. Check VSCode [debug configurations](.vscode/launch.json) for debugging and
[tasks](.vscode/tasks.json) for performance analysis.

## Docker build and test

To verify glibc compatibility or test in a clean environment, use VS Code
[Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)
extension to open the project directly in the container.

For manual Docker usage run:

```bash
# Setup .env file (better to do that manually, but here is some automation)
[ -f .env ] || cp .env.example .env
grep -q "^USER_UID=" .env || echo "USER_UID=$(id -u)" >> .env
grep -q "^USER_GID=" .env || echo "USER_GID=$(id -g)" >> .env

mise run docker # Build, run and attach to the container

mise test # Run the tests (inside the container)

exit # Exit and automatically stop the container
```

## Mitmproxy Web UI

The Docker environment includes [mitmproxy](https://mitmproxy.org/)
for inspecting HTTP/HTTPS traffic from the dev container.
The `docker-compose.proxied.yaml` is automatically merged by `mise run docker`.
To access the web UI:

```bash
# Set a known password
MITMPROXY_WEB_PASSWORD=example_password

# Add it to .env file
echo "MITMPROXY_WEB_PASSWORD=${MITMPROXY_WEB_PASSWORD}" >> .env

# Rebuild the container
mise run docker

# Access the UI at: `http://127.0.0.1:8081/?token=${MITMPROXY_WEB_PASSWORD}`
open http://127.0.0.1:8081/?token=${MITMPROXY_WEB_PASSWORD}
```

## Troubleshooting

Use the clean script to reset the environment (and free up disk space):

```bash
mise run clean
```
