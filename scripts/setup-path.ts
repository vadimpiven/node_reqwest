// SPDX-License-Identifier: Apache-2.0 OR MIT

import path from 'node:path';
import process from 'node:process';

import { makeSymlink } from './helpers/make-symlink.ts';

const projectRoot = process.cwd();
const pathDir = path.join(projectRoot, '.path');

const isWindows = process.platform === 'win32';

const nodePath = process.execPath;
const outputBin = path.join(pathDir, isWindows ? 'node.exe' : 'node');

await makeSymlink(nodePath, outputBin);
