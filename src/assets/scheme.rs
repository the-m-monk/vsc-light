use std::path::PathBuf;

use webkit6::WebContext;

use super::request::serve;

#[derive(Clone, Copy)]
pub(super) enum Scheme {
    App,
    File,
    Webview,
}

impl Scheme {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::App => "vsc-light",
            Self::File => "vscode-file",
            Self::Webview => "vscode-webview",
        }
    }
}

pub fn register(context: &WebContext, project_dir: PathBuf) {
    for scheme in [Scheme::App, Scheme::File, Scheme::Webview] {
        if let Some(security) = context.security_manager() {
            // Local/file schemes get opaque per-document access restrictions in WebKit.
            // Webviews need normal host-based origins for the nested content iframe.
            if !matches!(scheme, Scheme::Webview) {
                security.register_uri_scheme_as_local(scheme.name());
            }
            security.register_uri_scheme_as_secure(scheme.name());
            security.register_uri_scheme_as_cors_enabled(scheme.name());
        }

        let root = project_dir.clone();
        context.register_uri_scheme(scheme.name(), move |request| {
            serve(request, &root, scheme);
        });
    }
}
