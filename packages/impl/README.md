# node-reqwest

Node.js bindings for [reqwest](https://crates.io/crates/reqwest) - Rust
HTTP client library. This library provides support for system proxy and
trusted system CA certificates without additional configuration.
The build is made in a fashion that allows usage by Electron-based applications.

## Install script

Warning: this package uses install script to download precompiled binary
for the correct OS and architecture. All the binaries get attached to GitHub
release. The releases are made immutable to prevent supply chain attacks.
