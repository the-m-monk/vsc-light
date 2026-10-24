use std::path::{Component, Path, PathBuf};

use super::scheme::Scheme;

/// Resolves URI paths against the bundle and shim asset roots.
pub(super) fn resolve(project_dir: &Path, request_path: &str, scheme: Scheme) -> PathBuf {
    let path = Path::new(request_path)
        .components()
        .filter(|part| matches!(part, Component::Normal(_)))
        .collect::<PathBuf>();
    let bundle_root = project_dir.join("build/vscode/out-vscode");

    match scheme {
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
