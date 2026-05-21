// SPDX-License-Identifier: Apache-2.0 OR MIT

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./helpers/run-command.ts";
import { runScript } from "./helpers/run-script.ts";

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
  console.log(
    `[electron-install] before: path.txt=${existsSync(electronPathTxt)} dist=${existsSync(electronDist)}`,
  );
  if (!existsSync(electronPathTxt)) {
    await runCommand(process.execPath, [electronInstall]);
  }
  console.log(
    `[electron-install] after: path.txt=${existsSync(electronPathTxt)} dist=${existsSync(electronDist)}`,
  );

  const args = ["install", "cargo-auditable", "--locked"];
  const version = process.env["CARGO_AUDITABLE_VERSION"];
  if (version !== undefined && version !== "") {
    args.push("--version", version);
  }
  await runCommand("cargo", args);
});
