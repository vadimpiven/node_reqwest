# SBOM and Attestation

[cyclonedx]: https://cyclonedx.org/
[gh-attest]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations

## Goal

Ship a target-exact CycloneDX 1.6 SBOM with every release artifact, attested through the GitHub
Attestations API. Rust SBOMs come from the `.dep-v0` section that `cargo-auditable` embeds at link
time; the JS SBOM comes from `pnpm-lock.yaml` shipped inside the npm tarball. One generator (Syft)
covers both.

## Publish topology

`release.yaml` produces two artifact streams:

- **Per-target `.node.gz`** → `gh release upload` from `build-addon` (one per matrix entry).
  Contains the compiled Rust binary.
- **`package.tar.gz`** → `npm publish` from `publish`. JS only (loader, types, `export_dist/`).
  The `slsa` postinstall fetches the matching `.node.gz` from the GitHub Release.

Rust and JS live in different artifacts, so each gets its own SBOM attested to its own subject.
Per-target Rust attribution is preserved by construction; no merging required.

## Scope

| Artifact                 | Source of truth                     | Generator | Format        |
| ------------------------ | ----------------------------------- | --------- | ------------- |
| `*.node.gz` (per target) | `.dep-v0` section (cargo-auditable) | Syft      | CycloneDX 1.6 |
| `package.tar.gz` (JS)    | `pnpm-lock.yaml` (shipped)          | Syft      | CycloneDX 1.6 |

Not covered: system libraries (none — rustls eliminates OpenSSL), build toolchain (rustc,
neon-build).

## Trust model

The attestation proves *this SBOM was produced in the same workflow that built the artifact*.
Combined with `.dep-v0`, it strengthens to *the SBOM reflects what the compiler embedded into the
binary at link time*. Tampering with the binary post-link breaks `cargo audit bin`; tampering with
the SBOM breaks attestation verification.

A Cargo.lock-only SBOM would be approximate — `[target.'cfg(...)']` deps and feature flags differ
per platform (rustls vs schannel vs Security.framework). `.dep-v0` is target-exact because each
binary only embeds the deps the linker actually consumed.

## Changes

### 1. Install Syft via mise

```toml
# mise.toml — add inline alongside existing aqua: pins (mise.toml:43-52)
"aqua:anchore/syft" = "1.44.0"  # latest stable 2026-05-01
```

Pinned directly (not `anchore/sbom-action`, which lags Syft by 1–2 minor versions). Syft ≥ 1.15
enables `cargo-auditable-binary-cataloger` by default; ≥ 1.8 emits CycloneDX 1.6 by default.

### 2. Install cargo-auditable via mise + Dockerfile

```toml
# mise.toml — add under [tools]
[tools."github:rust-secure-code/cargo-auditable"]
version = "0.7.4"
[tools."github:rust-secure-code/cargo-auditable".platforms]
linux-x64    = { asset_pattern = "*-x86_64-unknown-linux-musl.tar.xz" }
macos-x64    = { asset_pattern = "*-x86_64-apple-darwin.tar.xz" }
macos-arm64  = { asset_pattern = "*-aarch64-apple-darwin.tar.xz" }
windows-x64  = { asset_pattern = "*-x86_64-pc-windows-msvc.zip" }
windows-arm64 = { asset_pattern = "*-aarch64-pc-windows-msvc.zip" }
# linux-arm64: no manylinux-compatible upstream binary (only gnu/glibc 2.39
# exists; our manylinux_2_28 base has glibc 2.28). Installed via Dockerfile.
```

```dockerfile
# Dockerfile — after mise install (Dockerfile:27-32)
# Single compile per image rebuild, cached in a Docker layer. Bump --version
# in lockstep with the mise.toml pin above.
RUN --mount=type=cache,target=/root/.cargo/registry \
    if [ "$(uname -m)" = "aarch64" ]; then \
      eval "$(mise activate bash)" && \
      cargo install cargo-auditable --version 0.7.4 --locked \
        --root /usr/local && \
      cargo-auditable --version; \
    fi
```

Linux x86_64 takes the static `musl` asset (runs in any container). macOS/Windows use native
binaries. Linux arm64 inside manylinux_2_28 has no compatible upstream binary → Dockerfile
compiles once at image build, layer-cached.

### 3. Compile all builds with cargo-auditable

```jsonc
// packages/node/package.json — patch build:cargo (line 53)
"build:cargo": "cargo auditable build",
// ci-build (line 64) unchanged; -r --locked forward to cargo auditable build.
"ci-build": "pnpm run build:cargo -r --locked && pnpm run build:ts"
```

