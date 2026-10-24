// Native extension package helper. Uses the ZIP library already pinned by VS Code.
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createPublicKey, verify } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yauzl from '../build/vscode/node_modules/yauzl/index.js';
import semver from '../build/vscode/node_modules/semver/index.js';

const uri = value => ({ $mid: 1, scheme: 'file', authority: '', path: value, query: '', fragment: '' });
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
function identifier(manifest) {
  if (![manifest.publisher, manifest.name].every(value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(value)) || !semver.valid(manifest.version)) throw new Error('Invalid extension identity or version');
  return `${manifest.publisher}.${manifest.name}`.toLowerCase();
}
function inside(root, location) {
  const relative = path.relative(path.resolve(root), path.resolve(location));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Extension location is outside the user extension store');
  return path.resolve(location);
}
async function local(location, builtin = false) {
  const manifest = await readJSON(path.join(location, 'package.json'));
  if (builtin && !manifest.publisher) manifest.publisher = 'vscode';
  const id = identifier(manifest);
  const metadata = manifest.__metadata ?? {};
  delete manifest.__metadata;
  const files = await fs.readdir(location);
  const find = prefix => files.find(name => new RegExp(`^${prefix}(\\.md|\\.txt)?$`, 'i').test(name));
  const readme = find('readme'), changelog = find('changelog');
  return { identifier: { id, uuid: metadata.id }, manifest, location: uri(location),
    // Match NativeExtensionsScannerService: absent metadata means UNDEFINED, not UNIVERSAL.
    // Different values make unchanged bundled extensions appear to require a restart.
    type: builtin ? 0 : 1, isBuiltin: builtin, targetPlatform: metadata.targetPlatform ?? 'undefined',
    isValid: true, validations: [], isWorkspaceScoped: false, isMachineScoped: !!metadata.isMachineScoped,
    isApplicationScoped: !!metadata.isApplicationScoped, publisherId: metadata.publisherId ?? null,
    publisherDisplayName: metadata.publisherDisplayName, installedTimestamp: metadata.installedTimestamp,
    isPreReleaseVersion: !!metadata.isPreReleaseVersion, hasPreReleaseVersion: !!metadata.hasPreReleaseVersion,
    private: !!metadata.private, preRelease: !!metadata.preRelease, updated: !!metadata.updated,
    pinned: !!metadata.pinned, forceAutoUpdate: false, source: metadata.source ?? 'resource', size: metadata.size ?? 0,
    readmeUrl: readme ? uri(path.join(location, readme)) : undefined,
    changelogUrl: changelog ? uri(path.join(location, changelog)) : undefined,
    metadata,
  };
}
async function scan(root, builtin = false) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const extensions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try { extensions.push(await local(path.join(root, entry.name), builtin)); }
    catch (error) { if (error.code !== 'ENOENT') console.error(`Skipping extension ${entry.name}: ${error.message}`); }
  }
  return extensions;
}
async function installed(paths, type = null) {
  const users = await scan(paths.root);
  const selected = new Map();
  // The profile selects the active version; retain older versions on disk until explicitly removed.
  const index = await readJSON(paths.profile).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const extension of users) {
    const previous = selected.get(extension.identifier.id);
    const active = index.some(entry => entry.identifier.id === extension.identifier.id && entry.version === extension.manifest.version);
    if (!previous || active || (!index.some(entry => entry.identifier.id === extension.identifier.id) && semver.gt(extension.manifest.version, previous.manifest.version))) selected.set(extension.identifier.id, extension);
  }
  return [...(type !== 1 ? await scan(paths.builtin, true) : []), ...(type !== 0 ? [...selected.values()] : [])];
}
async function updateIndex(paths, extension, remove = false) {
  const index = await readJSON(paths.profile).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const result = index.filter(entry => entry.identifier.id.toLowerCase() !== extension.identifier.id);
  if (!remove) result.push({ identifier: extension.identifier, version: extension.manifest.version, location: extension.location, metadata: extension.metadata });
  await writeJSON(paths.profile, result);
}
const openZip = file => new Promise((resolve, reject) => (Buffer.isBuffer(file) ? yauzl.fromBuffer : yauzl.open)(file, { lazyEntries: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
const entryStream = (zip, entry) => new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
async function readZipEntry(vsix, name, limit) {
  const zip = await openZip(vsix);
  return new Promise((resolve, reject) => {
    let found = false;
    zip.on('error', reject);
    zip.on('end', () => { if (!found) reject(new Error(`Archive does not contain ${name}`)); });
    zip.on('entry', async entry => {
      if (entry.fileName !== name) { zip.readEntry(); return; }
      found = true;
      try {
        if (entry.uncompressedSize > limit) throw new Error('Archive entry is too large');
        const chunks = [];
        for await (const chunk of await entryStream(zip, entry)) chunks.push(chunk);
        resolve(Buffer.concat(chunks));
      } catch (error) { reject(error); }
      finally { zip.close(); }
    });
    zip.readEntry();
  });
}
async function readManifest(vsix) {
  const manifest = JSON.parse((await readZipEntry(vsix, 'extension/package.json', 1024 * 1024)).toString('utf8'));
  identifier(manifest);
  return manifest;
}
async function extract(vsix, destination) {
  const zip = await openZip(vsix);
  let total = 0, entries = 0;
  return new Promise((resolve, reject) => {
    const fail = error => { zip.close(); reject(error); };
    zip.on('error', fail); zip.on('end', resolve);
    zip.on('entry', async entry => {
      try {
        if (++entries > 50000 || (total += entry.uncompressedSize) > 512 * 1024 * 1024) throw new Error('VSIX exceeds extraction limits');
        if (!entry.fileName.startsWith('extension/')) { zip.readEntry(); return; }
        const relative = entry.fileName.slice('extension/'.length);
        if (!relative) { zip.readEntry(); return; }
        if (relative.includes('\\') || relative.split('/').some(part => part === '..') || path.isAbsolute(relative)) throw new Error('Unsafe VSIX entry path');
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0o170000) === 0o120000) throw new Error('VSIX symbolic links are not supported');
        const target = inside(destination, path.join(destination, relative));
        if (relative.endsWith('/')) await fs.mkdir(target, { recursive: true });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await pipeline(await entryStream(zip, entry), createWriteStream(target, { flags: 'wx', mode: mode & 0o111 ? 0o755 : 0o644 }));
        }
        zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
}
async function execute({ operation, args, paths }) {
  await fs.mkdir(paths.root, { recursive: true });
  if (args?.profileLocation && path.resolve(args.profileLocation) !== path.resolve(paths.profile)) throw new Error('Only the default extension profile is supported');
  switch (operation) {
    case 'getInstalled': return installed(paths, args.type ?? null);
    case 'getManifest': return readManifest(args.path);
    case 'install': {
      let archive = args.path;
      if (args.signature) {
        archive = await fs.readFile(args.path);
        const signature = await readZipEntry(args.signature.path, '.signature.sig', 4096);
        const publicKey = createPublicKey(args.signature.publicKey);
        if (!verify(null, archive, publicKey, signature)) throw new Error('Open VSX package signature is invalid');
      }
      const manifest = await readManifest(archive);
      const id = identifier(manifest);
      if (args.expectedId && id !== args.expectedId.toLowerCase()) throw new Error('Downloaded extension identity does not match the gallery');
      if (args.expectedVersion && manifest.version !== args.expectedVersion) throw new Error('Downloaded extension version does not match the gallery');
      const product = await readJSON(new URL('../build/vscode/package.json', import.meta.url));
      if (!manifest.engines?.vscode || !semver.satisfies(product.version, manifest.engines.vscode, { includePrerelease: true })) throw new Error(`Extension requires VS Code ${manifest.engines?.vscode ?? '(unspecified)'}`);
      if (args.metadata?.targetPlatform && !/^[a-z0-9-]+$/.test(args.metadata.targetPlatform)) throw new Error('Invalid target platform');
      const stage = await fs.mkdtemp(path.join(paths.root, '.install-'));
      const target = inside(paths.root, path.join(paths.root, `${id}-${manifest.version}${args.metadata?.targetPlatform && args.metadata.targetPlatform !== 'universal' ? '-' + args.metadata.targetPlatform : ''}`));
      const backup = path.join(paths.root, `.backup-${randomUUID()}`);
      let backedUp = false, moved = false;
      try {
        await extract(archive, stage);
        const extracted = await readJSON(path.join(stage, 'package.json'));
        if (identifier(extracted) !== id || extracted.version !== manifest.version) throw new Error('VSIX contains inconsistent manifests');
        extracted.__metadata = { ...args.metadata, signatureVerified: !!args.signature, source: args.metadata?.source ?? 'vsix', installedTimestamp: Date.now() };
        await writeJSON(path.join(stage, 'package.json'), extracted);
        try { await fs.rename(target, backup); backedUp = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(stage, target); moved = true;
        const result = await local(target);
        await updateIndex(paths, result);
        if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(error => console.error(`Extension backup cleanup: ${error.message}`));
        return result;
      } catch (error) {
        if (moved) await fs.rm(target, { recursive: true, force: true });
        if (backedUp) await fs.rename(backup, target);
        throw error;
      } finally { await fs.rm(stage, { recursive: true, force: true }); }
    }
    case 'uninstall': {
      const target = inside(paths.root, args.path);
      const extension = await local(target);
      const current = await installed(paths);
      if (!args.options?.donotCheckDependents) {
        const dependents = current.filter(item => item.manifest.extensionDependencies?.some(id => id.toLowerCase() === extension.identifier.id));
        if (dependents.length) throw new Error(`Required by ${dependents.map(item => item.identifier.id).join(', ')}`);
      }
      const moved = [];
      try {
        for (const item of await scan(paths.root)) if (item.identifier.id === extension.identifier.id) {
          const source = inside(paths.root, item.location.path);
          const backup = path.join(paths.root, `.uninstall-${randomUUID()}`);
          await fs.rename(source, backup); moved.push([source, backup]);
        }
        await updateIndex(paths, extension, true);
      } catch (error) {
        for (const [source, backup] of moved) await fs.rename(backup, source);
        throw error;
      }
      for (const [, backup] of moved) await fs.rm(backup, { recursive: true, force: true }).catch(error => console.error(`Extension uninstall cleanup: ${error.message}`));
      return null;
    }
    case 'updateMetadata': {
      const target = inside(paths.root, args.path);
      const manifest = await readJSON(path.join(target, 'package.json'));
      manifest.__metadata = { ...manifest.__metadata, ...args.metadata };
      await writeJSON(path.join(target, 'package.json'), manifest);
      const result = await local(target); await updateIndex(paths, result); return result;
    }
    default: throw new Error(`Unsupported extension operation: ${operation}`);
  }
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
try { process.stdout.write(JSON.stringify({ ok: true, value: await execute(JSON.parse(input)) })); }
catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'EIO', message: error.message } })); process.exitCode = 1; }
