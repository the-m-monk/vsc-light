import { decodeIpcTransportValue } from "./ipcRenderer.js";

type Listener = (event: IpcMainEvent, ...args: unknown[]) => void;

interface IpcMainEvent {
  sender: WebContentsShim;
  senderFrame: { url: string; parent: null };
}

interface WebContentsShim {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
}

interface IpcMainShim {
  on(channel: string, listener: Listener): IpcMainShim;
  once(channel: string, listener: Listener): IpcMainShim;
  removeListener(channel: string, listener: Listener): IpcMainShim;
  handle(channel: string, listener: Listener): IpcMainShim;
  removeHandler(channel: string): IpcMainShim;
}

function findBinaryByteLength(value: unknown, seen = new WeakSet<object>()): number | undefined {
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const item of Object.values(value)) {
    const length = findBinaryByteLength(item, seen);
    if (length !== undefined) {
      return length;
    }
  }
  return undefined;
}

const listeners = new Map<string, Set<Listener>>();
const webContents: WebContentsShim = {
  id: 1,
  send(channel, ...args): void {
    if (channel === "vscode:message") {
      const length = findBinaryByteLength(args[0]) ?? -1;
      console.info(`host -> renderer vscode:message len=${length}`);
    }
    const receive = (globalThis as typeof globalThis & {
      __vscLightIpcReceive?: (channel: string, ...args: unknown[]) => void;
    }).__vscLightIpcReceive;
    receive?.(channel, ...args);
  },
};

function emit(channel: string, ...args: unknown[]): void {
  const decoded = args.map(decodeIpcTransportValue);
  const event: IpcMainEvent = {
    sender: webContents,
    senderFrame: { url: "vscode-file://vscode-app/out/vs/workbench/workbench.html", parent: null },
  };
  for (const listener of [...(listeners.get(channel) ?? [])]) {
    listener(event, ...decoded);
  }
}

const ipcMain: IpcMainShim = {
  on(channel: string, listener: Listener): IpcMainShim {
    const channelListeners = listeners.get(channel) ?? new Set<Listener>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
    return this;
  },
  once(channel: string, listener: Listener): IpcMainShim {
    const wrapped: Listener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    return this.on(channel, wrapped);
  },
  removeListener(channel: string, listener: Listener): IpcMainShim {
    listeners.get(channel)?.delete(listener);
    return this;
  },
  handle(): IpcMainShim {
    throw new Error("ipcMain.handle is not available in the VSC-Light IPC transport");
  },
  removeHandler(): IpcMainShim {
    return this;
  },
};

(
  globalThis as typeof globalThis & {
    __vscLightIpcMainReceive?: (channel: string, ...args: unknown[]) => void;
  }
).__vscLightIpcMainReceive = emit;

export default ipcMain;
