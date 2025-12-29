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
ARG TARGETARCH
FROM quay.io/pypa/manylinux_2_28_${TARGETARCH}

ARG NODE_VERSION PNPM_VERSION

# System deps
RUN yum install -y git curl xz && yum clean all

# Rust: Copy toolchain file and install via rustup
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
COPY rust-toolchain.toml /tmp/
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none && \
    cd /tmp && rustup toolchain install

# cargo-binstall + cargo-run-bin
RUN curl -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
RUN cargo binstall cargo-run-bin -y --locked

# Node.js
RUN ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && NODE_ARCH="x64" || NODE_ARCH="arm64"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" | \
    tar -xJf - -C /usr/local --strip-components=1

# pnpm
RUN npm install -g "pnpm@${PNPM_VERSION}"
ENV PNPM_HOME=/root/.local/share/pnpm PATH=$PNPM_HOME:$PATH
RUN pnpm config set store-dir /root/.pnpm-store

# UV (for semgrep)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH=/root/.local/bin:$PATH

WORKDIR /workspace
```

**Why copy rust-toolchain.toml?** Single source of truth. The file defines channel, profile, and
components; no need to duplicate in build args.

### 2. Setup Action (`.github/actions/setup-docker-builder/action.yaml`)

```yaml
inputs:
  container-image: { required: true }      # ghcr.io/owner/repo:builder-<hash>
  container-image-cache: { required: true } # ghcr.io/owner/repo:buildcache
  node-version: { required: true }
  pnpm-version: { required: true }
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

    - if: steps.check.outputs.exists == 'false'
      run: cp rust-toolchain.toml .github/docker/
      shell: bash

    - if: steps.check.outputs.exists == 'false'
      uses: docker/setup-qemu-action@v3

    - if: steps.check.outputs.exists == 'false'
      uses: docker/setup-buildx-action@v3

    - if: steps.check.outputs.exists == 'false'
      uses: docker/build-push-action@v5
      with:
        context: .github/docker
        file: .github/docker/Dockerfile.builder
        platforms: linux/amd64,linux/arm64
        push: true
        tags: ${{ inputs.container-image }}
        build-args: |
          NODE_VERSION=${{ inputs.node-version }}
          PNPM_VERSION=${{ inputs.pnpm-version }}
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
    RUST_CHANNEL=$(grep 'channel' rust-toolchain.toml | cut -d'"' -f2)
    NODE_VERSION=$(jq -r '.engines.node | ltrimstr("^")' package.json)
    PNPM_VERSION=$(jq -r '.engines.pnpm | ltrimstr("^")' package.json)
    
    VERSION_HASH=$(echo "${RUST_CHANNEL}|${NODE_VERSION}|${PNPM_VERSION}" | sha256sum | cut -c1-16)
    
    REPO="${{ github.repository }}"
    echo "container-image=ghcr.io/${REPO,,}:builder-${VERSION_HASH}" >> "$GITHUB_OUTPUT"
    echo "container-image-cache=ghcr.io/${REPO,,}:buildcache" >> "$GITHUB_OUTPUT"
```

**Why version hash in tag?**

- **Reproducibility:** Same versions → same hash → same image
- **Automatic invalidation:** Version change → new hash → triggers rebuild
- **Old tag builds:** Checking out v1.0.0 computes that version's hash, uses its cached image

### 4. Workflow Structure

```yaml
jobs:
  init: ...
  
  setup-docker:
    needs: [init]
    permissions: { packages: write }  # Required for pushing
    steps:
      - uses: ./.github/actions/setup-docker-builder
        with:
          container-image: ${{ needs.init.outputs.container-image }}
          # ...

  build-docker:
    needs: [init, setup-docker]  # Waits for image to exist
    container:
      image: ${{ needs.init.outputs.container-image }}
      credentials: { username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
    # ...

  build-native:
    needs: [init]  # Runs in parallel with setup-docker
    # macOS/Windows builds...
```

**Why setup-docker as separate job?**

- Runs once, not per-matrix entry
- build-docker jobs wait for it, then run in parallel
- build-native jobs don't wait (they don't need Docker)

## Security

1. **No caching in release builds** - Prevents cache-poisoning attacks
2. **Use env vars for dynamic values** - Prevents template injection:

   ```yaml
   env: { IMAGE: '${{ inputs.container-image }}' }
   run: echo "Image: $IMAGE"  # Not: echo "${{ inputs.container-image }}"
   ```

3. **Pin action versions to SHA** - Prevents supply chain attacks

## Build Times

| Scenario | Time |
| :--- | :--- |
| First build (cold) | ~15-20 min |
| Rebuild (cache hit) | ~3-5 min |
| Pull existing | ~30s |

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
