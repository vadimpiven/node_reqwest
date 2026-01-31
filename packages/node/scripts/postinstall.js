// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

function evalTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageDir = join(__dirname, "..");

  const { name, version, binary } = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );

  const vars = {
    version,
    platform: process.platform,
    arch: process.arch,
  };

  const modulePath = join(packageDir, binary.modulePath);
  const binaryPath = join(modulePath, binary.moduleName);
  const remotePath = evalTemplate(binary.remotePath, vars);
  const packedName = evalTemplate(binary.packedName, vars);
  const downloadUrl = `${remotePath}${packedName}`;

  // Ensure target directory exists
  await mkdir(modulePath, { recursive: true });

  // Skip install for development version
  if (version === "0.0.0") return;

  console.log("[%s] Downloading: %s", name, downloadUrl);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  // Decompress gzipped .node file
  await pipeline(response.body, createGunzip(), createWriteStream(binaryPath, { mode: 0o755 }));

  console.log('[%s] Installed: "%s"', name, binaryPath);
}

process.on("unhandledRejection", (reason) => {
  console.error("Rejection at:", reason);
  process.exit(1);
});

main().catch((err) => {
  console.error("Postinstall failed:", err.message);
  process.exit(1);
});
