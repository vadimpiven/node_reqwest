// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Module with build instructions to set npm package version to equal git tag.

use std::fs::create_dir_all;

use anyhow::Result;
use meta::SEMVER;
use meta::cdylib_win_rc;
use neon_build::Setup;

fn main() -> Result<()> {
    const FILENAME: &str = "node_reqwest.node";
    create_dir_all("dist")?;
    Setup::options()
        .output_dir("dist")
        .output_file(FILENAME)
        .setup();

    let version = SEMVER.unwrap_or_default();
    cdylib_win_rc("Node Reqwest", &version, FILENAME)?;

    Ok(())
}
