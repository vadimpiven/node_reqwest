// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from "node:fs";
import { runCommand } from "./helpers/run-command.ts";
import { runScript } from "./helpers/run-script.ts";

const BINARY_PATH = "packages/node/dist/node_reqwest.node";
const SBOM_PATH = "packages/node/dist/node_reqwest.cdx.json";
const MIN_COMPONENTS = 50;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isAuditableComponent(c: unknown): boolean {
  if (!isRecord(c)) return false;
  if (!Array.isArray(c.properties)) return false;
  return c.properties.some((p) => isRecord(p) && p.value === "cargo-auditable-binary-cataloger");
}

runScript("Generate Rust SBOM", async () => {
  await runCommand("syft", [
    "scan",
    BINARY_PATH,
    "--override-default-catalogers",
    "cargo-auditable-binary-cataloger",
    "-o",
    `cyclonedx-json=${SBOM_PATH}`,
  ]);
  const raw: unknown = JSON.parse(await fs.promises.readFile(SBOM_PATH, "utf8"));
  const components: unknown[] =
    isRecord(raw) && Array.isArray(raw.components) ? raw.components : [];
  const count = components.filter(isAuditableComponent).length;
  if (count <= MIN_COMPONENTS) {
    throw new Error(
      `expected > ${MIN_COMPONENTS} cargo-auditable components in ${SBOM_PATH}, got ${count}`,
    );
  }
  console.log("OK: %d cargo-auditable components", count);
});
