use super::*;

fn options(args: &[&str]) -> Options {
    let Command::Run(options) = parse(args.iter().map(OsString::from)).unwrap() else {
        panic!("expected a launch configuration");
    };
    options
}

#[test]
fn normal_extension_host_command() {
    let parsed = options(&[
        "--dns-result-order=ipv4first",
        "--experimental-network-inspection",
        "--inspect-port=0",
        "build/vscode/out-vscode/bootstrap-fork.js",
        "--skipWorkspaceStorageLock",
    ]);
    assert_eq!(
        parsed,
        Options {
            runtime: RuntimeOptions {
                dns_result_order: Some(DnsResultOrder::Ipv4First),
                experimental_network_inspection: true,
                inspector: InspectorOptions {
                    port: 0,
                    ..InspectorOptions::default()
                },
                ..RuntimeOptions::default()
            },
            script: Some("build/vscode/out-vscode/bootstrap-fork.js".into()),
            script_args: vec!["--skipWorkspaceStorageLock".into()],
        }
    );
}

#[test]
fn debug_test_and_profile_flags() {
    let parsed = options(&[
        "--prof",
        "--expose-gc",
        "--nolazy",
        "--inspect-brk=127.0.0.1:9230",
        "bootstrap-fork.js",
    ]);
    assert_eq!(
        parsed.runtime,
        RuntimeOptions {
            prof: true,
            expose_gc: true,
            lazy_compilation: false,
            inspector: InspectorOptions {
                mode: InspectorMode::Break,
                host: "127.0.0.1".into(),
                port: 9230
            },
            ..RuntimeOptions::default()
        }
    );
    assert_eq!(
        options(&["--inspect", "main.js"]).runtime.inspector.mode,
        InspectorMode::Inspect
    );
}

#[test]
fn inspector_address_supports_hostnames_ipv6_and_separate_port_values() {
    for (args, host, port) in [
        (vec!["--inspect=localhost:9230"], "localhost", 9230),
        (vec!["--inspect=[::1]:0"], "::1", 0),
        (vec!["--inspect=[::1]"], "::1", 9229),
        (vec!["--inspect-port", "65535"], "127.0.0.1", 65535),
        (vec!["--inspect=localhost"], "localhost", 9229),
    ] {
        let inspector = options(&args).runtime.inspector;
        assert_eq!((inspector.host.as_str(), inspector.port), (host, port));
    }
}

#[test]
fn inspector_mode_and_address_have_independent_precedence() {
    let parsed = options(&[
        "--inspect-port=localhost:9230",
        "--inspect",
        "--inspect-brk",
        "--inspect-port=0",
    ]);
    assert_eq!(
        parsed.runtime.inspector,
        InspectorOptions {
            mode: InspectorMode::Break,
            host: "localhost".into(),
            port: 0
        }
    );
}

#[test]
fn required_values_and_dns_choices() {
    let parsed = options(&[
        "--dns-result-order",
        "ipv6first",
        "--dns-result-order=verbatim",
    ]);
    assert_eq!(
        parsed.runtime.dns_result_order,
        Some(DnsResultOrder::Verbatim)
    );
    for args in [
        vec!["--dns-result-order"],
        vec!["--dns-result-order="],
        vec!["--dns-result-order=invalid"],
        vec!["--inspect-port"],
        vec!["--inspect-port", "--prof"],
    ] {
        assert!(parse(args.into_iter().map(OsString::from)).is_err());
    }
}

#[test]
fn invalid_inspector_addresses_are_rejected() {
    for address in [
        "",
        "1",
        "1023",
        "65536",
        "-1",
        "localhost:no",
        "localhost:",
        "[::1",
        "[invalid]:9230",
        "::1",
        "host name:9230",
    ] {
        let arg = format!("--inspect-port={address}");
        assert!(parse([OsString::from(&arg)]).is_err(), "accepted {arg}");
    }
    assert_eq!(
        options(&["--inspect-port=1024"]).runtime.inspector.port,
        1024
    );
}

#[test]
fn script_arguments_are_preserved_and_do_not_set_runtime_flags() {
    let parsed = options(&[
        "a script.js",
        "--prof",
        "--inspect-brk=9230",
        "--unknown",
        "space argument",
    ]);
    assert_eq!(
        parsed,
        Options {
            script: Some("a script.js".into()),
            script_args: [
                "--prof",
                "--inspect-brk=9230",
                "--unknown",
                "space argument"
            ]
            .map(OsString::from)
            .to_vec(),
            ..Options::default()
        }
    );
}

#[test]
fn explicit_separator_allows_a_script_name_starting_with_a_dash() {
    assert_eq!(
        options(&["--", "--script.js", "--prof"]).script,
        Some("--script.js".into())
    );
    assert!(parse([OsString::from("--unknown")]).is_err());
    assert_eq!(parse([OsString::from("--help")]), Ok(Command::Help));
}

#[cfg(unix)]
#[test]
fn non_utf8_script_paths_and_arguments_are_preserved() {
    use std::os::unix::ffi::OsStringExt;
    let path = OsString::from_vec(vec![b'f', 0xff]);
    let arg = OsString::from_vec(vec![0xfe]);
    let Command::Run(parsed) = parse([path.clone(), arg.clone()]).unwrap() else {
        panic!()
    };
    assert_eq!(
        (parsed.script, parsed.script_args),
        (Some(PathBuf::from(path)), vec![arg])
    );
}
