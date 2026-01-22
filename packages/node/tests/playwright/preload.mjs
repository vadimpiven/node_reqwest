import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  hello: () => ipcRenderer.invoke("hello"),
  undici_agent: () => ipcRenderer.invoke("undici_agent"),
  reqwest_agent: () => ipcRenderer.invoke("reqwest_agent"),
});
