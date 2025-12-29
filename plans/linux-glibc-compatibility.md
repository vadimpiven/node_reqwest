# Linux Glibc Compatibility: Docker-Based Build Guide

## Problem

GitHub's `ubuntu-24.04` runners use glibc 2.39. Binaries built there fail on older distros:

```text
/lib64/libc.so.6: version `GLIBC_2.39' not found
```

**Target compatibility:** Rocky Linux 8+ (glibc 2.28), which matches Node.js 20+ requirements.

## Solution: manylinux_2_28 Containers

Build Linux binaries inside `quay.io/pypa/manylinux_2_28` containers that provide glibc 2.28.

**Why not musl/static linking?** Node.js is built against glibc. Mixing glibc-based Node with
musl-based native addons can cause subtle compatibility issues.

## Architecture

```text
init → setup-docker → build-docker (parallel with build-native)
         ↓
    Check if image exists in ghcr.io
         ↓
    If no: Build + push with registry caching
         ↓
    build-docker pulls and uses the image
```

## Implementation

### 1. Dockerfile (`.github/docker/Dockerfile.builder`)

```dockerfile
# syntax=docker/dockerfile:1.4
ARG TARGETARCH
FROM quay.io/pypa/manylinux_2_28_${TARGETARCH}

ARG NODE_VERSION PNPM_VERSION PLAYWRIGHT_VERSION UV_VERSION

# System deps (cached)
RUN --mount=type=cache,target=/var/cache/yum,sharing=locked \
    yum install -y git curl xz

# Rust: Copy toolchain file and install via rustup (cached registry)
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
COPY rust-toolchain.toml /tmp/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none && \
    cd /tmp && rustup toolchain install

# cargo-binstall + cargo-run-bin + sccache
# Note: cargo-bin binaries (.bin folder) are installed at runtime, not in Docker image
# Cargo.toml is copied for version hash validation only (see runtime caching section)
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    curl -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash && \
    cargo binstall cargo-run-bin sccache -y --locked

# Node.js
RUN ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && NODE_ARCH="x64" || NODE_ARCH="arm64"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" | \
    tar -xJf - -C /usr/local --strip-components=1

# pnpm (cached store)
RUN npm install -g "pnpm@${PNPM_VERSION}"
ENV PNPM_HOME=/root/.local/share/pnpm PATH=$PNPM_HOME:$PATH
RUN pnpm config set store-dir /root/.pnpm-store

# UV and Python (cached)
COPY .python-version pyproject.toml uv.lock /tmp/
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh
ENV PATH=/root/.local/bin:$PATH
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    cd /tmp && uv sync --no-install-workspace

# Playwright browser dependencies (system packages including xvfb)
# Note: Browsers are installed at runtime. Our test runner script handles xvfb-run automatically.
RUN --mount=type=cache,target=/var/cache/yum,sharing=locked \
    npx playwright@${PLAYWRIGHT_VERSION} install-deps

WORKDIR /workspace
```

**Why copy these files?** Each file provides version information that affects the build:

- `rust-toolchain.toml` — Rust channel, profile, and components (used in Docker build)
- `.python-version` — Python version for UV to install (used in Docker build)
- `pyproject.toml` + `uv.lock` — Semgrep and other Python dependencies (used in Docker build)

**Note on `Cargo.toml`:** This file is copied for the setup action's version hash computation, but
cargo-bin binaries are **not** installed during Docker build. They're installed at workflow runtime
via the `preinstall` script and cached with `actions/cache` (see Section 6).

**Sccache installation:** Sccache is installed via `cargo binstall` to enable compile caching. The
actual cache backend is configured at runtime in the workflow via environment variables.

**Why `--mount=type=cache`?** BuildKit cache mounts persist data across builds without including it
in image layers:

- `/var/cache/yum` — Avoids re-downloading packages on each build
- `/usr/local/cargo/registry` — Caches downloaded crates and compiled dependencies
- `/root/.cache/uv` — Caches Python packages and interpreters for UV

The `sharing=locked` option ensures only one build writes at a time, preventing corruption during
parallel builds.

**Why install Playwright deps in Docker?** The `playwright install-deps` command installs system
packages (libatk, libglib, etc.) required by Playwright browsers. Installing in Docker avoids
`apt-get update && apt-get install` on every CI run.

### 2. Setup Action (`.github/actions/setup-docker-builder/action.yaml`)

```yaml
inputs:
  container-image: { required: true }       # ghcr.io/owner/repo:builder-<hash>-<arch>
  container-image-cache: { required: true } # ghcr.io/owner/repo:buildcache-<arch>
  platform: { required: true }              # linux/amd64 or linux/arm64
  node-version: { required: true }
  pnpm-version: { required: true }
  playwright-version: { required: true }
  uv-version: { required: true }
  github-token: { required: true }

