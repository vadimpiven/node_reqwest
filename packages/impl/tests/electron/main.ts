import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { hello } from '../../export/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.whenReady().then(() => {
  ipcMain.handle('hello', hello);

  const window = new BrowserWindow({
    webPreferences: {
      sandbox: false, // <https://www.electronjs.org/docs/latest/tutorial/esm>
      preload: path.join(__dirname, 'preload.mjs')
    }
  });
  window.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
