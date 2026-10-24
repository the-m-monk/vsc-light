//! Generic native capabilities exposed through the host RPC boundary.

mod error;
mod rpc;
mod services;

use serde_json::Value;

pub use error::HostError;
pub use rpc::handle_request;

pub type Result<T> = std::result::Result<T, HostError>;

pub fn dispatch(method: &str, args: &Value) -> Result<Value> {
    services::dispatch(method, args)
}