runs:
  using: 'composite'
  steps:
    - uses: docker/login-action@v3
      with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ inputs.github-token }} }

    - id: check
      shell: bash
      env: { CONTAINER_IMAGE: '${{ inputs.container-image }}' }
      run: |
        if docker manifest inspect "$CONTAINER_IMAGE" > /dev/null 2>&1; then
          echo "exists=true" >> "$GITHUB_OUTPUT"
        else
          echo "exists=false" >> "$GITHUB_OUTPUT"
        fi

    # Copy all version-defining files to Docker context
    - if: steps.check.outputs.exists == 'false'
      shell: bash
      run: |
        cp rust-toolchain.toml .github/docker/
        cp Cargo.toml .github/docker/
        cp .python-version .github/docker/
        cp pyproject.toml .github/docker/
        cp uv.lock .github/docker/

    - if: steps.check.outputs.exists == 'false'
      uses: docker/setup-qemu-action@v3
      with:
        platforms: ${{ inputs.platform }}

    - if: steps.check.outputs.exists == 'false'
      uses: docker/setup-buildx-action@v3

    - if: steps.check.outputs.exists == 'false'
      uses: docker/build-push-action@v5
      with:
        context: .github/docker
        file: .github/docker/Dockerfile.builder
        platforms: ${{ inputs.platform }}
        push: true
        tags: ${{ inputs.container-image }}
        build-args: |
          NODE_VERSION=${{ inputs.node-version }}
          PNPM_VERSION=${{ inputs.pnpm-version }}
          PLAYWRIGHT_VERSION=${{ inputs.playwright-version }}
          UV_VERSION=${{ inputs.uv-version }}
        cache-from: type=registry,ref=${{ inputs.container-image-cache }}
        cache-to: type=registry,ref=${{ inputs.container-image-cache }},mode=max
