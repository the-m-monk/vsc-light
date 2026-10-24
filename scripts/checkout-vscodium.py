#!/usr/bin/env python3
"""Optional disposable source checkout, using only the committed VSCodium pin."""
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
pin = json.loads((root / 'versions/vscodium.json').read_text())
if (pin['repository'] != 'https://github.com/VSCodium/vscodium.git'
        or not re.fullmatch(r'[0-9a-f]{40}', pin['commit'])
        or not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', pin['version'])):
    raise SystemExit('Expected a stable VSCodium pin with a full commit SHA.')
source = root / 'build/vscodium'


def git(*args, capture=False):
    return subprocess.run(['git', '-C', str(source), *args], check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


if not source.exists():
    source.mkdir(parents=True)
    git('init', '--quiet')
    git('remote', 'add', 'origin', pin['repository'])
if git('remote', 'get-url', 'origin', capture=True).strip() != pin['repository']:
    raise SystemExit('Unexpected VSCodium origin; refusing to modify this checkout.')
if git('status', '--porcelain', capture=True).strip():
    raise SystemExit('VSCodium checkout has local changes; preserve them before updating the checkout.')
if subprocess.run(['git', '-C', str(source), 'cat-file', '-e', pin['commit'] + '^{commit}'],
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
    git('fetch', '--depth=1', 'origin', pin['commit'])
git('checkout', '--detach', pin['commit'])
if git('rev-parse', 'HEAD', capture=True).strip() != pin['commit']:
    raise SystemExit('VSCodium checkout does not match committed pin.')
print(f"VSCodium {pin['version']} at {pin['commit']}")
