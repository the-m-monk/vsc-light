type ProcessListener = (...args: unknown[]) => void;

const processShim = {
  argv: ["vsc-light", "--vscode-window-config=vscode:fetchWindowConfig"],
  env: {} as Record<string, string | undefined>,
  platform: "linux",
  arch: "unknown",
  versions: {} as Record<string, string>,
  type: "renderer",
  execPath: "vsc-light",
  cwd(): string {
    return this.env.VSCODE_CWD ?? "/";
  },
  on(_event: string, _listener: ProcessListener): void {},
  getProcessMemoryInfo(): Promise<Record<string, never>> {
    return Promise.resolve({});
  },
};

(globalThis as unknown as Record<string, unknown>).process = processShim;

export default processShim;
