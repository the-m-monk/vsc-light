import assert from 'node:assert/strict';
import { build } from '../build/vscode/build/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';

const bundle = await build({
  stdin: { contents: `
    export { registerLoggingServices } from './build/vscode/src/vs/code/electron-browser/workbench/vsc-light/logging.ts';
    export { LogLevel } from './build/vscode/src/vs/platform/log/common/log.ts';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { registerLoggingServices, LogLevel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const channels = new Map();
const files = new Map();
const registration = registerLoggingServices({ registerChannel(name, channel) { channels.set(name, channel); } }, {
  hasProvider: () => true,
  async createFile(uri) { files.set(uri.toString(), ''); },
  async readFile(uri) { return { value: { toString: () => files.get(uri.toString()) ?? '' } }; },
  async writeFile(uri, buffer) { files.set(uri.toString(), buffer.toString()); },
});
const channel = channels.get('logger');
assert.ok(channel);
const resource = { scheme: 'file', path: '/tmp/test-workbench.log' };
let levelChange;
const subscription = channel.listen(undefined, 'onDidChangeLogLevel')(value => { levelChange = value; });
await channel.call(undefined, 'createLogger', [resource, {}]);
await channel.call(undefined, 'log', [resource, [[LogLevel.Info, 'first message'], [LogLevel.Error, 'second message']]]);
await new Promise(resolve => setTimeout(resolve, 250));
const contents = files.get('file:///tmp/test-workbench.log');
assert.match(contents, /\[info\] first message/);
assert.match(contents, /\[error\] second message/);
await channel.call(undefined, 'setLogLevel', [LogLevel.Warning]);
assert.equal(levelChange, LogLevel.Warning);
await channel.call(undefined, 'log', [resource, [[LogLevel.Info, 'filtered message'], [LogLevel.Warning, 'visible message']]]);
await new Promise(resolve => setTimeout(resolve, 250));
assert.doesNotMatch(files.get('file:///tmp/test-workbench.log'), /filtered message/);
assert.match(files.get('file:///tmp/test-workbench.log'), /visible message/);
await assert.rejects(channel.call(undefined, 'unexpected'), /Call not found/);
subscription.dispose();
registration.dispose();
console.log('PASS: logger channel writes messages and applies log-level changes');
