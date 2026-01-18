// SPDX-License-Identifier: Apache-2.0 OR MIT

import { type FileHandle, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import FdLock from 'fd-lock';
import { runCommand } from './helpers/run-command.ts';
import { ensureError, runScript } from './helpers/run-script.ts';

const packageDir: string = process.cwd();
const projectRoot: string = join(dirname(fileURLToPath(import.meta.url)), '..');

// Check if running under mise (with cargo-nextest and cargo-llvm-cov available)
const miseActive: boolean = process.env.MISE_ACTIVE === '1';

// Linux binaries require new GLIBC, and there is no support for Windows ARM64
const skipCoverage: boolean = ['linux', 'win32'].includes(process.platform);

runScript('Nextest execution', async () => {
  const args = process.argv.slice(2);

  // If mise is not active, fall back to plain cargo test
  if (!miseActive) {
    return await runCommand('cargo', ['test', ...args]);
  }

  // Ensure lock file exists
  const lockPath: string = join(projectRoot, 'target', '.test-nextest.lock');
  const fileHandle: FileHandle = await open(lockPath, 'a+');
  const lock: FdLock = new FdLock(fileHandle.fd, { wait: true });

  await lock.ready();
  try {
    if (skipCoverage) {
      // Run tests directly without coverage
      await runCommand('cargo', ['nextest', 'run', '--no-tests', 'pass', ...args]);
    } else {
      // Run tests and collect coverage data, but don't generate report yet
      // This preserves object files for subsequent report commands
      await runCommand('cargo', ['llvm-cov', 'nextest', '--no-report', ...args]);
    }

    // Copy junit report from target to package directory
    const junitSource = join(projectRoot, 'target', 'nextest', 'default', 'junit.xml');
    const junitDest = join(packageDir, 'report-nextest.junit.xml');

    try {
      // Use fs from promises for copyFile
      const { copyFile } = await import('node:fs/promises');
      await copyFile(junitSource, junitDest);
    } catch (copyErr: unknown) {
      const error = ensureError(copyErr);
      console.warn(`Warning: Could not copy junit report from ${junitSource}: ${error.message}`);
    }

    if (!skipCoverage) {
      // Generate lcov report for CI
      await runCommand('cargo', [
        'llvm-cov',
        'report',
        '--lcov',
        '--output-path',
        'lcov.info',
        ...args
      ]);

      // Generate text report for developer review
      await runCommand('cargo', ['llvm-cov', 'report', ...args]);
    }
  } finally {
    // Unlock and close resource
    await lock.close();
  }
});
