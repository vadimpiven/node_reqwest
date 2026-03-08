# SBOM Attestation for Native Addon Binaries

## Goal

Attach a signed [CycloneDX][cyclonedx] SBOM to the `.node`
binaries published to GitHub Releases. Enterprise consumers
query the SBOM via the [GitHub Attestations API][gh-attest] or
download it from the release, and merge it into their
application-level SBOM.

[cyclonedx]: https://cyclonedx.org/
[gh-attest]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations

## Problem

The compiled `.node` binary is opaque to JS-level SBOM
scanners (Trivy, Grype, Syft). The Rust dependency tree
(reqwest, hyper, rustls, tokio — ~100 crates from
`Cargo.lock`) is invisible to consumers auditing their supply
chain.

## Scope

The SBOM covers the **Rust dependency tree** resolved from
`Cargo.lock` via `cargo metadata`. It does **not** cover:

- System libraries linked at build time (none currently —
  rustls eliminates OpenSSL)
- Build toolchain components (rustc, neon-build)
- JS dependencies (`node-addon-slsa`, `undici`) — these are
  visible to JS-level scanners via `package-lock.json` /
  `pnpm-lock.yaml`

## Format: CycloneDX 1.5

CycloneDX over SPDX:

- `cargo-cyclonedx` (official CycloneDX project) generates it
  from `Cargo.lock` directly
- `actions/attest-sbom` accepts CycloneDX natively
- Dominant format in the npm/GitHub ecosystem for binary SBOMs

Spec 1.5 (not 1.6): `cargo-cyclonedx` 0.5.7 supports up to
1.5. Spec 1.5 covers all fields needed for dependency
inventory (purls, versions, licenses). Consumer tools (Trivy,
Grype, Dependency-Track) fully support 1.5.

## Trust model

The SBOM attestation is **as trustworthy as the CI
environment**. `cargo-cyclonedx` reads `Cargo.lock` and
`Cargo.toml` metadata, not the compiled binary. A compromised
CI could produce a valid SBOM that does not match actual binary
contents. This is consistent with SLSA Level 2–3 guarantees
and is the standard trust model for CI-generated SBOMs.

The attestation proves: "this SBOM was produced in the same
GitHub Actions workflow that built the binary." It does not
prove: "the binary contains exactly these dependencies."

## Changes

### 1. Install `cargo-cyclonedx` via mise

`cargo-cyclonedx` 0.5.7 publishes GitHub release binaries
(via cargo-dist). Tag format: `cargo-cyclonedx-0.5.7`.

Add to `mise.toml`:

```toml
[tools."github:CycloneDX/cyclonedx-rust-cargo"]
version_prefix = "cargo-cyclonedx-"
version = "0.5.7"
os = ["macos"]
[tools."github:CycloneDX/cyclonedx-rust-cargo".platforms]
macos-x64 = { asset_pattern = "*-x86_64-apple-darwin*" }
macos-arm64 = { asset_pattern = "*-aarch64-apple-darwin*" }
```

Available binaries: `x86_64-apple-darwin`,
`aarch64-apple-darwin`, `x86_64-pc-windows-msvc`,
`x86_64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`.

**No `aarch64-unknown-linux-*` binary exists.** Linux builds
run inside the `manylinux_2_28` Docker container (glibc 2.28).
The musl binary works for x86_64 Linux, but arm64 Linux has
no prebuilt binary at all. This is moot because SBOM
generation moves to `build-packages` (see next section).

### 2. Generate SBOM once in `build-packages`

The SBOM content is identical across platforms (same
`Cargo.lock`). Generating it 6 times in the `build-addon`
matrix is wasteful and creates a release asset naming
collision (`bom.json` uploaded by all 6 runners).

Generate the SBOM once in the `build-packages` job, which
runs on `ubuntu-latest` (not inside Docker), after all addon
builds succeed. This eliminates the glibc/musl concern and
the linux-arm64 binary gap.

Add after "Build and pack node package", before "Attest node
build provenance":

```yaml
- name: "Generate SBOM"
  shell: "bash"
  run: |
    cargo cyclonedx \
      --manifest-path packages/node/Cargo.toml \
      --format json \
      --spec-version 1.5 \
      --describe crate
- name: "Validate SBOM"
  shell: "bash"
  run: |
    test -s packages/node/bom.json
    jq -e '.components | length > 50' \
      packages/node/bom.json
```

Output: `packages/node/bom.json` (~50 KB). Contains all Rust
crates with versions pinned from `Cargo.lock`, plus license
and purl metadata from `Cargo.toml` / crates.io registry.

The `--describe crate` flag scopes the SBOM to the `node`
crate's dependency tree (including transitive workspace
dependencies `core` and `meta`). No feature flags needed —
`packages/node/Cargo.toml` has no optional features.

The validation step ensures the SBOM is non-empty and contains
a reasonable number of components (~100 expected). If
`cargo-cyclonedx` fails or produces a degenerate file, the
release fails fast.

`cargo-cyclonedx` must be available on the `build-packages`
runner (`ubuntu-latest`, native — not Docker). Install via
mise on native runners. The `build-packages` job currently
uses the `./.github/actions/shell` action which dispatches
to Docker on Linux. The SBOM generation step uses
`shell: "bash"` directly (runs on the host, not in Docker),
same as the existing `attest-build-provenance` step.

