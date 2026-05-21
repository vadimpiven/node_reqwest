// SPDX-License-Identifier: Apache-2.0 OR MIT

import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./helpers/run-command.ts";
import { runScript } from "./helpers/run-script.ts";

// Mirrors `getPlatformPath()` in electron's install.js — the value it writes
// to `path.txt` when its postinstall succeeds.
function electronPlatformPath(): string {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    default:
      return "electron";
  }
}

runScript("Workspace postinstall", async () => {
  if (process.env.MISE_ENV !== "docker") {
    await runCommand("playwright", ["install-deps"]);
  }

  // electron >=42 no longer ships a postinstall script in its tarball, and
  // pnpm 11 dropped the implicit "run install.js when name-prefixed bin
  // exists" behavior — so we trigger the binary download ourselves. Resolve
  // `electron/install.js` from packages/node (where electron is a dep) and
  // skip when `path.txt` already exists, since the script is idempotent but
  // re-fetches the archive every time.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const electronPkg = path.join(here, "..", "packages", "node", "package.json");
  const electronInstall = createRequire(electronPkg).resolve("electron/install.js");
  const electronDir = path.dirname(electronInstall);
  const electronPathTxt = path.join(electronDir, "path.txt");
  const electronDist = path.join(electronDir, "dist");
  const platformPath = electronPlatformPath();
  const electronBinary = path.join(electronDist, platformPath);
  if (!existsSync(electronPathTxt)) {
    // electron 42 + extract-zip 2.0.1 has two failure modes we have to
    // paper over:
    //   1) install.js exits 0 after extracting `dist/` but never writes
    //      `path.txt` (seen on CI macOS-15 — promise chain bails silently).
    //   2) install.js exits 1 with `EEXIST: ... symlink ...` when run
    //      against a partially-populated `dist/` (extract-zip can't
    //      reconcile symlinks on top of itself).
    // Treat both as "extracted, but path.txt absent" if the binary is
    // actually present on disk; write `path.txt` ourselves in that case.
    try {
      await runCommand(process.execPath, [electronInstall]);
    } catch (err) {
      if (!existsSync(electronBinary)) {
        throw err;
      }
      console.log(`[electron-install] install.js failed but ${electronBinary} exists — recovering`);
    }
  }
  if (!existsSync(electronPathTxt) && existsSync(electronBinary)) {
    writeFileSync(electronPathTxt, platformPath);
    console.log(`[electron-install] wrote missing path.txt -> ${platformPath}`);
  }
  if (!existsSync(electronPathTxt)) {
    throw new Error(
      `electron postinstall failed: ${electronPathTxt} missing and binary not found at ${electronBinary}`,
    );
  }

  const args = ["install", "cargo-auditable", "--locked"];
  const version = process.env["CARGO_AUDITABLE_VERSION"];
  if (version !== undefined && version !== "") {
    args.push("--version", version);
  }
  await runCommand("cargo", args);
});
