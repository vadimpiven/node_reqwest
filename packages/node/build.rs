// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Module with build instructions to set npm package version to equal git tag.

use anyhow::Result;
use meta::{SEMVER, cdylib_win_rc};

fn main() -> Result<()> {
    let version = SEMVER.unwrap_or_default();
    cdylib_win_rc("Node Reqwest", &version, "node_reqwest.node")?;
    Ok(())
}