[TODO: verify that `cargo cyclonedx` is available on the
GitHub Actions host after `mise install`. The `build-packages`
job runs `mise setup` via the setup action, which installs all
mise tools. Since `cargo-cyclonedx` will be in `mise.toml`,
it should be available. Confirm this works when `os` is set
to `["macos"]` — may need to add `"linux"` with a platforms
block for `ubuntu-latest`, or use `cargo binstall` as a
fallback step.]

### 3. Attest the SBOM

Add after the existing "Attest node build provenance" step:

```yaml
- name: "Attest SBOM"
  uses: "actions/attest-sbom@10926c72720ffc3f7b666661c8e55b1344e2a365" # v2.4.0
  with:
    subject-path: "packages/node/package.tar.gz"
    sbom-path: "packages/node/bom.json"
```

Binds the SBOM to the npm tarball (`package.tar.gz`) — the
artifact consumers actually install. The `build-packages` job
already has `id-token: write` and `attestations: write`
permissions.

### 4. Upload SBOM to GitHub Release

Extend the existing "Finalize release" step:

```yaml
- name: "Finalize release"
  uses: "softprops/action-gh-release@..."
  with:
    files: |
      packages/node/package.tar.gz
      packages/node/bom.json
    draft: false
```

Single upload from a single runner — no naming collision.

### 5. Rename SBOM file

Rename from `bom.json` to `node_reqwest-v{version}.cdx.json`:

- `.cdx.json` is the CycloneDX filename convention
- Version in filename prevents collisions when consumers
  download SBOMs for multiple versions

The rename happens after generation:

```yaml
- name: "Rename SBOM"
  shell: "bash"
  run: |
    mv packages/node/bom.json \
      "packages/node/node_reqwest-${GITHUB_REF_NAME}.cdx.json"
```

Update subsequent steps (`sbom-path`, `files`) to use the
new filename pattern.

### 6. Add smoke test verification

Add to the `smoke-test` job after the existing install check:

```bash
# Verify SBOM is downloadable from release
gh release download "$GITHUB_REF_NAME" \
  --repo vadimpiven/node_reqwest \
  --pattern "*.cdx.json"
# Validate SBOM content
jq -e '.bomFormat == "CycloneDX"' *.cdx.json
jq -e '.components | length > 50' *.cdx.json
# Verify SBOM attestation exists
gh attestation verify \
  "package.tar.gz" \
  --owner vadimpiven \
  --predicate-type https://cyclonedx.org/bom
```

[TODO: the smoke test job currently has `contents: read`
permission. `gh attestation verify` may need additional
permissions — verify this.]

### 7. Add local mise task

Add to `mise.toml`:

```toml
[tasks.sbom]
description = "Generate CycloneDX SBOM for node package"
depends = ["setup:rust"]
run = """
cargo cyclonedx \
  --manifest-path packages/node/Cargo.toml \
  --format json \
  --spec-version 1.5 \
  --describe crate
echo "SBOM written to packages/node/bom.json"
jq -e '.components | length' packages/node/bom.json
"""
sources = ["Cargo.lock", "packages/*/Cargo.toml"]
```

Developers can run `mise run sbom` to preview SBOM impact
after `Cargo.lock` changes.

### 8. Update README

Add a paragraph to the "Installation safety" section in
`packages/node/README.md`, after the existing provenance
text:

> A [CycloneDX][cyclonedx] SBOM listing all Rust dependencies
> compiled into the binary is attached to each GitHub Release
> and verifiable via the
> [GitHub Attestations API][gh-attest]. The SBOM covers the
> Rust dependency tree; JavaScript dependencies are visible
> through standard npm tooling.

### 9. No other changes needed

- **node-addon-slsa** — unchanged. SBOM is a transparency
  feature, not an install-time check.
- **`build-addon` job** — unchanged.
- **`publish` job** — unchanged.

## Consumer scenarios

### Automated SBOM ingestion

Enterprise security tooling queries the GitHub Attestations
API after `npm install`:

```bash
gh attestation verify \
  node_modules/node-reqwest/dist/node_reqwest.node \
  --owner vadimpiven \
  --format json \
  --predicate-type https://cyclonedx.org/bom
```

Returns the signed CycloneDX JSON. The tool merges it with
the JS-level SBOM for a complete dependency inventory.

### Manual download

```bash
gh release download v1.2.3 \
  --repo vadimpiven/node_reqwest \
  --pattern "*.cdx.json"
```

### CVE response

A CVE drops for `rustls@0.23.x`. The security team searches
their aggregated SBOMs, finds `rustls@0.23.25` in the
node-reqwest SBOM, identifies affected applications — without
contacting the maintainer.

## Remaining TODOs

1. Verify `cargo-cyclonedx` is available on `ubuntu-latest`
   after `mise install` with `os = ["macos"]`. May need to
   add Linux to the `os` list with a musl platform selector,
   or fall back to `cargo binstall`.
2. Verify `gh attestation verify` works in smoke test with
   only `contents: read` permission.
