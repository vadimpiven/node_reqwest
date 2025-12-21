# Contributing to node_reqwest

## Development Basics

- **Package Manager**: Use **pnpm**. Do not use `npm` or `yarn`.
- **Testing**: Use `pnpm test` to run all checks (unit tests, doctests, and
  linter).

## Dependency Management

Keep all dependencies in the workspace root.

- **Node.js**: Use `pnpm-workspace.yaml` to define dependencies
  and refer to them as `catalog:` or `workspace:*` in `package.json`.
- **Rust**: Use `[workspace.dependencies]` to define dependencies in root `Cargo.toml`
  and refer to them as `dependency.workspace = true` in packages.

## Coding Standards

- **License Headers**: Every new source file must start with:
  `SPDX-License-Identifier: Apache-2.0 OR MIT`
- **Imports**: Keep `use` or `import` statements at the top of the module (not
  inside functions).
- **Assertions**: Always place the expected value first:
  `assert_eq!(expected, actual)`.

## Linting

Before submitting a pull request, ensure your code passes the project checks:

```bash
pnpm test
```
