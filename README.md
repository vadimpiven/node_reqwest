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
mise trust # Trust the project

mise install # Install tools
pnpm install # Install dependencies

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

docker compose up --build -d --wait # Build and run the container
docker compose exec dev bash # Enter the container shell

pnpm install # Install dependencies
mise test # Run the tests

exit # Exit the container
docker compose down --remove-orphans # Stop the container
```

For simplicity you can use docker script:

```bash
pnpm docker # Build and attach to the container

pnpm install # Install dependencies
mise test # Run the tests

exit # Exit and stop the container
```

## Mitmproxy Web UI

The Docker environment includes [mitmproxy](https://mitmproxy.org/)
for inspecting HTTP/HTTPS traffic from the dev container.
The `docker-compose.override.yml` is automatically merged by Docker Compose,
enabling mitmproxy by default. To access the web UI:

```bash
# Set a known password
MITMPROXY_WEB_PASSWORD=example_password

# Add it to .env file
echo "MITMPROXY_WEB_PASSWORD=${MITMPROXY_WEB_PASSWORD}" >> .env

# Rebuild the container
docker compose up --build -d --wait

# Access the UI at: `http://127.0.0.1:8081/?token=${MITMPROXY_WEB_PASSWORD}`
open http://127.0.0.1:8081/?token=${MITMPROXY_WEB_PASSWORD}
```

To run without mitmproxy:

```bash
docker compose -f docker-compose.yml up --build -d --wait
```

## Troubleshooting

Use the clean script to reset the environment (and free up disk space):

```bash
mise run clean
```
