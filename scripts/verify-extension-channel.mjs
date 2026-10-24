import assert from 'node:assert/strict';
import { build } from '../build/vscode/build/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
const bundle = await build({
  stdin: { contents: `
    export { registerExtensionServices } from './build/vscode/src/vs/code/electron-browser/workbench/vsc-light/extensions.ts';
    export { URI } from './build/vscode/src/vs/base/common/uri.ts';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { registerExtensionServices, URI } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const channels = new Map();
const calls = [];
const registration = registerExtensionServices({ registerChannel(name, channel) { channels.set(name, channel); } }, {
  async call(method, args) {
    calls.push({ method, args });
    if (method === 'extensions.getInstalled') return [];
    if (method === 'extensions.getPaths') return { targetPlatform: 'linux-x64' };
    return { name: 'fixture' };
  },
});
const channel = channels.get('extensions');
const profile = JSON.parse(JSON.stringify(URI.from({ scheme: 'vscode-userdata', path: '/tmp/profile.json' })));
assert.deepEqual(await channel.call(undefined, 'getInstalled', [1, profile]), []);
assert.equal(calls.at(-1).args.profileLocation, '/tmp/profile.json');
assert.equal(await channel.call(undefined, 'getTargetPlatform'), 'linux-x64');
await assert.rejects(channel.call(undefined, 'getInstalled', [1, URI.parse('https://example.invalid/profile.json')]), /Only local/);
await assert.rejects(channel.call(undefined, 'getManifest', [profile]), /Only local/);
assert.equal((await channel.call(undefined, 'getManifest', [URI.file('/tmp/fixture.vsix')])).name, 'fixture');
registration.dispose();
console.log('PASS: serialized vscode-userdata profile paths, local VSIX path validation, installed-list channel, and target platform');
