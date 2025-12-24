// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import gyp from '@mapbox/node-pre-gyp';
import type { Addon } from './addon-def.ts';

const nodeFileUrl = import.meta.url;
const nodeDirname = dirname(fileURLToPath(nodeFileUrl));
const nodeRequire = createRequire(nodeFileUrl);

const { find: findAddon } = gyp;

// Pre-gyp reads binary section from package.json and constructs a path to addon
// https://github.com/mapbox/node-pre-gyp/blob/a541932680034f5de9e7365ef8d9a0d7a11cc1a9/lib/package.js#L35
// Require calls dlopen under the hood
// https://nodejs.org/api/process.html#processdlopenmodule-filename-flags
// DLOpen then searches for napi_register_module_v1 in addon export table
// https://github.com/search?q=repo%3Anodejs%2Fnode%20NAPI_MODULE_INITIALIZER&type=code
// And neon exports napi_register_module_v1 from #[neon::main]
// https://github.com/neon-bindings/neon/blob/b1728fa21e968ccde9611ac9955cf6d638be16e6/crates/neon/src/context/internal.rs#L76
const Addon: Addon = nodeRequire(findAddon(resolve(nodeDirname, '../package.json')));

export { Addon };
