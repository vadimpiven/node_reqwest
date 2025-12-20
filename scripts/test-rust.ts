// SPDX-License-Identifier: Apache-2.0 OR MIT

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);

const command = 'cargo';
let commandArgs: string[];

if (process.platform === 'win32' && process.arch === 'arm64') {
  // Do not calculate coverage for arm64 on Windows
  // <https://github.com/taiki-e/cargo-llvm-cov/issues/436>
  commandArgs = ['nextest', 'run', '--no-tests', 'pass', ...args];
} else {
  commandArgs = ['llvm-cov', 'nextest', '--lcov', '--output-path', 'lcov.info', '--no-tests', 'pass', ...args];
}

console.log('> %s %s', command, commandArgs.join(' '));
const result = spawnSync(command, commandArgs, { stdio: 'inherit' });

if (result.status === 0 && commandArgs.includes('llvm-cov') && !args.includes('--no-report')) {
  commandArgs = ['llvm-cov', 'report'];
  console.log('> %s %s', command, commandArgs.join(' '));
  spawnSync(command, commandArgs, { stdio: 'inherit' });
}

if (result.status !== null && result.status !== 0) {
  process.exit(result.status);
} else if (result.error) {
  console.error(result.error);
  process.exit(1);
}
