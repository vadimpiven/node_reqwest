// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from 'node:process';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

const containerName = process.env.INPUT_NAME!;

async function cleanup(): Promise<void> {
  console.log('Cleanup the container: %s', containerName);
  // Ensure we don't fail if the container is already gone
  try {
    await runCommand('docker', ['stop', containerName]);
  } catch (error) {
    console.warn(`Failed to stop container (it might already be stopped): ${error}`);
  }
}

runScript('Docker cleanup', cleanup);
