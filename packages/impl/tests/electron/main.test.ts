// SPDX-License-Identifier: Apache-2.0 OR MIT

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test
} from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let app: ElectronApplication;
let window: Page;

test.beforeEach(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, 'main.ts'), '--no-sandbox']
  });
  window = await app.firstWindow();

  await window.coverage.startJSCoverage();
});

// biome-ignore lint: Playwright requires object destructuring
test.afterEach(async ({}, testInfo) => {
  const coverageData = await window.coverage.stopJSCoverage();
  await addCoverageReport(coverageData, testInfo);

  await app.close();
});

test('should display hello', async () => {
  const output = window.locator('#output');

  await expect(output).not.toHaveText('Checking...');
  await expect(output).toHaveText('hello');
});
