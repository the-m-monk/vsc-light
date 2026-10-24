# Porting to a new VS Code version

Current base: VS Code **1.143.1**, commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`. The source pin is enforced by `scripts/prepare-product.mjs` and shown in the root README. Updating VS Code and [updating VSCodium](vscodium.md) are separate maintenance operations.

## Prepare and compare

1. Choose the intended VS Code release and resolve its tag to a full commit SHA. Check that revision's `package.json` version and build requirements. Record both the version and SHA; do not build from a moving branch.
2. Preserve changes in the existing `build/vscode` checkout, including any experiments or rebased patches. Use a fresh disposable checkout at the candidate SHA for the port; do not reset a dirty checkout. Keep the previous source available for comparison.
3. Compare changed APIs and startup paths with the old base. Focus on workbench bootstrap, product configuration, service registration, configuration defaults, asset bundling, Electron compatibility interfaces, IPC serialization and the local filesystem channel. Keep native functionality behind the generic TypeScript/Rust RPC boundary.

## Rebase the integration

1. Update the revision guard in `scripts/prepare-product.mjs` and the version/SHA in the root README. Update `vscode_revision` in `versions/vscodium-inventory.json` after rechecking its recorded applicability results against the candidate. That inventory field identifies VSC-Light's base; `versions/vscodium.json` describes VSCodium's own release target and must not be changed to pretend it targets the candidate.
2. Rebase `patches/vscodium/` first, then `patches/vscode/`. Preserve the intent and source origin of each patch. Drop an obsolete hunk only after confirming upstream now provides its behaviour. Regenerate only the affected diffs; exclude unrelated checkout changes.
3. Adapt source overlays in `vscode/src/`, the Electron shim in `shim/src/`, Rust host/asset handling in `src/`, and `gulpfile.vsc-light.ts` as required by actual API changes. Do not restore Electron or bypass the host boundary to make startup pass.
4. Review the committed upstream `product.json` against `config/vscodium-product.json` and `config/vsc-light-product.json`. Check new service endpoints, mandatory structural fields, Open VSX templates, telemetry, identity and unsupported native integrations. Keep VSC Light branding and deliberate service exclusions. The generator starts from the committed upstream product; do not edit its generated output as the lasting fix.
5. For changed derived artifacts, update local hashes and adaptation notes in `config/vscodium-provenance.json`. Keep original source paths/hashes tied to the unchanged VSCodium pin; adapting to a new VS Code base does not change the VSCodium source revision. Recheck and update affected inventory decisions/results rather than relabelling old applicability checks as current.
6. Install dependencies using the candidate's supported Node/package tooling. Copying or sharing the old checkout's `node_modules` is not a substitute for installing the candidate's dependencies.

## Validate the port

Run from the project root, after installing the candidate checkout's dependencies:

```sh
python3 scripts/verify-vscodium.py
python3 scripts/check-patches.py
sh scripts/prepare-vscode.sh
node --experimental-strip-types --max-old-space-size=8192 build/vscode/node_modules/gulp/bin/gulp.js --gulpfile build/vscode/build/gulpfile.vsc-light.ts vsc-light-bundle
build/vscode/node_modules/.bin/tsc -p shim/tsconfig.json
node scripts/verify-product.mjs
cargo check
cargo test
git diff --check
git -C build/vscode diff --check
VSC_LIGHT_VERIFY_FILESYSTEM=1 cargo run
```

`check-patches.py` checks distribution → compatibility ordering against a temporary index populated from the checkout's HEAD. Confirm HEAD is the intended candidate SHA; preparation also checks it against the revision guard. Preparation validates provenance offline, generates the layered product, applies patches/assets and copies the VSC-Light adapters and bundle task.

On a display, confirm the workbench renders and completes startup, VSC Light identity and VSCodium artwork remain, the font-family setting works, Open VSX is configured, and renderer-to-Rust filesystem stat/binary-read probes succeed. Compare warnings with the previous build and investigate new failures. Extension installation, terminals and unsupported native services should not be claimed as working merely because the workbench renders. Record the tested versions and remaining limitations with the port.
