# Development with AI Agents

This document specifies the lifecycle and environment management for AI coding agents.

## Environment Initialization

Agents should ensure the following state before executing builds.
This command is safe to run multiple times:

```bash
# Initialize Docker environment variables if missing
[ -f .env ] || cp .env.example .env
grep -q "^USER_UID=" .env || echo "USER_UID=$(id -u)" >> .env
grep -q "^USER_GID=" .env || echo "USER_GID=$(id -g)" >> .env
grep -q "^CI=" .env || echo "CI=true" >> .env
```

## Container Lifecycle

The repository uses `docker-compose.yml` to maintain a persistent development environment.

### 1. Start the Environment

```bash
docker compose up -d
```

### 2. Execute Commands

Agents MUST use `docker compose exec dev` to execute all build and test commands.
This ensures that the persistent environment and caches are utilized:

```bash
# Standard build & test flow
docker compose exec dev bash -c "pnpm install && pnpm test"
```

### 3. Shell Access

If an interactive session is required:

```bash
docker compose exec dev bash
```

## Context for Agents

- **Workspace Path**: `/workspace` (mirrors host root)
- **User**: `runner` (mapped to host UID via `.env`)
- **Key Tooling**:
  - `uv`: Manages Python runtimes
  - `pnpm`: Global, manages Node.js (via `pnpm env`)
  - `cargo`: Global, uses `sccache` by default
  - `trivy`: Vulnerability scanner

- **Implicit Environment Variables** (pre-configured in container):
  - `CI=true`: Configured via `.env` during initialization.
  - `RUSTC_WRAPPER=sccache`: Enabled by default for all Rust builds.
  - `SCCACHE_DIR=/home/runner/.cache/sccache`: Points to persistent volume.
  - `PNPM_HOME`, `CARGO_HOME`, `RUSTUP_HOME`: Set correctly for user `runner`.

### Caching Paths

When running in CLI or as an agent, cache directories are mounted to the repository-local
`.cache` folder.
This isolated environment prevents container binaries from mixing with your host global setup.
Avoid deleting the `.cache` directory unless a clean-slate build is explicitly required.

The following internal paths are persistent:

- `/home/runner/.cache/uv` (maps to `./.cache/uv`)
- `/home/runner/.cache/pnpm-store` (maps to `./.cache/pnpm-store`)
- `/home/runner/.cargo/registry` (maps to `./.cache/cargo/registry`)
- `/home/runner/.cargo/git` (maps to `./.cache/cargo/git`)
- `/home/runner/.cache/sccache` (maps to `./.cache/sccache`)

## Rebuilding

You MUST rebuild the image to apply changes if any of the following are modified:

- Python: `.python-version`, `pyproject.toml`
- Node.js: `package.json` (`packageManager` or `engines` sections only)
- Rust: `rust-toolchain.toml`
- Infrastructure: `Dockerfile`, `docker-compose.yml`, `.env`

```bash
docker compose build && docker compose up -d
```

## Verification

Agents can verify the environment by running:

```bash
docker compose exec dev bash -c "
  uv --version && \
  python --version && \
  pnpm --version && \
  node --version && \
  rustup --version && \
  cargo --version && \
  rustc --version"
```
