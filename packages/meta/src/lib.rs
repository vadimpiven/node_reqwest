//! Module with the relevant metadata and helper methods for build.rs files.

use std::{env, fmt, path::Path, process::Command};

use chrono::Datelike;
use indoc::formatdoc;
use tauri_winres::{VersionInfo, WindowsResource};

/// Git tag (release build) or commit hash (dev build), or "undefined" when no git context available.
pub const VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/version.txt"));

/// Structured semantic version parsed from VERSION, or None if VERSION is not a semantic version tag.
pub const SEMVER: Option<Version> = Version::parse(VERSION);

/// Semantic version structure
#[derive(Debug, Copy, Clone, Default, PartialEq, Eq)]
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

/// Override package.json version with the given version
pub fn npm_version(version: &Version) {
    let error = formatdoc! {"
        Failed to run
        `npm version {version}
            --allow-same-version --workspaces-update=false`",
        version = version
    };
    // npm must be executed on Windows using CMD and on Posix systems using Bash
    // https://github.com/jeronimosg/npm_rs/blob/80d7f99f82fea5bb53947c12575bb8a5834398ae/src/lib.rs#L48-L56
    // to not bother with this we let node properly execute the correct runner
    let node_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.path/node");
    Command::new(&node_path)
        .arg("-p")
        .arg(formatdoc! {"
            process.exit(
                require('child_process')
                    .spawnSync(
                        'npm',
                        [
                            'version',
                            '{version}',
                            '--allow-same-version',
                            '--workspaces-update=false'
                        ], {{
                            stdio: 'inherit',
                            shell: true,
                            encoding: 'utf-8'
                        }}
                    )
                    .status
            )",
            version = version
        })
        .status()
        .expect(&error)
        .success()
        .then_some(())
        .expect(&error);
}

/// Compile resource.rc file to resource.res file and add it to linker input as described in:
///
/// - <https://stackoverflow.com/questions/74509880/add-exe-file-details-to-binary-of-compiled-rust-code>
/// - <https://learn.microsoft.com/en-us/windows/win32/menurc/versioninfo-resource>
///
/// # Warning
///
/// Intended for use only in build.rs
pub fn cdylib_win_rc(product: &str, version: &Version, filename: &str) {
    const ENGLISH_US: u16 = 0x0409;

    const VS_FFI_FILEFLAGSMASK: u64 = 0x0000_003F;
    const VOS_NT_WINDOWS32: u64 = 0x0004_0004;
    const VFT_DLL: u64 = 0x0000_0002;
    const VFT2_UNKNOWN: u64 = 0x0000_0000;

    if !cfg!(target_env = "msvc") {
        return;
    }

    let internal_name =
        env::var("CARGO_PKG_NAME").expect("CARGO_PKG_NAME is set by cargo for build.rs");

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

    res.compile().expect("failed to compile windows resource");
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn version_parsing_test() {
        // Valid semantic version tag
        let result = Version::parse("v1.0.82");
        assert_eq!(
            Some(Version {
                major: 1,
                minor: 0,
                patch: 82
            }),
            result
        );

        // Git describe output with additional info (should fail)
        let result = Version::parse("v1.0.81-2-ge6a4f89");
        assert_eq!(None, result);

        // Commit hash (should fail)
        let result = Version::parse("c24f925");
        assert_eq!(None, result);
    }
}
