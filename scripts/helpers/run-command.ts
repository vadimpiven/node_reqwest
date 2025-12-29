// SPDX-License-Identifier: Apache-2.0 OR MIT

import { spawn } from 'node:child_process';
import { ensureError } from './run-script.ts';

/**
 * Executes a command asynchronously, logs it, and handles errors/exit status.
 */
export async function runCommand(command: string, args: string[]): Promise<void> {
  console.log('> %s %s', command, args.join(' '));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });

    child.on('error', (err: unknown) => {
      const error = ensureError(err);
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`${command} failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
