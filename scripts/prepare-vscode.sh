#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python3 "$root/scripts/verify-vscodium.py"
node "$root/scripts/prepare-product.mjs"
sh "$root/patches/vscodium/apply.sh"
sh "$root/patches/vscode/apply.sh"
cp "$root/gulpfile.vsc-light.ts" "$root/build/vscode/build/gulpfile.vsc-light.ts"
