type Listener = (...args: unknown[]) => void;

interface NativeMessageHandler {
  postMessage(message: unknown): Promise<unknown> | void;
}

interface WebKitBridge {
  messageHandlers: {
    vscLightSend?: NativeMessageHandler;
    vscLightInvoke?: NativeMessageHandler;
  };
}

interface IpcRendererEvent {
  senderId: number;
}

interface IpcRendererShim {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): IpcRendererShim;
  once(channel: string, listener: Listener): IpcRendererShim;
  removeListener(channel: string, listener: Listener): IpcRendererShim;
  off(channel: string, listener: Listener): IpcRendererShim;
}

export function decodeIpcTransportValue(value: unknown): unknown {
  return decodeIpcValue(value);
}

const listeners = new Map<string, Set<Listener>>();
const onceListeners = new Map<Listener, Map<string, Listener>>();
const nativeWindow = window as Window & { webkit?: WebKitBridge };

const BINARY_TAG = "__vscLightBinary";

function encodeBinary(type: string, bytes: Uint8Array): unknown {
  return { [BINARY_TAG]: { type, bytes: Array.from(bytes) } };
}

function encodeIpcValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return encodeBinary("ArrayBuffer", new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return encodeBinary(
      value.constructor.name,
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (Array.isArray(value)) {
    return value.map(encodeIpcValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeIpcValue(item)]));
  }
  return value;
}

function decodeIpcValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeIpcValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const taggedBinary = record[BINARY_TAG];
    if (Object.keys(record).length === 1 && Array.isArray(taggedBinary)) {
      // Accept the original VSC-Light wire format for in-flight or older senders.
      return new Uint8Array(taggedBinary as number[]);
    }
    if (Object.keys(record).length === 1 && taggedBinary && typeof taggedBinary === "object") {
      const binary = taggedBinary as { type?: unknown; bytes?: unknown };
      if (typeof binary.type === "string" && Array.isArray(binary.bytes)) {
        return decodeBinary(binary.type, binary.bytes as number[]);
      }
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeIpcValue(item)]));
  }
  return value;
}

function decodeBinary(type: string, values: number[]): unknown {
  const bytes = Uint8Array.from(values);
  const buffer = bytes.buffer;
  switch (type) {
    case "ArrayBuffer": return buffer;
    case "Int8Array": return new Int8Array(buffer);
    case "Uint8ClampedArray": return new Uint8ClampedArray(buffer);
    case "Int16Array": return new Int16Array(buffer);
    case "Uint16Array": return new Uint16Array(buffer);
    case "Int32Array": return new Int32Array(buffer);
    case "Uint32Array": return new Uint32Array(buffer);
    case "Float32Array": return new Float32Array(buffer);
    case "Float64Array": return new Float64Array(buffer);
    case "BigInt64Array": return new BigInt64Array(buffer);
    case "BigUint64Array": return new BigUint64Array(buffer);
    case "DataView": return new DataView(buffer);
    case "Uint8Array":
    default: return bytes;
  }
}

function findBinaryValue(value: unknown, seen = new WeakSet<object>()): ArrayBuffer | ArrayBufferView | undefined {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const item of Object.values(value)) {
    const binary = findBinaryValue(item, seen);
    if (binary) {
      return binary;
    }
  }
  return undefined;
}

function dispatch(channel: string, ...args: unknown[]): void {
  const channelListeners = listeners.get(channel);
  if (!channelListeners) {
    return;
  }

  const decodedArgs = args.map(decodeIpcValue);
  if (channel === "vscode:message") {
    const binary = findBinaryValue(decodedArgs);
    if (binary) {
      const bytes = binary instanceof ArrayBuffer
        ? new Uint8Array(binary)
        : new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
      const constructor = binary.constructor?.name ?? "unknown";
      const hasSubarray = typeof (binary as { subarray?: unknown }).subarray === "function";
      const firstBytes = Array.from(bytes.subarray(0, 8), byte => byte.toString(16).padStart(2, "0")).join(" ");
      console.info(
        `[vsc-light:ipc] inbound binary constructor=${constructor} isView=${ArrayBuffer.isView(binary)} byteLength=${bytes.byteLength} hasSubarray=${hasSubarray}${firstBytes ? ` firstBytes=${firstBytes}` : ""}`,
      );
    } else {
      console.info("[vsc-light:ipc] inbound vscode:message has no binary value");
    }
  }

  const event: IpcRendererEvent = { senderId: 1 };
  for (const listener of [...channelListeners]) {
    listener(event, ...decodedArgs);
  }
}

(
  globalThis as typeof globalThis & {
    __vscLightIpcReceive?: (channel: string, ...args: unknown[]) => void;
  }
).__vscLightIpcReceive = dispatch;

