// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Module with build instructions to set npm package version to equal git tag.

use anyhow::Result;
use meta::SEMVER;
use meta::cdylib_win_rc;
use neon_build::Setup;

fn main() -> Result<()> {
    const FILENAME: &str = "node_reqwest.node";
    Setup::options()
        .output_dir("dist")
        .output_file(FILENAME)
        .setup();

    let version = SEMVER.unwrap_or_default();
    cdylib_win_rc("Node Reqwest", &version, FILENAME)?;

    Ok(())
}
