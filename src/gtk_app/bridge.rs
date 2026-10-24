use gtk4::gio;
use javascriptcore6::Value;
use webkit6::{ScriptMessageReply, UserContentManager, WebView, prelude::*};

use crate::host;

/// Connects WebKit messaging to the upstream IPC relay and generic native RPC.
pub(super) fn connect(manager: &UserContentManager, webview: &WebView) {
    manager.register_script_message_handler("vscLightSend", None);
    manager.register_script_message_handler_with_reply("vscLightInvoke", None);

    let webview = webview.clone();
    manager.connect_script_message_received(Some("vscLightSend"), move |_, message| {
        relay(&webview, message);
    });
    manager.connect_script_message_with_reply_received(
        Some("vscLightInvoke"),
        |_, message, reply| {
            invoke(message, reply);
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

fn invoke(message: &Value, reply: &ScriptMessageReply) {
    let request = message
        .to_json(0)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let response = host::handle_request(&request);

    let Some(context) = message.context() else {
        reply.return_error_message("No JavaScriptCore context");
        return;
    };
    reply.return_value(&Value::from_json(&context, &response.to_string()));
}
