# Contributing to node_reqwest

## Quick Start

The only prerequisite is
[mise](https://mise.jdx.dev/getting-started.html). It manages
Node.js, Rust, Python, pnpm, and all other tooling automatically.

```bash
git clone https://github.com/vadimpiven/node_reqwest.git
cd node_reqwest
cp .env.example .env   # then set GITHUB_TOKEN to avoid mise rate limits
mise trust             # approve the mise.toml config
mise install           # install all tools defined in mise.toml
mise run test          # auto-fix, build, type-check, run all tests
```

`--force` bypasses mise task caching to ensure a clean run:

```bash
mise run --force test
```

A GitHub token is optional but recommended; create one at
<https://github.com/settings/personal-access-tokens/new>.

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

## Dependency Management

Keep all dependencies in the workspace root.

- **Node.js**: Use `pnpm-workspace.yaml` to define dependencies
  and refer to them as `catalog:` or `workspace:*` in
  `package.json`.
- **Rust**: Use `[workspace.dependencies]` to define dependencies
  in root `Cargo.toml` and refer to them as
  `dependency.workspace = true` in packages.

## Coding Standards

Run `mise run fix` to auto-format. See [`CLAUDE.md`](CLAUDE.md)
for project-wide conventions (license headers, `node:` imports,
markdown line length). A few additional rules:

- **Assertions**: place the expected value first
  (`assert_eq!(expected, actual)`).
- **TypeScript types**: extract complex inline types into named
  `type` aliases.
- **Dependencies**: pin exact versions in `pnpm-workspace.yaml`
  (no `^` or `~`) and reference them as `catalog:` in
  `package.json`.

## Submitting Changes

1. For new features or architectural changes, open an issue
   first.
2. Fork the repository and create a branch from `main`.
3. Run the full suite before submitting:

   ```bash
   mise run --force test
   ```

4. Open a pull request against `main`. Describe what changed
   and why, and link to the related issue.

## Reporting Issues

<https://github.com/vadimpiven/node_reqwest/issues>

Include reproduction steps, Node.js version (`node -v`), and
OS.

## License

Contributions are licensed under Apache-2.0 OR MIT
([Apache-2.0](LICENSE-APACHE.txt), [MIT](LICENSE-MIT.txt)).
