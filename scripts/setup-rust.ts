// SPDX-License-Identifier: Apache-2.0 OR MIT

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run-command.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');

interface PackageJson {
  rust?: {
    components?: string[];
  };
}

let pkg: PackageJson;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error('Failed to read package.json at %s:', pkgPath, err);
  process.exit(1);
}

const components = pkg.rust?.components ?? [];

const args = [
  'toolchain',
  'install',
  'nightly',
  '--profile',
  'minimal',
  ...components.flatMap((c) => ['--component', c])
];

await runCommand('rustup', args);
