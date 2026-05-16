# SBOM and Attestation

[cyclonedx]: https://cyclonedx.org/
[gh-attest]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations

## Goal

Ship a target-exact CycloneDX 1.6 SBOM with every release artifact, attested via the GitHub
Attestations API.

## Artifacts

| Artifact                 | Produced by                              | Contents              | SBOM source                         | Generator |
| ------------------------ | ---------------------------------------- | --------------------- | ----------------------------------- | --------- |
| `*.node.gz` (per target) | `build-addon` → `gh release upload`      | Compiled Rust binary  | `.dep-v0` section (cargo-auditable) | Syft      |
| `package.tar.gz`         | `build-packages` → `publish` (npm)       | JS only; no `.node`   | `pnpm-lock.yaml` (shipped)          | Syft      |

The `slsa` postinstall in the npm package fetches the matching `.node.gz` from the GitHub Release
at install time. Rust and JS live in different artifacts, so each gets its own SBOM attested to
its own subject — no merging, per-target Rust attribution preserved by construction.

Not covered: system libraries (none — rustls eliminates OpenSSL), build toolchain (rustc,
neon-build).

## Trust model

The attestation proves *this SBOM was produced in the same workflow that built the artifact*.
Combined with `.dep-v0`, it strengthens to *the SBOM reflects what the compiler embedded into the
binary at link time*. Tampering with the binary post-link breaks `cargo audit bin`; tampering with
the SBOM breaks attestation verification.

`.dep-v0` over `Cargo.lock`: feature flags and `[target.'cfg(...)']` deps vary per platform
(rustls vs schannel vs Security.framework), so a Cargo.lock-derived SBOM would be approximate.

## Implementation steps (commit order)

§5 must land before §6 (which references the mise tasks); otherwise the steps are independent and
can be split into per-commit PRs as preferred.

### 1. Install Syft via mise

```toml
# mise.toml — inline alongside existing aqua: pins (mise.toml:43-52)
"aqua:anchore/syft" = "1.44.0"  # latest stable 2026-05-01
```

- Pinned directly, not via `anchore/sbom-action` (lags Syft by 1–2 minors).
- Syft ≥ 1.15: `cargo-auditable-binary-cataloger` on by default.
- Syft ≥ 1.8: CycloneDX 1.6 by default.

### 2. Install cargo-auditable via mise

```toml
# mise.toml — add under [tools]
"cargo:cargo-auditable" = "0.7.4"
```

`cargo:` backend tries `cargo binstall` first (already pinned at `mise.toml:53`) and succeeds on
5 of 6 targets via upstream release binaries. Falls back to source build only on linux-arm64
inside the manylinux_2_28 container, where no compatible upstream binary exists (only gnu/glibc
2.39 is published; our base has glibc 2.28). The fallback is one small Rust compile cached by
mise — no Dockerfile changes needed.

### 3. Compile all builds with cargo-auditable

```jsonc
// packages/node/package.json — patch build:cargo (line 53)
"build:cargo": "cargo auditable build",
// ci-build (line 64) unchanged; -r --locked forward to cargo auditable build.
"ci-build": "pnpm run build:cargo -r --locked && pnpm run build:ts"
```

`build-addon` invokes `pnpm -F "{packages/node}" run ci-build` (release.yaml:86). cargo-auditable
delegates to `cargo build` and embeds `.dep-v0` post-link — ELF on Linux, Mach-O on macOS, PE on
Windows.

### 4. Ship pnpm-lock.yaml inside the npm tarball

Without the lockfile inside `package.tar.gz`, Syft's pnpm cataloger only sees direct deps from
`package.json`. `pnpm pack` resolves `files` relative to the package dir, so copy the root
lockfile in before pack. Use `shx` for a portable `cp` (the project has Windows dev runners; bare
`cp` breaks there).

```yaml
# pnpm-workspace.yaml — add to catalog: section (exact pin, per project convention)
shx: 0.4.0
```

```jsonc
// packages/node/package.json
"files": [
  "export/**/*",
  "export_dist/**/*",
  "pnpm-lock.yaml"
],
"devDependencies": {
  "shx": "catalog:"
  // ...existing entries
},
"scripts": {
  "build:ts": "vite build && typedoc && shx cp ../../pnpm-lock.yaml . && pnpm pack --out package.tar.gz"
  // ...
}
```

Add `packages/node/pnpm-lock.yaml` to `.gitignore` (transient copy; source of truth stays at repo
root).

### 5. Define mise SBOM tasks

All SBOM work lives in `mise.toml`. CI and local dev call the same tasks.

```toml
# mise.toml — all three tasks set shell="bash -c" because the jq filters use
# single-quoted args. mise on Windows defaults to cmd.exe, which doesn't strip
# single quotes, so the filter would reach jq with stray quotes. git-bash is
# available on GitHub Actions Windows runners and on any Git-for-Windows dev box.

# Exits non-zero if .dep-v0 missing.
[tasks."sbom:verify"]
description = "Check .dep-v0 is present in the built addon"
shell = "bash -c"
run = "cargo auditable info packages/node/dist/node_reqwest.node"

[tasks."sbom:rust"]
description = "Generate CycloneDX SBOM from the addon's .dep-v0 section"
depends = ["sbom:verify"]
shell = "bash -c"
run = [
  '''syft scan packages/node/dist/node_reqwest.node --override-default-catalogers cargo-auditable-binary-cataloger -o cyclonedx-json=packages/node/dist/node_reqwest.cdx.json''',
  '''jq -e '.bomFormat == "CycloneDX"' packages/node/dist/node_reqwest.cdx.json''',
  '''jq -e '[.components[]? | select(.properties[]?.value == "cargo-auditable-binary-cataloger")] | length > 50' packages/node/dist/node_reqwest.cdx.json''',
]

[tasks."sbom:js"]
description = "Generate CycloneDX SBOM from the packed npm tarball"
shell = "bash -c"
run = [
  '''syft scan packages/node/package.tar.gz -o cyclonedx-json=packages/node/package.cdx.json''',
  '''jq -e '.bomFormat == "CycloneDX"' packages/node/package.cdx.json''',
  '''jq -e '[.components[]? | select(.type == "library")] | length > 0' packages/node/package.cdx.json''',
]
```

