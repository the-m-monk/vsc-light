pub(super) mod extension_host;
mod filesystem;
mod storage;
pub(super) mod terminal;

use serde_json::Value;

use super::{HostError, Result};

pub(super) fn dispatch(method: &str, args: &Value) -> Result<Value> {
    match method.split_once('.') {
        Some(("extensionHost", operation)) => extension_host::dispatch(operation, args),
        Some(("fs", operation)) => filesystem::dispatch(operation, args),
        Some(("storage", operation)) => storage::dispatch(operation, args),
        Some(("terminal", operation)) => terminal::dispatch(operation, args),
        _ => Err(HostError::unsupported(format!(
            "unsupported host method: {method}"
        ))),
    }
}
