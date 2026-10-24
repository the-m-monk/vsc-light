#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const product = JSON.parse(readFileSync(new URL('build/vscode/product.json', root), 'utf8'));
const behaviour = JSON.parse(readFileSync(new URL('config/vscodium-product.json', root), 'utf8'));
assert.equal(product.nameShort, 'VSC Light');
assert.equal(product.applicationName, 'vsc-light');
assert.equal(product.urlProtocol, 'vsc-light');
assert.equal(product.dataFolderName, '.vsc-light');
assert.equal(product.linuxDesktopName, 'dev.vsc_light.WebView');
assert.equal(product.quality, 'stable');
assert.equal(product.enableTelemetry, false);
assert.deepEqual(product.enabledTelemetryLevels, { error: false, usage: false });
assert.deepEqual(product.extensionsGallery, behaviour.extensionsGallery);
assert.deepEqual(product.tunnelApplicationConfig, {});
assert.deepEqual(product.builtInExtensionsEnabledWithAutoUpdates, []);
for (const key of ['voiceWsUrl', 'updateUrl', 'crashReporter', 'webviewContentExternalBaseUrlTemplate']) {
  assert.equal(Object.hasOwn(product, key), false, `${key} must be absent`);
}
assert.equal(Object.keys(product).some(key => /^(win32|darwin)/.test(key)), false);
assert.match(product.commit, /^[0-9a-f]{40}$/);
assert.equal(typeof product.version, 'string');
assert.equal(typeof product.defaultChatAgent.provider.default.id, 'string');
assert.equal(Object.values(product.defaultChatAgent).some(value => typeof value === 'string' && /^(https|wss):/.test(value)), false);
// Check the actual assets copied by the bundle build, not only the source overlay.
for (const path of [
  'vs/workbench/browser/media/code-icon.svg',
  ...['dark', 'light', 'hcDark', 'hcLight'].map(theme => `vs/workbench/browser/parts/editor/media/letterpress-${theme}.svg`),
]) {
  assert.deepEqual(readFileSync(new URL(`build/vscode/out-vscode/${path}`, root)),
    readFileSync(new URL(`assets/vscodium/src/${path}`, root)), path);
  assert.deepEqual(readFileSync(new URL(`build/vscode/out-vscode/media/${path.split('/').at(-1)}`, root)),
    readFileSync(new URL(`assets/vscodium/src/${path}`, root)), `CSS bundle asset: ${path}`);
}
console.log('Product identity, Open VSX, disabled service configuration, and bundled VSCodium assets verified.');
