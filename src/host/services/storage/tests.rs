use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "vsc-light-storage-test-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn call(&self, operation: &str, args: Value) -> Result<Value> {
        dispatch_at(&self.0, operation, &args)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn trust_and_revocation_are_durable_without_an_in_memory_cache() {
    use std::os::unix::fs::PermissionsExt;
    let directory = Directory::new();
    let key = "content.trust.model.key";
    let trusted = json!({ "uriTrustInfo": [{
        "uri": { "scheme": "file", "path": "/tmp/project 你好" }, "trusted": true,
    }] })
    .to_string();
    directory
        .call(
            "updateItems",
            json!({ "applicationShared": true, "insert": [[key, trusted]] }),
        )
        .unwrap();
    assert_eq!(
        directory
            .call("getItems", json!({ "applicationShared": true }))
            .unwrap(),
        json!([[key, trusted]])
    );
    let file = directory.0.join("application-shared.json");
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o077, 0);

    let revoked = json!({ "uriTrustInfo": [] }).to_string();
    directory
        .call(
            "updateItems",
            json!({ "applicationShared": true, "insert": [[key, revoked]] }),
        )
        .unwrap();
    assert_eq!(
        directory
            .call("getValue", json!({ "applicationShared": true, "key": key }))
            .unwrap(),
        json!(revoked)
    );
    directory
        .call(
            "updateItems",
            json!({ "applicationShared": true, "delete": [key] }),
        )
        .unwrap();
    assert_eq!(
        directory
            .call("getItems", json!({ "applicationShared": true }))
            .unwrap(),
        json!([])
    );
}

#[test]
fn application_profile_and_workspace_scopes_are_isolated() {
    let directory = Directory::new();
    let scopes = [
        json!({}),
        json!({ "applicationShared": true }),
        json!({ "profile": { "id": "first" } }),
        json!({ "profile": { "id": "../second" } }),
        json!({ "workspace": { "id": "first" }, "profile": { "id": "first" } }),
        json!({ "workspace": { "id": "../../second" } }),
    ];
    for (index, scope) in scopes.iter().enumerate() {
        let mut request = scope.clone();
        request["insert"] = json!([["same-key", index.to_string()]]);
        directory.call("updateItems", request).unwrap();
    }
    for (index, scope) in scopes.iter().enumerate() {
        assert_eq!(
            directory.call("getItems", scope.clone()).unwrap(),
            json!([["same-key", index.to_string()]])
        );
    }
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), scopes.len());
}

#[test]
fn invalid_updates_and_corrupt_files_do_not_overwrite_saved_state() {
    let directory = Directory::new();
    directory
        .call("updateItems", json!({ "insert": [["keep", "value"]] }))
        .unwrap();
    assert!(
        directory
            .call(
                "updateItems",
                json!({ "insert": [["keep", "bad"]], "delete": [12] })
            )
            .is_err()
    );
    assert_eq!(
        directory.call("getItems", json!({})).unwrap(),
        json!([["keep", "value"]])
    );
    let file = directory.0.join("application.json");
    fs::write(&file, "invalid JSON").unwrap();
    assert!(directory.call("getItems", json!({})).is_err());
    assert!(
        directory
            .call("updateItems", json!({ "insert": [["new", "value"]] }))
            .is_err()
    );
    assert_eq!(fs::read_to_string(file).unwrap(), "invalid JSON");
}

#[test]
fn compare_and_swap_checks_the_persisted_value() {
    let directory = Directory::new();
    assert_eq!(
        directory
            .call(
                "compareAndSwap",
                json!({ "key": "lock", "newValue": "first" })
            )
            .unwrap(),
        json!({ "swapped": true, "currentValue": "first" })
    );
    assert_eq!(
        directory
            .call(
                "compareAndSwap",
                json!({ "key": "lock", "newValue": "second" })
            )
            .unwrap(),
        json!({ "swapped": false, "currentValue": "first" })
    );
    assert_eq!(
        directory
            .call(
                "compareAndSwap",
                json!({ "key": "lock", "expectedValue": "first", "newValue": "second" })
            )
            .unwrap(),
        json!({ "swapped": true, "currentValue": "second" })
    );
    assert_eq!(
        directory
            .call("getValue", json!({ "key": "lock" }))
            .unwrap(),
        json!("second")
    );
    assert_eq!(
        directory
            .call("getValue", json!({ "key": "missing" }))
            .unwrap(),
        Value::Null
    );
}
