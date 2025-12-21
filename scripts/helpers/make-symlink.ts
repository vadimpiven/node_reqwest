// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const isWindows = process.platform === 'win32';

/**
 * Creates a symlink from target to link path, ensuring parent directories exist.
 */
export async function makeSymlink(target: string, link: string): Promise<void> {
  const linkDir = path.dirname(link);

  // Ensure the directory exists
  try {
    await fs.mkdir(linkDir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create directory ${linkDir}: ${err}`);
  }

  // Remove existing symlink/file if it exists
  const exists = await fs
    .access(link)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    try {
      await fs.unlink(link);
    } catch (err) {
      throw new Error(`Failed to remove existing file ${link}: ${err}`);
    }
  }

  // Create the symlink
  try {
    // On Windows, 'file' argument is required for file symlinks
    await fs.symlink(target, link, isWindows ? 'file' : undefined);
    console.log('Symlinked: %s -> %s', target, link);
  } catch (err) {
    const message = isWindows
      ? `Failed to symlink from ${target} to ${link}. Enable Developer Mode to create symlinks: ${err}`
      : `Failed to symlink from ${target} to ${link}: ${err}`;
    throw new Error(message);
  }
}
