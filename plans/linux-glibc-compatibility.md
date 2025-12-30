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

### 1. Update init-workflow Action

Add container image outputs to `.github/actions/init-workflow/action.yaml`:

```yaml
outputs:
  # ... existing outputs ...
  container-image-base:
    description: 'Base container image name (without arch suffix)'
    value: ${{ steps.compute.outputs.container-image-base }}
  container-image-cache-base:
    description: 'Container image cache base'
    value: ${{ steps.compute.outputs.container-image-cache-base }}
  version-hash:
    description: 'Version hash for container tagging'
    value: ${{ steps.compute.outputs.version-hash }}

runs:
  using: 'composite'
  steps:
    - name: Parse versions from package.json
      id: parse
      # ... existing step ...

    - name: Compute container image version hash
      id: compute
      shell: bash
      run: |
        RUST_CHANNEL=$(yq -p toml -oy '.toolchain.channel' rust-toolchain.toml)
        NODE_VERSION=$(jq -r '.engines.node | ltrimstr("^")' package.json)
        PNPM_VERSION=$(jq -r '.engines.pnpm | ltrimstr("^")' package.json)
        PYTHON_VERSION=$(tr -d '\n\r' < .python-version)
        UV_VERSION=$(yq -p toml -oy '.tool.uv."required-version"' pyproject.toml | sed 's/[^0-9.]*//g')
        DOCKERFILE_HASH=$(sha256sum .devcontainer/Dockerfile | cut -c1-16)
        
        VERSION_STRING="${RUST_CHANNEL}|${NODE_VERSION}|${PNPM_VERSION}|${PYTHON_VERSION}|${UV_VERSION}|${DOCKERFILE_HASH}"
        VERSION_HASH=$(echo "${VERSION_STRING}" | sha256sum | cut -c1-16)
        
        REPO="${{ github.repository }}"
        REPO_LC="${REPO,,}"
        
        echo "container-image-base=ghcr.io/${REPO_LC}:builder-${VERSION_HASH}" >> "$GITHUB_OUTPUT"
        echo "container-image-cache-base=ghcr.io/${REPO_LC}:buildcache" >> "$GITHUB_OUTPUT"
        echo "version-hash=${VERSION_HASH}" >> "$GITHUB_OUTPUT"
```

### 2. Create setup-docker-builder Action

Create `.github/actions/setup-docker-builder/action.yaml`:

```yaml
name: 'Setup Docker Builder'
description: 'Build and push container image if not exists'

inputs:
  container-image:
    description: 'Full container image name with tag'
    required: true
  container-image-cache:
    description: 'Container image cache reference'
    required: true
  platform:
    description: 'Target platform (linux/amd64 or linux/arm64)'
    required: true
  github-token:
    description: 'GitHub token for registry authentication'
    required: true

runs:
  using: 'composite'
  steps:
    - name: Login to GitHub Container Registry
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ inputs.github-token }}

    - name: Check if image exists
      id: check
      shell: bash
      env:
        CONTAINER_IMAGE: '${{ inputs.container-image }}'
      run: |
        if docker manifest inspect "$CONTAINER_IMAGE" > /dev/null 2>&1; then
          echo "exists=true" >> "$GITHUB_OUTPUT"
        else
          echo "exists=false" >> "$GITHUB_OUTPUT"
        fi

    - name: Setup QEMU
      if: steps.check.outputs.exists == 'false'
      uses: docker/setup-qemu-action@v3
      with:
        platforms: '${{ inputs.platform }}'

    - name: Setup Docker Buildx
      if: steps.check.outputs.exists == 'false'
      uses: docker/setup-buildx-action@v3

    - name: Build and push
      if: steps.check.outputs.exists == 'false'
      uses: docker/build-push-action@v6
      with:
        context: .
        file: .devcontainer/Dockerfile
        platforms: ${{ inputs.platform }}
        push: true
        tags: ${{ inputs.container-image }}
        cache-from: type=registry,ref=${{ inputs.container-image-cache }}
        cache-to: type=registry,ref=${{ inputs.container-image-cache }},mode=max,image-manifest=true
```

### 3. Add Workflow Jobs

Add to `.github/workflows/regular.yaml`:

```yaml
jobs:
  init:
    # ... existing init job ...

  setup-docker:
    needs: [init]
    permissions:
      packages: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - { platform: linux/amd64, arch: amd64, runner: ubuntu-24.04 }
          - { platform: linux/arm64, arch: arm64, runner: ubuntu-24.04-arm }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
      - uses: ./.github/actions/setup-docker-builder
        with:
          container-image: ${{ needs.init.outputs.container-image-base }}-${{ matrix.arch }}
          container-image-cache: ${{ needs.init.outputs.container-image-cache-base }}
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
      credentials:
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
      
      - uses: actions/cache@v4
        with:
          path: .bin
          key: cargo-bin-${{ matrix.arch }}-${{ hashFiles('Cargo.toml') }}
          restore-keys: cargo-bin-${{ matrix.arch }}-
      
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build-native:
    needs: [init]
    # macOS/Windows builds - unchanged
```

## Runtime Caching

For CI jobs running inside the container:

```yaml
- uses: actions/cache@v4
  with:
    path: .bin
    key: cargo-bin-${{ matrix.arch }}-${{ hashFiles('Cargo.toml') }}

- uses: actions/cache@v4
  with:
    path: /home/vscode/.pnpm-store
    key: pnpm-${{ matrix.arch }}-${{ hashFiles('pnpm-lock.yaml') }}

- uses: actions/cache@v4
  with:
    path: /home/vscode/.cache/uv
    key: uv-${{ matrix.arch }}-${{ hashFiles('uv.lock') }}
```

## Build Times

| Scenario | Time |
| :--- | :--- |
| Cold build (no cache) | ~7-10 min |
| Rebuild (deps cached) | ~1-2 min |
| Pull existing image | ~30s |
