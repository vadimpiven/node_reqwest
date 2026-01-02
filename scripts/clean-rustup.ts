// SPDX-License-Identifier: Apache-2.0 OR MIT

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

const execAsync = promisify(exec);

runScript('clean-rustup', async () => {
  const { stdout } = await execAsync('rustup toolchain list');
  const lines = stdout.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('(default)')) {
      continue;
    }

    // The toolchain name is the first part of the line
    const toolchain = trimmed.split(/\s+/)[0];
    if (toolchain) {
      await runCommand('rustup', ['toolchain', 'uninstall', toolchain]);
    }
  }
});
