use std::path::PathBuf;

use webkit6::WebContext;

use super::request::serve;

#[derive(Clone, Copy)]
pub(super) enum Scheme {
    App,
    File,
}

impl Scheme {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::App => "vsc-light",
            Self::File => "vscode-file",
        }
    }
}

pub fn register(context: &WebContext, project_dir: PathBuf) {
    for scheme in [Scheme::App, Scheme::File] {
        if let Some(security) = context.security_manager() {
            security.register_uri_scheme_as_local(scheme.name());
            security.register_uri_scheme_as_secure(scheme.name());
            security.register_uri_scheme_as_cors_enabled(scheme.name());
        }

        let root = project_dir.clone();
        context.register_uri_scheme(scheme.name(), move |request| {
            serve(request, &root, scheme);
        });
    }
}
