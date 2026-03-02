#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const distIndex = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

try {
  await access(distIndex);
} catch {
  // dist/index.js has not been built yet; skip silently.
  process.exit(0);
}

const { runSlsa } = await import("../dist/index.js");
runSlsa();
