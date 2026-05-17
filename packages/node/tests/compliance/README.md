# Standards-compliance tests

We pin `external/undici` (a git submodule) at the same release as our
`peerDependencies.undici` range, and lift behavioral assertions from
undici's own dispatcher test suite to verify our Agent honors the
WHATWG / undici Dispatcher contract.

## What's exercised

`dispatcher-compliance.test.ts` is a curated mirror of the behavioral
assertions in `external/undici/test/node-test/client-dispatch.js`,
adapted to:

- import `Agent` from our package (not undici's),
- skip cases that probe undici-private symbols (`kRunning`, `kPending`,
  etc.) since those aren't part of the Dispatcher contract,
- skip CONNECT/upgrade — we document these as unsupported (see
  `packages/node/COMPATIBILITY.md`).

This complements `tests/contract/` which uses undici's *consumer* APIs
(`request`, `fetch`, `setGlobalDispatcher`) to validate that our Agent
plugs in where undici's own does.

## What we *don't* import directly

- **WPT (Web Platform Tests).** Adding `web-platform-tests/wpt` as a
  submodule pulls ~10 GB of WHATWG conformance fixtures. The same
  coverage is achieved transitively: when `setGlobalDispatcher(new Agent())`
  is set, `undici.fetch` (spec-compliant in JS) routes its transport
  through us — WPT against `undici.fetch` therefore also exercises our
  dispatcher. Wire-up scaffolding is in `wpt-runner.mjs` (TODO).
- **undici's full `test/node-test/`.** Most of those tests reach into
  undici-private symbols and would fail against any Dispatcher
  implementation other than undici's own.

## Bumping the pin

```sh
git -C external/undici fetch
git -C external/undici checkout v<NEXT_VERSION>
# Mirror the same version in `pnpm-workspace.yaml` catalog:.
git add external/undici pnpm-workspace.yaml
```
