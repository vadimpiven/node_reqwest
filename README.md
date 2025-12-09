# node-reqwest

Node.js bindings for reqwest - Rust HTTP client library

## Build requirements

- [pnpm](https://pnpm.io/installation) for workspace management
- C++ development toolchain (required by Rust)
  - Windows: [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
  - macOS: `xcode-select --install`
  - Linux: preinstalled `g++`
- [Rust](https://www.rust-lang.org/tools/install) development toolchain
- [Cargo binstall](https://github.com/cargo-bins/cargo-binstall?tab=readme-ov-file#installation) for installing Rust binaries

## Build and test

```bash
pnpm install
pnpm run rustup
pnpm run dev-test
```
