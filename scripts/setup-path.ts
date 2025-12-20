// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const nodePath = process.execPath;
const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, '.path');
const outputBin = path.join(outputDir, isWindows ? 'node.exe' : 'node');

// Ensure the directory exists
try {
  fs.mkdirSync(outputDir, { recursive: true });
} catch (err) {
  console.error('Failed to create directory %s:', outputDir, err);
  process.exit(1);
}

// Remove existing symlink/file if it exists
if (fs.existsSync(outputBin)) {
  try {
    fs.unlinkSync(outputBin);
  } catch (err) {
    console.error('Failed to remove existing file %s:', outputBin, err);
    process.exit(1);
  }
}

// Create the symlink
try {
  // On Windows, 'file' argument is required for file symlinks
  fs.symlinkSync(nodePath, outputBin, isWindows ? 'file' : undefined);
  console.log('Symlinked node: %s -> %s', nodePath, outputBin);
} catch (err) {
  console.error('Failed to symlink node from %s to %s:', nodePath, outputBin, err);
  if (isWindows) {
    console.error(
      'On Windows, you may need to enable Developer Mode or run as Administrator to create symlinks.'
    );
  }
  process.exit(1);
}
