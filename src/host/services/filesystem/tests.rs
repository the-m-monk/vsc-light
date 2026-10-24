use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use crate::host::dispatch;

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "vsc-light-fs-test-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn binary_round_trip_and_write_options() {
    let directory = Directory::new();
    let path = directory.0.join("binary");
    let bytes: Vec<u8> = (0..=255).collect();
    let write = json!({
        "path": path,
        "contents": { "__vscLightBinary": { "type": "Uint8Array", "bytes": bytes } },
        "create": true,
        "overwrite": false,
    });
    dispatch("fs.writeFile", &write).unwrap();
    let read = dispatch("fs.readFile", &json!({ "path": path })).unwrap();
    assert_eq!(read["__vscLightBinary"]["bytes"], json!(bytes));
    assert_eq!(dispatch("fs.writeFile", &write).unwrap_err().code, "EEXIST");
    let stat = dispatch("fs.stat", &json!({ "path": path })).unwrap();
    assert_eq!(
        (stat["kind"].as_str(), stat["size"].as_u64()),
        (Some("file"), Some(256))
    );

    let missing = directory.0.join("missing");
    let mut options = write;
    options["path"] = json!(missing);
    options["create"] = Value::Bool(false);
    options["overwrite"] = Value::Bool(true);
    assert_eq!(
        dispatch("fs.writeFile", &options).unwrap_err().code,
        "ENOENT"
    );
    assert!(!missing.exists());
    options["create"] = Value::Bool(true);
    options["atomic"] = json!({ "postfix": ".tmp" });
    assert_eq!(
        dispatch("fs.writeFile", &options).unwrap_err().code,
        "ENOSYS"
    );
    assert!(!missing.exists());
}

#[test]
fn directory_symlinks_delete_and_native_errors() {
    let directory = Directory::new();
    let target = directory.0.join("target");
    dispatch("fs.mkdir", &json!({ "path": target })).unwrap();
    fs::write(target.join("keep"), b"keep").unwrap();
    let link = directory.0.join("link");
    symlink(&target, &link).unwrap();
    let info = dispatch("fs.stat", &json!({ "path": link })).unwrap();
    assert_eq!(
        (info["kind"].as_str(), info["symbolicLink"].as_bool()),
        (Some("directory"), Some(true))
    );
    dispatch("fs.delete", &json!({ "path": link, "recursive": true })).unwrap();
    assert!(target.join("keep").exists());
    assert_eq!(
        dispatch("fs.delete", &json!({ "path": target, "recursive": false }))
            .unwrap_err()
            .code,
        "ENOTEMPTY"
    );
    assert_eq!(
        dispatch("fs.delete", &json!({ "path": target, "useTrash": true }))
            .unwrap_err()
            .code,
        "ENOSYS"
    );
    let entries = dispatch("fs.readDir", &json!({ "path": target })).unwrap();
    assert_eq!(entries[0]["name"], "keep");
    assert_eq!(
        dispatch("fs.readDir", &json!({ "path": target.join("keep") }))
            .unwrap_err()
            .code,
        "ENOTDIR"
    );
    let missing = directory.0.join("missing");
    assert_eq!(
        dispatch("fs.stat", &json!({ "path": missing }))
            .unwrap_err()
            .code,
        "ENOENT"
    );
}