`build-addon` invokes `pnpm -F "{packages/node}" run ci-build` (release.yaml:86). cargo-auditable
delegates to `cargo build` and embeds `.dep-v0` post-link — ELF on Linux, Mach-O on macOS, PE on
Windows. Dev `pnpm run build` uses the same command.

### 4. Ship pnpm-lock.yaml inside the npm tarball

Without the lockfile inside `package.tar.gz`, Syft's pnpm cataloger only sees direct deps from
`package.json`. `pnpm pack` resolves `files` relative to the package dir, so copy the root
lockfile in before pack:

```jsonc
// packages/node/package.json
"files": [
  "export/**/*",
  "export_dist/**/*",
  "pnpm-lock.yaml"
],
"build:ts": "vite build && typedoc && cp ../../pnpm-lock.yaml . && pnpm pack --out package.tar.gz"
```

Add `packages/node/pnpm-lock.yaml` to `.gitignore` (transient copy; source of truth stays at repo
root).

### 5. Define mise SBOM tasks

All SBOM work lives in `mise.toml`. CI and local dev call the same tasks.

```toml
# mise.toml

# Exits non-zero if .dep-v0 missing.
[tasks."sbom:verify"]
description = "Check .dep-v0 is present in the built addon"
run = "cargo auditable info packages/node/dist/node_reqwest.node"

[tasks."sbom:rust"]
description = "Generate CycloneDX SBOM from the addon's .dep-v0 section"
depends = ["sbom:verify"]
run = [
  '''syft scan packages/node/dist/node_reqwest.node --override-default-catalogers cargo-auditable-binary-cataloger -o cyclonedx-json=packages/node/dist/node_reqwest.cdx.json''',
  '''jq -e '.bomFormat == "CycloneDX"' packages/node/dist/node_reqwest.cdx.json''',
  '''jq -e '[.components[]? | select(.properties[]?.value == "cargo-auditable-binary-cataloger")] | length > 50' packages/node/dist/node_reqwest.cdx.json''',
]

[tasks."sbom:js"]
description = "Generate CycloneDX SBOM from the packed npm tarball"
run = [
  '''syft scan packages/node/package.tar.gz -o cyclonedx-json=packages/node/package.cdx.json''',
  '''jq -e '.bomFormat == "CycloneDX"' packages/node/package.cdx.json''',
  '''jq -e '[.components[]? | select(.type == "library")] | length > 0' packages/node/package.cdx.json''',
]
```

Add `packages/node/dist/node_reqwest.cdx.json` and `packages/node/package.cdx.json` to
`.gitignore`.

Fixed input paths (`dist/node_reqwest.node`, `package.tar.gz`) and fixed output paths — each
matrix entry writes one SBOM in its own workspace, and the attest step picks it up by literal
name. No host-target probing; Syft reads `.dep-v0` from ELF/Mach-O/PE identically. Each `run`
entry is a single command — no shell idioms, portable across bash, PowerShell, git-bash.

### 6. Verify auditable metadata in build-addon

```yaml
# New step between "Sign and notarize" (release.yaml:87) and "Pack node addon"
# (release.yaml:91). After sign+notarize ensures signing didn't strip .dep-v0.
- name: "Verify auditable metadata"
  shell: "bash"
  run: mise run sbom:verify
```

### 7. Generate per-target Rust SBOM in build-addon

```yaml
# New step after "Pack node addon", before "Attest build provenance" (release.yaml:96).
- name: "Generate Rust SBOM"
  shell: "bash"
  run: mise run sbom:rust
```

### 8. Attest Rust SBOM in build-addon

```yaml
# New step after "Attest build provenance". Per-matrix-entry: exactly one
# subject and one predicate, so attest-sbom's lack of stem-pairing is moot.
- name: "Attest Rust SBOM"
  uses: "actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e" # v4.1.0
  with:
    subject-path: "packages/node/dist/*.node.gz"
    sbom-path: "packages/node/dist/node_reqwest.cdx.json"
```

### 9. Generate JS SBOM in build-packages

```yaml
# New step in build-packages, after "Build and pack node package", before
# "Attest node build provenance".
- name: "Generate JS SBOM"
  shell: "bash"
  run: mise run sbom:js
```

### 10. Attest JS SBOM

