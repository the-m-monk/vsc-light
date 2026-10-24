import "./require.js";
import { host } from "./host.js";

(globalThis as typeof globalThis & { __vscLightHost: typeof host }).__vscLightHost = host;

interface IdleDeadlineShim {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type IdleCallbackShim = (deadline: IdleDeadlineShim) => void;

interface IdleWindowShim {
  requestIdleCallback?: (callback: IdleCallbackShim, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

const idleWindow = window as IdleWindowShim;
if (!idleWindow.requestIdleCallback) {
  idleWindow.requestIdleCallback = (callback, options) => window.setTimeout(() => {
    const startedAt = performance.now();
    const timedOut = options?.timeout !== undefined && options.timeout <= 1;
    callback({
      didTimeout: timedOut,
      timeRemaining: () => Math.max(0, 50 - (performance.now() - startedAt)),
    });
  }, 1);
  idleWindow.cancelIdleCallback = (handle) => window.clearTimeout(handle);
}

interface ScriptUrlPolicy {
  createScriptURL(url: string): unknown;
}

interface TrustedTypesShim {
  createPolicy(
    name: string,
    rules: { createScriptURL(url: string): string },
  ): ScriptUrlPolicy;
}

await new Promise<void>((resolve, reject) => {
  const preload = document.createElement("script");
  const preloadUrl = "vsc-light://app/vs/base/parts/sandbox/electron-browser/preload.js";
  const trustedTypes = (globalThis as unknown as { trustedTypes?: TrustedTypesShim }).trustedTypes;
  const policy = trustedTypes?.createPolicy("vscLightShim", {
    createScriptURL: (url) => url,
  });
  if (policy) {
    (preload as unknown as { src: unknown }).src =
      policy.createScriptURL(preloadUrl);
  } else {
    preload.src = preloadUrl;
  }
  preload.onload = () => resolve();
  preload.onerror = () => reject(new Error(`Failed to load ${preload.src}`));
  document.head.appendChild(preload);
}).catch((error: unknown) => {
  console.error("VS Code preload failed:", error);
});