```

**Why check before build?** Avoid rebuilding when image already exists. Pulling is ~30s vs building
~15min.

**Why registry cache with mode=max?**

- GHA cache is limited to 10GB and branch-scoped
- Registry cache has no size limit and is shared across all branches/PRs
- `mode=max` caches intermediate layers, maximizing cache hits

### 3. Init Workflow Updates

### Add version hash computation to `.github/actions/init-workflow/action.yaml`

```yaml
- id: compute
  shell: bash
  run: |
    # Core tool versions
    RUST_CHANNEL=$(grep 'channel' rust-toolchain.toml | cut -d'"' -f2)
    NODE_VERSION=$(jq -r '.engines.node | ltrimstr("^")' package.json)
    PNPM_VERSION=$(jq -r '.engines.pnpm | ltrimstr("^")' package.json)
    PYTHON_VERSION=$(cat .python-version | tr -d '\n')
    
    # Playwright version from pnpm catalog
    PLAYWRIGHT_VERSION=$(grep '@playwright/test' pnpm-workspace.yaml | head -1 | awk '{print $2}')
    
    # Cargo-bin tool versions (extracted from Cargo.toml [workspace.metadata.bin])
    CARGO_BIN_VERSIONS=$(sed -n '/\[workspace.metadata.bin\]/,/^\[/p' Cargo.toml | \
      grep -E '^[a-z-]+ = ' | sort | tr '\n' '|')
    
    # Semgrep version from pyproject.toml
    SEMGREP_VERSION=$(grep 'semgrep==' pyproject.toml | sed 's/.*semgrep==\([^"]*\).*/\1/')
    
    # UV version from pyproject.toml (required-version field)
    UV_VERSION=$(grep 'required-version' pyproject.toml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    
    # Compute hash from all version components
    VERSION_STRING="${RUST_CHANNEL}|${NODE_VERSION}|${PNPM_VERSION}|${PYTHON_VERSION}|${PLAYWRIGHT_VERSION}|${CARGO_BIN_VERSIONS}|${SEMGREP_VERSION}|${UV_VERSION}"
    VERSION_HASH=$(echo "${VERSION_STRING}" | sha256sum | cut -c1-16)
    
    REPO="${{ github.repository }}"
    REPO_LC="${REPO,,}"
    
    # Base outputs for constructing per-arch names
    echo "container-image-base=ghcr.io/${REPO_LC}:builder-${VERSION_HASH}" >> "$GITHUB_OUTPUT"
    echo "container-image-cache-base=ghcr.io/${REPO_LC}:buildcache" >> "$GITHUB_OUTPUT"
    echo "version-hash=${VERSION_HASH}" >> "$GITHUB_OUTPUT"
    
    # Version outputs for build args
    echo "node-version=${NODE_VERSION}" >> "$GITHUB_OUTPUT"
    echo "pnpm-version=${PNPM_VERSION}" >> "$GITHUB_OUTPUT"
    echo "playwright-version=${PLAYWRIGHT_VERSION}" >> "$GITHUB_OUTPUT"
    echo "uv-version=${UV_VERSION}" >> "$GITHUB_OUTPUT"
```

**Why version hash in tag?**

- **Reproducibility:** Same versions → same hash → same image
- **Automatic invalidation:** Version change → new hash → triggers rebuild
- **Old tag builds:** Checking out v1.0.0 computes that version's hash, uses its cached image

**Components included in the version hash:**

| Component | Source File | Why It Affects the Image |
| :--- | :--- | :--- |
| Rust channel | `rust-toolchain.toml` | Different Rust versions produce different binaries |
| Node.js version | `package.json` | Node runtime version |
| pnpm version | `package.json` | Package manager version |
| Python version | `.python-version` | UV installs this Python version |
| Playwright version | `pnpm-workspace.yaml` | Playwright system deps change per version |
| cargo-bin versions | `Cargo.toml` | cargo-nextest, cargo-llvm-cov, zizmor, etc. |
| Semgrep version | `pyproject.toml` | Python-based security scanner |
| UV version | `pyproject.toml` | Python package manager version |

### 4. Workflow Structure

```yaml
jobs:
  init: ...
  
  setup-docker:
    needs: [init]
    permissions: { packages: write }  # Required for pushing
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: linux/amd64
            arch: amd64
            runner: ubuntu-24.04
          - platform: linux/arm64
            arch: arm64
            runner: ubuntu-24.04-arm  # or ubuntu-24.04 with QEMU
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-docker-builder
        with:
          container-image: ${{ needs.init.outputs.container-image-base }}-${{ matrix.arch }}
          container-image-cache: ${{ needs.init.outputs.container-image-cache-base }}-${{ matrix.arch }}
          platform: ${{ matrix.platform }}
          node-version: ${{ needs.init.outputs.node-version }}
          pnpm-version: ${{ needs.init.outputs.pnpm-version }}
          playwright-version: ${{ needs.init.outputs.playwright-version }}
          uv-version: ${{ needs.init.outputs.uv-version }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

  build-docker:
    needs: [init, setup-docker]  # Waits for images to exist
    strategy:
      matrix:
        include:
          - arch: amd64
            runner: ubuntu-24.04
          - arch: arm64
            runner: ubuntu-24.04-arm  # or ubuntu-24.04 with QEMU
    runs-on: ${{ matrix.runner }}
    container:
      image: ${{ needs.init.outputs.container-image-base }}-${{ matrix.arch }}
      credentials: { username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
    env:
      RUSTC_WRAPPER: sccache
      SCCACHE_GHA_ENABLED: 'true'
    steps:
      - uses: actions/checkout@v4

      # Sccache with GitHub Actions cache backend
      - uses: mozilla-actions/sccache-action@v0.0.9

      - run: pnpm install --frozen-lockfile
      
      - run: pnpm test

  build-native:
    needs: [init]  # Runs in parallel with setup-docker
    # macOS/Windows builds...
```

**Why split architecture builds?**

- **Parallel execution:** Both amd64 and arm64 build simultaneously
- **Native runners:** Can use arm64 runners for faster arm64 builds (no QEMU)
- **Isolated caches:** Each arch has its own registry cache, no conflicts
- **~40% faster:** Total time drops from ~15-20 min to ~7-10 min

**Why setup-docker as separate job?**

- Runs once per arch, not per-matrix entry in build-docker
- build-docker jobs wait for their arch's image, then run in parallel
- build-native jobs don't wait (they don't need Docker)

### 5. Sccache Integration

Sccache caches compiled Rust artifacts using the GitHub Actions cache as a backend.

**How it works:**

1. `sccache` is pre-installed in the Docker image via `cargo binstall`
2. `mozilla-actions/sccache-action` configures the GHA cache backend at runtime
3. `RUSTC_WRAPPER=sccache` tells Cargo to use sccache for compilation
4. `SCCACHE_GHA_ENABLED=true` enables the GitHub Actions cache backend

**Cache key strategy:** Sccache automatically generates cache keys based on:

- Rust toolchain version
- Target architecture
- Compiler flags
- Source file hashes

**Caveats:**

- **10GB limit:** GitHub Actions cache has a 10GB limit across all caches. Sccache shares this with
  other caches (npm, Docker layers, etc.). Monitor usage in Actions → Caches.
- **Cache eviction:** Old entries are evicted when limit is reached (LRU policy)
- **Fork restrictions:** Forks can read but not write to the cache (security measure)

### 6. pnpm and UV Cache Strategy

Both pnpm and UV have their own caching mechanisms. Here's how they work inside the Docker
container:

**Docker Build Time (BuildKit cache mounts):**

```dockerfile
# pnpm store is configured to /root/.pnpm-store in the Dockerfile
RUN pnpm config set store-dir /root/.pnpm-store

# UV cache for Python packages and interpreters
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    cd /tmp && uv sync --no-install-workspace
```

The BuildKit cache mounts persist data *during Docker image builds* but are NOT included in the
final image layers. This means:

- First image build: pnpm/UV downloads packages (~slow)
- Subsequent image rebuilds: pnpm/UV uses BuildKit cache (~fast)
- Running container: Starts fresh, no cache from build time

**Runtime Caching (inside the container):**

For caching dependencies *at workflow runtime* (when `pnpm install` runs inside the container), we
need additional cache steps in the workflow:

```yaml
build-docker:
  steps:
    - uses: actions/checkout@v4
    
    # Restore cargo-bin binaries (.bin folder)
    # These are installed by preinstall script: cargo bin --install
    - uses: actions/cache@v4
      with:
        path: .bin
        key: cargo-bin-${{ matrix.arch }}-${{ hashFiles('Cargo.toml') }}
        restore-keys: |
          cargo-bin-${{ matrix.arch }}-
    
    # Restore pnpm store cache
    - uses: actions/cache@v4
      with:
        path: /root/.pnpm-store
        key: pnpm-${{ matrix.arch }}-${{ hashFiles('pnpm-lock.yaml') }}
        restore-keys: |
          pnpm-${{ matrix.arch }}-
    
    # Restore UV cache
    - uses: actions/cache@v4
      with:
        path: /root/.cache/uv
        key: uv-${{ matrix.arch }}-${{ hashFiles('uv.lock') }}
        restore-keys: |
          uv-${{ matrix.arch }}-
    
    - run: pnpm install --frozen-lockfile
    # ...
```

**Why cache `.bin` separately?** The `preinstall` script runs `cargo bin --install` which downloads
and builds binaries from `[workspace.metadata.bin]` in `Cargo.toml`. These include:

- `cargo-nextest` — Test runner
- `cargo-llvm-cov` — Code coverage
- `cargo-deny` — License/security checker
- `zizmor` — GitHub Actions linter

Without caching, first install takes ~2-3 minutes. With cache, it's ~5 seconds.

**Cache Size Considerations:**

| Cache | Typical Size | Location | Notes |
| :--- | :--- | :--- | :--- |
| cargo-bin | ~100-200 MB | `.bin/` | cargo-nextest, cargo-llvm-cov, zizmor, etc. |
| pnpm store | ~200-500 MB | `/root/.pnpm-store` | Shared across all packages |
| UV cache | ~100-300 MB | `/root/.cache/uv` | Python interpreters + packages |
| Sccache | ~500 MB-2 GB | GHA cache | Rust compilation artifacts |
| Docker registry | Unlimited | ghcr.io | Build layer cache |

**Total GHA cache usage:** Keep total under 10GB. With sccache + cargo-bin + pnpm + UV, typical
usage is ~1.5-3.5GB.

## Security

1. **No caching in release builds** - Prevents cache-poisoning attacks
2. **Use env vars for dynamic values** - Prevents template injection:

   ```yaml
   env: { IMAGE: '${{ inputs.container-image }}' }
   run: echo "Image: $IMAGE"  # Not: echo "${{ inputs.container-image }}"
   ```

3. **Pin action versions to SHA** - Prevents supply chain attacks

## Build Times

| Scenario | Single Multi-Arch | Split Arch (Parallel) | With Sccache |
| :--- | :--- | :--- | :--- |
| First build (cold) | ~15-20 min | ~7-10 min | ~7-10 min |
| Rebuild (same deps) | ~3-5 min | ~1-2 min | ~30s-1 min |
| PR with minor changes | ~3-5 min | ~1-2 min | ~30s-1 min |
| Pull existing image | ~30s | ~30s | ~30s |

**Why sccache?**

- **Compilation caching:** Caches compiled `.rlib`/`.rmeta` artifacts, not just downloaded sources
- **Cross-build sharing:** Cache is shared across PRs and branches via GitHub Actions cache
- **Incremental benefit:** Subsequent builds with same dependencies are dramatically faster
- **Complements registry cache:** Cargo registry cache stores source code; sccache stores compiled output

**Note:** BuildKit cache mounts provide ~20-30% improvement for Docker layer caching. Sccache
provides an additional 50-80% improvement for Rust compilation specifically.

## Zizmor Configuration

Add ignore rules for dynamically-computed image tags:

```yaml
rules:
  unpinned-images:
    ignore:
      - regular.yaml:XX:7   # Line with container image
      - release.yaml:XX:7
```

**Why ignore?** Images use version-hash tags computed at runtime. They're effectively pinned to
specific tool versions, just not to a SHA digest.
