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

const currentFilename: string = fileURLToPath(import.meta.url);
const currentDirname: string = path.dirname(currentFilename);

let app: ElectronApplication;
let window: Page;

test.beforeEach(async () => {
  app = await electron.launch({
    args: [path.join(currentDirname, 'main.ts'), '--no-sandbox', '--headless']
  });
  window = await app.firstWindow();

  await window.coverage.startJSCoverage();
});

// biome-ignore lint: Playwright requires object destructuring
test.afterEach(async ({}, testInfo) => {
  if (window) {
    const coverageData = await window.coverage.stopJSCoverage();
    await addCoverageReport(coverageData, testInfo);
  }

  if (app) {
    await app.close();
  }
});

test('should fail with undici agent and succeed with node_reqwest agent', async () => {
  {
    const output = window.locator('#output');

    await expect(output).not.toHaveText('Waiting...');
    await expect(output).toHaveText('hello');
  }

  if (process.env.MITM_PROXY) {
    const output = window.locator('#undici_agent');

    await expect(output).not.toHaveText('Waiting...');
    await expect(output).toHaveText('false');
  }

  {
    const output = window.locator('#reqwest_agent');

    await expect(output).not.toHaveText('Waiting...');
    await expect(output).toHaveText('true');
  }
});
