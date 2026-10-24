import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import yazl from '../build/vscode/node_modules/yazl/index.js';

const directory = await fs.mkdtemp(path.join(tmpdir(), 'vsc-light-extension-store-'));
const helper = fileURLToPath(new URL('./extension-store.mjs', import.meta.url));
const paths = { root: path.join(directory, 'extensions'), builtin: path.join(directory, 'builtin'), profile: path.join(directory, 'profile.json'), cache: path.join(directory, 'cache') };
const manifest = { publisher: 'fixture', name: 'theme', version: '1.0.0', engines: { vscode: '^1.80.0' }, contributes: { themes: [{ label: 'Fixture', uiTheme: 'vs-dark', path: './theme.json' }] } };
async function vsix(file, manifest, symlink = false) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'extension/package.json');
  zip.addBuffer(Buffer.from('{"colors":{}}'), 'extension/theme.json');
  if (symlink) zip.addBuffer(Buffer.from('/etc/passwd'), 'extension/link', { mode: 0o120777 });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
}
function call(operation, args = {}, success = true) {
  const result = spawnSync(process.execPath, [helper], { input: JSON.stringify({ operation, args, paths }), encoding: 'utf8' });
  assert.equal(result.error, undefined);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, success, response.error?.message);
  return success ? response.value : response.error;
}
try {
  await fs.mkdir(paths.builtin, { recursive: true });
  await fs.writeFile(paths.profile, '[]');
  const builtin = path.join(paths.builtin, 'bundled-theme');
  await fs.mkdir(builtin);
  await fs.writeFile(path.join(builtin, 'package.json'), JSON.stringify(manifest));
  const bundled = call('getInstalled', { type: 0 });
  assert.equal(bundled.length, 1);
  assert.equal(bundled[0].isBuiltin, true);
  assert.equal(bundled[0].targetPlatform, 'undefined', 'Must agree with the upstream runtime scanner to avoid false restart badges');
  const packagePath = path.join(directory, 'theme.vsix');
  await vsix(packagePath, manifest);
  assert.equal(call('getManifest', { path: packagePath }).name, 'theme');
  const extension = call('install', { path: packagePath, expectedId: 'fixture.theme', expectedVersion: '1.0.0', metadata: { source: 'gallery', targetPlatform: 'universal' } });
  assert.equal(extension.identifier.id, 'fixture.theme');
  assert.equal(extension.targetPlatform, 'universal', 'Explicit gallery platform must be preserved');
  assert.equal((await fs.readFile(path.join(extension.location.path, 'theme.json'), 'utf8')), '{"colors":{}}');
  assert.equal(call('getInstalled', { type: 1 })[0].identifier.id, 'fixture.theme');
  assert.equal(JSON.parse(await fs.readFile(paths.profile, 'utf8'))[0].version, '1.0.0');
  call('updateMetadata', { path: extension.location.path, metadata: { pinned: true } });
  assert.equal(call('getInstalled', { type: 1 })[0].pinned, true);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signaturePath = path.join(directory, 'theme.sigzip');
  async function signatureFile(bytes) {
    const zip = new yazl.ZipFile(); zip.addBuffer(bytes, '.signature.sig'); zip.end();
    await pipeline(zip.outputStream, createWriteStream(signaturePath));
  }
  await signatureFile(sign(null, await fs.readFile(packagePath), privateKey));
  const signature = { path: signaturePath, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  const signed = call('install', { path: packagePath, signature, metadata: { pinned: true } });
  assert.equal(signed.metadata.signatureVerified, true);
  await signatureFile(Buffer.alloc(64));
  assert.match(call('install', { path: packagePath, signature }, false).message, /signature is invalid/);
  assert.match(call('install', { path: packagePath, expectedId: 'different.extension' }, false).message, /identity/);
  await vsix(packagePath, manifest, true);
  assert.match(call('install', { path: packagePath }, false).message, /symbolic link/);
  assert.equal(call('getInstalled', { type: 1 })[0].pinned, true, 'Failed replacement must preserve installed extension');
  await vsix(packagePath, { ...manifest, engines: { vscode: '^999.0.0' } });
  assert.match(call('install', { path: packagePath }, false).message, /requires VS Code/);
  assert.match(call('uninstall', { path: directory }, false).message, /outside/);
  call('uninstall', { path: extension.location.path });
  assert.deepEqual(call('getInstalled', { type: 1 }), []);
  assert.deepEqual(JSON.parse(await fs.readFile(paths.profile, 'utf8')), []);
  assert.deepEqual(await fs.readdir(paths.root), []);
  console.log('PASS: VSIX install, persistent discovery, profile index, metadata, uninstall, identity/engine validation, symlink rejection, and failed replacement preserves existing files');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
