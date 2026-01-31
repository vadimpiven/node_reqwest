// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Module with build instructions to extract version tag or commit hash from git.

use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Context;
use anyhow::Result;

fn valid_git_repo() -> bool {
    matches!(Command::new("git").arg("status").status(), Ok(status) if status.success())
}

fn git_branch_show_current() -> Result<Option<String>> {
    let output = Command::new("git")
        .arg("branch")
        .arg("--show-current")
        .output()
        .context("Failed to run `git branch --show-current`")?;

    if !output.status.success() {
        return Ok(None);
    }

    let branch = String::from_utf8(output.stdout)
        .context("valid UTF-8")?
        .trim()
        .to_owned();

    if branch.is_empty() {
        Ok(None)
    } else {
        Ok(Some(branch))
    }
}

fn rerun_if_git_ref_changed() -> Result<()> {
    let git_dir = Path::new("..").join("..").join(".git");

    let head_path = git_dir.join("HEAD");
    if head_path.exists() {
        println!("cargo:rerun-if-changed={}", head_path.display());
    }

    if let Some(current_branch) = git_branch_show_current()? {
        let git_current_branch_ref = git_dir.join("refs").join("heads").join(current_branch);
        if git_current_branch_ref.exists() {
            println!(
                "cargo:rerun-if-changed={}",
                git_current_branch_ref.display()
            );
        }
    }

    let tags_path = git_dir.join("refs").join("tags");
    if tags_path.exists() {
        println!("cargo:rerun-if-changed={}", tags_path.display());
    }

    Ok(())
}

fn git_describe_tags() -> Result<Option<String>> {
    let output = Command::new("git")
        .arg("describe")
        .arg("--tags")
        .output()
        .context("Failed to run `git describe --tags`")?;

    if !output.status.success() {
        return Ok(None);
    }

    let tag = String::from_utf8(output.stdout)
        .context("valid UTF-8")?
        .trim()
        .to_owned();

    if tag.is_empty() {
        Ok(None)
    } else {
        Ok(Some(tag))
    }
}

fn git_rev_parse_commit_hash() -> Result<Option<String>> {
    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--short")
        .arg("HEAD^{commit}")
        .output()
        .context("Failed to run `git rev-parse --short HEAD^{commit}`")?;

    if !output.status.success() {
        return Ok(None);
    }

    let hash = String::from_utf8(output.stdout)
        .context("valid UTF-8")?
        .trim()
        .to_owned();

    if hash.is_empty() {
        Ok(None)
    } else {
        Ok(Some(hash))
    }
}

fn get_version() -> Result<String> {
    if valid_git_repo() {
        rerun_if_git_ref_changed()?;
        if let Some(tag) = git_describe_tags()? {
            return Ok(tag);
        }
        if let Some(hash) = git_rev_parse_commit_hash()? {
            return Ok(hash);
        }
    }
    Ok("undefined".to_owned())
}

fn main() -> Result<()> {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").context("OUT_DIR is set by cargo")?);
    fs::write(out_dir.join("version.txt"), get_version()?)?;
    Ok(())
}
