mod filesystem;

use serde_json::Value;

use super::{HostError, Result};

pub(super) fn dispatch(method: &str, args: &Value) -> Result<Value> {
    match method.split_once('.') {
        Some(("fs", operation)) => filesystem::dispatch(operation, args),
        _ => Err(HostError::unsupported(format!(
            "unsupported host method: {method}"
        ))),
    }
}
