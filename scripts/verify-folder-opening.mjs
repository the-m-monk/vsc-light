// Run after compiling the shim: node scripts/verify-folder-opening.mjs
import assert from 'node:assert/strict';
const calls = [];
let veto = false;
let badPath = false;
let reloads = 0;
globalThis.window = {
  location: { reload() { reloads++; } },
  webkit: { messageHandlers: { vscLightInvoke: { postMessage(request) {
    calls.push(request.method);
    if (badPath && request.method === 'window.validateFolder') return JSON.stringify({ id: request.id, ok: false, error: { code: 'ENOENT', message: 'missing' } });
    return JSON.stringify({ id: request.id, ok: true, value: request.method === 'window.getState' ? { folder: '/tmp/folder with spaces', folderId: 'abc', homeDir: '/home/test' } : null });
  } } } },
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
const { default: ipc, workbenchUnload } = await import('../shim/dist/modules/electron/ipcRenderer.js');
const { host } = await import('../shim/dist/host.js');
await assert.rejects(workbenchUnload('before'), /not ready/);
ipc.on('vscode:onBeforeUnload', (_event, reply) => {
  assert.ok(reply.okChannel.startsWith('vscode:'));
  assert.ok(reply.cancelChannel.startsWith('vscode:'));
  calls.push('before');
  ipc.send(veto ? reply.cancelChannel : reply.okChannel, 1);
});
ipc.on('vscode:onWillUnload', (_event, reply) => {
  assert.ok(reply.replyChannel.startsWith('vscode:'));
  calls.push('will');
  ipc.send(reply.replyChannel, 1);
});
veto = true;
await host.call('window.openFolder', { path: '/tmp' });
assert.deepEqual(calls.splice(0), ['window.validateFolder', 'before']);
assert.equal(reloads, 0);
veto = false;
badPath = true;
await assert.rejects(host.call('window.openFolder', { path: '/missing' }), { code: 'ENOENT' });
assert.deepEqual(calls.splice(0), ['window.validateFolder']);
badPath = false;
await host.call('window.openFolder', { path: '/tmp' });
await new Promise(resolve => setTimeout(resolve, 10));
assert.deepEqual(calls.splice(0), ['window.validateFolder', 'before', 'window.setFolder', 'will']);
assert.equal(reloads, 1);
const config = await ipc.invoke('vscode:fetchWindowConfig');
assert.equal(config.workspace.uri.path, '/tmp/folder with spaces');
assert.equal(config.workspace.id, 'vsc-light-folder-abc');
assert.equal(config.homeDir, '/home/test');
console.log('PASS: lifecycle veto, invalid folder, ordered shutdown/reload, folder config');
