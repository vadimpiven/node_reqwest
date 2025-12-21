// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from 'node:process';

/**
 * Wraps an unknown error into a proper Error object.
 */
export function ensureError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

/**
 * Logs an error with a specific prefix and exits the process.
 */
export function handleError(prefix: string, err: unknown): never {
  const error = ensureError(err);
  console.error('%s: %s', prefix, error.message);
  process.exit(1);
}

/**
 * Runs a script's main function with standard error handling and rejection tracking.
 */
export function runScript(name: string, fn: () => Promise<void>): void {
  process.on('unhandledRejection', (reason) => {
    handleError('Rejection at', reason);
  });

  fn().catch((err: unknown) => {
    handleError(`${name} failed`, err);
  });
}
