// SPDX-License-Identifier: Apache-2.0 OR MIT

import { rm } from "node:fs/promises";

const filePath = process.env.INPUT_FILE_PATH!;

await rm(filePath, { force: true });
