use std::path::PathBuf;

use serde_json::Value;

use crate::host::{HostError, Result};

pub(super) fn path(args: &Value, name: &str) -> Result<PathBuf> {
    args.get(name)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| HostError::invalid(format!("missing {name}")))
}

pub(super) fn flag(args: &Value, name: &str, default: bool) -> bool {
    args.get(name).and_then(Value::as_bool).unwrap_or(default)
}

pub(super) fn reject_option(args: &Value, name: &str) -> Result<()> {
    if args
        .get(name)
        .is_some_and(|value| !value.is_null() && *value != Value::Bool(false))
    {
        return Err(HostError::unsupported(format!(
            "filesystem option {name} is not supported"
        )));
    }
    Ok(())
}

pub(super) fn contents(args: &Value) -> Result<Vec<u8>> {
    let values = args
        .get("contents")
        .and_then(|value| value.get("__vscLightBinary"))
        .and_then(|value| value.get("bytes"))
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::invalid("contents must be tagged binary"))?;
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .filter(|byte| *byte <= 255)
                .map(|byte| byte as u8)
                .ok_or_else(|| HostError::invalid("invalid binary byte"))
        })
        .collect()
}
