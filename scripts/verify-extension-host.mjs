// Requires a freshly built vsc-light-bundle, including the Node transport helper.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from '../build/vscode/build/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({ stdin: { contents: `
  export { registerExtensionHostServices, startNativeExtensionHost } from './build/vscode/src/vs/platform/extensions/vsc-light/extensionHost.ts';
  export { RPCProtocol } from './build/vscode/src/vs/workbench/services/extensions/common/rpcProtocol.ts';
  export { MainContext, ExtHostContext } from './build/vscode/src/vs/workbench/api/common/extHost.protocol.ts';
  export { URI } from './build/vscode/src/vs/base/common/uri.ts';
`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const url = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`;
const { registerExtensionHostServices, RPCProtocol, MainContext, ExtHostContext, URI } = await import(url);
// These entry points live in separate production bundles too.
const { startNativeExtensionHost } = await import(`${url}#renderer`);
const directory = await mkdtemp(join(tmpdir(), 'vsc-light-extension-test-'));
const marker = join(directory, 'activated.json');
const deactivated = join(directory, 'deactivated');
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'native-fixture', publisher: 'test', version: '1.0.0', engines: { vscode: '*' }, main: './extension.cjs' }));
await writeFile(join(directory, 'extension.cjs'), `const vscode = require('vscode'); exports.activate = () => require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: vscode.version, node: process.versions.node })); exports.deactivate = () => require('fs').writeFileSync(${JSON.stringify(deactivated)}, 'yes');`);
const processes = new Map();
let nextId = 0;
const host = { async call(method, args) {
  if (method === 'extensionHost.create') return { id: String(++nextId) };
  if (method === 'extensionHost.start') {
    const child = spawn('node', [join(root, 'build/vscode/out-vscode/vsc-light-extension-host.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    processes.set(args.id, child);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => globalThis.__vscLightExtensionHostEvents?.([{ ...JSON.parse(line), id: args.id }]));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('exit', () => globalThis.__vscLightExtensionHostEvents?.([{ id: args.id, event: 'closed' }]));
    child.stdin.write(`${JSON.stringify({ operation: 'start', options: args.options })}\n`);
  } else if (method === 'extensionHost.send') processes.get(args.id).stdin.write(`${JSON.stringify({ operation: 'send', bytes: args.bytes })}\n`);
  else if (method === 'extensionHost.kill') processes.get(args.id)?.stdin.end();
  else throw new Error(`Unexpected host call: ${method}`);
} };
globalThis.__vscLightHost = host;
const channels = new Map();
const registration = registerExtensionHostServices({ registerChannel(name, channel) { channels.set(name, channel); } }, host);
const starter = channels.get('extensionHostStarter');
let rpc;
const deadline = setTimeout(() => { console.error('FAIL: extension activation timed out'); for (const child of processes.values()) child.stdin.end(); process.exitCode = 1; }, 15000);
try {
  const { id } = await starter.call(undefined, 'createExtensionHost', []);
  const exits = [];
  const exitListener = starter.listen(undefined, 'onDynamicExit', id)(event => exits.push(event));
  const { pid, protocol } = await startNativeExtensionHost(id, { env: {}, execArgv: [], silent: true, detached: false, responseWindowId: 1, responseChannel: '', responseNonce: '' });
  assert.ok(pid > 0);
  const extension = { identifier: { value: 'test.native-fixture' }, name: 'native-fixture', publisher: 'test', version: '1.0.0', engines: { vscode: '*' }, main: './extension.cjs', extensionLocation: URI.file(directory), isBuiltin: false, isUserBuiltin: false, enabledApiProposals: [] };
  const init = {
    version: '1.143.1', parentPid: 0, environment: { isExtensionDevelopmentDebug: false, appName: 'VSC Light Test', appHost: 'desktop', appRoot: URI.file(join(root, 'build/vscode')), appLanguage: 'en', appUriScheme: 'vsc-light', isExtensionTelemetryLoggingOnly: true, globalStorageHome: URI.file(join(directory, 'globalStorage')), workspaceStorageHome: URI.file(join(directory, 'workspaceStorage')), useHostProxy: false },
    extensions: { versionId: 0, allExtensions: [extension], myExtensions: [extension.identifier], activationEvents: {} }, telemetryInfo: { sessionId: 'test', machineId: 'test', sqmId: 'test', devDeviceId: 'test', firstSessionDate: '' },
    logLevel: 3, loggers: [], logsLocation: URI.file(join(directory, 'logs')), autoStart: false, remote: { isRemote: false, connectionData: null }, consoleForward: { includeStack: false, logNative: false }, uiKind: 1,
  };
  await new Promise(resolve => {
    const listener = protocol.onMessage(message => {
      if (message.byteLength === 1 && message.buffer[0] === 2) protocol.send({ buffer: Buffer.from(JSON.stringify(init)) });
      if (message.byteLength === 1 && message.buffer[0] === 1) { listener.dispose(); resolve(); }
    });
  });
  rpc = new RPCProtocol(protocol);
  const calls = [];
  for (const identifier of Object.values(MainContext)) {
    rpc.set(identifier, new Proxy({}, { get: (_target, method) => (...args) => {
      calls.push(String(method));
      if (method === '$getInitialState') return {};
      if (method === '$getTools') return [];
      if (method === '$onExtensionActivationError' || method === '$onUnexpectedError') console.error(method, args);
      return undefined;
    } }));
  }
  await rpc.getProxy(ExtHostContext.ExtHostWorkspace).$initializeWorkspace(null, true);
  const model = { contents: {}, keys: [], overrides: [] };
  await rpc.getProxy(ExtHostContext.ExtHostConfiguration).$initializeConfiguration({ defaults: model, policy: model, application: model, userLocal: model, userRemote: model, workspace: model, folders: [], configurationScopes: [] });
  const service = rpc.getProxy(ExtHostContext.ExtHostExtensionService);
  await service.$startExtensionHost({ versionId: 1, toAdd: [], toRemove: [], myToAdd: [], myToRemove: [], addActivationEvents: {} });
  const activated = await service.$activate(extension.identifier, { startup: false, extensionId: extension.identifier, activationEvent: 'test' });
  assert.equal(activated, true);
  const result = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(result.version, '1.143.1');
  assert.ok(result.node);
  // Simulate the native window closing its bridge, rather than terminating Node directly.
  processes.get(id).stdin.end();
  await starter.call(undefined, 'waitForExit', [id, 5000]);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 0);
  assert.equal(await readFile(deactivated, 'utf8'), 'yes');
  exitListener.dispose();
  const crashed = await starter.call(undefined, 'createExtensionHost', []);
  const crashEvents = [];
  const crashListener = starter.listen(undefined, 'onDynamicExit', crashed.id)(event => crashEvents.push(event));
  await startNativeExtensionHost(crashed.id, { env: {}, execArgv: ['--vsc-light-invalid-option'] });
  await starter.call(undefined, 'waitForExit', [crashed.id, 5000]);
  assert.equal(crashEvents.length, 1);
  assert.notEqual(crashEvents[0].code, 0);
  crashListener.dispose();
  console.log('PASS: Node startup, Ready/Initialized handshake, VS Code API extension activation, graceful shutdown, and startup crash reporting');
} finally {
  clearTimeout(deadline); rpc?.dispose(); registration.dispose();
  for (const child of processes.values()) child.stdin.end();
  delete globalThis.__vscLightHost;
  await rm(directory, { recursive: true, force: true });
}
