# Contributing to node_reqwest

## Quick Start

The only prerequisite is
[mise](https://mise.jdx.dev/getting-started.html).
It manages Node.js, Rust, Python, pnpm, and all other tooling
automatically.

```bash
git clone https://github.com/vadimpiven/node_reqwest.git
cd node_reqwest
mise trust       # approve the mise.toml config
mise install     # install all tools defined in mise.toml
mise run test    # auto-fix, build, type-check, run all tests
```

`--force` bypasses mise task caching to ensure a clean run:

```bash
mise run --force test
```

## Dependency Management

Keep all dependencies in the workspace root.

- **Node.js**: Use `pnpm-workspace.yaml` to define dependencies
  and refer to them as `catalog:` or `workspace:*` in
  `package.json`.
- **Rust**: Use `[workspace.dependencies]` to define dependencies
  in root `Cargo.toml` and refer to them as
  `dependency.workspace = true` in packages.

## Coding Standards

- **License Headers**: Every new source file must start with:
  `SPDX-License-Identifier: Apache-2.0 OR MIT`
- **Imports**: Keep `use` or `import` statements at the top of
  the module (not inside functions). Use the `node:` prefix for
  Node.js built-in imports
  (`import { readFile } from "node:fs/promises"`).
- **Assertions**: Always place the expected value first:
  `assert_eq!(expected, actual)`.
- **Type Declarations (TypeScript)**: Extract complex inline
  types into named `type` aliases. Prefer
  `type Foo = (x: string) => void` over inline
  `const fn: (x: string) => void = ...`.
- **Formatting**: Run `mise run fix` to auto-format all files.
- **Dependencies**: Pin exact versions in `pnpm-workspace.yaml`
  (no `^` or `~`) and reference them as `catalog:` in
  `package.json`.

## Submitting Changes

1. For new features or architectural changes, open an issue
   first.
2. Fork the repository and create a branch from `main`.
3. Run the full suite before submitting:

   ```bash
   mise run --force test
   ```

4. Open a pull request against `main`. Describe what changed
   and why, and link to the related issue.

## Reporting Issues

<https://github.com/vadimpiven/node_reqwest/issues>

Include reproduction steps, Node.js version (`node -v`), and
OS.

## License

Contributions are licensed under Apache-2.0 OR MIT
([Apache-2.0](LICENSE-APACHE.txt), [MIT](LICENSE-MIT.txt)).
