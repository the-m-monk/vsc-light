#!/bin/sh
set -eu

patch_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
vscode_dir="$patch_dir/../../build/vscode"

for patch_file in "$patch_dir"/*.patch; do
    if git -C "$vscode_dir" apply --reverse --check "$patch_file" 2>/dev/null; then
        echo "Already applied: $(basename "$patch_file")"
    elif git -C "$vscode_dir" apply --check "$patch_file"; then
        git -C "$vscode_dir" apply "$patch_file"
        echo "Applied: $(basename "$patch_file")"
    else
        echo "Cannot apply patch: $patch_file" >&2
        exit 1
    fi
done

# VSC-Light adapters live outside the upstream checkout so they can be rebased
# independently of the small integration patches above.
cp -R "$patch_dir/../../vscode/src/." "$vscode_dir/src/"
