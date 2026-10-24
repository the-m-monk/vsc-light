# Porting to a new VSCodium version

Current source: stable **1.140.06880**, commit `f33df00b6dd822a163133a48b3c7dab78a520007`. `versions/vscodium.json` is authoritative. Normal builds validate committed vendored changes offline; they do not resolve the newest release or require a VSCodium checkout.

VSCodium's pinned release targets VS Code **1.140.0**, commit `07f806f999227108933c2e30515b26eecc1fda74`. VSC-Light currently uses VS Code **1.143.1**, commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`. Preserve that distinction; updating VSCodium must not automatically change VSC-Light's VS Code pin. See [the VS Code porting guide](vscode.md) for that separate operation.

## Resolve and inspect the candidate

1. Run the explicit network maintenance command:

   ```sh
   python3 scripts/resolve-vscodium.py > /tmp/vscodium-candidate.json
   ```

   It filters out drafts, prereleases and non-stable tag names, resolves the stable release tag to a full SHA (peeling annotated tags), and reads that revision's `upstream/stable.json`. It prints metadata without overwriting the committed pin. Review it before proceeding; never use a release's `target_commitish` branch name as the pin.

2. Record the old pin, then intentionally update `versions/vscodium.json` with the reviewed candidate. Preserve local changes in any maintenance checkout before switching versions. The optional disposable source checkout uses only the recorded SHA:

   ```sh
   python3 scripts/checkout-vscodium.py
   ```

   It fetches the exact commit if missing, checks out detached HEAD in ignored `build/vscodium`, and refuses dirty checkouts or unexpected origins. It does not overwrite vendored adaptations.

3. Fetch the old full SHA into the maintenance checkout if needed, then compare the two exact revisions. Review `prepare_vscode.sh`, `product.json`, `patches/`, `src/stable/`, `undo_telemetry.sh`, `prepare_assets.sh` and `upstream/stable.json`, plus any other changed transformation inputs. Start from the existing source paths, hashes and decisions in `config/vscodium-provenance.json` and `versions/vscodium-inventory.json`; audit changed inputs instead of repeating unchanged work.

## Refresh selected changes

1. Classify new or changed behaviour before importing it. Keep product identity, Open VSX, telemetry/service exclusions and useful workbench behaviour where compatible. Skip Electron runtime/native modules, installers and updater infrastructure; adapt or defer useful host-dependent behaviour for WebKit/Rust. Never apply the whole VSCodium patch directory blindly.
2. Refresh only selected diffs in `patches/vscodium/`, assets in `assets/vscodium/`, and behaviour in `config/vscodium-product.json`. Retain VSC-Light-specific identity/service exclusions in `config/vsc-light-product.json` and compatibility changes in `patches/vscode/`. Keep application branding as VSC Light.
3. Preserve deliberate adaptations: the gallery patch omits Node environment overrides; the font patch implements only global font-family customization; the AI patch extracts the default-off setting. Full proportional font sizing remains deferred because CSS and measured layouts must be ported together. Required account metadata and the empty auto-update extension array currently prevent startup failures; removing complete product objects is not automatically safe.
4. Update `config/vscodium-provenance.json` with the reviewed release/SHA, original paths/source hashes, local artifact hashes and adaptation notes. Update patch origin headers, asset attribution, inventory release/SHA/source hashes and affected decisions/applicability checks. Keep `vscode_revision` in the inventory tied to VSC-Light's actual base. Preserve source licenses and record deferred conflicts.
5. Update the version/SHA note in the root README and the current-base notes in these guides. `versions/vscodium.json` records VSCodium's own VS Code target; document any mismatch with VSC-Light rather than changing either pin implicitly.

## Validate and accept

```sh
python3 scripts/verify-vscodium.py
python3 scripts/verify-vscodium.py --upstream
```

The default verifier checks committed pin/provenance/inventory consistency and local artifact hashes without network access. `--upstream` additionally checks the disposable checkout's exact HEAD, stable VS Code target and referenced source hashes without fetching. Complete reviewed provenance updates before normal preparation, which rejects inconsistent metadata.

Follow the [build and runtime validation steps](vscode.md#validate-the-port): check patch ordering, prepare and rebuild the desktop bundle, compile the shim, run product/asset checks, `cargo check`, filesystem tests and whitespace checks, then launch on a display. Confirm startup, identity, fonts/artwork, Open VSX and renderer-to-Rust filesystem functionality. Keep unsupported host warnings distinct from new regressions. Accept the pin only after this verification; ordinary builds must continue to use committed metadata without release lookups.
