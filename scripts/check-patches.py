#!/usr/bin/env python3
"""Verify ordered source patch application against the clean pinned Git index."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = root / 'build/vscode'
with tempfile.TemporaryDirectory(prefix='vsc-light-patch-check-') as temp:
    env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temp) / 'index')}
    subprocess.run(['git', '-C', str(source), 'read-tree', 'HEAD'], env=env, check=True)
    count = 0
    for group in ['vscodium', 'vscode']:
        for patch in sorted((root / 'patches' / group).glob('*.patch')):
            subprocess.run(['git', '-C', str(source), 'apply', '--cached',
                            '--whitespace=error', str(patch)], env=env, check=True)
            count += 1
    print(f'{count} patches apply in distribution/compatibility order with strict whitespace checks.')
