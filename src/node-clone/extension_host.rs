//! VS Code's extension-host environment and script-level flags.

use std::{ffi::OsString, path::PathBuf};

use serde_json::Value;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub entrypoint: Option<String>,
    pub ipc_hook: Option<PathBuf>,
    pub handles_uncaught_errors: bool,
    pub parent_pid: Option<u32>,
    pub nls_config: Option<Value>,
    pub skip_workspace_storage_lock: bool,
    pub support_global_navigator: bool,
}

impl Options {
    pub fn parse(
        args: &[OsString],
        mut env: impl FnMut(&str) -> Option<OsString>,
    ) -> Result<Self, String> {
        let entrypoint = text(&mut env, "VSCODE_ESM_ENTRYPOINT")?;
        let ipc_hook = env("VSCODE_EXTHOST_IPC_HOOK")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        // bootstrap-fork treats any nonempty value as true, including the string "false".
        let handles_uncaught_errors = text(&mut env, "VSCODE_HANDLES_UNCAUGHT_ERRORS")?.is_some();
        let parent_pid = text(&mut env, "VSCODE_PARENT_PID")?
            .map(|value| {
                value
                    .parse::<u32>()
                    .ok()
                    .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
                    .ok_or_else(|| {
                        "VSCODE_PARENT_PID must be an integer in range 1–2147483647".to_string()
                    })
            })
            .transpose()?;
        let nls_config = text(&mut env, "VSCODE_NLS_CONFIG")?
            .map(|value| {
                let json: Value = serde_json::from_str(&value)
                    .map_err(|error| format!("VSCODE_NLS_CONFIG: {error}"))?;
                if !json.is_object() {
                    return Err("VSCODE_NLS_CONFIG must contain a JSON object".to_string());
                }
                Ok(json)
            })
            .transpose()?;
        let mut options = Self {
            entrypoint,
            ipc_hook,
            handles_uncaught_errors,
            parent_pid,
            nls_config,
            ..Self::default()
        };
        for arg in args {
            if arg == "--" {
                break;
            }
            let Some(arg) = arg.to_str() else {
                continue;
            };
            let (flag, value) = arg
                .split_once('=')
                .map_or((arg, None), |(flag, value)| (flag, Some(value)));
            let target = match flag {
                "--skipWorkspaceStorageLock" => &mut options.skip_workspace_storage_lock,
                "--supportGlobalNavigator" => &mut options.support_global_navigator,
                _ => continue,
            };
            *target = match value {
                None | Some("true") => true,
                Some("false") => false,
                _ => return Err(format!("{flag} expects true or false")),
            };
        }
        Ok(options)
    }
}

fn text(
    env: &mut impl FnMut(&str) -> Option<OsString>,
    name: &str,
) -> Result<Option<String>, String> {
    env(name)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .into_string()
                .map_err(|_| format!("{name} must be valid UTF-8"))
        })
        .transpose()
}

#[cfg(test)]
mod tests;
