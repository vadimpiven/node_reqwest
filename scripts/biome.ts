// SPDX-License-Identifier: Apache-2.0 OR MIT

import path from 'node:path';
import process from 'node:process';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

runScript('biome', async () => {
  const isWindows = process.platform === 'win32';
  const biomePath = path.join(process.cwd(), '.path', isWindows ? 'biome.exe' : 'biome');
  await runCommand(biomePath, process.argv.slice(2));
});
