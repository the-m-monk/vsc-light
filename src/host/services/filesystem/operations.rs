use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use serde_json::{Value, json};

use crate::host::{HostError, Result};

use super::arguments::{contents, flag, path as path_arg, reject_option};

pub(super) fn read_file(path: &Path) -> Result<Value> {
    let bytes = fs::read(path)?;
    Ok(json!({ "__vscLightBinary": { "type": "Uint8Array", "bytes": bytes } }))
}

pub(super) fn write_file(path: &Path, args: &Value) -> Result<Value> {
    reject_option(args, "unlock")?;
    let bytes = contents(args)?;
    let create = flag(args, "create", true);
    let overwrite = flag(args, "overwrite", true);
    let append = flag(args, "append", false);
    let atomic_path = match args.get("atomic") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(options) => {
            let postfix = options
                .get("postfix")
                .and_then(Value::as_str)
                .filter(|postfix| !postfix.is_empty())
                .ok_or_else(|| HostError::invalid("atomic.postfix must be a non-empty string"))?;
            let mut temporary_name = path
                .file_name()
                .ok_or_else(|| HostError::invalid("atomic write path must name a file"))?
                .to_os_string();
            temporary_name.push(postfix);
            Some(path.with_file_name(temporary_name))
        }
    };
    let target_exists = path.try_exists()?;
    if !create && !target_exists {
        return Err(io::Error::new(io::ErrorKind::NotFound, "write target does not exist").into());
    }
    if !overwrite && target_exists {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "write target exists").into());
    }
    let target = atomic_path.as_deref().unwrap_or(path);
    let mut options = OpenOptions::new();
    options.write(true).append(append).truncate(!append);
    if atomic_path.is_none() && create && !overwrite {
        options.create_new(true);
    } else {
        options.create(create || atomic_path.is_some());
    }
    let write_result = (|| {
        let mut file = options.open(target)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok::<_, io::Error>(())
    })();
    if let Err(error) = write_result {
        if atomic_path.is_some() {
            let _ = fs::remove_file(target);
        }
        return Err(error.into());
    }
    if let Some(temporary) = atomic_path {
        fs::rename(temporary, path)?;
    }
    Ok(Value::Null)
}

pub(super) fn mkdir(path: &Path) -> Result<Value> {
    fs::create_dir(path)?;
    Ok(Value::Null)
}

pub(super) fn rename(path: &Path, args: &Value) -> Result<Value> {
    let to = path_arg(args, "to")?;
    if !flag(args, "overwrite", true) {
        match fs::symlink_metadata(&to) {
            Ok(_) => {
                return Err(
                    io::Error::new(io::ErrorKind::AlreadyExists, "rename target exists").into(),
                );
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    fs::rename(path, to)?;
    Ok(Value::Null)
}

pub(super) fn delete(path: &Path, args: &Value) -> Result<Value> {
    reject_option(args, "useTrash")?;
    reject_option(args, "atomic")?;
    // Inspect the link itself so removing a directory symlink never follows its target.
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        if flag(args, "recursive", false) {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_dir(path)?;
        }
    } else {
        fs::remove_file(path)?;
    }
    Ok(Value::Null)
}

pub(super) fn realpath(path: &Path) -> Result<Value> {
    let canonical = fs::canonicalize(path)?;
    let path = canonical
        .to_str()
        .ok_or_else(|| HostError::invalid("path is not UTF-8"))?;
    Ok(json!(path))
}
