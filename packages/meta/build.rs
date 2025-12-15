// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Module with build instructions to extract version tag or commit hash from git.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};

fn valid_git_repo() -> bool {
    matches!(Command::new("git").arg("status").status(), Ok(status) if status.success())
}

fn git_branch_show_current() -> Option<String> {
    let output = Command::new("git")
        .arg("branch")
        .arg("--show-current")
        .output()
        .expect("Failed to run `git branch --show-current`");
    output
        .status
        .success()
        .then_some(
            String::from_utf8(output.stdout)
                .expect("valid UTF-8")
                .trim()
                .to_owned(),
        )
        .and_then(|output| (!output.is_empty()).then_some(output))
}

fn rerun_if_git_ref_changed() {
    let git_dir = Path::new("..").join("..").join(".git");

    let head_path = git_dir.join("HEAD");
    if head_path.exists() {
        println!("cargo:rerun-if-changed={}", head_path.display());
    }

    if let Some(current_branch) = git_branch_show_current() {
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
}

fn git_describe_tags() -> Option<String> {
    let output = Command::new("git")
        .arg("describe")
        .arg("--tags")
        .output()
        .expect("Failed to run `git describe --tags`");
    output
        .status
        .success()
        .then_some(
            String::from_utf8(output.stdout)
                .expect("valid UTF-8")
                .trim()
                .to_owned(),
        )
        .and_then(|output| (!output.is_empty()).then_some(output))
}

fn git_rev_parse_commit_hash() -> Option<String> {
    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--short")
        .arg("HEAD^{commit}")
        .output()
        .expect("Failed to run `git rev-parse --short HEAD^{commit}`");
    output
        .status
        .success()
        .then_some(
            String::from_utf8(output.stdout)
                .expect("valid UTF-8")
                .trim()
                .to_owned(),
        )
        .and_then(|output| (!output.is_empty()).then_some(output))
}

fn get_version() -> String {
    if valid_git_repo() {
        rerun_if_git_ref_changed();
        if let Some(tag) = git_describe_tags() {
            return tag;
        }
        if let Some(hash) = git_rev_parse_commit_hash() {
            return hash;
        }
    }
    "undefined".to_owned()
}

fn main() -> Result<()> {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").context("OUT_DIR is set by cargo")?);
    fs::write(out_dir.join("version.txt"), get_version())?;
    Ok(())
}