const ipcRenderer: IpcRendererShim = {
  send(channel: string, ...args: unknown[]): void {
    if (channel === "vscode:hello") {
      console.info("renderer -> host vscode:hello");
    } else if (channel === "vscode:message") {
      const payload = args[0];
      const length = payload instanceof ArrayBuffer
        ? payload.byteLength
        : ArrayBuffer.isView(payload) ? payload.byteLength : -1;
      console.info(`renderer -> host vscode:message len=${length}`);
    }
    const bridge = nativeWindow.webkit?.messageHandlers.vscLightSend;
    if (!bridge) {
      console.error(`[ipcRenderer] Native send bridge is unavailable for ${channel}`);
      return;
    }
    bridge.postMessage({ channel, args: encodeIpcValue(args) });
  },

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    console.info(`[ipcRenderer] invoke(${JSON.stringify(channel)})`);
    if (channel === "vscode:fetchWindowConfig") {
      return Promise.all([
        fetch("vsc-light://app/nls.messages.json").then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to load NLS messages: ${response.status}`);
          }
          return response.json() as Promise<string[]>;
        }),
        fetch("vsc-light://app/product.json").then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to load product configuration: ${response.status}`);
          }
          return response.json() as Promise<Record<string, unknown>>;
        }),
      ]).then(([messages, product]) => ({
          profiles: (() => {
            const uri = (path: string) => ({
              scheme: "file",
              authority: "",
              path,
              query: "",
              fragment: "",
            });
            const location = "/tmp/vsc-light-user-data/User/profiles/default";
            const profile = {
              id: "default",
              name: "Default",
              isDefault: true,
              location: uri(location),
              globalStorageHome: uri(`${location}/globalStorage`),
              settingsResource: uri(`${location}/settings.json`),
              keybindingsResource: uri(`${location}/keybindings.json`),
              tasksResource: uri(`${location}/tasks.json`),
              snippetsHome: uri(`${location}/snippets`),
              promptsHome: uri(`${location}/prompts`),
              extensionsResource: uri(`${location}/extensions.json`),
              mcpResource: uri(`${location}/mcp.json`),
              languageModelsResource: uri(`${location}/chatLanguageModels.json`),
              agentPluginsHome: uri(`${location}/agent-plugins`),
              cacheHome: uri(`${location}/cache`),
            };
            return {
              all: [profile],
              profile,
              home: uri("/tmp/vsc-light-user-data/User/profiles"),
            };
          })(),
          windowId: 1,
          appRoot: "/",
          userEnv: {},
          product,
          homeDir: "/tmp",
          tmpDir: "/tmp",
          userDataDir: "/tmp/vsc-light-user-data",
          backupPath: "/tmp/vsc-light-user-data/Backups",
          logsPath: "/tmp/vsc-light-user-data/logs",
          execPath: "vsc-light",
          mainPid: 0,
          machineId: "vsc-light",
          sqmId: "vsc-light",
          devDeviceId: "vsc-light",
          isPortable: false,
          zoomLevel: 0,
          logLevel: 2,
          loggers: [],
          perfMarks: [],
          os: { release: "", hostname: "localhost", arch: "unknown" },
          nls: { messages, language: "en" },
          colorScheme: { dark: false, highContrast: false },
          cssModules: [],
        }));
    }
    if (channel === "vscode:fetchShellEnv") {
      return Promise.resolve({});
    }
    if (channel === "vscLight:host") {
      const request = args[0] as { id: number; method: string; args: unknown };
      const bridge = nativeWindow.webkit?.messageHandlers.vscLightInvoke;
      if (!bridge) return Promise.reject(new Error("Native host RPC bridge is unavailable"));
      return Promise.resolve(bridge.postMessage({ id: request.id, method: request.method, args: encodeIpcValue(request.args) }))
        .then((raw) => {
          const response = decodeIpcValue(raw) as { id?: number; ok?: boolean; value?: unknown; error?: { message?: string; code?: string; osCode?: number } };
          if (response?.id !== request.id) throw new Error(`Host RPC reply ID mismatch for ${request.method}`);
          if (!response.ok) throw Object.assign(new Error(response.error?.message ?? "Host RPC failed"), response.error);
          return response.value;
        });
    }
    const bridge = nativeWindow.webkit?.messageHandlers.vscLightInvoke;
    if (!bridge) {
      return Promise.reject(new Error(`Native invoke bridge is unavailable for ${channel}`));
    }
    try {
      return Promise.resolve(bridge.postMessage({ channel, args: encodeIpcValue(args) })).then(decodeIpcValue);
    } catch (error) {
      return Promise.reject(error);
    }
  },

  on(channel: string, listener: Listener): IpcRendererShim {
    const channelListeners = listeners.get(channel) ?? new Set<Listener>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
    return this;
  },

  once(channel: string, listener: Listener): IpcRendererShim {
    const wrapped: Listener = (...args) => {
      this.removeListener(channel, listener);
      listener(...args);
    };
    const wrappers = onceListeners.get(listener) ?? new Map<string, Listener>();
    wrappers.set(channel, wrapped);
    onceListeners.set(listener, wrappers);
    return this.on(channel, wrapped);
  },

  removeListener(channel: string, listener: Listener): IpcRendererShim {
    const wrapped = onceListeners.get(listener)?.get(channel);
    listeners.get(channel)?.delete(wrapped ?? listener);
    if (wrapped) {
      onceListeners.get(listener)?.delete(channel);
    }
    return this;
  },

  off(channel: string, listener: Listener): IpcRendererShim {
    return this.removeListener(channel, listener);
  },
};

export default ipcRenderer;
