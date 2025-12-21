// SPDX-License-Identifier: Apache-2.0 OR MIT

import path from 'node:path';
import process from 'node:process';
import { makeSymlink } from './helpers/make-symlink.ts';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

const projectRoot = process.cwd();
const pathDir = path.join(projectRoot, '.path');

const isWindows = process.platform === 'win32';

runScript('Setup path', async () => {
  const nodePath = process.execPath;
  const outputBin = path.join(pathDir, isWindows ? 'node.exe' : 'node');
  await makeSymlink(nodePath, outputBin);

  await runCommand('uv', ['sync', '--no-install-workspace']);

  const venvPythonPath = path.join(
    projectRoot,
    '.venv',
    isWindows ? 'Scripts' : 'bin',
    isWindows ? 'python.exe' : 'python'
  );
  const pythonInPath = path.join(pathDir, isWindows ? 'python.exe' : 'python');
  await makeSymlink(venvPythonPath, pythonInPath);
});
