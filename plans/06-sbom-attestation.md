# SBOM and Attestation

[cyclonedx]: https://cyclonedx.org/
[gh-attest]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations
[cargo-sbom-tracking]: https://github.com/rust-lang/cargo/issues/16565

## Goal

Audit both Rust and JS dependency trees of the published
npm package through four complementary mechanisms.

## Problem

The compiled `.node` binary is opaque to JS-level SBOM
scanners (Trivy, Grype, Syft). The ~100 Rust crates from
`Cargo.lock` are invisible to consumers. JS dependencies
bundled into the tarball lack a machine-readable SBOM —
`pnpm-lock.yaml` is not included in the published package.

## Scope

| Layer | Tool | Covers | Format |
| --- | --- | --- | --- |
| Rust deps (file) | `cargo-cyclonedx` | Cargo.lock tree | CycloneDX 1.5 |
| Rust deps (embedded) | `cargo-auditable` | Cargo.lock tree | `.dep-v0` section |
| Cargo build manifest | `-Z sbom` | deps + features + rustc | cargo JSON |
| JS/TS deps | `rollup-plugin-sbom` | bundled npm deps | CycloneDX 1.6 |

**Not covered**: system libraries (none — rustls
eliminates OpenSSL), build toolchain (rustc, neon-build).

## Format: CycloneDX

CycloneDX over SPDX: both `cargo-cyclonedx` and
`rollup-plugin-sbom` generate it natively,
`actions/attest-sbom` accepts it, dominant format in the
npm/GitHub ecosystem.

Rust SBOM: spec 1.5 (`cargo-cyclonedx` 0.5.7 max).
JS SBOM: spec 1.6 (`rollup-plugin-sbom` default).
Consumer tools (Trivy, Grype, Dependency-Track) support
both.

## Trust model

SBOM attestations are **as trustworthy as the CI
environment**. `cargo-cyclonedx` reads `Cargo.lock`
metadata, `rollup-plugin-sbom` reads the Vite bundle
graph — neither inspects the compiled binary. Consistent
with SLSA Level 2-3 guarantees.

The attestation proves: "this SBOM was produced in the
same workflow that built the artifact." Not: "the artifact
contains exactly these dependencies."

## Changes

### 1. Install cargo-cyclonedx via mise

```toml
# mise.toml
[tools."github:CycloneDX/cyclonedx-rust-cargo"]
version_prefix = "cargo-cyclonedx-"
version = "0.5.7"
os = ["linux", "macos"]
[tools."github:CycloneDX/cyclonedx-rust-cargo".platforms]
linux-x64 = {
  asset_pattern = "*-x86_64-unknown-linux-musl*"
}
macos-x64 = {
  asset_pattern = "*-x86_64-apple-darwin*"
}
macos-arm64 = {
  asset_pattern = "*-aarch64-apple-darwin*"
}
```

Linux uses the musl binary (statically linked). No
`aarch64-unknown-linux-*` binary exists, but SBOM
generation runs only on `ubuntu-latest` (x86_64) in
`build-packages`.

### 2. Install cargo-auditable via mise (cargo backend)

```toml
# mise.toml — add under [tools]
"cargo:cargo-auditable" = "0.7.4"
```

The `cargo:` backend tries `cargo binstall` first, then
falls back to `cargo install`. `cargo-binstall` is already
in `mise.toml` (line 53).

Handles the linux-arm64 glibc mismatch: the only published
arm64 Linux binary is GNU, linked against glibc 2.39
(ubuntu-24.04). The Docker image (`manylinux_2_28`) has
glibc 2.28 — `binstall` fails, mise falls back to source
build automatically.

### 3. Add rollup-plugin-sbom to packages/node

```yaml
# pnpm-workspace.yaml — add to catalog
rollup-plugin-sbom: 3.0.5
```

```typescript
// packages/node/vite.config.mts — add import
import sbom from "rollup-plugin-sbom";

// add to plugins array, before dts()
sbom({
  rootComponentType: "library",
  generateSerial: true,
}),
```

Generates `export_dist/cyclonedx/bom.json` and
`export_dist/.well-known/sbom` during `vite build`.
Same pattern as
`node-addon-slsa/package/vite.config.mts:47-50`.

### 4. Use cargo-auditable for release builds

```jsonc
// packages/node/package.json
// before
"ci-build": "pnpm run build:cargo -r --locked && pnpm run build:ts",
// after
"ci-build": "cargo auditable build -r --locked && pnpm run build:ts",
```

Transparent wrapper around `cargo build` that embeds a
compressed dependency snapshot into the binary's `.dep-v0`
section. Dev builds stay with plain `cargo build`
(`build:cargo` unchanged). The release workflow already
calls `ci-build` (`release.yaml` > `build-addon`).

### 5. Enable cargo `-Z sbom`

```toml
# .cargo/config.toml — add to existing [build] section
sbom = true

# add new section
[unstable]
sbom = true
```

