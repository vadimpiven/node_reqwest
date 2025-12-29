import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  hello: () => ipcRenderer.invoke('hello')
});
