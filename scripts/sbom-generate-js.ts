// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./helpers/run-command.ts";
import { runScript } from "./helpers/run-script.ts";

const SBOM_PATH = "packages/node/package.cdx.json";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isLibraryComponent(c: unknown): boolean {
  return isRecord(c) && c.type === "library";
}

runScript("Generate JS SBOM", async () => {
  // Resolve only node-reqwest's prod-dep closure into a fresh temp dir so
  // Syft enumerates the package's runtime deps (not the whole workspace
  // lockfile's monorepo + tooling deps).
  await using deployDir = await fs.promises.mkdtempDisposable(
    path.join(os.tmpdir(), "sbom-deploy-"),
  );
  await runCommand("pnpm", [
    "deploy",
    "--filter",
    "node-reqwest",
    "--prod",
    "--legacy",
    // Skip lifecycle scripts: node-reqwest's postinstall (`slsa wget`)
    // would try to fetch the .node binary from registry.npmjs.org, which
    // is unreachable from the restricted-network CI build container.
    // SBOM generation only needs the resolved dep tree.
    "--ignore-scripts",
    deployDir.path,
  ]);
  await runCommand("syft", [
    "scan",
    `dir:${deployDir.path}`,
    // npm catalogers only — drop binary/file catalogers (which add noisy
    // file-type components for the package.json files themselves).
    "--override-default-catalogers",
    "javascript-package-cataloger,javascript-lock-cataloger",
    "--select-catalogers",
    "-file",
    "-o",
    `cyclonedx-json=${SBOM_PATH}`,
  ]);
  const raw: unknown = JSON.parse(await fs.promises.readFile(SBOM_PATH, "utf8"));
  const components: unknown[] =
    isRecord(raw) && Array.isArray(raw.components) ? raw.components : [];
  const libraries = components.filter(isLibraryComponent);
  if (libraries.length === 0) {
    throw new Error(`expected > 0 library components in ${SBOM_PATH}, got 0`);
  }
  console.log("OK: %d library components", libraries.length);
});
