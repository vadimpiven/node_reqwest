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

mise installs from upstream GitHub release binaries on every target where one exists. The single
gap is linux-arm64 inside the manylinux_2_28 build container — upstream's only arm64 Linux binary
is gnu/glibc 2.39, which won't execute on glibc 2.28. Handle that one case at image-build time
inside the Dockerfile so there's zero per-CI-run compile.

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
# linux-arm64: no manylinux-compatible upstream binary; installed via Dockerfile
```

Linux x86_64 uses the `musl` asset — static, runs in any container. macOS and Windows use native
binaries. No `linux-arm64` entry means mise skips installation on that target; the Dockerfile must
provide the binary.

In the project Dockerfile at the repo root, after the mise install block (Dockerfile:27-32), add a
step that installs cargo-auditable into the manylinux image. Run only on the arm64 build (the
x86_64 build picks it up from mise's musl asset; doing this for both arches is harmless but
unnecessary):

```dockerfile
# Dockerfile — after mise install, before user setup
RUN --mount=type=cache,target=/root/.cargo/registry \
    if [ "$(uname -m)" = "aarch64" ]; then \
      eval "$(mise activate bash)" && \
      cargo install cargo-auditable --version 0.7.4 --locked \
        --root /usr/local && \
      cargo-auditable --version; \
    fi
```

Single compile per image rebuild, cached in a Docker layer. Subsequent `docker build` runs reuse
the layer; CI runs see a pre-installed binary. Bump `--version` in lockstep with the mise.toml pin
when upgrading.

### 3. Compile all builds with cargo-auditable

```jsonc
// packages/node/package.json — patch build:cargo (currently line 53)
"build:cargo": "cargo auditable build",
// ci-build stays as-is (line 64); -r --locked are forwarded to cargo auditable build:
"ci-build": "pnpm run build:cargo -r --locked && pnpm run build:ts"
```

cargo-auditable is a thin wrapper that delegates to `cargo build` and embeds a compressed dep
manifest into a binary section — overhead is negligible, so dev and release builds use the same
command. `build-addon` invokes `pnpm -F "{packages/node}" run ci-build` (release.yaml:86);
cargo-auditable runs wherever that runs (host on macOS/Windows, manylinux Docker on Linux). PE
binaries on Windows get `.dep-v0` in a PE section, same mechanism as ELF/Mach-O.

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

All SBOM work — verify, generate, validate — lives in `mise.toml` as portable tasks. CI calls them
verbatim; local dev calls them verbatim. Same code path, same outputs, both platforms (bash,
PowerShell, git-bash on Windows runners).

```toml
# mise.toml

# Verify cargo-auditable embedded .dep-v0. Exits non-zero if missing.
[tasks."sbom:verify"]
description = "Check .dep-v0 is present in the built addon"
run = "cargo auditable info packages/node/dist/node_reqwest.node"

# Generate Rust SBOM from the addon binary (always at this fixed path post-build).
[tasks."sbom:rust"]
description = "Generate CycloneDX SBOM from the addon's .dep-v0 section"
depends = ["sbom:verify"]
run = [
  '''syft scan packages/node/dist/node_reqwest.node --override-default-catalogers cargo-auditable-binary-cataloger -o cyclonedx-json=packages/node/dist/node_reqwest.cdx.json''',
  '''jq -e '.bomFormat == "CycloneDX"' packages/node/dist/node_reqwest.cdx.json''',
  '''jq -e '[.components[]? | select(.properties[]?.value == "cargo-auditable-binary-cataloger")] | length > 50' packages/node/dist/node_reqwest.cdx.json''',
]

# Generate JS SBOM from the packed tarball (always at this fixed path post-pack).
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

Portability notes:

- Each `run` entry is a single command — no bash loops, no glob expansion, no host-target probing.
  The addon is always at `packages/node/dist/node_reqwest.node` regardless of target (Linux/macOS
  `.so/.dylib` get renamed to `.node` by the build); Syft reads `.dep-v0` from ELF / Mach-O / PE
  with the same invocation.
- TOML triple-single-quote literals carry jq filters unescaped.
- Output paths are fixed — no `${GITHUB_REF_NAME}` or per-target naming. Each matrix entry writes
  its own `node_reqwest.cdx.json` in its own runner workspace; the attest step picks it up by
  literal path.

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

Each matrix entry produces one `.node` (the source) and one `.cdx.json` (the SBOM) in its own
workspace.

### 8. Attest Rust SBOM in build-addon

```yaml
# New step after "Attest build provenance".
- name: "Attest Rust SBOM"
  uses: "actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e" # v4.1.0
  with:
    subject-path: "packages/node/dist/*.node.gz"
    sbom-path: "packages/node/dist/node_reqwest.cdx.json"
```

`actions/attest-sbom` loads one SBOM as predicate and attaches it to all matched subjects (no
stem-pairing). Per-matrix-entry, exactly one subject and one predicate.

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
# New step after "Attest node build provenance".
- name: "Attest JS SBOM"
  uses: "actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e" # v4.1.0
  with:
    subject-path: "packages/node/package.tar.gz"
    sbom-path: "packages/node/package.cdx.json"
