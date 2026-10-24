let nextId = 1;

/** Generic request/reply bridge to native VSC-Light host capabilities. */
export const host = {
  async call<T>(method: string, args: unknown): Promise<T> {
    if (method === "window.openFolder") {
      const { workbenchUnload } = await import("./modules/electron/ipcRenderer.js");
      console.info(`[vsc-light:folder] open requested ${JSON.stringify(args)}`);
      // Validate first, so a bad path never starts shutdown.
      await host.call("window.validateFolder", args);
      console.info("[vsc-light:folder] validation passed; checking before-unload");
      const allowed = await workbenchUnload("before");
      console.info(`[vsc-light:folder] before-unload ${allowed ? "allowed" : "cancelled"}`);
      if (!allowed) return undefined as T;
      await host.call("window.setFolder", args);
      console.info("[vsc-light:folder] folder state updated; checking will-unload");
      await workbenchUnload("will");
      console.info("[vsc-light:folder] will-unload complete; scheduling reload");
      setTimeout(() => {
        console.info("[vsc-light:folder] reloading workbench");
        window.location.reload();
      }, 0);
      return undefined as T;
    }
    const ipc = (await import("./modules/electron/ipcRenderer.js")).default;
    const id = nextId++;
    console.info(`[vsc-light:host] call ${method} id=${id}`);
    const result = await ipc.invoke("vscLight:host", { id, method, args });
    console.info(`[vsc-light:host] reply ${method} id=${id}`);
    return result as T;
  },
};