```yaml
# New step after "Attest node build provenance". The existing release upload
# in build-packages (release.yaml:155-160) stays as-is: the SBOM lives in
# the attestation predicate, not as a separate release asset.
- name: "Attest JS SBOM"
  uses: "actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e" # v4.1.0
  with:
    subject-path: "packages/node/package.tar.gz"
    sbom-path: "packages/node/package.cdx.json"
```

### 11. Update README

In `packages/node/README.md` > "Installation safety", after existing provenance text:

> A [CycloneDX][cyclonedx] SBOM is attested for every release artifact: per-target Rust SBOMs
> (derived from the `cargo-auditable` `.dep-v0` section embedded in each `.node.gz` binary) and a
> JS SBOM for the npm tarball. The SBOM lives inside the attestation predicate, retrievable via
> the [GitHub Attestations API][gh-attest]:
>
> ```bash
> gh attestation verify <artifact> --owner vadimpiven \
>   --predicate-type https://cyclonedx.org/bom \
>   --format json | jq '.[0].verificationResult.statement.predicate'
> ```

## Scope of impact

- **`regular.yaml`**: unchanged. All builds use `cargo auditable build` via `build:cargo`.
- **`release.yaml`**:
  - `build-addon`: two `mise run sbom:*` calls + Rust attestation (§6–8).
  - `build-packages`: `mise run sbom:js` + JS attestation (§9–10). Release upload unchanged.
  - `smoke-test`: unchanged. No post-publish SBOM job — build-time validations cover all
    pipeline failure modes; consumer-side `gh attestation verify` is exercised once in the
    dry-run checklist.
- **Local dev**: `mise run sbom:rust` after `pnpm -F packages/node run ci-build`; `mise run
  sbom:js` after `build:ts`.
- **node-addon-slsa**: unchanged.

## Consumer scenarios

### Verify any release artifact

```bash
gh attestation verify \
  node_reqwest-v1.2.3-linux-x64.node.gz \
  --owner vadimpiven \
  --predicate-type https://cyclonedx.org/bom
```

### Audit the binary you installed

```bash
# Reads .dep-v0 directly — no network, no API.
cargo audit bin node_modules/node-reqwest/dist/node_reqwest.node
```

### Bulk CVE response

CVE drops for `rustls@0.23.x`. Security team fetches each artifact's attestation, extracts the
SBOM predicate, greps the affected crate, identifies impacted installations — target-exact, no
false positives from features compiled out on their platform:

```bash
gh attestation verify <artifact> --owner vadimpiven \
  --predicate-type https://cyclonedx.org/bom \
  --format json \
  | jq '.[0].verificationResult.statement.predicate.components[]
        | select(.name == "rustls") | .version'
```

## Implementation order

Sections 1–11 are in commit order. §5 must land before §6–§10 (which reference its tasks);
otherwise sections are independent and can be split into per-commit PRs as preferred.

After each commit, `mise run check` must pass (Stop hook per `CLAUDE.md`). To validate the
workflow itself, push a release-candidate tag (`v0.0.0-rc1`) — `release.yaml` triggers on
`push: tags: v*` and accepts any tag pointing at a `main` commit (release.yaml:31-39).

## Dry-run checklist

Push `v0.0.0-rc1` and verify:

1. `.dep-v0` present in the binary across all 6 matrix targets (Linux x64/arm64 manylinux,
   macOS x64/arm64, Windows x64/arm64).
2. `mise run sbom:verify` succeeds on the signed+notarized binary — signing didn't strip
   `.dep-v0`.
3. `mise run sbom:rust` emits CycloneDX 1.6 with > 50 cargo-auditable components per target.
4. `actions/attest-sbom` attestations appear in the public transparency log.
5. `mise run sbom:js` output contains transitive deps — find resolved versions of indirect
   entries (e.g. transitive `undici` or `@types/*`) to confirm `pnpm-lock.yaml` shipped.
6. `gh attestation verify <artifact> --owner vadimpiven --predicate-type https://cyclonedx.org/bom
   --format json` succeeds for one `.node.gz` and the `package.tar.gz` — proves the consumer
   retrieval path. One-time design check; `actions/attest-sbom` already guarantees Sigstore
   inclusion per run.
7. `cargo audit bin` works on a notarized macOS `.node` extracted from `.node.gz` — proves the
   independent-audit path.

Rollback: `gh release delete v0.0.0-rc1 --cleanup-tag --yes`.

Syft and cargo-auditable pinned in `mise.toml` are picked up by the existing scheduled dependency
update workflow — no Renovate config changes.
