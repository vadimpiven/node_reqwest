// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Tests for `npm_version` binary.

use std::fs::{File, read_to_string};
use std::io::Write;
use std::process::Command;

use anyhow::{Context, Result};
use indoc::{formatdoc, indoc};
use meta::SEMVER;
use pretty_assertions::assert_eq;
use tempfile::tempdir;
use with_dir::WithDir;

fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").trim().to_string()
}

#[test]
fn npm_version_test() -> Result<()> {
    let dir = tempdir()?;
    let dir_path = dir.path();
    let package_json_path = dir_path.join("package.json");
    let version = meta::Version {
        major: 1,
        minor: 2,
        patch: 3,
    };

    let initial_content = indoc! {r#"
        {
          "name": "test-package",
          "version": "0.0.0"
        }
    "#};
    File::create(&package_json_path)?.write_all(initial_content.as_bytes())?;
    assert_eq!(
        normalize_newlines(initial_content),
        normalize_newlines(&read_to_string(&package_json_path)?)
    );

    WithDir::new(dir_path)
        .map(|_| meta::npm_version(&version))
        .context(format!(
            "failed to switch workdir to {}",
            dir_path.display()
        ))??;

    let expected_content = indoc! {r#"
        {
          "name": "test-package",
          "version": "1.2.3"
        }
    "#};
    assert_eq!(
        normalize_newlines(expected_content),
        normalize_newlines(&read_to_string(&package_json_path)?)
    );

    Ok(())
}

#[test]
fn npm_version_binary_test() -> Result<()> {
    let dir = tempdir()?;
    let dir_path = dir.path();
    let package_json_path = dir_path.join("package.json");

    let version = SEMVER.unwrap_or_default();
    let initial_content = formatdoc! {r#"
        {{
          "name": "test-package",
          "version": "{version}"
        }}
    "#, version = version};

    File::create(&package_json_path)?.write_all(initial_content.as_bytes())?;
    assert_eq!(
        normalize_newlines(&initial_content),
        normalize_newlines(&read_to_string(&package_json_path)?)
    );

    let status = Command::new(env!("CARGO_BIN_EXE_npm_version"))
        .current_dir(dir_path)
        .status()?;
    assert!(status.success());

    assert_eq!(
        normalize_newlines(&initial_content),
        normalize_newlines(&read_to_string(&package_json_path)?)
    );

    Ok(())
}
