# Linux Glibc Compatibility: Docker-Based CI Builds

## Problem

GitHub's `ubuntu-24.04` runners use glibc 2.39. Binaries fail on older distros (Rocky Linux 8+
requires glibc 2.28).

## Solution

Build inside the devcontainer image (`.devcontainer/Dockerfile`) which uses `quay.io/pypa/manylinux_2_28`.

## Architecture

```text
init → setup-docker → build-docker (parallel with build-native)
         ↓
    Check if image exists in ghcr.io → If no: Build + push with registry caching
```

## Implementation

### 1. CI Dockerfile Modifications

For CI, copy `.devcontainer/Dockerfile` and add BuildKit cache mounts:

```dockerfile
# Add to system deps
RUN --mount=type=cache,target=/var/cache/yum,sharing=locked \
    yum install -y ...

# Add to UV/Python
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    cd /tmp/config && uv python install --default

# Add to Rust
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    curl -sSf https://sh.rustup.rs | sh -s -- ...
```

### BuildKit Cache Mounts

| Path | Purpose |
| :--- | :--- |
| `/var/cache/yum` | Package downloads |
| `/usr/local/cargo/registry` | Crate sources |
| `/root/.cache/uv` | Python packages |

### 2. Setup Action (`.github/actions/setup-docker-builder/action.yaml`)

```yaml
name: 'Setup Docker Builder'

inputs:
  container-image: { required: true }
  container-image-cache: { required: true }
  platform: { required: true }
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
      shell: bash
      run: |
        cp package.json pnpm-workspace.yaml rust-toolchain.toml .python-version pyproject.toml .devcontainer/

    - if: steps.check.outputs.exists == 'false'
      uses: docker/setup-qemu-action@v3
      with: { platforms: '${{ inputs.platform }}' }

    - if: steps.check.outputs.exists == 'false'
      uses: docker/setup-buildx-action@v3

    - if: steps.check.outputs.exists == 'false'
      uses: docker/build-push-action@v5
      with:
        context: .devcontainer
        file: .devcontainer/Dockerfile
        platforms: ${{ inputs.platform }}
        push: true
        tags: ${{ inputs.container-image }}
        cache-from: type=registry,ref=${{ inputs.container-image-cache }}
        cache-to: type=registry,ref=${{ inputs.container-image-cache }},mode=max
```

### 3. Version Hash Computation (`.github/actions/init-workflow/action.yaml`)

```yaml
- id: compute
  shell: bash
  run: |
    RUST_CHANNEL=$(yq -p toml -oy '.toolchain.channel' rust-toolchain.toml)
    NODE_VERSION=$(jq -r '.engines.node | ltrimstr("^")' package.json)
    PNPM_VERSION=$(jq -r '.engines.pnpm | ltrimstr("^")' package.json)
    PYTHON_VERSION=$(tr -d '\n\r' < .python-version)
    PLAYWRIGHT_VERSION=$(yq -oy '.catalog."@playwright/test"' pnpm-workspace.yaml)
    CARGO_BIN_VERSIONS=$(yq -p toml -oy -o json '.workspace.metadata.bin' Cargo.toml | jq -r 'to_entries | sort_by(.key) | map("\(.key)=\(.value)") | join("|")')
    SEMGREP_VERSION=$(yq -p toml -oy '.dependency-groups.dev[]' pyproject.toml | grep 'semgrep==' | sed 's/semgrep==//')
    UV_VERSION=$(yq -p toml -oy '.tool.uv."required-version"' pyproject.toml | sed 's/[^0-9.]*//g')
    
    VERSION_STRING="${RUST_CHANNEL}|${NODE_VERSION}|${PNPM_VERSION}|${PYTHON_VERSION}|${PLAYWRIGHT_VERSION}|${CARGO_BIN_VERSIONS}|${SEMGREP_VERSION}|${UV_VERSION}"
    VERSION_HASH=$(echo "${VERSION_STRING}" | sha256sum | cut -c1-16)
    
    REPO="${{ github.repository }}"
    REPO_LC="${REPO,,}"
    
    echo "container-image-base=ghcr.io/${REPO_LC}:builder-${VERSION_HASH}" >> "$GITHUB_OUTPUT"
    echo "container-image-cache-base=ghcr.io/${REPO_LC}:buildcache" >> "$GITHUB_OUTPUT"
    echo "version-hash=${VERSION_HASH}" >> "$GITHUB_OUTPUT"
```

