//! Native HTTP transport for gallery requests and package downloads, outside browser CORS.

use super::bridge::respond;
use gtk4::{gio, glib};
use javascriptcore6::Value;
use serde_json::json;
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use webkit6::{
    ScriptMessageReply,
    soup::{self, prelude::*},
};

#[derive(Default)]
pub(super) struct NetworkState {
    pending: Rc<RefCell<HashMap<String, gio::Cancellable>>>,
}

impl NetworkState {
    pub(super) fn handle(
        &self,
        request: &serde_json::Value,
        value: &Value,
        reply: &ScriptMessageReply,
    ) -> bool {
        let method = request["method"].as_str().unwrap_or_default();
        if !matches!(
            method,
            "network.request" | "network.download" | "network.cancel"
        ) {
            return false;
        }
        let args = &request["args"];
        let key = args["requestId"].as_str().unwrap_or_default().to_owned();
        if method == "network.cancel" {
            if let Some(cancellable) = self.pending.borrow().get(&key) {
                cancellable.cancel();
            }
            respond(
                value,
                reply,
                json!({ "id": request["id"], "ok": true, "value": null }),
            );
            return true;
        }
        let url = args["url"].as_str().unwrap_or_default();
        let result = if url.starts_with("https://") || url.starts_with("http://") {
            soup::Message::new(args["type"].as_str().unwrap_or("GET"), url)
                .map_err(|_| "Invalid HTTP URL")
        } else {
            Err("Only HTTP and HTTPS requests are supported")
        };
        let message = match result {
            Ok(message) => message,
            Err(error) => {
                respond(
                    value,
                    reply,
                    json!({ "id": request["id"], "ok": false, "error": { "code": "EINVAL", "message": error } }),
                );
                return true;
            }
        };
        if args["followRedirects"].as_u64() == Some(0) {
            message.set_flags(soup::MessageFlags::NO_REDIRECT);
        }
        if let Some(headers) = message.request_headers() {
            if let Some(request_headers) = args["headers"].as_object() {
                for (name, values) in request_headers {
                    if ["host", "content-length", "connection", "accept-encoding"]
                        .contains(&name.to_ascii_lowercase().as_str())
                    {
                        continue;
                    }
                    if let Some(value) = values.as_str() {
                        headers.replace(name, value);
                    } else if let Some(values) = values.as_array() {
                        for value in values.iter().filter_map(serde_json::Value::as_str) {
                            headers.append(name, value);
                        }
                    }
                }
            }
        }
        if let Some(data) = args["data"].as_str() {
            let content_type = message
                .request_headers()
                .and_then(|headers| headers.one("Content-Type"));
            message.set_request_body_from_bytes(
                content_type.as_deref(),
                Some(&glib::Bytes::from_owned(data.as_bytes().to_vec())),
            );
        }
        let session = soup::Session::new();
        session.set_timeout(
            (args["timeout"].as_u64().unwrap_or(30000).div_ceil(1000)).clamp(1, 300) as u32,
        );
        session.set_user_agent("VSC-Light");
        let cancellable = gio::Cancellable::new();
        self.pending
            .borrow_mut()
            .insert(key.clone(), cancellable.clone());
        let pending = self.pending.clone();
        let value = value.clone();
        let reply = reply.clone();
        let id = request["id"].clone();
        let destination = if method == "network.download" {
            args["path"].as_str().map(str::to_owned)
        } else {
            None
        };
        let response_message = message.clone();
        session.send_and_read_async(&message, glib::Priority::DEFAULT, Some(&cancellable), move |result| {
            pending.borrow_mut().remove(&key);
            let response = match result {
                Ok(bytes) => {
                    let mut headers = HashMap::new();
                    if let Some(values) = response_message.response_headers() {
                        values.foreach(|name, value| { headers.insert(name.to_ascii_lowercase(), value.to_owned()); });
                    }
                    let status = response_message.status_code();
                    let result = if let Some(path) = destination {
                        if !(200..300).contains(&status) { Err(format!("Download returned HTTP {status}")) }
                        else {
                            let target = std::path::Path::new(&path);
                            target.parent().map_or(Ok(()), std::fs::create_dir_all)
                                .and_then(|_| std::fs::write(target, bytes.as_ref()))
                                .map(|_| json!({ "path": path, "statusCode": status }))
                                .map_err(|error| error.to_string())
                        }
                    } else {
                        Ok(json!({ "statusCode": status, "headers": headers, "body": { "__vscLightBinary": { "type": "Uint8Array", "bytes": bytes.as_ref() } } }))
                    };
                    match result {
                        Ok(result) => json!({ "id": id, "ok": true, "value": result }),
                        Err(error) => json!({ "id": id, "ok": false, "error": { "code": "EIO", "message": error } }),
                    }
                }
                Err(error) => json!({ "id": id, "ok": false, "error": { "code": if error.matches(gio::IOErrorEnum::Cancelled) { "ECANCELED" } else { "EIO" }, "message": error.to_string() } }),
            };
            respond(&value, &reply, response);
        });
        true
    }
}
