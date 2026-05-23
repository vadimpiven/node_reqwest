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
  }

  // electron >=42 no longer ships a postinstall hook. Trigger the binary
  // download here on every OS — otherwise it happens lazily inside the
  // Playwright `beforeEach`, where slow ARM runners exceed the 60 s
  // hook timeout. Resolved from packages/node since electron is its dep.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const electronInstall = createRequire(
    path.join(here, "..", "packages", "node", "package.json"),
  ).resolve("electron/install.js");
  await runCommand(process.execPath, [electronInstall]);

  const args = ["install", "cargo-auditable", "--locked"];
  const version = process.env["CARGO_AUDITABLE_VERSION"];
  if (version !== undefined && version !== "") {
    args.push("--version", version);
  }
  await runCommand("cargo", args);
});
