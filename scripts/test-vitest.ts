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

  // Ensure coverage directory and its .tmp subdirectory exist to prevent ENOENT race condition
  const coveragePath = join(packageDir, coverageDir);
  await fs.mkdir(join(coveragePath, '.tmp'), { recursive: true });
  console.log('> Ensured coverage directory exists: %s', coverageDir);

  await runCommand('pnpm', ['exec', 'vitest', 'run', '--coverage', ...args]);
});
