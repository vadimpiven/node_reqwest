// SPDX-License-Identifier: Apache-2.0 OR MIT

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./helpers/run-command.ts";
import { runScript } from "./helpers/run-script.ts";

runScript("Workspace postinstall", async () => {
  if (process.env.MISE_ENV !== "docker") {
    await runCommand("playwright", ["install-deps"]);
  }

  // electron 42's bundled `install.js` is broken on Node 24 because its
  // unzipper (`extract-zip@2.0.1`) silently bails after extracting two
  // entries and resolves as if it succeeded. We sidestep it with
  // `scripts/install-electron.ts`, which re-uses electron's own
  // `@electron/get` to download the cached zip and then extracts with the
  // platform's native unzip tool.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const installElectron = path.join(here, "install-electron.ts");
  await runCommand(process.execPath, [installElectron]);

  const args = ["install", "cargo-auditable", "--locked"];
  const version = process.env["CARGO_AUDITABLE_VERSION"];
  if (version !== undefined && version !== "") {
    args.push("--version", version);
  }
  await runCommand("cargo", args);
});
