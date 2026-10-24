//! Persistent string storage for upstream application, profile, and workspace state.

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use gtk4::{gio, glib, prelude::*};
use serde_json::{Value, json};

use crate::host::{HostError, Result};

#[cfg(test)]
mod tests;

pub(super) fn dispatch(operation: &str, args: &Value) -> Result<Value> {
    let root = glib::user_data_dir().join("vsc-light/storage");
    dispatch_at(&root, operation, args)
}

fn scope_file(root: &Path, args: &Value) -> Result<PathBuf> {
    for (field, prefix) in [("workspace", "workspace"), ("profile", "profile")] {
        if args.get(field).is_some_and(|value| !value.is_null()) {
            let id = text(&args[field], "id")?;
            let hash = glib::compute_checksum_for_string(glib::ChecksumType::Md5, id)
                .expect("MD5 checksum is supported");
            return Ok(root.join(format!("{prefix}-{hash}.json")));
        }
    }
    Ok(
        root.join(if args["applicationShared"].as_bool().unwrap_or(false) {
            "application-shared.json"
        } else {
            "application.json"
        }),
    )
}

fn text<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::invalid(format!("storage {name} must be a string")))
}

fn read_items(path: &Path) -> Result<BTreeMap<String, String>> {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents).map_err(|error| {
            HostError::invalid(format!("invalid storage {}: {error}", path.display()))
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.into()),
    }
}

fn save_items(path: &Path, items: &BTreeMap<String, String>) -> Result<()> {
    fs::create_dir_all(path.parent().expect("storage files have a parent"))?;
    let contents =
        serde_json::to_vec(items).map_err(|error| HostError::invalid(error.to_string()))?;
    gio::File::for_path(path)
        .replace_contents(
            &contents,
            None,
            false,
            gio::FileCreateFlags::PRIVATE,
            None::<&gio::Cancellable>,
        )
        .map_err(io::Error::other)?;
    Ok(())
}

fn dispatch_at(root: &Path, operation: &str, args: &Value) -> Result<Value> {
    if !matches!(
        operation,
        "getItems" | "getValue" | "updateItems" | "compareAndSwap"
    ) {
        return Err(HostError::unsupported(format!(
            "unsupported host method: storage.{operation}"
        )));
    }
    let path = scope_file(root, args)?;
    let mut items = read_items(&path)?;
    match operation {
        "getItems" => Ok(json!(items.into_iter().collect::<Vec<_>>())),
        "getValue" => Ok(json!(items.get(text(args, "key")?))),
        "updateItems" => {
            let insert: Vec<(String, String)> = serde_json::from_value(
                args.get("insert").cloned().unwrap_or(json!([])),
            )
            .map_err(|error| HostError::invalid(format!("invalid storage insert: {error}")))?;
            let delete: Vec<String> = serde_json::from_value(
                args.get("delete").cloned().unwrap_or(json!([])),
            )
            .map_err(|error| HostError::invalid(format!("invalid storage delete: {error}")))?;
            let previous = items.clone();
            for (key, value) in insert {
                items.insert(key, value);
            }
            for key in delete {
                items.remove(&key);
            }
            let changed: Vec<_> = items
                .iter()
                .filter(|(key, value)| previous.get(*key) != Some(*value))
                .collect();
            let deleted: Vec<_> = previous
                .keys()
                .filter(|key| !items.contains_key(*key))
                .collect();
            if !changed.is_empty() || !deleted.is_empty() {
                save_items(&path, &items)?;
            }
            Ok(json!({ "changed": changed, "deleted": deleted }))
        }
        "compareAndSwap" => {
            let key = text(args, "key")?;
            let new_value = text(args, "newValue")?;
            let expected = match args.get("expectedValue") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => Some(value.as_str()),
                _ => return Err(HostError::invalid("storage expectedValue must be a string")),
            };
            if items.get(key).map(String::as_str) != expected {
                return Ok(json!({ "swapped": false, "currentValue": items.get(key) }));
            }
            items.insert(key.to_owned(), new_value.to_owned());
            save_items(&path, &items)?;
            Ok(json!({ "swapped": true, "currentValue": new_value }))
        }
        _ => unreachable!(),
    }
}
