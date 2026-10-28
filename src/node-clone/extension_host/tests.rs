use super::*;
use serde_json::json;

fn options(args: &[&str], environment: &[(&str, &str)]) -> Result<Options, String> {
    let args: Vec<_> = args.iter().map(OsString::from).collect();
    Options::parse(&args, |name| {
        environment
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| OsString::from(value))
    })
}

#[test]
fn complete_extension_host_configuration() {
    let nls = r#"{"resolvedLanguage":"en","defaultMessagesFile":"/bundle/nls.messages.json","additionalField":true}"#;
    let parsed = options(
        &["--skipWorkspaceStorageLock", "--supportGlobalNavigator"],
        &[
            (
                "VSCODE_ESM_ENTRYPOINT",
                "vs/workbench/api/node/extensionHostProcess",
            ),
            ("VSCODE_EXTHOST_IPC_HOOK", "/tmp/host socket/ipc.sock"),
            ("VSCODE_HANDLES_UNCAUGHT_ERRORS", "true"),
            ("VSCODE_PARENT_PID", "1234"),
            ("VSCODE_NLS_CONFIG", nls),
        ],
    )
    .unwrap();
    assert_eq!(
        parsed,
        Options {
            entrypoint: Some("vs/workbench/api/node/extensionHostProcess".into()),
            ipc_hook: Some("/tmp/host socket/ipc.sock".into()),
            handles_uncaught_errors: true,
            parent_pid: Some(1234),
            nls_config: Some(
                json!({"resolvedLanguage":"en","defaultMessagesFile":"/bundle/nls.messages.json","additionalField":true})
            ),
            skip_workspace_storage_lock: true,
            support_global_navigator: true,
        }
    );
}

#[test]
fn omitted_and_empty_environment_values_are_optional() {
    assert_eq!(options(&[], &[]).unwrap(), Options::default());
    assert_eq!(
        options(&[], &[("VSCODE_PARENT_PID", ""), ("VSCODE_NLS_CONFIG", "")]).unwrap(),
        Options::default()
    );
}

#[test]
fn malformed_environment_is_reported_with_variable_name() {
    for value in ["-1", "0", "2147483648", "not-a-pid"] {
        assert!(
            options(&[], &[("VSCODE_PARENT_PID", value)])
                .unwrap_err()
                .contains("VSCODE_PARENT_PID")
        );
    }
    for value in ["{broken", "[]", "null", "42"] {
        assert!(
            options(&[], &[("VSCODE_NLS_CONFIG", value)])
                .unwrap_err()
                .contains("VSCODE_NLS_CONFIG")
        );
    }
}

#[test]
fn uncaught_error_setting_matches_bootstrap_truthiness() {
    assert!(
        options(&[], &[("VSCODE_HANDLES_UNCAUGHT_ERRORS", "false")])
            .unwrap()
            .handles_uncaught_errors
    );
    assert!(
        !options(&[], &[("VSCODE_HANDLES_UNCAUGHT_ERRORS", "")])
            .unwrap()
            .handles_uncaught_errors
    );
}

#[test]
fn script_flags_have_boolean_values_and_last_value_wins() {
    let parsed = options(
        &[
            "--skipWorkspaceStorageLock",
            "--skipWorkspaceStorageLock=false",
            "--supportGlobalNavigator=true",
            "--unrelated=argument",
        ],
        &[],
    )
    .unwrap();
    assert_eq!(
        (
            parsed.skip_workspace_storage_lock,
            parsed.support_global_navigator
        ),
        (false, true)
    );
    assert!(options(&["--supportGlobalNavigator=invalid"], &[]).is_err());
    assert!(
        !options(&["--", "--skipWorkspaceStorageLock"], &[])
            .unwrap()
            .skip_workspace_storage_lock
    );
}

#[cfg(unix)]
#[test]
fn non_utf8_environment_text_is_rejected_without_losing_socket_paths() {
    use std::os::unix::ffi::OsStringExt;
    let invalid = OsString::from_vec(vec![0xff]);
    assert!(
        Options::parse(&[], |name| (name == "VSCODE_NLS_CONFIG")
            .then(|| invalid.clone()))
        .is_err()
    );
    let parsed = Options::parse(&[], |name| {
        (name == "VSCODE_EXTHOST_IPC_HOOK").then(|| invalid.clone())
    })
    .unwrap();
    assert_eq!(parsed.ipc_hook, Some(PathBuf::from(invalid)));
}
