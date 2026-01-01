// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeSymlink } from './helpers/make-symlink.ts';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

const projectRoot = process.cwd();
const pathDir = path.join(projectRoot, '.path');
const binDir = path.join(projectRoot, '.bin');

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/**
 * Ensures the cargo "bin" toolchain is available and prepares the repository .bin directory for the current platform and architecture.
 *
 * If the platform/arch marker is missing, the existing .bin directory is removed. The function verifies whether `cargo bin` is available and installs `cargo-run-bin` if it is not, runs the cargo bin installer, creates the `.bin` directory, and writes an empty marker file named `.<platform>-<arch>` inside it.
 */
async function setupCargoBin(): Promise<void> {
  const markerFile = `.${process.platform}-${os.arch()}`;
  const markerPath = path.join(binDir, markerFile);

  const markerExists = await fs
    .access(markerPath)
    .then(() => true)
    .catch(() => false);

  if (!markerExists) {
    await fs.rm(binDir, { recursive: true, force: true });
  }

  // Install cargo-run-bin only if not already available (e.g., restored from cache)
  try {
    await runCommand('cargo', ['bin', '--version']);
  } catch {
    await runCommand('cargo', ['binstall', 'cargo-run-bin', '-y', '--locked']);
  }

  await runCommand('cargo', ['bin', '--install']);
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(markerPath, '');
}

async function setupNodeSymlink(): Promise<void> {
  const nodePath = process.execPath;
  const outputBin = path.join(pathDir, isWindows ? 'node.exe' : 'node');
  await makeSymlink(nodePath, outputBin);
}

async function setupPythonVenv(): Promise<void> {
  await runCommand('uv', ['sync', '--no-install-workspace']);

  const venvPythonPath = path.join(
    projectRoot,
    '.venv',
    isWindows ? 'Scripts' : 'bin',
    isWindows ? 'python.exe' : 'python'
  );
  const pythonInPath = path.join(pathDir, isWindows ? 'python.exe' : 'python');
  await makeSymlink(venvPythonPath, pythonInPath);
}

async function setupBiomeSymlink(): Promise<void> {
  // Map platform/arch to package name
  // Linux uses musl variants for glibc 2.28 compatibility
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  let packageName: string;

  if (isLinux) {
    packageName = `@biomejs/cli-linux-${arch}-musl`;
  } else if (isWindows) {
    packageName = `@biomejs/cli-win32-${arch}`;
  } else {
    // macOS
    packageName = `@biomejs/cli-darwin-${arch}`;
  }

  const biomeBinPath = path.join(
    projectRoot,
    'node_modules',
    packageName,
    isWindows ? 'biome.exe' : 'biome'
  );
  const biomeInPath = path.join(pathDir, isWindows ? 'biome.exe' : 'biome');
  await makeSymlink(biomeBinPath, biomeInPath);
}

runScript('Setup path', async () => {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional
  }
  await setupCargoBin();
  await setupNodeSymlink();
  await setupPythonVenv();
  await setupBiomeSymlink();
});