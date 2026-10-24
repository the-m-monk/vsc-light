// Native ESM entry point used by upstream modules importing "electron".
// Keep all values sourced from index.ts so ESM and require() share one shim.
import electron from "./index.js";

console.info("[vsc-light:electron-esm] loaded");

export const contextBridge = electron.contextBridge;
export const ipcRenderer = electron.ipcRenderer;
export const ipcMain = electron.ipcMain;
export const process = electron.process;
export const webFrame = electron.webFrame;
export default electron;
