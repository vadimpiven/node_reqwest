// SPDX-License-Identifier: Apache-2.0 OR MIT

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

console.log('> rustup %s', args.join(' '));
const result = spawnSync('rustup', args, { stdio: 'inherit' });

if (result.status !== 0) {
  console.error('rustup failed with exit code %d', result.status);
  process.exit(result.status ?? 1);
}
