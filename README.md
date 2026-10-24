# vsc-light

vscode with webkit + rs backend instead of electron with vscodium patches

Currently x86_64 linux is the only target, although aarch64, riscv64, *BSD, and haiku support is planned

vsc-light is currently based on:

- VS Code **1.143.1**, commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`.
- VSCodium **1.140.06880**, commit `f33df00b6dd822a163133a48b3c7dab78a520007`.

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

## AI assistance

OpenAI Codex is used during development for tasks including code generation, debugging, source analysis, and patching. Codex-assisted changes are reviewed and tested before being accepted. Project direction, architecture, and final implementation decisions remain human-controlled.
