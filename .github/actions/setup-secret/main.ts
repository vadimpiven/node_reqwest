// SPDX-License-Identifier: Apache-2.0 OR MIT

import { writeFile } from "node:fs/promises";

const filePath = process.env.INPUT_FILE_PATH!;
const fileText = process.env.INPUT_FILE_TEXT!;

await writeFile(filePath, fileText);