```

Existing upload step in `build-packages` (release.yaml:155-160) is unchanged — SBOMs live in the
attestation predicate, not as separate release assets.

### 11. New job: smoke-sbom

Add a top-level job under `jobs:` in `release.yaml`, alongside the existing `smoke-test`
(release.yaml:203). Single-runner since SBOM/attestation verification doesn't depend on OS.

```yaml
smoke-sbom:
  name: "Smoke test SBOM"
  timeout-minutes: 5
  permissions:
    contents: "read"
  needs:
    - "publish"
  if: needs.publish.result == 'success'
  runs-on: "ubuntu-latest"
  steps:
    - name: "Download release artifacts"
      shell: "bash"
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        mkdir -p sbom-check && cd sbom-check
        gh release download "$GITHUB_REF_NAME" \
          --repo vadimpiven/node_reqwest \
          --pattern "*.node.gz" \
          --pattern "package.tar.gz"
    - name: "Verify attestation + extract SBOM"
      shell: "bash"
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        cd sbom-check
        for artifact in *.node.gz package.tar.gz; do
          # Verifies signature + transparency log inclusion, returns the
          # attestation bundle (which embeds the SBOM as its predicate).
          gh attestation verify "$artifact" \
            --owner vadimpiven \
            --predicate-type https://cyclonedx.org/bom \
            --format json > "${artifact}.attestation.json"
          # Extract the SBOM predicate and validate its shape.
          jq -e '.[0].verificationResult.statement.predicate.bomFormat == "CycloneDX"' \
            "${artifact}.attestation.json"
        done
```

`gh attestation verify` reads the public transparency log; default `contents: read` is sufficient.
`GITHUB_TOKEN` env is for rate limits only. The verify call returns the full attestation bundle
including the SBOM predicate — no separate SBOM download needed since the SBOM lives in the
attestation, not as a release asset.

### 12. Update README

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

- **`regular.yaml`**: unchanged in workflow logic. All builds (dev + CI) now go through
  `cargo auditable build` via `build:cargo` — negligible overhead, single code path.
- **`release.yaml`**:
  - `build-addon`: three `mise run sbom:*` calls (verify, rust) + Rust attestation (§6–8).
  - `build-packages`: lockfile bundling (§4) + `mise run sbom:js` + JS attestation (§9–10).
    Existing release upload unchanged — SBOMs live in the attestation predicate.
  - `smoke-sbom` (new): single-runner attestation verification + SBOM extraction (§11).
  - `smoke-test`: unchanged.
- **Local dev**: `mise run sbom:rust` (after `pnpm -F packages/node run ci-build`) produces a
  host-target SBOM. `mise run sbom:js` runs after `build:ts` produces the tarball.
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

Sections 1–12 are written in commit order:

- §1 + §2 (mise pins + Dockerfile bake) land first — subsequent CI changes assume the tools are
  installed.
- §3 (cargo-auditable in build:cargo) lands next — it's a one-line edit that all later sections
  depend on.
- §4 (ship lockfile) is independent of §3 but small — bundle either way.
- §5 (mise tasks) defines the building blocks. Must land before §6–§10 which reference them.
- §6 + §7 + §8 extend `build-addon` (verify, Rust SBOM gen, Rust attest).
- §9 + §10 extend `build-packages` (JS SBOM gen, JS attest).
- §11 adds the verification job.
- §12 (README) lands last.

After each set of CI changes, `mise run check` must pass (gate enforced by the Stop hook per
`CLAUDE.md`). To validate the actual workflow, push a release-candidate tag (e.g. `v0.0.0-rc1`) —
`release.yaml` triggers on `push: tags: v*` and the "Verify tag is on main" check
(release.yaml:31-39) accepts any tag pointing at a `main` commit.

## Dry-run checklist

Before the first real `v*` release tag, push a release-candidate tag and verify:

1. `build-addon` produces `.dep-v0` in the binary across all matrix targets (Linux x64/arm64
   manylinux, macOS x64/arm64, Windows x64/arm64).
2. `mise run sbom:verify` (§6) succeeds on the signed+notarized binary — confirms signing
   preserves `.dep-v0`.
3. `mise run sbom:rust` (§7) emits CycloneDX 1.6 with > 50 cargo-auditable components per target.
4. `actions/attest-sbom` attestations appear in the public transparency log.
5. `mise run sbom:js` output (§9) contains transitive deps — look for resolved versions of
   indirect entries (e.g. transitive `undici` or `@types/*`) to confirm `pnpm-lock.yaml` was
   bundled.
6. `smoke-sbom` (§11) passes end-to-end — attestation verifies AND the embedded SBOM predicate
   is well-formed CycloneDX.
7. `cargo audit bin` works on a notarized macOS `.node` extracted from `.node.gz` — confirms
   consumers can audit independently.

If anything fails: `gh release delete v0.0.0-rc1 --cleanup-tag --yes` and iterate.

## Notes

- **Dependency updates**: Syft and cargo-auditable pinned in `mise.toml` are picked up by the
  existing scheduled dependency update workflow. No Renovate config changes needed.
