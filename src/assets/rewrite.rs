use std::path::Path;

pub(super) fn rewrite(path: &Path, contents: Vec<u8>) -> Vec<u8> {
    if path.ends_with("vs/code/electron-browser/workbench/workbench.html") {
        String::from_utf8_lossy(&contents)
            .replace(
                "trusted-types\n\t\t\t\t\tamdLoader",
                "trusted-types\n\t\t\t\t\tvscLightShim\n\t\t\t\t\tamdLoader",
            )
            .replace(
                "script-src\n\t\t\t\t\t'self'",
                "script-src\n\t\t\t\t\t'self'\n\t\t\t\t\tvscode-file:\n\t\t\t\t\tvsc-light:",
            )
            .into_bytes()
    } else if path.ends_with("vs/code/electron-browser/workbench/workbench.js") {
        format!(
            "import \"vsc-light://app/shim/dist/workbenchPreload.js\";\n{}",
            String::from_utf8_lossy(&contents)
        )
        .into_bytes()
    } else {
        contents
    }
}
