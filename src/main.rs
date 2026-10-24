use gtk4::prelude::*;
use webkit6::prelude::*;
use std::path::{Component, Path, PathBuf};

fn register_vsc_light_scheme(context: &webkit6::WebContext, project_dir: PathBuf) {
    if let Some(security) = context.security_manager() {
        for scheme in ["vsc-light", "vscode-file"] {
            security.register_uri_scheme_as_local(scheme);
            security.register_uri_scheme_as_secure(scheme);
            security.register_uri_scheme_as_cors_enabled(scheme);
        }
    }

    let light_project_dir = project_dir.clone();
    context.register_uri_scheme("vsc-light", move |request| {
        serve_asset_request(&request, &light_project_dir, false);
    });
    context.register_uri_scheme("vscode-file", move |request| {
        serve_asset_request(&request, &project_dir, true);
    });
}

fn serve_asset_request(
    request: &webkit6::URISchemeRequest,
    project_dir: &Path,
    vscode_file: bool,
) {
    let relative = request.path().unwrap_or_default();
    let safe_path = Path::new(relative.as_str())
        .components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .collect::<PathBuf>();
    let (asset_root, safe_path) = if vscode_file {
        match safe_path.strip_prefix("out") {
            Ok(path) => (project_dir.join("build/vscode/out-vscode"), path.to_path_buf()),
            Err(_) => (project_dir.join("build/vscode/out-vscode"), PathBuf::from("__not_found__")),
        }
    } else if safe_path == Path::new("product.json") {
        (project_dir.join("build/vscode"), safe_path)
    } else if safe_path.starts_with("shim") {
        (project_dir.to_path_buf(), safe_path)
    } else {
        (project_dir.join("build/vscode/out-vscode"), safe_path)
    };
    let file_path = asset_root.join(safe_path);

    match std::fs::read(&file_path) {
        Ok(contents) => {
            let contents = if file_path.ends_with("vs/code/electron-browser/workbench/workbench.html") {
                let html = String::from_utf8_lossy(&contents);
                html.replace(
                    "trusted-types\n\t\t\t\t\tamdLoader",
                    "trusted-types\n\t\t\t\t\tvscLightShim\n\t\t\t\t\tamdLoader",
                )
                .replace(
                    "script-src\n\t\t\t\t\t'self'",
                    "script-src\n\t\t\t\t\t'self'\n\t\t\t\t\tvscode-file:\n\t\t\t\t\tvsc-light:",
                )
                .into_bytes()
            } else if file_path.ends_with("vs/code/electron-browser/workbench/workbench.js") {
                let js = String::from_utf8_lossy(&contents);
                format!("import \"vsc-light://app/shim/dist/workbenchPreload.js\";\n{js}")
                    .into_bytes()
            } else {
                contents
            };
            let bytes = gtk4::glib::Bytes::from_owned(contents);
            let stream = gtk4::gio::MemoryInputStream::from_bytes(&bytes);
            let response = webkit6::URISchemeResponse::new(&stream, bytes.len() as i64);
            response.set_content_type(mime_type(&file_path));
            let headers = webkit6::soup::MessageHeaders::new(
                webkit6::soup::MessageHeadersType::Response,
            );
            headers.append("Access-Control-Allow-Origin", "vsc-light://app");
            headers.append("Vary", "Origin");
            response.set_http_headers(headers);
            request.finish_with_response(&response);
        }
        Err(error) => {
            eprintln!("{} request failed for {}: {error}", if vscode_file { "vscode-file" } else { "vsc-light" }, file_path.display());
            let message = format!("Unable to load {}: {error}", file_path.display());
            let bytes = gtk4::glib::Bytes::from_owned(message.into_bytes());
            let stream = gtk4::gio::MemoryInputStream::from_bytes(&bytes);
            let response = webkit6::URISchemeResponse::new(&stream, bytes.len() as i64);
            response.set_status(404, Some("Not Found"));
            response.set_content_type("text/plain; charset=utf-8");
            request.finish_with_response(&response);
        }
    }
}

fn mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).unwrap_or("") {
        "css" => "text/css",
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn main() {
    let app = gtk4::Application::builder()
        .application_id("dev.vsc_light.WebView")
        .build();

    app.connect_activate(|app| {
        let context = webkit6::WebContext::default().expect("default WebKit context");
        let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        register_vsc_light_scheme(&context, project_dir);
        let content_manager = webkit6::UserContentManager::new();
        content_manager.register_script_message_handler("vscLightSend", None);
        content_manager.register_script_message_handler_with_reply("vscLightInvoke", None);
        let webview = webkit6::WebView::builder()
            .web_context(&context)
            .user_content_manager(&content_manager)
            .build();

        let ipc_webview = webview.clone();
        content_manager.connect_script_message_received(Some("vscLightSend"), move |_, message| {
            let channel = message
                .object_get_property("channel")
                .map(|channel| channel.to_str().to_string())
                .unwrap_or_else(|| "<invalid>".to_string());
            let parsed = message.to_json(0).unwrap_or_else(|| message.to_str());
            if channel == "vscode:hello" {
                eprintln!("renderer -> host vscode:hello");
            } else if channel == "vscode:message" {
                eprintln!("renderer -> host vscode:message");
            }
            let script = format!("{{const m={parsed};globalThis.__vscLightIpcMainReceive?.(m.channel,...(m.args??[]));}}");
            ipc_webview.evaluate_javascript(&script, None, None, None::<&gtk4::gio::Cancellable>, |_| {});
        });
        content_manager.connect_script_message_with_reply_received(
            Some("vscLightInvoke"),
            |_, message, reply| {
                let channel = message
                    .object_get_property("channel")
                    .map(|channel| channel.to_str().to_string())
                    .unwrap_or_else(|| "<invalid>".to_string());
                eprintln!("WebKit IPC invoke has no handler: {channel}");
                reply.return_error_message(&format!("No native IPC handler for channel {channel}"));
                true
            },
        );
        if let Some(settings) = webkit6::prelude::WebViewExt::settings(&webview) {
            settings.set_enable_write_console_messages_to_stdout(true);
        }

        webview.connect_load_failed(|_, event, uri, error| {
            eprintln!("WebKit load failed ({event:?}) for {uri}: {error}");
            false
        });
        webview.connect_resource_load_started(|_, resource, request| {
            let uri = request.uri().map(|uri| uri.to_string()).unwrap_or_default();
            resource.connect_failed(move |_, error| {
                eprintln!("WebKit resource failed ({uri}): {error}");
            });
        });
        webview.connect_web_process_terminated(|_, reason| {
            eprintln!("WebKit web process terminated: {reason:?}");
        });

        let window = gtk4::ApplicationWindow::builder()
            .application(app)
            .title("VSC Light")
            .default_width(800)
            .default_height(600)
            .child(&webview)
            .build();

        window.present();
        webview.load_uri("vsc-light://app/shim/index.html");
    });

    app.run();
}
