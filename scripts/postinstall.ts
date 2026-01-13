// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from 'node:process';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

runScript('postinstall', async () => {
  await runCommand('uv', ['sync', '--no-install-workspace']);

  await runCommand('mise', ['sync', 'python', '--uv']);

  await runCommand('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
    env: Object.fromEntries([
      ['CI', 'true'],
      ['HUSKY', '1']
    ])
  });

  if (!process.env.DEV_CONTAINER) {
    await runCommand('pnpm', ['exec', 'playwright', 'install-deps']);
  }
});
