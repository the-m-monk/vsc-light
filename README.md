# vsc-light

vscode with webkit + rs backend instead of electron with vscodium patches

currently x86_64 linux is the only target, although aarch64, riscv64, *BSD, and haiku support is planned

Run these commands from the project root to set up and build:

```sh
mkdir -p build
git clone https://github.com/microsoft/vscode.git build/vscode
git -C build/vscode checkout e646868227c3e3a9e3f24277c8c7220be42c0be7
sh patches/vscode/apply.sh
cp gulpfile.vsc-light.ts build/vscode/build/
cd build/vscode
npm install
node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js --gulpfile build/gulpfile.vsc-light.ts vsc-light-bundle
cd ../..
build/vscode/node_modules/.bin/tsc -p shim/tsconfig.json
cargo run
```

The patches in `patches/vscode` add console diagnostics for renderer startup, desktop service initialization, IPC requests, and MessagePort connections. Messages prefixed with `[vsc-light:...]` show when each stage starts, completes, or fails. Operations that remain pending print a warning after five seconds without being cancelled. This helps identify which service or unanswered IPC request is preventing the workbench from appearing.

After changing VS Code patches or sources, rebuild from the project root:

```sh
sh patches/vscode/apply.sh
cp gulpfile.vsc-light.ts build/vscode/build/
cd build/vscode
node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js --gulpfile build/gulpfile.vsc-light.ts vsc-light-bundle
cd ../..
build/vscode/node_modules/.bin/tsc -p shim/tsconfig.json
cargo build
```

The patch script skips patches that are already applied and stops on conflicts. Run `npm install` again if the VS Code dependencies change or are missing.

## AI assistance

OpenAI Codex is used during development for tasks including code generation, debugging, source analysis, and patching. Codex-assisted changes are reviewed and tested before being accepted. Project direction, architecture, and final implementation decisions remain human-controlled.