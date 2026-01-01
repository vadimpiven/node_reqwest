// SPDX-License-Identifier: Apache-2.0 OR MIT

import { spawn } from 'node:child_process';
import { ensureError } from './run-script.ts';

/**
 * Run an external command with the given arguments and log its invocation.
 *
 * @param command - The executable name or path to run
 * @param args - Arguments to pass to the command
 * @returns Resolves when the process exits with code 0; rejects with an `Error` if the process fails to start or exits with a non-zero exit code
 */
export async function runCommand(command: string, args: string[]): Promise<void> {
  console.log('> %s %s', command, args.join(' '));

  return new Promise((resolve, reject) => {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true, javascript.lang.security.detect-child-process.detect-child-process
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