Add `packages/node/dist/node_reqwest.cdx.json` and `packages/node/package.cdx.json` to
`.gitignore`.

- **Fixed paths in / out**: each matrix entry writes one SBOM in its own workspace; the attest
  step picks it up by literal name.
- **No host-target probing**: Syft reads `.dep-v0` from ELF / Mach-O / PE identically.
- **bash on all platforms**: `shell = "bash -c"` per task — uses git-bash on Windows.

### 6. Wire SBOM steps into `release.yaml`

Five new steps across two jobs. Each is a one-liner calling §5's tasks, or an `actions/attest-sbom`
invocation. Existing release-upload steps stay as-is — SBOMs live in the attestation predicate,
not as release assets.

```yaml
# build-addon: between "Sign and notarize" (release.yaml:87) and "Pack node addon" (:91).
# After sign+notarize ensures signing didn't strip .dep-v0.
- name: "Verify auditable metadata"
  shell: "bash"
  run: mise run sbom:verify

# build-addon: after "Pack node addon", before "Attest build provenance" (:96).
- name: "Generate Rust SBOM"
  shell: "bash"
  run: mise run sbom:rust

# build-addon: after "Attest build provenance".
# Per-matrix-entry: one subject, one predicate — attest-sbom's lack of stem-pairing is moot.
- name: "Attest Rust SBOM"
  uses: "actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e" # v4.1.0
  with:
    subject-path: "packages/node/dist/*.node.gz"
    sbom-path: "packages/node/dist/node_reqwest.cdx.json"

# build-packages: after "Build and pack node package", before "Attest node build provenance".
- name: "Generate JS SBOM"
  shell: "bash"
  run: mise run sbom:js

# build-packages: after "Attest node build provenance".
# Existing release upload (release.yaml:155-160) is unchanged.
- name: "Attest JS SBOM"
  uses: "actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e" # v4.1.0
  with:
    subject-path: "packages/node/package.tar.gz"
    sbom-path: "packages/node/package.cdx.json"
```

### 7. Update README

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

## Files touched

CI workflows:

- **`regular.yaml`**: unchanged. All builds use `cargo auditable build` via `build:cargo`.
- **`release.yaml`**:
  - `build-addon`: two `mise run sbom:*` calls + Rust attestation (§6).
  - `build-packages`: `mise run sbom:js` + JS attestation (§6). Release upload unchanged.
  - `smoke-test`: unchanged. No post-publish SBOM job — build-time validations cover all pipeline
    failure modes; consumer-side `gh attestation verify` is exercised once in the dry-run check.
- **`node-addon-slsa`**: unchanged.

Local dev: `mise run sbom:rust` after `pnpm -F packages/node run ci-build`; `mise run sbom:js`
after `build:ts`.

Renovate: Syft and cargo-auditable pinned in `mise.toml` are picked up by the existing scheduled
dependency update workflow — no config changes.

## Consumer scenarios

### Verify a release artifact

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

Pull the SBOM predicate from each artifact's attestation and grep for the affected crate —
target-exact, no platform-feature false positives.

```bash
gh attestation verify <artifact> --owner vadimpiven \
  --predicate-type https://cyclonedx.org/bom \
  --format json \
  | jq '.[0].verificationResult.statement.predicate.components[]
        | select(.name == "rustls") | .version'
```

## Dry-run checklist

`mise run check` must pass after each commit (Stop hook per `CLAUDE.md`). To validate the
workflow end-to-end, push a release-candidate tag (`v0.0.0-rc1`) — `release.yaml` triggers on
`push: tags: v*` and accepts any tag pointing at a `main` commit (release.yaml:31-39). Then
verify:

1. `.dep-v0` present in the binary across all 6 matrix targets (Linux x64/arm64 manylinux, macOS
   x64/arm64, Windows x64/arm64).
2. `mise run sbom:verify` succeeds on the signed+notarized binary — signing didn't strip
   `.dep-v0`.
3. `mise run sbom:rust` emits CycloneDX 1.6 with > 50 cargo-auditable components per target.
4. `actions/attest-sbom` attestations appear in the public transparency log.
5. `mise run sbom:js` output contains transitive deps — find resolved versions of indirect
   entries (e.g. transitive `undici` or `@types/*`) to confirm `pnpm-lock.yaml` shipped.
6. `gh attestation verify --predicate-type https://cyclonedx.org/bom --format json` succeeds for
   one `.node.gz` and the `package.tar.gz`.
7. `cargo audit bin` works on a notarized macOS `.node` extracted from `.node.gz`.

Rollback: `gh release delete v0.0.0-rc1 --cleanup-tag --yes`.
