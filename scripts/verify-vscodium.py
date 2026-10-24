#!/usr/bin/env python3
"""Offline pin/provenance checks; optional verification against a pinned checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--upstream', action='store_true', help='also check build/vscodium source bytes (no fetching)')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
pin = json.loads((root / 'versions/vscodium.json').read_text())
provenance = json.loads((root / 'config/vscodium-provenance.json').read_text())
inventory = json.loads((root / 'versions/vscodium-inventory.json').read_text())


def require(condition, message):
    if not condition:
        raise SystemExit(message)


require(re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', pin['version']), 'Pin must name a stable numeric release.')
require(re.fullmatch(r'[0-9a-f]{40}', pin['commit']), 'Pin must contain a full Git commit SHA.')
require(re.fullmatch(r'[0-9a-f]{40}', pin['vscode']['commit']), 'VS Code target must contain a full SHA.')
require(pin['repository'] == 'https://github.com/VSCodium/vscodium.git', 'Unexpected pin repository.')
require(pin['releaseUrl'] == f"https://github.com/VSCodium/vscodium/releases/tag/{pin['version']}", 'Release URL differs from pin.')
require((provenance['version'], provenance['commit']) == (pin['version'], pin['commit']), 'Provenance differs from pin.')
require((inventory['vscodium_release'], inventory['vscodium_revision']) == (pin['version'], pin['commit']), 'Audit inventory differs from pin.')
expected = {str(path.relative_to(root)) for path in (root / 'patches/vscodium').glob('*.patch')}
expected.update(str(path.relative_to(root)) for path in (root / 'assets/vscodium/src').rglob('*.svg'))
expected.update(['assets/vscodium/LICENSE', 'config/vscodium-product.json', 'config/vsc-light-product.json'])
require({entry['local'] for entry in provenance['artifacts']} == expected, 'Provenance coverage is incomplete.')
for entry in provenance['artifacts']:
    require(hashlib.sha256((root / entry['local']).read_bytes()).hexdigest() == entry['localSha256'],
            f"Artifact changed; review/update provenance: {entry['local']}")
if args.upstream:
    def git(*arguments):
        return subprocess.check_output(['git', '-C', str(root / 'build/vscodium'), *arguments])
    require(git('rev-parse', 'HEAD').decode().strip() == pin['commit'], 'VSCodium checkout HEAD differs from pin.')
    target = json.loads(git('show', pin['commit'] + ':upstream/stable.json'))
    require((target['tag'], target['commit']) == (pin['vscode']['version'], pin['vscode']['commit']), 'VS Code target differs from upstream manifest.')
    for entry in provenance['artifacts']:
        for source in entry['sources']:
            require(hashlib.sha256(git('show', pin['commit'] + ':' + source['path'])).hexdigest() == source['sha256'],
                    f"Upstream source differs from provenance: {source['path']}")
print(f"Verified pinned VSCodium {pin['version']} ({pin['commit']}); no network lookup.")
