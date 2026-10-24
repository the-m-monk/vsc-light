use serde_json::{Value, json};

use super::dispatch;

/// Builds the generic reply envelope; native services never handle transport details.
pub fn handle_request(request: &Value) -> Value {
    let id = &request["id"];
    let method = request["method"].as_str().unwrap_or_default();
    eprintln!("[vsc-light:host] call {method} id={id}");

    match dispatch(method, &request["args"]) {
        Ok(value) => {
            eprintln!("[vsc-light:host] reply {method} id={id}");
            json!({ "id": id, "ok": true, "value": value })
        }
        Err(error) => {
            eprintln!(
                "[vsc-light:host] error {method} id={id} code={}",
                error.code
            );
            json!({ "id": id, "ok": false, "error": error.to_json() })
        }
    }
}
