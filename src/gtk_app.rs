//! GTK application lifecycle and WebKit window construction.

mod bridge;
mod diagnostics;
mod extensions;
mod network;
mod window;

use std::path::PathBuf;

use gtk4::{Application, ApplicationWindow, prelude::*};
use webkit6::{UserContentManager, WebContext, WebView, prelude::*};

use crate::assets;

const APPLICATION_ID: &str = "dev.vsc_light.WebView";
const STARTUP_URI: &str = "vsc-light://app/shim/index.html";
const VERIFICATION_URI: &str = "vsc-light://app/shim/index.html?vsc-light-verify-filesystem";
const TERMINAL_VERIFICATION_URI: &str = "vsc-light://app/shim/index.html?vsc-light-verify-terminal";
const MARKETPLACE_VERIFICATION_URI: &str = "vsc-light://app/shim/index.html?vsc-light-verify-marketplace";

pub fn run() {
    let app = Application::builder()
        .application_id(APPLICATION_ID)
        .build();
    app.connect_activate(activate);
    app.run();
}

fn activate(app: &Application) {
    let webview = create_webview();
    let window = ApplicationWindow::builder()
        .application(app)
        .title("VSC Light")
        .default_width(800)
        .default_height(600)
        .child(&webview)
        .build();

    window.present();
    webview.load_uri(startup_uri());
}

fn create_webview() -> WebView {
    let context = WebContext::default().expect("default WebKit context");
    assets::register(&context, PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let manager = UserContentManager::new();
    let webview = WebView::builder()
        .web_context(&context)
        .user_content_manager(&manager)
        .build();

    bridge::connect(&manager, &webview);
    diagnostics::connect(&webview);
    webview
}

fn startup_uri() -> &'static str {
    if std::env::var_os("VSC_LIGHT_VERIFY_MARKETPLACE").is_some() {
        MARKETPLACE_VERIFICATION_URI
    } else if std::env::var_os("VSC_LIGHT_VERIFY_TERMINAL").is_some() {
        TERMINAL_VERIFICATION_URI
    } else if std::env::var_os("VSC_LIGHT_VERIFY_FILESYSTEM").is_some() {
        VERIFICATION_URI
    } else {
        STARTUP_URI
    }
}
