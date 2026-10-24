use std::{fmt, io};

use serde_json::{Value, json};

#[derive(Debug)]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
    pub os_code: Option<i32>,
}

impl HostError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "EINVAL",
            message: message.into(),
            os_code: None,
        }
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "ENOSYS",
            message: message.into(),
            os_code: None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "code": self.code,
            "message": self.message,
            "osCode": self.os_code,
        })
    }
}

impl From<io::Error> for HostError {
    fn from(error: io::Error) -> Self {
        use io::ErrorKind;
        let code = match error.kind() {
            ErrorKind::NotFound => "ENOENT",
            ErrorKind::AlreadyExists => "EEXIST",
            ErrorKind::PermissionDenied => "EACCES",
            ErrorKind::NotADirectory => "ENOTDIR",
            ErrorKind::IsADirectory => "EISDIR",
            ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
            ErrorKind::InvalidInput | ErrorKind::InvalidData => "EINVAL",
            ErrorKind::Unsupported => "ENOSYS",
            _ => "EIO",
        };
        Self {
            code,
            message: error.to_string(),
            os_code: error.raw_os_error(),
        }
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for HostError {}
