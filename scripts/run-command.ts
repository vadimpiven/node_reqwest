// SPDX-License-Identifier: Apache-2.0 OR MIT

import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Executes a command asynchronously, logs it, and handles errors/exit status.
 */
export async function runCommand(command: string, args: string[]): Promise<void> {
  console.log('> %s %s', command, args.join(' '));
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });

    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error('%s failed with exit code %d', command, code);
        process.exit(code);
      }
      resolve();
    });

    child.on('error', (err) => {
      console.error(err);
      process.exit(1);
    });
  });
}
