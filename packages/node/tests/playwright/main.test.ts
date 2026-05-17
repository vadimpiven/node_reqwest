// SPDX-License-Identifier: Apache-2.0 OR MIT

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { addCoverageReport } from "monocart-reporter";

const currentFilename: string = fileURLToPath(import.meta.url);
const currentDirname: string = path.dirname(currentFilename);

let app: ElectronApplication;
let window: Page;

test.beforeEach(async () => {
  app = await electron.launch({
    args: [path.join(currentDirname, "main.ts"), "--no-sandbox", "--headless"],
  });
  window = await app.firstWindow();
  await window.coverage.startJSCoverage();
});

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (window) {
    const coverageData = await window.coverage.stopJSCoverage();
    await addCoverageReport(coverageData, testInfo);
  }
  if (app) await app.close();
});

test("integration scenarios all pass inside Electron", async () => {
  const status = window.locator("#status");
  await expect(status).not.toHaveText("Running...", { timeout: 30_000 });

  const detail = await window.locator("#detail").textContent();
  // Surface per-scenario results in the failure message for quick diagnosis.
  expect(status, `details:\n${detail}`).toHaveText("ALL PASS");
});
