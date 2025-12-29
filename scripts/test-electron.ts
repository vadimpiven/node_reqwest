// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from 'node:process';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

runScript('Electron tests', async () => {
  const args = process.argv.slice(2);

  // Ensure ELECTRON_RUN_AS_NODE is unset for Electron tests.
  // When set (e.g., to '1'), Electron behaves as a regular Node process
  // and fails to provide Electron-specific APIs like 'app' and 'BrowserWindow'.
  delete process.env.ELECTRON_RUN_AS_NODE;

  await runCommand('pnpm', ['exec', 'playwright', 'test', '--pass-with-no-tests', ...args]);
});
