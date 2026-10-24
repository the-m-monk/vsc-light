let nextId = 1;

/** Generic request/reply bridge to native VSC-Light host capabilities. */
export const host = {
  async call<T>(method: string, args: unknown): Promise<T> {
    const ipc = (await import("./modules/electron/ipcRenderer.js")).default;
    const id = nextId++;
    console.info(`[vsc-light:host] call ${method} id=${id}`);
    const result = await ipc.invoke("vscLight:host", { id, method, args });
    console.info(`[vsc-light:host] reply ${method} id=${id}`);
    return result as T;
  },
};
