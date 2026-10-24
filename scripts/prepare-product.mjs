#!/usr/bin/env node
// Layer pinned VS Code -> reviewed VSCodium behaviour -> VSC-Light identity.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'build/vscode');
const revision = 'e646868227c3e3a9e3f24277c8c7220be42c0be7';
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== revision) {
  throw new Error(`Expected VS Code ${revision}; review product and patch compatibility before updating the pin.`);
}
const read = name => JSON.parse(readFileSync(resolve(root, 'config', name), 'utf8'));
const merge = (base, overlay) => {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) delete base[key];
    else if (typeof value === 'object' && !Array.isArray(value)) {
      base[key] = merge(typeof base[key] === 'object' && base[key] !== null ? base[key] : {}, value);
    } else base[key] = value;
  }
  return base;
};
// Always regenerate from the committed pin, not a previously transformed product.
const upstream = JSON.parse(git('show', `${revision}:product.json`));
const product = merge(merge(upstream, read('vscodium-product.json')), read('vsc-light-product.json'));
// This runtime has no Windows/macOS packaging. Future ports must supply their own IDs.
for (const key of Object.keys(product)) {
  if (/^(win32|darwin)/.test(key)) delete product[key];
}
const pkg = JSON.parse(git('show', `${revision}:package.json`));
product.version = pkg.version;
product.commit = revision;
writeFileSync(resolve(source, 'product.json'), JSON.stringify(product, null, '\t') + '\n');
console.log(`Generated VSC Light product configuration from ${revision}`);