Version hash ensures: same versions → same hash → same image.

### 4. Workflow Structure

```yaml
jobs:
  init: ...
  
  setup-docker:
    needs: [init]
    permissions: { packages: write }
    strategy:
      fail-fast: false
      matrix:
        include:
          - { platform: linux/amd64, arch: amd64, runner: ubuntu-24.04 }
          - { platform: linux/arm64, arch: arm64, runner: ubuntu-24.04-arm }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-docker-builder
        with:
          container-image: ${{ needs.init.outputs.container-image-base }}-${{ matrix.arch }}
          container-image-cache: ${{ needs.init.outputs.container-image-cache-base }}-${{ matrix.arch }}
          platform: ${{ matrix.platform }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

  build-docker:
    needs: [init, setup-docker]
    strategy:
      matrix:
        include:
          - { arch: amd64, runner: ubuntu-24.04 }
          - { arch: arm64, runner: ubuntu-24.04-arm }
    runs-on: ${{ matrix.runner }}
    container:
      image: ${{ needs.init.outputs.container-image-base }}-${{ matrix.arch }}
      credentials: { username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
    env:
      RUSTC_WRAPPER: sccache
      SCCACHE_GHA_ENABLED: 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: mozilla-actions/sccache-action@v0.0.9
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build-native:
    needs: [init]
    # macOS/Windows builds...
```

### 5. Runtime Caching

```yaml
build-docker:
  steps:
    - uses: actions/checkout@v4
    
    - uses: actions/cache@v4
      with:
        path: .bin
        key: cargo-bin-${{ matrix.arch }}-${{ hashFiles('Cargo.toml') }}
        restore-keys: cargo-bin-${{ matrix.arch }}-
    
    - uses: actions/cache@v4
      with:
        path: /root/.pnpm-store
        key: pnpm-${{ matrix.arch }}-${{ hashFiles('pnpm-lock.yaml') }}
        restore-keys: pnpm-${{ matrix.arch }}-
    
    - uses: actions/cache@v4
      with:
        path: /root/.cache/uv
        key: uv-${{ matrix.arch }}-${{ hashFiles('uv.lock') }}
        restore-keys: uv-${{ matrix.arch }}-
    
    - run: pnpm install --frozen-lockfile
```

### Cache Sizes

| Cache | Size | Location |
| :--- | :--- | :--- |
| cargo-bin | ~100-200 MB | `.bin/` |
| pnpm | ~200-500 MB | `/root/.pnpm-store` |
| UV | ~100-300 MB | `/root/.cache/uv` |
| Sccache | ~500 MB-2 GB | GHA cache |
| Docker registry | Unlimited | ghcr.io |

Keep total GHA cache under 10GB (~1.5-3.5GB typical).

## Security

1. No caching in release builds
2. Use env vars for dynamic values
3. Pin action versions to SHA

## Build Times

| Scenario | Parallel | With Sccache |
| :--- | :--- | :--- |
| Cold build | ~7-10 min | ~7-10 min |
| Rebuild (same deps) | ~1-2 min | ~30s-1 min |
| Pull existing | ~30s | ~30s |

## Zizmor Configuration

```yaml
rules:
  unpinned-images:
    ignore:
      - regular.yaml:XX:7
      - release.yaml:XX:7
```

## File Structure

```text
.devcontainer/
├── Dockerfile          # ← Already implemented
└── devcontainer.json   # ← Already implemented

.github/actions/
├── init-workflow/action.yaml
└── setup-docker-builder/action.yaml  # ← To be created
```
