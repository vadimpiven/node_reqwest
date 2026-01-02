# Development with AI Agents

This document specifies the lifecycle and environment management for AI coding agents.

## Sudo Requirement

**Before running any commands, determine if sudo is needed.** Run this check:

```bash
docker info > /dev/null 2>&1 && echo "NO_SUDO" || echo "NEEDS_SUDO"
```

- If this prints `NO_SUDO`: you do NOT need sudo. Use commands exactly as shown.
- If this prints `NEEDS_SUDO`: you NEED sudo. Prefix ALL `docker` and `chown` commands with `sudo`.

**Remember your result.** Apply it consistently to every command in this document.

## Quick Start

### 1. Initialize environment

```bash
[ -f .env ] || cp .env.example .env
grep -q "^USER_UID=" .env || echo "USER_UID=$(id -u)" >> .env
grep -q "^USER_GID=" .env || echo "USER_GID=$(id -g)" >> .env
grep -q "^CI=" .env || echo "CI=true" >> .env
```

### 2. Start container (~10 minutes on first run)

Without sudo:

```bash
docker compose up -d
```

With sudo:

```bash
sudo docker compose up -d
```

### 3. Fix cache directory permissions

Without sudo:

```bash
mkdir -p .cache && chown -R $(id -u):$(id -g) .cache
```

With sudo:

```bash
mkdir -p .cache && sudo chown -R $(id -u):$(id -g) .cache
```

### 4. Run tests (~10 minutes on first run)

Without sudo:

```bash
docker compose exec -T dev bash -c "pnpm install && pnpm test"
```

With sudo:

```bash
sudo docker compose exec -T dev bash -c "pnpm install && pnpm test"
```

**Important**: Ensure your execution timeout is at least **30 minutes** for initial setup.

## Command Execution

All build and test commands MUST run inside the container via `docker compose exec dev`.

Without sudo:

```bash
docker compose exec -T dev bash -c "pnpm install && pnpm test"
```

With sudo:

```bash
sudo docker compose exec -T dev bash -c "pnpm install && pnpm test"
```

## Rebuilding the Image

Rebuild is required when modifying:

- Python: `.python-version`, `pyproject.toml`
- Node.js: `package.json` (`engines` or `packageManager` fields)
- Rust: `rust-toolchain.toml`
- Infrastructure: `Dockerfile`, `docker-compose.yml`, `.env`

Without sudo:

```bash
docker compose build && docker compose up -d
```

With sudo:

```bash
sudo docker compose build && sudo docker compose up -d
```

## Container Environment Reference

| Item      | Value                              |
| --------- | ---------------------------------- |
| Workspace | `/workspace` (mirrors repo root)   |
| User      | `runner` (UID mapped via `.env`)   |
| Python    | Managed by `uv`                    |
| Node.js   | Managed by `pnpm env`              |
| Rust      | Uses `sccache` via `RUSTC_WRAPPER` |

### Persistent Cache Paths

Cache directories are mounted to `./.cache/` on the host:

| Container Path                   | Host Path                 |
| -------------------------------- | ------------------------- |
| `/home/runner/.cache/uv`         | `./.cache/uv`             |
| `/home/runner/.cache/pnpm-store` | `./.cache/pnpm-store`     |
| `/home/runner/.cargo/registry`   | `./.cache/cargo/registry` |
| `/home/runner/.cargo/git`        | `./.cache/cargo/git`      |
| `/home/runner/.cache/sccache`    | `./.cache/sccache`        |

Avoid deleting `.cache/` unless a clean-slate build is required.
