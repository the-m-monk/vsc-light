import electron from "./modules/electron/index.js";

const browserGlobal = globalThis as typeof globalThis & {
  require?: (moduleId: string) => unknown;
};

browserGlobal.require = function require(moduleId: string): unknown {
  const target = moduleId === "electron"
    ? "./modules/electron/index.js"
    : undefined;
  console.info(`[shim] require(${JSON.stringify(moduleId)}) -> ${target ?? "<unresolved>"}`);
  if (moduleId === "electron") {
    electron.onRequire();
    return electron;
  }
  return undefined;
};
