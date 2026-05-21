// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Stand-in for electron 42's broken `install.js`.
//!
//! `extract-zip@2.0.1` (electron's bundled unzipper) silently stops
//! processing entries on Node 24 for both `electron-darwin-arm64.zip`
//! and `electron-linux-*.zip`: it extracts the first two top-level
//! files (LICENSE, LICENSES.chromium.html), resolves the promise as if
//! it had succeeded, and `install.js` then writes neither the
//! `Electron.app` payload nor `path.txt`. This reproduces locally on
//! Node 24.16 and on every CI runner; it does not happen on Node 22.
//!
//! We side-step it by reusing electron's own `@electron/get` to fetch
//! (and cache) the zip, then shelling out to the platform's native
//! unzip tool, then writing `path.txt` ourselves with the value
//! electron's `getPlatformPath()` would have produced.

import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runCommand } from "./helpers/run-command.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const electronPkgJson = path.join(here, "..", "packages", "node", "package.json");
const requireFromElectronDep = createRequire(electronPkgJson);

const electronEntry = requireFromElectronDep.resolve("electron");
const electronDir = path.dirname(electronEntry);
// `@electron/get` is a runtime dep of `electron`, so it resolves through
// electron's own require — never from the workspace's top-level deps.
const electronInternalRequire = createRequire(path.join(electronDir, "package.json"));
const { downloadArtifact } = electronInternalRequire("@electron/get") as {
  downloadArtifact: (opts: {
    version: string;
    artifactName: string;
    platform: string;
    arch: string;
    checksums?: Record<string, { sha256: string }>;
  }) => Promise<string>;
};

interface ElectronPkg {
  readonly version: string;
}
const { version } = electronInternalRequire("./package.json") as ElectronPkg;
const checksums = electronInternalRequire("./checksums.json") as Record<string, { sha256: string }>;

function platformPathFor(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    default:
      return "electron";
  }
}

const platform = process.env.npm_config_platform ?? process.platform;
const arch = process.env.npm_config_arch ?? process.arch;
const distDir = path.join(electronDir, "dist");
const pathTxt = path.join(electronDir, "path.txt");
const platformPath = platformPathFor(platform as NodeJS.Platform);
const binaryPath = path.join(distDir, platformPath);

if (existsSync(binaryPath) && existsSync(pathTxt)) {
  console.log("[install-electron] already installed, skipping");
  process.exit(0);
}

console.log(`[install-electron] downloading electron ${version} (${platform}-${arch})`);
const zipPath = await downloadArtifact({
  version,
  artifactName: "electron",
  platform,
  arch,
  checksums,
});

// Wipe any partial `dist/` left by a previous failed extract-zip run;
// `unzip -o` overwrites files but won't reconcile pre-existing
// directories the way a fresh extract does.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

if (platform === "win32") {
  // PowerShell's `Expand-Archive` ships on every supported Windows.
  await runCommand("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${distDir}'`,
  ]);
} else {
  // `-o` overwrites, `-q` keeps the log quiet on the happy path.
  await runCommand("unzip", ["-oq", zipPath, "-d", distDir]);
}

if (!existsSync(binaryPath)) {
  throw new Error(`extracted archive but ${binaryPath} is still missing`);
}

writeFileSync(pathTxt, platformPath);
console.log(`[install-electron] wrote ${pathTxt} -> ${platformPath}`);
