# Reviewed VSCodium-derived changes

Origin: https://github.com/VSCodium/vscodium/tree/f33df00b6dd822a163133a48b3c7dab78a520007

Apply via `sh scripts/prepare-vscode.sh`, before `patches/vscode/`. Each patch records its source and adaptation in its header. See `docs/maintenance/vscodium.md` and the complete inventory for decisions and applicability at the pinned VS Code revision.

- `00-tunnel-disable-recommendation.patch`: unchanged renderer guard for absent tunnel extension metadata.
- `00-chat-disable-ai.patch`: extract the default-off AI setting; required product account metadata stays, while URL fields are removed by the VSC-Light layer.
- `00-telemetry-disable.patch`: unchanged upstream diff, including the crash-setting default in the existing desktop renderer contribution.
- `00-settings-gallery.patch`: upstream types and latest-version manifest URL; omit Node environment overrides.
- `00-ui-font-family.patch`: extract global family setting, CSS variable/fallbacks and startup/change handler from the much larger custom-font patch. No size/layout/editor changes.
- `81-ui-disable-onboarding.patch`: unchanged upstream diff. Deleting the now-unreferenced source directory is unnecessary.

`apply.sh` also overlays only the reviewed stable workbench assets from `assets/vscodium/`. No script downloads or patches a moving VSCodium HEAD during a normal build.

Stable release: **1.140.06880**. The authoritative pin is `versions/vscodium.json`; original source paths and hashes are mapped in `config/vscodium-provenance.json`. See `docs/maintenance/vscodium.md` for explicit updates.
