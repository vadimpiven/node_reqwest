// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { resolveConfig } from 'vitest/node';
import { runCommand } from './helpers/run-command.ts';
import { runScript } from './helpers/run-script.ts';

runScript('Vitest', async () => {
  const args = process.argv.slice(2);
  const packageDir = process.cwd();

  // Resolve vitest config to get coverage directory
  const { vitestConfig } = await resolveConfig({ root: packageDir });
  const coverageDir = vitestConfig.coverage.reportsDirectory ?? 'coverage';

  // Clean and recreate coverage directory to prevent ENOENT race condition
  const coveragePath = join(packageDir, coverageDir);
  await fs.rm(coveragePath, { recursive: true, force: true });
  await fs.mkdir(join(coveragePath, '.tmp'), { recursive: true });
  // Small delay to ensure filesystem is synced (helps with Docker sync flakes)
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log('> Recreated coverage directory: %s', coverageDir);

  await runCommand('pnpm', [
    'exec',
    'vitest',
    'run',
    '--coverage',
    '--coverage.clean=false',
    ...args
  ]);
});
