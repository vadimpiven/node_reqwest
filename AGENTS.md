# Development with AI Agents

This document specifies the lifecycle and environment management for AI coding agents.

**Total setup time**: ~20 minutes on first run (image build + dependency install).

## Timeout Guidance for Agents

**CRITICAL**: Set your session/execution timeout to **at least 30 minutes**.

- **Step 3 (Container Build)**: Can take **10-15 minutes**.
    Use `WaitMsBeforeAsync: 600000` (10 min) or monitor status.
- **Step 4 (Install & Test)**: Can take **10-15 minutes**.
    Use `WaitMsBeforeAsync: 600000` (10 min) or monitor status.
- **DO NOT** use default 1-3 minute timeouts for these commands; they will stall or fail.

## Sudo Requirement

**Before running any commands, determine if sudo is needed.** Run this check ONCE:

```bash
docker info > /dev/null 2>&1 && echo "NO_SUDO" || echo "NEEDS_SUDO"
```

- `NO_SUDO` → Use commands exactly as shown
- `NEEDS_SUDO` → Prefix ALL `docker` and `chown` commands with `sudo`

**Remember this result and apply it consistently.**

## Quick Start (Step-by-Step)

### Step 1: Initialize environment file

```bash
[ -f .env ] || cp .env.example .env
grep -q "^USER_UID=" .env || echo "USER_UID=$(id -u)" >> .env
grep -q "^USER_GID=" .env || echo "USER_GID=$(id -g)" >> .env
grep -q "^CI=" .env || echo "CI=true" >> .env
grep -q "^COMPOSE_FILE=" .env || echo "COMPOSE_FILE=docker-compose.yml" >> .env
```

### Step 2: Fix cache directory ownership (BEFORE starting container)

The `.cache/` directory structure should already exist (committed via `.gitkeep` files).
However, if it doesn't or has wrong permissions:

Without sudo:

```bash
mkdir -p .cache/native/{uv,pnpm-store,sccache} .cache/docker/{mise,uv,pnpm-store,sccache} .cache/cargo/{registry,git}
chown -R $(id -u):$(id -g) .cache
```

With sudo:

```bash
mkdir -p .cache/native/{uv,pnpm-store,sccache} .cache/docker/{mise,uv,pnpm-store,sccache} .cache/cargo/{registry,git}
sudo chown -R $(id -u):$(id -g) .cache
```

### Step 3: Start container (~10 minutes on first run)

**CAUTION**: This step involves building the image. Set a high timeout (10+ min).

Without sudo:

```bash
docker compose up --build -d
```

With sudo:

```bash
sudo docker compose up --build -d
```

**Note:** Some agent tool wrappers may report "failed with unknown error"
even when the command succeeds. Always verify actual status
with `docker compose ps` below.

**Wait for container to be running** before proceeding. Check status:

Without sudo:

```bash
docker compose ps
```

With sudo:

```bash
sudo docker compose ps
```

Expected output should show `dev` container with `Up` status.

### Step 4: Run tests (~10 minutes on first run)

**CAUTION**: This step installs dependencies and runs all tests. Set a high timeout (10+ min).

Without sudo:

```bash
docker compose exec -T dev bash -c "mise run test"
```

With sudo:

```bash
sudo docker compose exec -T dev bash -c "mise run test"
```

**Note on expected output:**

- **404 Errors**: During `pnpm install`, 404s for `node-pre-gyp` (version `0.0.0`)
    are **expected** and handled by the fallback source build.
- **Pyrefly Warning**: A warning about missing `.venv/Lib/site-packages`
    is **expected** on Linux (it's the Windows path). It can be ignored.

## Troubleshooting

### Container name conflict error

If you see: `Error response from daemon: Conflict. The container name is already in use`

This is a Docker daemon bug. Fix it by:

Without sudo:

```bash
# Show all containers (including broken/orphaned ones)
docker ps -a

# Force remove the specific container by ID (use the ID shown in the error)
docker rm -f <container_id>

# If that fails, restart Docker daemon and try again
docker compose down --remove-orphans && docker compose up --build -d
```

With sudo:

```bash
sudo docker ps -a
sudo docker rm -f <container_id>
sudo docker compose down --remove-orphans && sudo docker compose up --build -d
```

### Permission denied on .cache/docker/pnpm-store

This happens when Docker creates directories as root. Fix it:

Without sudo:

```bash
chown -R $(id -u):$(id -g) .cache
docker compose exec -T dev bash -c "mise run test"
```

With sudo:

```bash
sudo chown -R $(id -u):$(id -g) .cache
sudo docker compose exec -T dev bash -c "mise run test"
```

### Container not starting / stays in "Created" state

Without sudo:

```bash
docker compose logs dev
```

With sudo:

```bash
sudo docker compose logs dev
```

## Command Execution

All commands MUST run inside the container via `docker compose exec dev bash -c "..."`.

**IMPORTANT**: Always use `bash -c "..."` wrapper. This ensures:

1. Container initialization is complete (waits for ready marker)
2. mise is properly activated (shims/tasks are available)
3. Tools are automatically installed on-demand by mise tasks
4. Environment variables are correctly set

Without sudo:

```bash
docker compose exec -T dev bash -c "mise run test"
```

With sudo:

```bash
sudo docker compose exec -T dev bash -c "mise run test"
```

**DO NOT** run commands directly without bash wrapper (e.g., `docker compose exec dev mise run test`).
This bypasses initialization and may fail.

## Rebuilding the Image

Rebuild is required when modifying:

- Tool versions: `mise.toml`
- Infrastructure: `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.env`

Without sudo:

```bash
docker compose down && docker compose up --build -d
```

With sudo:

```bash
sudo docker compose down && sudo docker compose up --build -d
```

## Container Environment Reference

| Item      | Value                              |
| --------- | ---------------------------------- |
| Workspace | `/workspace` (mirrors repo root)   |
| User      | `runner` (UID mapped via `.env`)   |
| Python    | Managed by `uv` (via `mise`)       |
| Node.js   | Managed by `mise`                  |
| Rust      | Uses `sccache` via `config.toml`   |

### Persistent Cache Paths

Cache directories are stored in `.cache/` within the workspace. Docker and native
environments use separate subdirectories to avoid platform conflicts.

**Docker caches** (via Dockerfile environment variables):

| Environment Variable    | Path                                  |
| ----------------------- | ------------------------------------- |
| `MISE_DATA_DIR`         | `/workspace/.cache/docker/mise`       |
| `UV_CACHE_DIR`          | `/workspace/.cache/docker/uv`         |
| `npm_config_store_dir`  | `/workspace/.cache/docker/pnpm-store` |
| `SCCACHE_DIR`           | `/workspace/.cache/docker/sccache`    |
| `CARGO_HOME`            | `/workspace/.cache/cargo`             |

**Native caches** (CI paths; local uses defaults unless configured):

| Tool    | CI Path                      |
| ------- | ---------------------------- |
| uv      | `./.cache/native/uv`         |
| pnpm    | `./.cache/native/pnpm-store` |
| sccache | `./.cache/native/sccache`    |
| cargo   | `./.cache/cargo`             |
| mise    | `~/.local/share/mise`        |

Avoid deleting `.cache/` unless a clean-slate build is required.
