// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ensureError } from './run-script.ts';

const isWindows = process.platform === 'win32';

/**
 * Creates a symlink from target to link path, ensuring parent directories exist.
 * The symlink target is stored as a relative path to ensure portability.
 */
export async function makeSymlink(target: string, link: string): Promise<void> {
  const linkDir = path.dirname(link);

  // Ensure the directory exists
  try {
    await fs.mkdir(linkDir, { recursive: true });
  } catch (err: unknown) {
    const error = ensureError(err);
    throw new Error(`Failed to create directory ${linkDir}: ${error.message}`);
  }

  // Remove existing symlink/file if it exists
  try {
    await fs.rm(link, { force: true, recursive: true });
  } catch (err: unknown) {
    const error = ensureError(err);
    throw new Error(`Failed to remove existing file ${link}: ${error.message}`);
  }

  // Calculate relative path for better portability (e.g. devcontainers)
  // If target is already relative, we assume it's relative to CWD and we might need to adjust it,
  // but usually we pass absolute paths to this helper.
  const absoluteTarget = path.resolve(process.cwd(), target);
  const relativeTarget = path.relative(linkDir, absoluteTarget);

  // Create the symlink
  try {
    // On Windows, 'file' argument is required for file symlinks
    await fs.symlink(relativeTarget, link, isWindows ? 'file' : undefined);
    console.log('Symlinked: %s -> %s (rel: %s)', absoluteTarget, link, relativeTarget);
  } catch (err: unknown) {
    const error = ensureError(err);
    const message = isWindows
      ? `Failed to symlink from ${absoluteTarget} to ${link}. Enable Developer Mode to create symlinks: ${error.message}`
      : `Failed to symlink from ${absoluteTarget} to ${link}: ${error.message}`;
    throw new Error(message);
  }
}
