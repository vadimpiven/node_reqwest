// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Standalone binary to update package.json version from git tag.

use meta::{SEMVER, npm_version};

fn main() {
    let version = SEMVER.unwrap_or_default();
    npm_version(&version);
}
