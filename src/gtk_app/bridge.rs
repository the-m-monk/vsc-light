use gtk4::gio;
use javascriptcore6::Value;
use webkit6::{ScriptMessageReply, UserContentManager, WebView, prelude::*};

use crate::host;

/// Connects WebKit messaging to the upstream IPC relay and generic native RPC.
pub(super) fn connect(manager: &UserContentManager, webview: &WebView) {
    manager.register_script_message_handler("vscLightSend", None);
    manager.register_script_message_handler_with_reply("vscLightInvoke", None);

    // Deliver PTY output on GTK's thread without blocking it on shell reads.
    let weak_webview = webview.downgrade();
    gtk4::glib::timeout_add_local(std::time::Duration::from_millis(20), move || {
        let Some(webview) = weak_webview.upgrade() else {
            host::shutdown_extension_hosts();
            return gtk4::glib::ControlFlow::Break;
        };
        let events = host::drain_terminal_events();
        if !events.is_empty() {
            let script = format!(
                "globalThis.__vscLightTerminalEvents?.({});",
                serde_json::json!(events)
            );
            webview.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
        }
        let events = host::drain_extension_host_events();
        if !events.is_empty() {
            let script = format!(
                "globalThis.__vscLightExtensionHostEvents?.({});",
                serde_json::json!(events)
            );
            webview.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
        }
        gtk4::glib::ControlFlow::Continue
    });
    webview.connect_load_changed(|_, event| {
        if event == webkit6::LoadEvent::Started {
            host::shutdown_terminals();
            host::shutdown_extension_hosts();
        }
    });

    let webview = webview.clone();
    let invoke_webview = webview.clone();
    let window_state = super::window::WindowState::default();
    let network = super::network::NetworkState::default();
    manager.connect_script_message_received(Some("vscLightSend"), move |_, message| {
        relay(&webview, message);
    });
    manager.connect_script_message_with_reply_received(
        Some("vscLightInvoke"),
        move |_, message, reply| {
            invoke(message, reply, &invoke_webview, &window_state, &network);
            true
        },
    );
}

fn relay(webview: &WebView, message: &Value) {
    let channel = message
        .object_get_property("channel")
        .map(|channel| channel.to_str().to_string())
        .unwrap_or_else(|| "<invalid>".into());
    let payload = message.to_json(0).unwrap_or_else(|| message.to_str());
    if matches!(channel.as_str(), "vscode:hello" | "vscode:message") {
        eprintln!("renderer -> host {channel}");
    }

    let script = format!(
        "{{const m={payload};globalThis.__vscLightIpcMainReceive?.(m.channel,...(m.args??[]));}}"
    );
    webview.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
}

fn invoke(
    message: &Value,
    reply: &ScriptMessageReply,
    webview: &WebView,
    window_state: &super::window::WindowState,
    network: &super::network::NetworkState,
) {
    let request = message
        .to_json(0)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    if window_state.handle(&request, message, reply, webview) {
        return;
    }
    if network.handle(&request, message, reply) {
        return;
    }
    if super::extensions::handle(&request, message, reply) { return; }
    let response = host::handle_request(&request);
    respond(message, reply, response);
}

/// Send JSON text: async WebKit object replies have arrived as {} before Explorer activation.
pub(super) fn respond(message: &Value, reply: &ScriptMessageReply, response: serde_json::Value) {
    let Some(context) = message.context() else {
        eprintln!(
            "[vsc-light:bridge] reply FAILED: no JavaScriptCore context; response={response}"
        );
        reply.return_error_message("No JavaScriptCore context");
        return;
    };
    reply.return_value(&Value::new_string(&context, Some(&response.to_string())));
}
