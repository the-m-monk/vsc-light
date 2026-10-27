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
            .replace(
                "font-src\n\t\t\t\t\t'self'",
                "font-src\n\t\t\t\t\t'self'\n\t\t\t\t\tvscode-file:\n\t\t\t\t\tvsc-light:",
            )
            .replace(
                "img-src\n\t\t\t\t\t'self'",
                "img-src\n\t\t\t\t\t'self'\n\t\t\t\t\tvscode-file:\n\t\t\t\t\tvsc-light:",
            )
            .replace(
                "connect-src\n\t\t\t\t\t'self'",
                "connect-src\n\t\t\t\t\t'self'\n\t\t\t\t\tvscode-file:",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workbench_policy_allows_local_wasm_fetches() {
        let html = "connect-src\n\t\t\t\t\t'self'\n\t\t\t\t\thttps:\n\t\t\t\t\tws:\n\t\t\t\t;";
        let result = rewrite(
            Path::new("vs/code/electron-browser/workbench/workbench.html"),
            html.as_bytes().to_vec(),
        );
        assert_eq!(
            String::from_utf8(result).unwrap(),
            "connect-src\n\t\t\t\t\t'self'\n\t\t\t\t\tvscode-file:\n\t\t\t\t\thttps:\n\t\t\t\t\tws:\n\t\t\t\t;"
        );
    }
}
