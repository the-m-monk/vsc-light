use std::path::{Component, Path, PathBuf};

use super::scheme::Scheme;

/// Resolves URI paths against the bundle and shim asset roots.
pub(super) fn resolve(project_dir: &Path, request_path: &str, scheme: Scheme) -> PathBuf {
    // Browser-loaded extension images/scripts may use their real file paths.
    // Resolve links first, and serve only files within the two extension stores.
    if matches!(scheme, Scheme::File) {
        if let Ok(requested) = Path::new(request_path).canonicalize() {
            for root in [
                project_dir.join("build/vscode/extensions"),
                gtk4::glib::home_dir().join(".vsc-light/extensions"),
            ] {
                if root
                    .canonicalize()
                    .is_ok_and(|root| requested.starts_with(root))
                {
                    return requested;
                }
            }
        }
    }
    // FileAccess uses the real appRoot in browser URLs as well as in Node init data.
    // Map its absolute bundle paths onto the same virtual layout as /out/ URLs.
    let request_path = Path::new(request_path);
    let bundle_dir = project_dir.join("build/vscode");
    let relative_path = if matches!(scheme, Scheme::File) {
        request_path
            .strip_prefix(&bundle_dir)
            .unwrap_or(request_path)
    } else {
        request_path
    };
    let path = relative_path
        .components()
        .filter(|part| matches!(part, Component::Normal(_)))
        .collect::<PathBuf>();
    let bundle_root = project_dir.join("build/vscode/out-vscode");

    match scheme {
        // Keep each hashed webview origin isolated and expose only its bootstrap files.
        Scheme::Webview => match request_path.to_str().unwrap_or_default() {
            "/index.html" | "/fake.html" | "/service-worker.js" => bundle_root
                .join("vs/workbench/contrib/webview/browser/pre")
                .join(path),
            _ => bundle_root.join("__not_found__"),
        },
        // Electron's unpacked ASAR paths refer to ordinary node_modules in this build.
        Scheme::File | Scheme::App if path.starts_with("node_modules.asar.unpacked") => project_dir
            .join("build/vscode/node_modules")
            .join(path.strip_prefix("node_modules.asar.unpacked").unwrap()),
        // xterm and its addons are loaded as browser scripts outside the compiled out/ tree.
        Scheme::File | Scheme::App if path.starts_with("node_modules") => {
            project_dir.join("build/vscode").join(path)
        }
        Scheme::File => bundle_root.join(
            path.strip_prefix("out")
                .unwrap_or(Path::new("__not_found__")),
        ),
        Scheme::App if path == Path::new("product.json") => {
            project_dir.join("build/vscode").join(path)
        }
        Scheme::App if path.starts_with("shim") => project_dir.join(path),
        Scheme::App => bundle_root.join(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacked_asar_resources_resolve_to_node_modules() {
        let root = Path::new("/project");
        let expected = root.join("build/vscode/node_modules/vscode-oniguruma/release/onig.wasm");
        for scheme in [Scheme::File, Scheme::App] {
            assert_eq!(
                resolve(
                    root,
                    "/node_modules.asar.unpacked/vscode-oniguruma/release/onig.wasm",
                    scheme
                ),
                expected
            );
        }
    }

    #[test]
    fn absolute_app_root_resources_use_the_virtual_bundle_layout() {
        let root = Path::new("/project");
        assert_eq!(
            resolve(
                root,
                "/project/build/vscode/out/vs/workbench/workbench.desktop.main.js",
                Scheme::File
            ),
            root.join("build/vscode/out-vscode/vs/workbench/workbench.desktop.main.js")
        );
        assert_eq!(
            resolve(
                root,
                "/project/build/vscode/node_modules.asar.unpacked/vscode-oniguruma/release/onig.wasm",
                Scheme::File
            ),
            root.join("build/vscode/node_modules/vscode-oniguruma/release/onig.wasm")
        );
        assert!(resolve(root, "/outside/secrets.json", Scheme::File).ends_with("__not_found__"));
    }
}
