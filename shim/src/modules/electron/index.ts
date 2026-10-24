import contextBridge from "./contextBridge.js";
import ipcRenderer from "./ipcRenderer.js";
import ipcMain from "./ipcMain.js";
import process from "./process.js";
import webFrame from "./webFrame.js";

const electron = {
  contextBridge,
  ipcRenderer,
  ipcMain,
  process,
  webFrame,
  onRequire(): void {
    console.info("[electron] shim loaded");
  },
};
export default electron;
