// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Addon as AddonDef } from "./addon-def.ts";
import packageJson from "../package.json" with { type: "json" };

const nodeFileUrl: string = import.meta.url;
const nodeDirname: string = dirname(fileURLToPath(nodeFileUrl));
const nodeRequire: NodeJS.Require = createRequire(nodeFileUrl);

const binary = packageJson.binary;

// Resolve path to native addon (NAPI 8, requires Node.js 18+)
// Require calls dlopen under the hood
// https://nodejs.org/api/process.html#processdlopenmodule-filename-flags
// DLOpen then searches for napi_register_module_v1 in addon export table
// https://github.com/search?q=repo%3Anodejs%2Fnode%20NAPI_MODULE_INITIALIZER&type=code
// And neon exports napi_register_module_v1 from #[neon::main]
// https://github.com/neon-bindings/neon/blob/b1728fa21e968ccde9611ac9955cf6d638be16e6/crates/neon/src/context/internal.rs#L76
const addonPath = join(nodeDirname, "..", binary.modulePath, binary.moduleName);
const Addon: AddonDef = nodeRequire(addonPath);

export { Addon };
