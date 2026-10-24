// Run after compiling the shim: node scripts/verify-host-transport.mjs
import assert from 'node:assert/strict';

let respond;
globalThis.window = {
  webkit: { messageHandlers: { vscLightInvoke: {
    postMessage(request) { return respond(request); },
  } } },
};
const { default: ipc } = await import('../shim/dist/modules/electron/ipcRenderer.js');
let nextId = 1;
const invoke = method => ipc.invoke('vscLight:host', { id: nextId++, method, args: {} });

// First folder selection is asynchronous and must work before any view/lifecycle setup.
const folder = '/tmp/folder with spaces/"quoted"/你好';
respond = request => new Promise(resolve => setTimeout(() => {
  resolve(JSON.stringify({ id: request.id, ok: true, value: folder }));
}, 10));
assert.equal(await invoke('dialog.pickFolder'), folder);

// The same wire format carries file bytes and nested metadata without changing their types.
respond = request => JSON.stringify({ id: request.id, ok: true, value: {
  contents: { __vscLightBinary: { type: 'Uint8Array', bytes: [0, 127, 128, 255] } },
  entries: [{ name: '你好', size: 4, symbolicLink: false }],
  missing: null,
} });
const file = await invoke('fs.readFile');
assert.deepEqual(file.contents, new Uint8Array([0, 127, 128, 255]));
assert.deepEqual(file.entries, [{ name: '你好', size: 4, symbolicLink: false }]);
assert.equal(file.missing, null);

respond = request => JSON.stringify({ id: request.id, ok: false,
  error: { code: 'EIO', message: 'native failure', osCode: 5 } });
await assert.rejects(invoke('fs.readFile'), { message: 'native failure', code: 'EIO', osCode: 5 });
respond = () => '{}';
await assert.rejects(invoke('fs.readFile'), /reply ID mismatch/);
respond = request => JSON.stringify({ id: request.id + 1, ok: true, value: null });
await assert.rejects(invoke('fs.readFile'), /reply ID mismatch/);
respond = () => 'invalid JSON';
await assert.rejects(invoke('fs.readFile'), SyntaxError);

console.log('PASS: initial async folder reply, JSON text, Unicode, binary data, native errors, invalid IDs, and malformed JSON');
