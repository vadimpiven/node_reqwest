// SPDX-License-Identifier: Apache-2.0 OR MIT

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { request, Agent as UndiciAgent } from 'undici';
import { hello } from '../../export/index.ts';

const currentFilename: string = fileURLToPath(import.meta.url);
const currentDirname: string = path.dirname(currentFilename);

app.whenReady().then(() => {
  ipcMain.handle('hello', hello);
  ipcMain.handle('undici_agent', async () => {
    // Skip when not in MITM environment - echo.lan doesn't exist and DNS
    // lookup failures crash on Windows (exit code 0xC0000005) XD)) because
    // Node.js delegates DNS resolution to https://github.com/c-ares/c-ares
    if (!process.env.MITM_PROXY) {
      return 'skipped';
    }
    return await request('https://echo.lan', { dispatcher: new UndiciAgent() })
      .then(() => true)
      .catch(() => false);
  });
  ipcMain.handle('reqwest_agent', async () => {
    return true;
    // return await request('https://echo.lan', { agent: ... })
    //   .then(() => true)
    //   .catch(() => false);
  });

  const isHeadless = process.argv.includes('--headless');
  const window = new BrowserWindow({
    show: !isHeadless, // Hide window when running in headless/test mode
    webPreferences: {
      sandbox: false, // <https://www.electronjs.org/docs/latest/tutorial/esm>
      preload: path.join(currentDirname, 'preload.mjs')
    }
  });
  window.loadFile(path.join(currentDirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
