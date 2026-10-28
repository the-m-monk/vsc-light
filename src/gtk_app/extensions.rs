//! Extension package operations run in a Node helper, never on GTK's main thread.

use super::bridge::respond;
use gtk4::{gio, glib};
use javascriptcore6::Value;
use serde_json::json;
use std::{
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
use webkit6::ScriptMessageReply;

pub(super) fn paths() -> serde_json::Value {
    let root = glib::home_dir().join(".vsc-light/extensions");
    let profile = glib::user_data_dir().join("vsc-light/extensions-profile.json");
    let cache = glib::user_cache_dir().join("vsc-light/extension-downloads");
    for directory in [&root, profile.parent().unwrap(), &cache] {
        if let Err(error) = fs::create_dir_all(directory) {
            eprintln!(
                "[vsc-light:extensions] unable to create {}: {error}",
                directory.display()
            );
        }
    }
    if let Ok(mut file) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&profile)
    {
        let _ = file.write_all(b"[]");
    }
    json!({ "root": root, "profile": profile, "cache": cache,
        "targetPlatform": if std::env::consts::ARCH == "aarch64" { "linux-arm64" } else { "linux-x64" },
        "appRoot": PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("build/vscode"),
        "builtin": PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("build/vscode/extensions") })
}

pub(super) fn handle(
    request: &serde_json::Value,
    value: &Value,
    reply: &ScriptMessageReply,
) -> bool {
    let Some(operation) = request["method"]
        .as_str()
        .and_then(|method| method.strip_prefix("extensions."))
    else {
        return false;
    };
    let paths = paths();
    if operation == "getPaths" {
        respond(
            value,
            reply,
            json!({ "id": request["id"], "ok": true, "value": paths }),
        );
        return true;
    }
    let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/extension-store.mjs");
    let process = match gio::Subprocess::newv(
        &[OsStr::new("node"), helper.as_os_str()],
        gio::SubprocessFlags::STDIN_PIPE
            | gio::SubprocessFlags::STDOUT_PIPE
            | gio::SubprocessFlags::STDERR_PIPE,
    ) {
        Ok(process) => process,
        Err(error) => {
            respond(
                value,
                reply,
                json!({ "id": request["id"], "ok": false, "error": { "code": "EIO", "message": format!("Cannot start extension helper: {error}") } }),
            );
            return true;
        }
    };
    let input =
        json!({ "operation": operation, "args": request["args"], "paths": paths }).to_string();
    let value = value.clone();
    let reply = reply.clone();
    let id = request["id"].clone();
    process.communicate_utf8_async(Some(input), None::<&gio::Cancellable>, move |result| {
        let result = result
            .map_err(|error| error.to_string())
            .and_then(|(stdout, stderr)| {
                serde_json::from_str::<serde_json::Value>(stdout.as_deref().unwrap_or_default())
                    .map_err(|error| {
                        format!(
                            "Extension helper failed: {error}; {}",
                            stderr.as_deref().unwrap_or_default()
                        )
                    })
            });
        let response = match result {
            Ok(mut response) => {
                response["id"] = id;
                response
            }
            Err(error) => {
                json!({ "id": id, "ok": false, "error": { "code": "EIO", "message": error } })
            }
        };
        respond(&value, &reply, response);
    });
    true
}
