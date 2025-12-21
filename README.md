![NPM Version](https://img.shields.io/npm/v/node-reqwest)
![GitHub branch status](https://img.shields.io/github/checks-status/vadimpiven/node_reqwest/main)
![Codecov](https://img.shields.io/codecov/c/github/vadimpiven/node_reqwest/main)

# node-reqwest

Node.js bindings for [reqwest](https://crates.io/crates/reqwest) - Rust
HTTP client library. This library provides support for system proxy and
trusted system CA certificates without additional configuration.
The build is made in a fashion that allows usage by Electron-based applications.

## Build requirements

- [pnpm](https://pnpm.io/installation) for workspace management
- [uv](https://docs.astral.sh/uv/getting-started/installation/) for python integration
- C++ development toolchain (required by Rust)
  - Windows: [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
  - macOS: `xcode-select --install`
  - Linux: preinstalled `g++`
- [Rust](https://www.rust-lang.org/tools/install) development toolchain
- [Cargo binstall](https://github.com/cargo-bins/cargo-binstall?tab=readme-ov-file#installation)
  for installing Rust binaries

## Build and test

```bash
pnpm install
pnpm test
```

VSCode [recommended extensions](.vscode/extensions.json) make development experience
better. Check VSCode [debug configurations](.vscode/launch.json) for debugging and
[tasks](.vscode/tasks.json) for performance analysis.
