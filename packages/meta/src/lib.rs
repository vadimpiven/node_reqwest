// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Module with the relevant metadata and helper methods for build.rs files.

use core::fmt;
use std::env::var;
use std::fs::{read_to_string, write};

use anyhow::{Context, Result};
use chrono::Datelike;
use tauri_winres::{VersionInfo, WindowsResource};

/// Git tag (release build) or commit hash (dev build), or "undefined" when no git context available.
pub const VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/version.txt"));

/// Structured semantic version parsed from VERSION, or None if VERSION is not a semantic version tag.
pub const SEMVER: Option<Version> = Version::parse(VERSION);

/// Semantic version structure
#[derive(Debug, Copy, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Version {
    /// Major version number
    pub major: u64,
    /// Minor version number  
    pub minor: u64,
    /// Patch version number
    pub patch: u64,
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Version {
    /// Create a new Version structure
    #[must_use]
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// Parse version in "vX.Y.Z" format from string slice
    #[must_use]
    const fn parse(s: &str) -> Option<Self> {
        let bytes = s.as_bytes();
        if bytes.len() < 6 || bytes[0] != b'v' {
            return None;
        }

        let mut offset = 1;
        let mut version = [0; 3];
        let mut segment = 0usize;

        while offset < bytes.len() && segment < 3 {
            if bytes[offset] == b'.' {
                segment += 1;
            } else if bytes[offset] < b'0' || bytes[offset] > b'9' {
                return None;
            } else {
                version[segment] = version[segment] * 10 + (bytes[offset] - b'0') as u64;
            }
            offset += 1;
        }

        if segment != 2 {
            return None;
        }

        Some(Version {
            major: version[0],
            minor: version[1],
            patch: version[2],
        })
    }
}

/// Override `package.json` version with the given version.
///
/// This implementation uses `serde_json` with the `preserve_order` feature to ensure that the
/// `package.json` file is updated without changing the order of entries or significantly
/// altering the formatting (it uses standard 2-space indentation).
pub fn npm_version(version: &Version) -> Result<()> {
    let path = "package.json";
    let content = read_to_string(path).context(format!("Failed to read {path}"))?;

    let mut json: serde_json::Value =
        serde_json::from_str(&content).context(format!("Failed to parse {path}"))?;

    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "version".to_string(),
            serde_json::Value::String(version.to_string()),
        );
    }

    let mut new_content =
        serde_json::to_string_pretty(&json).context(format!("Failed to serialize {path}"))?;
    new_content.push('\n');
    write(path, new_content).context(format!("Failed to write {path}"))?;

    Ok(())
}

/// Compile resource.rc file to resource.res file and add it to linker input as described in:
///
/// - <https://stackoverflow.com/questions/74509880/add-exe-file-details-to-binary-of-compiled-rust-code>
/// - <https://learn.microsoft.com/en-us/windows/win32/menurc/versioninfo-resource>
///
/// # Warning
///
/// Intended for use only in build.rs
pub fn cdylib_win_rc(product: &str, version: &Version, filename: &str) -> Result<()> {
    const ENGLISH_US: u16 = 0x0409;

    const VS_FFI_FILEFLAGSMASK: u64 = 0x0000_003F;
    const VOS_NT_WINDOWS32: u64 = 0x0004_0004;
    const VFT_DLL: u64 = 0x0000_0002;
    const VFT2_UNKNOWN: u64 = 0x0000_0000;

    if !cfg!(target_env = "msvc") {
        return Ok(());
    }

    let internal_name =
        var("CARGO_PKG_NAME").context("CARGO_PKG_NAME is set by cargo for build.rs")?;

    let version_hex = (version.major << 48) | (version.minor << 32) | (version.patch << 16);
    let version_str = format!("{}.{}.{}.0", version.major, version.minor, version.patch);

    let author = "Vadim Piven <vadim@piven.tech> (https://piven.tech)";
    let copyright = format!("Copyright © {} {}", chrono::Utc::now().year(), author);

    let mut res = WindowsResource::new();
    res.set_language(ENGLISH_US);

    res.set_version_info(VersionInfo::FILEVERSION, version_hex);
    res.set_version_info(VersionInfo::PRODUCTVERSION, version_hex);
    res.set_version_info(VersionInfo::FILEFLAGSMASK, VS_FFI_FILEFLAGSMASK);
    res.set_version_info(VersionInfo::FILEFLAGS, 0);
    res.set_version_info(VersionInfo::FILEOS, VOS_NT_WINDOWS32);
    res.set_version_info(VersionInfo::FILETYPE, VFT_DLL);
    res.set_version_info(VersionInfo::FILESUBTYPE, VFT2_UNKNOWN);

    res.set("CompanyName", author);
    res.set("LegalCopyright", &copyright);
    res.set("ProductName", product);
    res.set("FileDescription", product);
    res.set("InternalName", &internal_name);
    res.set("OriginalFilename", filename);
    res.set("ProductVersion", &version_str);
    res.set("FileVersion", &version_str);

    res.compile()
        .context("failed to compile windows resource")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::env::consts::ARCH;
    use std::env::set_var;

    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn version_formatting_test() {
        let version = Version::new(1, 0, 82);
        assert_eq!("1.0.82", version.to_string());
    }

    #[test]
    fn version_parsing_test() {
        // Valid semantic version tag
        let result = Version::parse("v1.0.82");
        assert_eq!(Some(Version::new(1, 0, 82)), result);

        // Git describe output with additional info (should fail)
        let result = Version::parse("v1.0.81-2-ge6a4f89");
        assert!(result.is_none());

        // Commit hash (should fail)
        let result = Version::parse("c24f925");
        assert!(result.is_none());
    }

    #[test]
    #[expect(unsafe_code)]
    fn cdylib_win_rc_test() -> Result<()> {
        let temp_dir = tempdir()?;
        // SAFETY: mocking environment variables for test execution.
        // This is required for `embed-resource` (used by `cdylib_win_rc`) to function correctly in the test
        // environment. Tests are run in separate processes by nextest, so there is no risk of race conditions.
        unsafe {
            set_var("HOST", format!("{ARCH}-pc-windows-msvc"));
            set_var("TARGET", format!("{ARCH}-pc-windows-msvc"));
            set_var("OUT_DIR", temp_dir.path());
        }

        let version = Version::new(1, 2, 3);
        cdylib_win_rc("TestProduct", &version, "test.dll")?;

        Ok(())
    }
}
