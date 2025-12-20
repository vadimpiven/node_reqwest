// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from 'node:process';
import { runCommand } from './run-command.ts';

const args = process.argv.slice(2);

if (process.platform === 'win32' && process.arch === 'arm64') {
  // cannot calculate coverage <https://github.com/taiki-e/cargo-llvm-cov/issues/436>
  args.push('--no-report');
}

await runCommand('cargo', [
  'llvm-cov',
  'nextest',
  '--lcov',
  '--output-path',
  'lcov.info',
  '--no-tests',
  'pass',
  ...args
]);
if (!args.includes('--no-report')) {
  await runCommand('cargo', ['llvm-cov', 'report']);
}
