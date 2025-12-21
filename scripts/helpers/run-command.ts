// SPDX-License-Identifier: Apache-2.0 OR MIT

import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Executes a command asynchronously, logs it, and handles errors/exit status.
 */
export async function runCommand(command: string, args: string[]): Promise<void> {
  console.log('> %s %s', command, args.join(' '));
  const child = spawn(command, args, { stdio: 'inherit' });

  const [code] = await once(child, 'close');
  if (code !== 0 && code !== null) {
    throw new Error(`${command} failed with exit code ${code}`);
  }
}
