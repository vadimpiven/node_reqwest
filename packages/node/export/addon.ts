// SPDX-License-Identifier: Apache-2.0 OR MIT

import { requireAddon } from "node-addon-slsa";
import type { Addon as AddonDef } from "./addon-def.ts";

const Addon = await requireAddon<AddonDef>({ from: import.meta.url });

export { Addon };
