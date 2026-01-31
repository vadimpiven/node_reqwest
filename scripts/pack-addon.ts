// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import process from "node:process";
import { createGzip } from "node:zlib";
import { runScript } from "./helpers/run-script.ts";

interface PackageJson {
  version: string;
  binary: {
    moduleName: string;
    modulePath: string;
    packedName: string;
  };
}

function evalTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

runScript("Pack addon", async () => {
  const packageDir: string = process.cwd();

  const { version, binary }: PackageJson = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );

  const vars: Record<string, string> = {
    version,
    platform: process.platform,
    arch: process.arch,
  };

  const modulePath = join(packageDir, binary.modulePath);
  const binaryPath = join(modulePath, binary.moduleName);
  const packedName = evalTemplate(binary.packedName, vars);
  const packedFile = join(modulePath, packedName);

  console.log("Packing: %s", binaryPath);

  // Gzip the .node file
  await pipeline(
    createReadStream(binaryPath),
    createGzip({ level: 9 }),
    createWriteStream(packedFile),
  );

  console.log("Packed: %s", packedFile);
});
