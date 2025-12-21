// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { runCommand } from './helpers/run-command.ts';
import { ensureError, runScript } from './helpers/run-script.ts';

const packageDir = process.cwd();
const projectRoot = join(packageDir, '..', '..');

const isWindowsArm = process.platform === 'win32' && process.arch === 'arm64';

runScript('Test execution', async () => {
  const args = process.argv.slice(2);

  // Run tests and collect coverage data, but don't generate report yet
  // This preserves object files for subsequent report commands
  await runCommand('cargo', [
    'bin',
    'cargo-llvm-cov',
    'nextest',
    '--no-report',
    '--no-tests',
    'pass',
    ...args
  ]);

  // Copy junit report from target to package directory
  const junitSource = join(projectRoot, 'target', 'nextest', 'default', 'junit.xml');
  const junitDest = join(packageDir, 'report-rust.junit.xml');

  try {
    await fs.copyFile(junitSource, junitDest);
  } catch (err: unknown) {
    const error = ensureError(err);
    console.warn(`Warning: Could not copy junit report from ${junitSource}: ${error.message}`);
  }

  if (!isWindowsArm) {
    // Generate lcov report for CI
    await runCommand('cargo', [
      'bin',
      'cargo-llvm-cov',
      'report',
      '--lcov',
      '--output-path',
      'lcov.info',
      ...args
    ]);

    // Generate text report for developer review
    await runCommand('cargo', ['bin', 'cargo-llvm-cov', 'report', ...args]);
  }

  // Clean up object files
  await runCommand('cargo', ['bin', 'cargo-llvm-cov', 'clean', '--workspace']);
});
