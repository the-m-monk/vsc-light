use webkit6::{WebView, prelude::*};

pub(super) fn connect(webview: &WebView) {
    if let Some(settings) = WebViewExt::settings(webview) {
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
}
