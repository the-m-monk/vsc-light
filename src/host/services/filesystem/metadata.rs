use std::fs::{self, Metadata};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::host::{HostError, Result};

struct FileMetadata {
    metadata: Metadata,
    symbolic_link: bool,
}

impl FileMetadata {
    fn read(path: &Path) -> Result<Self> {
        let link = fs::symlink_metadata(path)?;
        let symbolic_link = link.is_symlink();
        let metadata = if symbolic_link {
            match fs::metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => link,
                Err(error) => return Err(error.into()),
            }
        } else {
            link
        };
        Ok(Self {
            metadata,
            symbolic_link,
        })
    }

    fn kind(&self) -> &'static str {
        if self.metadata.is_dir() {
            "directory"
        } else if self.metadata.is_file() {
            "file"
        } else {
            "unknown"
        }
    }
}

pub(super) fn stat(path: &Path) -> Result<Value> {
    let file = FileMetadata::read(path)?;
    let metadata = &file.metadata;
    let mode = metadata.permissions().mode();

    Ok(json!({
        "kind": file.kind(),
        "symbolicLink": file.symbolic_link,
        "ctime": unix_millis(metadata.created().or_else(|_| metadata.modified())),
        "mtime": unix_millis(metadata.modified()),
        "size": metadata.len(),
        "readonly": mode & 0o200 == 0,
        "executable": mode & 0o111 != 0,
    }))
}

pub(super) fn read_dir(path: &Path) -> Result<Value> {
    let entries = fs::read_dir(path)?
        .map(|entry| {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| HostError::invalid("filename is not UTF-8"))?;
            let file = FileMetadata::read(&entry.path())?;
            Ok(json!({
                "name": name,
                "kind": file.kind(),
                "symbolicLink": file.symbolic_link,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Value::Array(entries))
}

fn unix_millis(time: io::Result<SystemTime>) -> u128 {
    time.ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0)
}
