#!/usr/bin/env python3
"""Explicit maintenance command: resolve newest stable release; never write the pin."""
import json
import re
import subprocess
from urllib.request import Request, urlopen

repository = 'https://github.com/VSCodium/vscodium.git'
# GitHub lists releases newest first. Page past drafts/prereleases/non-stable tags.
# This also avoids relying on the mutable target_commitish field.
page = 1
while True:
    suffix = '' if page == 1 else f'&page={page}'
    request = Request('https://api.github.com/repos/VSCodium/vscodium/releases?per_page=20' + suffix,
                      headers={'User-Agent': 'vsc-light-pin-maintenance'})
    with urlopen(request, timeout=30) as response:
        releases = json.load(response)
    if not releases:
        raise SystemExit('No stable VSCodium release found.')
    release = next((item for item in releases if not item['draft'] and not item['prerelease']
                    and re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', item['tag_name'])), None)
    if release:
        break
    page += 1
tag = release['tag_name']
if release['draft'] or release['prerelease'] or not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', tag):
    raise SystemExit(f'Refusing non-stable release: {tag}')
# An annotated tag must be peeled; target_commitish may merely be "master".
refs = subprocess.check_output(['git', 'ls-remote', '--tags', repository,
                                f'refs/tags/{tag}', f'refs/tags/{tag}^{{}}'], text=True)
resolved = dict(line.split()[::-1] for line in refs.splitlines())
commit = resolved.get(f'refs/tags/{tag}^{{}}', resolved.get(f'refs/tags/{tag}'))
if not commit or not re.fullmatch(r'[0-9a-f]{40}', commit):
    raise SystemExit('Stable release tag did not resolve to a full commit SHA.')
request = Request(f'https://raw.githubusercontent.com/VSCodium/vscodium/{commit}/upstream/stable.json',
                  headers={'User-Agent': 'vsc-light-pin-maintenance'})
with urlopen(request, timeout=30) as response:
    upstream = json.load(response)
print(json.dumps({'repository': repository, 'version': tag, 'commit': commit,
                  'releaseUrl': release['html_url'],
                  'vscode': {'version': upstream['tag'], 'commit': upstream['commit']}}, indent=2))
