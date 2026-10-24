use super::*;
use std::time::{Duration, Instant};

fn shell(terminals: &mut Terminals, args: Value) -> u64 {
    terminals
        .call(
            "createProcess",
            &json!({ "shellLaunchConfig": {
        "executable": "/bin/sh", "args": args,
    }, "cwd": "/tmp", "cols": 80, "rows": 24,
    "env": { "PS1": "", "VSC_LIGHT_PTY_TEST": "preserved" } }),
        )
        .unwrap()
        .as_u64()
        .unwrap()
}

fn until(
    terminals: &mut Terminals,
    predicate: impl Fn(&str, &[Value]) -> bool,
) -> (String, Vec<Value>) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut events = Vec::new();
    loop {
        for event in terminals.drain() {
            if let Some(data) = event["bytes"].as_array() {
                bytes.extend(data.iter().map(|byte| byte.as_u64().unwrap() as u8));
                terminals
                    .call(
                        "acknowledgeDataEvent",
                        &json!({ "id": event["id"], "bytes": data.len() }),
                    )
                    .unwrap();
            }
            events.push(event);
        }
        let output = String::from_utf8_lossy(&bytes).into_owned();
        if predicate(&output, &events) {
            return (output, events);
        }
        assert!(
            Instant::now() < deadline,
            "terminal timed out: {output:?}; events={events:?}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn interactive_pty_has_a_tty_environment_cwd_resize_and_ctrl_c() {
    let mut terminals = Terminals::new();
    let id = shell(&mut terminals, json!(["-i"]));
    let ready = terminals.call("start", &json!({ "id": id })).unwrap();
    assert_eq!(ready["cwd"], "/tmp");
    assert!(ready["pid"].as_i64().unwrap() > 0);
    terminals
        .call("resize", &json!({ "id": id, "cols": 101, "rows": 37 }))
        .unwrap();
    terminals.call("input", &json!({ "id": id, "data": "test -t 0 && printf 'TTY=%s\\n' yes; stty size; printf 'ENV=%s\\n' \"$VSC_LIGHT_PTY_TEST\"; printf 'CWD=%s\\n' \"$PWD\"; printf '\\344\\275\\240\\345\\245\\275\\n'\n" })).unwrap();
    let (output, _) = until(&mut terminals, |output, _| output.contains("你好"));
    assert!(output.contains("TTY=yes"), "{output}");
    assert!(output.contains("37 101"), "{output}");
    assert!(output.contains("ENV=preserved"), "{output}");
    assert!(output.contains("CWD=/tmp"), "{output}");
    terminals
        .call("input", &json!({ "id": id, "data": "sleep 30\n" }))
        .unwrap();
    thread::sleep(Duration::from_millis(150));
    terminals
        .call("input", &json!({ "id": id, "data": "\u{3}" }))
        .unwrap();
    terminals
        .call(
            "input",
            &json!({ "id": id, "data": "printf 'alive%s\\n' 42\n" }),
        )
        .unwrap();
    until(&mut terminals, |output, _| output.contains("alive42"));
    terminals
        .call("input", &json!({ "id": id, "data": "exit 7\n" }))
        .unwrap();
    let (_, events) = until(&mut terminals, |_, events| {
        events.iter().any(|event| event["type"] == "exit")
    });
    assert_eq!(events.last().unwrap()["code"], 7);
    assert!(terminals.sessions.is_empty());
}

#[test]
fn shutdown_terminates_a_foreground_command_and_missing_shell_reports_an_error() {
    let mut terminals = Terminals::new();
    let id = shell(&mut terminals, json!(["-i"]));
    terminals.call("start", &json!({ "id": id })).unwrap();
    terminals
        .call("input", &json!({ "id": id, "data": "sleep 30\n" }))
        .unwrap();
    thread::sleep(Duration::from_millis(150));
    terminals.call("shutdown", &json!({ "id": id })).unwrap();
    until(&mut terminals, |_, events| {
        events.iter().any(|event| event["type"] == "exit")
    });
    assert!(terminals.sessions.is_empty());

    let id = terminals.call("createProcess", &json!({ "shellLaunchConfig": { "executable": "/does-not-exist/vsc-light-shell" }, "cwd": "/tmp" })).unwrap();
    assert_eq!(
        terminals
            .call("start", &json!({ "id": id }))
            .unwrap_err()
            .code,
        "ENOENT"
    );
    assert!(!profiles(&json!({})).as_array().unwrap().is_empty());
}

#[test]
fn large_output_is_bounded_until_acknowledged_and_arrives_before_exit() {
    let mut terminals = Terminals::new();
    let id = shell(&mut terminals, json!(["-c", "head -c 262144 /dev/zero"]));
    terminals.call("start", &json!({ "id": id })).unwrap();
    let mut delivered = 0;
    let deadline = Instant::now() + Duration::from_secs(5);
    while delivered < 128 * 1024 {
        for event in terminals.drain() {
            assert_eq!(event["type"], "data");
            delivered += event["bytes"].as_array().unwrap().len();
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    assert!(delivered < 128 * 1024 + 8192);
    assert!(terminals.drain().is_empty());
    terminals
        .call(
            "acknowledgeDataEvent",
            &json!({ "id": id, "bytes": delivered }),
        )
        .unwrap();
    let (remaining, events) = until(&mut terminals, |_, events| {
        events.iter().any(|event| event["type"] == "exit")
    });
    assert_eq!(delivered + remaining.len(), 262144);
    assert_eq!(events.last().unwrap()["code"], 0);
}
