// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from 'node:process';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

runScript('postinstall', async () => {
  await runCommand('uv', ['sync']);
  await runCommand('mise', ['sync', 'python', '--uv']);

  if (process.env.MISE_ENV !== 'docker') {
    await runCommand('pnpm', ['exec', 'playwright', 'install-deps']);
  }
});
