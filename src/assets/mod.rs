//! Local URI schemes for bundled VS Code and shim assets.

mod mime;
mod path;
mod request;
mod rewrite;
mod scheme;

pub use scheme::register;
