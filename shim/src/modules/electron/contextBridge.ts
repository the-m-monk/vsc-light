// https://www.electronjs.org/docs/latest/api/context-bridge

const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    (globalThis as unknown as Record<string, unknown>)[key] = api;
  },
};

export default contextBridge;
