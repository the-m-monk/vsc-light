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
    reject_option(args, "atomic")?;
    reject_option(args, "unlock")?;
    let bytes = contents(args)?;
    let create = flag(args, "create", true);
    let overwrite = flag(args, "overwrite", true);
    let append = flag(args, "append", false);
    if !create && !overwrite && path.try_exists()? {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "write target exists").into());
    }
    let mut options = OpenOptions::new();
    options.write(true).append(append).truncate(!append);
    if create && !overwrite {
        options.create_new(true);
    } else {
        options.create(create);
    }
    let mut file = options.open(path)?;
    file.write_all(&bytes)?;
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
