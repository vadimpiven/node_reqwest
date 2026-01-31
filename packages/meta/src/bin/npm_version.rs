// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Standalone binary to update package.json version from git tag.

use anyhow::Result;
use meta::SEMVER;
use meta::npm_version;

fn main() -> Result<()> {
    let version = SEMVER.unwrap_or_default();
    npm_version(&version)?;
    Ok(())
}
