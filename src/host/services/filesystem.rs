//! Native filesystem method routing. Wire decoding and disk operations stay separate.

mod arguments;
mod metadata;
mod operations;

#[cfg(test)]
mod tests;

use serde_json::Value;

use crate::host::{HostError, Result};

pub(super) fn dispatch(operation: &str, args: &Value) -> Result<Value> {
    // Decode the path once, but report an unknown method before argument errors.
    let path = arguments::path(args, "path");
    match operation {
        "stat" => metadata::stat(&path?),
        "readFile" => operations::read_file(&path?),
        "writeFile" => operations::write_file(&path?, args),
        "readDir" => metadata::read_dir(&path?),
        "mkdir" => operations::mkdir(&path?),
        "rename" => operations::rename(&path?, args),
        "delete" => operations::delete(&path?, args),
        "realpath" => operations::realpath(&path?),
        _ => Err(HostError::unsupported(format!(
            "unsupported host method: fs.{operation}"
        ))),
    }
}