Generates `node_reqwest.cargo-sbom.json` alongside the
`.node` binary during every build — full dependency graph
with package IDs, features, and rustc version. Unstable
feature on nightly (`nightly-2026-02-28`). Tracking issue:
[rust-lang/cargo#16565][cargo-sbom-tracking] — 3 open
stabilization blockers.

[TODO: verify the exact output path — confirm the file
ends up in `packages/node/dist/` after the build.]

### 6. Verify auditable metadata in CI

In `release.yaml` > `build-addon`, after "Build node
addon", before "Sign and notarize":

```yaml
- name: "Verify auditable metadata"
  uses: "./.github/actions/shell"
  with:
      docker-service: >-
          ${{ needs.init.outputs.docker-service }}
      run: |
          cargo auditable info \
            packages/node/dist/node_reqwest.node
```

Exits non-zero if `.dep-v0` is missing, failing the
release.

### 7. Generate Rust CycloneDX SBOM in `build-packages`

In `build-packages`, after "Build and pack node package",
before "Attest node build provenance". Runs once on
`ubuntu-latest` (x86_64) — Rust SBOM is identical across
platforms (same `Cargo.lock`).

```yaml
- name: "Generate Rust SBOM"
  shell: "bash"
  run: |
    cargo cyclonedx \
      --manifest-path packages/node/Cargo.toml \
      --format json \
      --spec-version 1.5 \
      --describe crate
    mv packages/node/bom.json \
      "packages/node/node_reqwest-${GITHUB_REF_NAME}-rust.cdx.json"
- name: "Validate Rust SBOM"
  shell: "bash"
  run: |
    jq -e '.components | length > 50' \
      packages/node/node_reqwest-*-rust.cdx.json
```

`--describe crate` scopes to the `node` crate's dependency
tree (including transitive workspace deps `core` and
`meta`). Validation ensures ~100 expected components are
present. Uses `shell: "bash"` (host, not Docker), same as
the existing `attest-build-provenance` step.

### 8. Rename JS SBOM

Generated by `rollup-plugin-sbom` during `vite build`
(part of `build:ts`):

```yaml
- name: "Rename JS SBOM"
  shell: "bash"
  run: |
    mv packages/node/export_dist/cyclonedx/bom.json \
      "packages/node/node_reqwest-${GITHUB_REF_NAME}-js.cdx.json"
```

### 9. Attest both SBOMs

After the existing "Attest node build provenance" step:

```yaml
- name: "Attest Rust SBOM"
  uses: "actions/attest-sbom@10926c72720ffc3f7b666661c8e55b1344e2a365" # v2.4.0
  with:
    subject-path: "packages/node/package.tar.gz"
    sbom-path: "packages/node/node_reqwest-*-rust.cdx.json"
- name: "Attest JS SBOM"
  uses: "actions/attest-sbom@10926c72720ffc3f7b666661c8e55b1344e2a365" # v2.4.0
  with:
    subject-path: "packages/node/package.tar.gz"
    sbom-path: "packages/node/node_reqwest-*-js.cdx.json"
```

Binds both SBOMs to the npm tarball. `build-packages`
already has `id-token: write` and `attestations: write`.

[TODO: verify `actions/attest-sbom` supports glob patterns
in `sbom-path`. If not, use the explicit versioned
filename.]

### 10. Upload all artifacts to GitHub Release

```yaml
- name: "Finalize release"
  uses: "softprops/action-gh-release@..."
  with:
    files: |
      packages/node/package.tar.gz
      packages/node/node_reqwest-*-rust.cdx.json
      packages/node/node_reqwest-*-js.cdx.json
      packages/node/dist/*.cargo-sbom.json
    draft: false
```

### 11. Add smoke test verification

In `smoke-test`, after the existing install check:

```bash
# Verify SBOMs are downloadable from release
gh release download "$GITHUB_REF_NAME" \
  --repo vadimpiven/node_reqwest \
  --pattern "*.cdx.json"
# Validate SBOM content
jq -e '.bomFormat == "CycloneDX"' *-rust.cdx.json
jq -e '.components | length > 50' *-rust.cdx.json
jq -e '.bomFormat == "CycloneDX"' *-js.cdx.json
# Verify SBOM attestation exists
gh attestation verify \
  "package.tar.gz" \
  --owner vadimpiven \
  --predicate-type https://cyclonedx.org/bom
```

[TODO: `smoke-test` has `contents: read` permission.
`gh attestation verify` may need more — verify.]

### 12. Add local mise task

```toml
# mise.toml
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

### 13. Update README

In `packages/node/README.md` > "Installation safety",
after existing provenance text:

> A [CycloneDX][cyclonedx] SBOM listing all Rust and
> JavaScript dependencies is attached to each GitHub
> Release and verifiable via the
> [GitHub Attestations API][gh-attest].

### 14. Scope of impact

- **Regular CI** (`regular.yaml`): `-Z sbom` generates
  manifest during builds. No other changes.
- **Release CI** (`release.yaml`):
  - `build-addon`: `cargo auditable build` +
    verification step.
  - `build-packages`: Rust/JS CycloneDX generation,
    attestation, upload.
  - `smoke-test`: SBOM download and validation.
- **Local dev**: `cargo build` (no auditable), `-Z sbom`
  generates manifest, `mise run sbom` for CycloneDX.
- **node-addon-slsa**: Unchanged.

## Consumer scenarios

### Automated SBOM ingestion

```bash
gh attestation verify \
  node_modules/node-reqwest/dist/node_reqwest.node \
  --owner vadimpiven \
  --format json \
  --predicate-type https://cyclonedx.org/bom
```

### Binary audit (no API needed)

```bash
cargo audit bin \
  node_modules/node-reqwest/dist/node_reqwest.node
```

### Manual download

```bash
gh release download v1.2.3 \
  --repo vadimpiven/node_reqwest \
  --pattern "*.cdx.json"
```

### CVE response

A CVE drops for `rustls@0.23.x`. The security team
searches aggregated SBOMs, finds `rustls@0.23.25` in the
Rust SBOM, identifies affected applications — without
contacting the maintainer.

## Remaining TODOs

1. Verify `cargo-cyclonedx` is available on
   `ubuntu-latest` after `mise install` with
   `os = ["linux", "macos"]`.
2. Verify `gh attestation verify` works in smoke test
   with only `contents: read` permission.
3. Verify `actions/attest-sbom` supports glob patterns
   in `sbom-path`.
4. Verify `cargo -Z sbom` output path ends up in
   `packages/node/dist/` after the build.
