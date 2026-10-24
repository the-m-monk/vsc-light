// Exercise the native channel adapter with the actual upstream LocalPty client.
import assert from 'node:assert/strict';
import { build } from '../build/vscode/build/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  stdin: { contents: `
    export { registerTerminalServices } from './build/vscode/src/vs/code/electron-browser/workbench/vsc-light/terminal.ts';
    export { LocalPty } from './build/vscode/src/vs/workbench/contrib/terminal/electron-browser/localPty.ts';
    export { ProxyChannel } from './build/vscode/src/vs/base/parts/ipc/common/ipc.ts';
  `, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { registerTerminalServices, LocalPty, ProxyChannel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const calls = [];
let failStart = false;
const host = { async call(method, args) {
  calls.push({ method, args });
  if (method === 'terminal.createProcess') return 1;
  if (method === 'terminal.start') {
    if (failStart) throw new Error('shell missing');
    // Output may arrive while the native start Promise is still in flight.
    globalThis.__vscLightTerminalEvents([{ id: 1, type: 'data', bytes: [0xe4, 0xbd] }]);
    return { pid: 123, cwd: '/tmp' };
  }
} };
let serverChannel;
const registration = registerTerminalServices({ registerChannel(name, channel) {
  assert.equal(name, 'localPty'); serverChannel = channel;
} }, host);
const channel = {
  call(command, arg) { return serverChannel.call(undefined, command, arg); },
  listen(event, arg) { return serverChannel.listen(undefined, event, arg); },
};
const proxy = ProxyChannel.toService(channel);
const id = await proxy.createProcess({ executable: '/bin/sh' }, '/tmp', 80, 24, '11', { TEST: 'value' });
const pty = new LocalPty(id, false, proxy);
const subscriptions = [
  proxy.onProcessReady(e => pty.handleReady(e.event)),
  proxy.onProcessData(e => pty.handleData(e.event)),
  proxy.onDidChangeProperty(e => pty.handleDidChangeProperty(e.property)),
  proxy.onProcessExit(e => pty.handleExit(e.event)),
];
const order = [];
pty.onProcessReady(event => { assert.equal(event.pid, 123); order.push('ready'); });
pty.onProcessData(data => order.push(data));
pty.onProcessExit(code => order.push(`exit:${code}`));
assert.equal(await pty.start(), undefined);
assert.equal(await pty.getInitialCwd(), '/tmp');
globalThis.__vscLightTerminalEvents([{ id, type: 'data', bytes: [0xa0] }, { id, type: 'data', bytes: [0x41] }]);
assert.deepEqual(order, ['ready', '你', 'A']);
pty.acknowledgeDataEvent(1);
assert.ok(calls.some(call => call.method === 'terminal.acknowledgeDataEvent' && call.args.bytes === 3));
pty.acknowledgeDataEvent(1);
pty.input('echo test\r');
pty.resize(101, 37);
await pty.processBinary('\xff');
assert.ok(calls.some(call => call.method === 'terminal.input' && call.args.data === 'echo test\r'));
assert.ok(calls.some(call => call.method === 'terminal.resize' && call.args.cols === 101 && call.args.rows === 37));
assert.ok(calls.some(call => call.method === 'terminal.processBinary' && call.args.bytes[0] === 255));
globalThis.__vscLightTerminalEvents([{ id, type: 'exit', code: 7 }]);
assert.equal(order.at(-1), 'exit:7');

await proxy.createProcess({ executable: '/missing' }, '/tmp', 80, 24, '11', {});
failStart = true;
assert.deepEqual(await proxy.start(1), { message: 'shell missing' });
assert.equal(calls.at(-1).method, 'terminal.shutdown');
for (const subscription of subscriptions) subscription.dispose();
pty.dispose();
registration.dispose();
assert.equal(globalThis.__vscLightTerminalEvents, undefined);
console.log('PASS: upstream LocalPty, early output, split UTF-8, ready/exit events, input, resize, binary input, launch errors, and disposal');
