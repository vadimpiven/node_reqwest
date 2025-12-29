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

  const isLinux = process.platform === 'linux';
  const noDisplay = isLinux && !process.env.DISPLAY;

  const command = noDisplay ? 'xvfb-run' : 'pnpm';
  const baseArgs = ['exec', 'playwright', 'test', '--pass-with-no-tests', ...args];
  const finalArgs = noDisplay ? ['--auto-servernum', '--', 'pnpm', ...baseArgs] : baseArgs;

  await runCommand(command, finalArgs);
});
