// Uses the real upstream storage clients and cache with a mocked native transport.
import assert from 'node:assert/strict';
import { build } from '../build/vscode/build/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  stdin: { contents: `
    export { registerStorageServices } from './build/vscode/src/vs/code/electron-browser/workbench/vsc-light/storage.ts';
    export { ApplicationSharedStorageDatabaseClient, WorkspaceStorageDatabaseClient } from './build/vscode/src/vs/platform/storage/common/storageIpc.ts';
    export { Storage } from './build/vscode/src/vs/base/parts/storage/common/storage.ts';
  `, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { registerStorageServices, ApplicationSharedStorageDatabaseClient, WorkspaceStorageDatabaseClient, Storage } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const databases = new Map();
let failWrites = false;
const host = { async call(method, arg) {
  const scope = arg.workspace ? `workspace:${arg.workspace.id}` : arg.profile ? `profile:${arg.profile.id}` : arg.applicationShared ? 'shared' : 'application';
  if (!databases.has(scope)) databases.set(scope, new Map());
  const items = databases.get(scope);
  switch (method) {
    case 'storage.getItems': return [...items];
    case 'storage.getValue': return items.get(arg.key) ?? null;
    case 'storage.updateItems': {
      if (failWrites) throw new Error('disk write failed');
      for (const [key, value] of arg.insert ?? []) items.set(key, value);
      for (const key of arg.delete ?? []) items.delete(key);
      return { changed: arg.insert ?? [], deleted: arg.delete ?? [] };
    }
    case 'storage.compareAndSwap': return { swapped: false, currentValue: null };
    default: throw new Error(`Unexpected native call: ${method}`);
  }
} };
let registered;
const registration = registerStorageServices({ registerChannel(name, channel) {
  assert.equal(name, 'storage'); registered = channel;
} }, host);
const channel = {
  call(command, arg) { return registered.call(undefined, command, arg); },
  listen(event, arg) { return registered.listen(undefined, event, arg); },
};
const first = new Storage(new ApplicationSharedStorageDatabaseClient(channel));
await first.init();
const key = 'content.trust.model.key';
const trusted = JSON.stringify({ uriTrustInfo: [{ uri: { scheme: 'file', path: '/tmp/project' }, trusted: true }] });
first.set(key, trusted);
await first.flush(0);
await first.close();

const restored = new Storage(new ApplicationSharedStorageDatabaseClient(channel));
const observer = new Storage(new ApplicationSharedStorageDatabaseClient(channel));
const workspace = new Storage(new WorkspaceStorageDatabaseClient(channel, { id: 'project' }));
await Promise.all([restored.init(), observer.init(), workspace.init()]);
assert.equal(restored.get(key), trusted);
assert.equal(workspace.get(key), undefined);
const revoked = JSON.stringify({ uriTrustInfo: [] });
restored.set(key, revoked);
await restored.flush(0);
assert.equal(observer.get(key), revoked);
workspace.set('workspace.trust.startupPrompt.shown', 'true');
await workspace.flush(0);
assert.equal(databases.get('workspace:project').get('workspace.trust.startupPrompt.shown'), 'true');
assert.equal(await channel.call('getValue', { key: 'missing' }), undefined);
assert.deepEqual(await channel.call('compareAndSwap', { key: 'missing', newValue: 'value' }), { swapped: false, currentValue: undefined });

let events = 0;
const listener = channel.listen('onDidChangeStorage', { applicationShared: true })(() => events++);
failWrites = true;
await assert.rejects(channel.call('updateItems', { applicationShared: true, insert: [[key, trusted]] }), /disk write failed/);
assert.equal(events, 0);
failWrites = false;
listener.dispose();
await Promise.all([restored.close(), observer.close(), workspace.close()]);
registration.dispose();
console.log('PASS: upstream storage clients restore trust, persist revocation and prompt state, isolate workspaces, deliver change events, and propagate write failures');
