// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from 'node:process';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

interface DockerEnv {
  [key: string]: string;
}

async function main(): Promise<void> {
  const image = process.env.INPUT_IMAGE!;
  const name = process.env.INPUT_NAME!;
  const user = process.env.INPUT_USER!;
  const workspace = process.env.INPUT_WORKSPACE!;
  const envJson = process.env.INPUT_ENV!;

  const home = process.env.HOME || '';
  const ghaWorkspace = process.env.GITHUB_WORKSPACE || '';

  if (!image || !user || !workspace || !ghaWorkspace) {
    throw new Error('Missing required environment variables');
  }

  const env: DockerEnv = JSON.parse(envJson);

  const dockerArgs: string[] = [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-v',
    `${home}/.cache/uv:/home/${user}/.cache/uv`,
    '-v',
    `${home}/.pnpm-store:/home/${user}/.pnpm-store`,
    '-v',
    `${home}/.cache/sccache:/home/${user}/.cache/sccache`,
    '-v',
    `${home}/.cargo/bin:/home/${user}/.cargo/bin`,
    '-v',
    `${ghaWorkspace}:${workspace}`,
    '-w',
    workspace,
    '-e',
    `SCCACHE_DIR=/home/${user}/.cache/sccache`
  ];

  for (const [key, value] of Object.entries(env)) {
    if (key !== 'SCCACHE_DIR') {
      dockerArgs.push('-e', `${key}=${value}`);
    }
  }

  dockerArgs.push(image, 'sleep', 'infinity');

  await runCommand('docker', dockerArgs);
}

runScript('Docker startup', main);
