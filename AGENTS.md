# Development with AI Agents

This document specifies the lifecycle and environment management for AI coding agents.

## Quick Start

```bash
# 1. Initialize environment variables
[ -f .env ] || cp .env.example .env
grep -q "^USER_UID=" .env || echo "USER_UID=$(id -u)" >> .env
grep -q "^USER_GID=" .env || echo "USER_GID=$(id -g)" >> .env
grep -q "^CI=" .env || echo "CI=true" >> .env

# 2. Check if sudo is needed (if this fails, prefix all docker commands with sudo)
docker info > /dev/null 2>&1 || DOCKER_SUDO="sudo"

# 3. Start container (auto-builds on first run, ~10 minutes)
$DOCKER_SUDO docker compose up -d

# 4. Ensure cache directory permissions
mkdir -p .cache && $DOCKER_SUDO chown -R $(id -u):$(id -g) .cache

# 5. Run tests (~10 minutes on first run due to Rust compilation)
$DOCKER_SUDO docker compose exec dev bash -c "pnpm install && pnpm test"
```

**Important**: Ensure your execution timeout is at least **30 minutes** for initial setup.

## Command Execution

All build and test commands MUST run inside the container via `docker compose exec dev`:

```bash
$DOCKER_SUDO docker compose exec dev bash -c "pnpm install && pnpm test"
```

For interactive shell access:

```bash
$DOCKER_SUDO docker compose exec dev bash
```

## Rebuilding the Image

Rebuild is required when modifying:

- Python: `.python-version`, `pyproject.toml`
- Node.js: `package.json` (`engines` or `packageManager` fields)
- Rust: `rust-toolchain.toml`
- Infrastructure: `Dockerfile`, `docker-compose.yml`, `.env`

```bash
$DOCKER_SUDO docker compose build && $DOCKER_SUDO docker compose up -d
```

## Troubleshooting

### "permission denied" connecting to Docker daemon

Prefix all `docker` commands with `sudo`:

```bash
sudo docker compose up -d
sudo docker compose exec dev bash -c "pnpm install && pnpm test"
```

### "EACCES: permission denied" inside container

Fix `.cache` directory ownership:

```bash
$DOCKER_SUDO chown -R $(id -u):$(id -g) .cache
$DOCKER_SUDO docker compose restart dev
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
