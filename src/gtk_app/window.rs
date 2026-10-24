//! Per-window state and asynchronous GTK folder selection.

use std::{cell::RefCell, path::PathBuf};

use gtk4::{FileDialog, Window, gio, prelude::*};
use javascriptcore6::Value;
use serde_json::json;
use webkit6::{ScriptMessageReply, WebView};

use crate::host::HostError;

#[derive(Default)]
pub(super) struct WindowState {
    folder: RefCell<Option<PathBuf>>,
}

impl WindowState {
    pub(super) fn handle(
        &self,
        request: &serde_json::Value,
        message: &Value,
        reply: &ScriptMessageReply,
        webview: &WebView,
    ) -> bool {
        let method = request["method"].as_str().unwrap_or_default();
        match method {
            "window.getState" => {
                let folder_id = self.folder.borrow().as_ref().map(|folder| {
                    gtk4::glib::compute_checksum_for_string(
                        gtk4::glib::ChecksumType::Md5,
                        folder.to_string_lossy().as_ref(),
                    )
                    .expect("MD5 checksum is supported")
                    .to_string()
                });
                respond(
                    message,
                    reply,
                    json!({ "id": request["id"], "ok": true,
                    "value": { "folder": *self.folder.borrow(), "folderId": folder_id,
                    "homeDir": std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()) } }),
                );
            }
            "window.validateFolder" | "window.setFolder" => {
                let result = request["args"]["path"]
                    .as_str()
                    .ok_or_else(|| HostError::invalid("folder path is required"))
                    .and_then(validate_folder);
                let response = match result {
                    Ok(folder) => {
                        if method == "window.setFolder" {
                            *self.folder.borrow_mut() = Some(folder);
                        }
                        json!({ "id": request["id"], "ok": true, "value": null })
                    }
                    Err(error) => {
                        json!({ "id": request["id"], "ok": false, "error": error.to_json() })
                    }
                };
                respond(message, reply, response);
            }
            "dialog.pickFolder" => {
                let dialog = FileDialog::builder()
                    .title("Open Folder")
                    .modal(true)
                    .build();
                if let Some(path) = request["args"]["defaultPath"].as_str() {
                    dialog.set_initial_folder(Some(&gio::File::for_path(path)));
                }
                let parent = webview.root().and_downcast::<Window>();
                let message = message.clone();
                let reply = reply.clone();
                let id = request["id"].clone();
                dialog.select_folder(parent.as_ref(), None::<&gio::Cancellable>, move |result| {
                    let response = match result {
                        Ok(file) => match file.path() {
                            Some(path) => json!({ "id": id, "ok": true, "value": path }),
                            None => json!({ "id": id, "ok": false, "error": HostError::invalid("only local folders are supported").to_json() }),
                        },
                        Err(error) if error.matches(gtk4::DialogError::Dismissed) || error.matches(gtk4::DialogError::Cancelled) => {
                            json!({ "id": id, "ok": true, "value": null })
                        }
                        Err(error) => json!({ "id": id, "ok": false, "error": { "code": "EIO", "message": error.to_string() } }),
                    };
                    respond(&message, &reply, response);
                });
            }
            _ => return false,
        }
        true
    }
}

fn validate_folder(path: &str) -> crate::host::Result<PathBuf> {
    let path = std::fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(HostError::invalid("selected path is not a directory"));
    }
    Ok(path)
}

fn respond(message: &Value, reply: &ScriptMessageReply, response: serde_json::Value) {
    if let Some(context) = message.context() {
        reply.return_value(&Value::from_json(&context, &response.to_string()));
    } else {
        reply.return_error_message("No JavaScriptCore context");
    }
}

#[cfg(test)]
mod tests {
    use super::validate_folder;

    #[test]
    fn folder_validation_rejects_files_and_missing_paths() {
        assert!(
            validate_folder(env!("CARGO_MANIFEST_DIR"))
                .unwrap()
                .is_absolute()
        );
        assert!(validate_folder(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).is_err());
        assert_eq!(
            validate_folder("/does-not-exist/vsc-light")
                .unwrap_err()
                .code,
            "ENOENT"
        );
    }
}
