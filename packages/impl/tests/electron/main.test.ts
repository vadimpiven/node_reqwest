import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let electronApp: ElectronApplication;

test.beforeEach(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, 'main.ts'), '--no-sandbox']
  });
});

test.afterEach(async () => {
  await electronApp.close();
});

test('should display hello', async () => {
  const window = await electronApp.firstWindow();
  const output = window.locator('#output');

  await expect(output).not.toHaveText('Checking...');
  await expect(output).toHaveText('hello');
});
