import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  runScenarios: () => ipcRenderer.invoke("run-scenarios"),
});
