import assert from 'node:assert/strict';
import { build } from '../build/vscode/build/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
const bundle = await build({
  stdin: { contents: `
    export { request } from './build/vscode/src/vs/workbench/services/request/vsc-light/request.ts';
    export { CancellationToken, CancellationTokenSource } from './build/vscode/src/vs/base/common/cancellation.ts';
    export { streamToBuffer } from './build/vscode/src/vs/base/common/buffer.ts';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { request, CancellationToken, CancellationTokenSource, streamToBuffer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const calls = [];
let handler;
globalThis.__vscLightHost = { async call(method, args) { calls.push({ method, args }); return handler(method, args); } };
handler = () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([0, 128, 255]) });
const response = await request({ url: 'https://example.invalid/gallery', type: 'POST', data: '{"query":"theme"}', user: 'fixture', password: 'password', callSite: 'test' }, CancellationToken.None);
assert.equal(response.res.statusCode, 200);
assert.deepEqual([...((await streamToBuffer(response.stream)).buffer)], [0, 128, 255]);
assert.equal(calls[0].args.type, 'POST');
assert.equal(calls[0].args.headers.Authorization, `Basic ${Buffer.from('fixture:password').toString('base64')}`);
const cancelled = new CancellationTokenSource(); cancelled.cancel();
await assert.rejects(request({ url: 'https://example.invalid', callSite: 'test' }, cancelled.token), /Canceled/);
assert.equal(calls.length, 1);
const pending = new CancellationTokenSource();
let rejectNetwork;
handler = method => method === 'network.cancel' ? undefined : new Promise((_, reject) => { rejectNetwork = reject; });
const result = request({ url: 'https://example.invalid', callSite: 'test' }, pending.token);
pending.cancel(); rejectNetwork(new Error('native operation cancelled'));
await assert.rejects(result, /Canceled/);
assert.equal(calls.at(-1).method, 'network.cancel');
assert.equal(calls.at(-1).args.requestId, calls.at(-2).args.requestId);
cancelled.dispose(); pending.dispose(); delete globalThis.__vscLightHost;
console.log('PASS: native request bridge, binary body, POST, auth headers, cancellation before/during request, and matching cancellation IDs');
