# SLSA Binary Provenance Verification

Verifies that an npm package and its prebuilt native binary were
produced by the same GitHub Actions workflow run. Uses
[sigstore][sigstore] provenance attestations and the
[GitHub Attestations API][gh-attestations].

[sigstore]: https://www.sigstore.dev/
[gh-attestations]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds

On `npm install`, the `slsa wget` postinstall hook:

1. Verifies npm package provenance via sigstore (Fulcio CA chain,
   tlog inclusion proof, SET, signature)
2. Extracts the workflow Run Invocation URI from the Fulcio
   certificate
3. Downloads the gzip-compressed native binary from a GitHub release
4. Verifies the binary's GitHub attestation was signed by the same
   workflow run
5. Decompresses and installs the binary

Installation aborts with a `SECURITY` error if any step fails.

## Setup

Node.js `^20.19.0 || >=22.12.0`. The npm package must be published
with `--provenance`. The binary must be attested with
[`actions/attest-build-provenance`][attest-action].

[attest-action]: https://github.com/actions/attest-build-provenance

### package.json

`addon.url` supports `{version}`, `{platform}`, `{arch}` placeholders.
`addon.path` must be a relative path within the package directory.

```json
{
    "name": "my-native-addon",
    "version": "1.0.0",
    "repository": {
        "url": "git+https://github.com/owner/repo.git"
    },
    "addon": {
        "path": "./dist/my_addon.node",
        "url": "https://github.com/owner/repo/releases/download/v{version}/my_addon-v{version}-{platform}-{arch}.node.gz"
    },
    "scripts": {
        "postinstall": "slsa wget"
    },
    "dependencies": {
        "@node-reqwest/slsa": "^1.0.0"
    }
}
```

### CI workflow

```yaml
jobs:
    build:
        runs-on: ubuntu-latest
        permissions:
            id-token: write
            contents: write
            attestations: write
        steps:
            - uses: actions/checkout@v6
            - run: npm run build
            - run: npx slsa pack
            - uses: actions/attest-build-provenance@v4
              with:
                  subject-path: dist/my_addon-v*.node.gz
            - run: gh release upload "$TAG" dist/my_addon-v*.node.gz

    publish:
        needs: build
        runs-on: ubuntu-latest
        permissions:
            id-token: write
        steps:
            - run: npm publish --provenance --access public
```

## CLI

| Command     | Purpose                                            |
| ----------- | -------------------------------------------------- |
| `slsa wget` | Download, verify, and install the native binary    |
| `slsa pack` | Gzip-compress the native binary for release upload |

Both read `addon` config from `package.json` in the working directory.

## Security model

| Threat                  | Mitigation                                            |
| ----------------------- | ----------------------------------------------------- |
| Tampered npm package    | sigstore verification (Fulcio chain, tlog, SET, SCTs) |
| Tampered GitHub release | GitHub Attestations API + sigstore verification       |

## License

Apache-2.0 OR MIT
