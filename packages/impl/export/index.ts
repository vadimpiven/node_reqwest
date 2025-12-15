// SPDX-License-Identifier: Apache-2.0 OR MIT

import { AddonSymbol } from './addon.ts';

export function hello(): string {
  return AddonSymbol.hello();
}
