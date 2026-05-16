// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./helpers/run-command.ts";
import { runScript } from "./helpers/run-script.ts";

runScript("Workspace postinstall", async () => {
  if (process.env.MISE_ENV !== "docker") {
    await runCommand("playwright", ["install-deps"]);
  } else {
    // electron >=42 no longer ships a postinstall hook, so trigger the
    // binary download here while pnpm install still has network access.
    // electron is a dep of packages/node, so resolve from that workspace.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const electronInstall = createRequire(
      path.join(here, "..", "packages", "node", "package.json"),
    ).resolve("electron/install.js");
    await runCommand(process.execPath, [electronInstall]);
  }

  const args = ["install", "cargo-auditable", "--locked"];
  const version = process.env["CARGO_AUDITABLE_VERSION"];
  if (version !== undefined && version !== "") {
    args.push("--version", version);
  }
  await runCommand("cargo", args);
});
