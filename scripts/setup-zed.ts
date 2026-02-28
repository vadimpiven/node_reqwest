// SPDX-License-Identifier: Apache-2.0 OR MIT

import { runCommand } from "./helpers/run-command.ts";
import { runScript } from "./helpers/run-script.ts";

const extensions = [
  "html",
  "toml",
  "dockerfile",
  "docker-compose",
  "yaml",
  "basher",
  "editorconfig",
  "markdownlint",
  "ruff",
  "github-actions",
  "typos",
  "crates-lsp",
  "deputy",
];

runScript("Zed extensions setup", async () => {
  for (const ext of extensions) {
    await runCommand("zed", ["--install-extension", ext]);
  }
});
