//! Node extension host ownership and bounded, asynchronous stdio transport.

use crate::host::{HostError, Result};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, SyncSender},
    thread,
};

thread_local! { static HOSTS: RefCell<Hosts> = RefCell::new(Hosts::new()); }
struct Session {
    child: Option<Child>,
    input: Option<SyncSender<Value>>,
}
struct Hosts {
    next_id: u32,
    sessions: HashMap<String, Session>,
    sender: SyncSender<Value>,
    receiver: Receiver<Value>,
}

pub(super) fn dispatch(operation: &str, args: &Value) -> Result<Value> {
    HOSTS.with(|hosts| hosts.borrow_mut().call(operation, args))
}
pub(in crate::host) fn drain_events() -> Vec<Value> {
    HOSTS.with(|hosts| hosts.borrow_mut().drain())
}
pub(in crate::host) fn shutdown_all() {
    HOSTS.with(|hosts| hosts.borrow_mut().sessions.clear());
}
impl Drop for Session {
    fn drop(&mut self) {
        // Closing stdin lets the helper deactivate extensions and remove its socket.
        self.input.take();
        if let Some(mut child) = self.child.take() {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}
impl Hosts {
    fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel(128);
        Self {
            next_id: 1,
            sessions: HashMap::new(),
            sender,
            receiver,
        }
    }
    fn call(&mut self, operation: &str, args: &Value) -> Result<Value> {
        if operation == "create" {
            let id = self.next_id.to_string();
            self.next_id += 1;
            self.sessions.insert(
                id.clone(),
                Session {
                    child: None,
                    input: None,
                },
            );
            return Ok(json!({ "id": id }));
        }
        let id = args["id"]
            .as_str()
            .ok_or_else(|| HostError::invalid("extension host id is required"))?;
        if operation == "kill" {
            if let Some(session) = self.sessions.remove(id) {
                if let Some(child) = &session.child {
                    // Ask our helper to kill its child and remove its private socket.
                    unsafe {
                        libc::kill(child.id() as i32, libc::SIGTERM);
                    }
                }
            }
            return Ok(Value::Null);
        }
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| HostError::invalid("Unknown extension host"))?;
        if operation == "start" {
            if session.child.is_some() {
                return Err(HostError::invalid("Extension host is already started"));
            }
            let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("build/vscode/out-vscode/vsc-light-extension-host.mjs");
            if !helper.is_file() {
                return Err(HostError::invalid(
                    "Extension host helper is missing; rebuild the vsc-light-bundle",
                ));
            }
            let mut child = Command::new("node")
                .arg(helper)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()?;
            let mut input = child.stdin.take().unwrap();
            let output = child.stdout.take().unwrap();
            let (sender, receiver) = mpsc::sync_channel::<Value>(128);
            sender
                .send(json!({ "operation": "start", "options": args["options"] }))
                .unwrap();
            thread::spawn(move || {
                for message in receiver {
                    if writeln!(input, "{message}").is_err() {
                        break;
                    }
                }
            });
            let events = self.sender.clone();
            let id = id.to_string();
            thread::spawn(move || {
                for line in BufReader::new(output).lines() {
                    let event = match line {
                        Ok(line) => serde_json::from_str::<Value>(&line),
                        Err(_) => break,
                    };
                    match event {
                        Ok(mut event) => {
                            event["id"] = json!(id);
                            if events.send(event).is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = events.send(json!({ "id": id, "event": "error", "message": format!("Invalid extension host response: {error}") }));
                        }
                    }
                }
                let _ = events.send(json!({ "id": id, "event": "closed" }));
            });
            session.child = Some(child);
            session.input = Some(sender);
            return Ok(Value::Null);
        }
        let input = session
            .input
            .as_ref()
            .ok_or_else(|| HostError::invalid("Extension host is not started"))?;
        let request = match operation {
            "send" => {
                if !args["bytes"].is_array() {
                    return Err(HostError::invalid("Extension host bytes are required"));
                }
                json!({ "operation": "send", "bytes": args["bytes"] })
            }
            "inspect" => json!({ "operation": "inspect" }),
            _ => {
                return Err(HostError::unsupported(format!(
                    "Unknown extension host operation: {operation}"
                )));
            }
        };
        input.try_send(request).map_err(|error| {
            HostError::invalid(format!("Extension host input unavailable: {error}"))
        })?;
        Ok(Value::Null)
    }
    fn drain(&mut self) -> Vec<Value> {
        let mut result = Vec::new();
        for _ in 0..128 {
            let Ok(event) = self.receiver.try_recv() else {
                break;
            };
            if event["event"] == "closed" {
                if let Some(id) = event["id"].as_str() {
                    self.sessions.remove(id);
                }
            }
            result.push(event);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    // The real Node bundle is required, so keep this separate from fast Rust unit tests.
    #[test]
    #[ignore = "requires a compiled vsc-light-bundle and Node"]
    fn node_handshake_and_process_cleanup() {
        let mut hosts = Hosts::new();
        let logs = std::env::temp_dir().join(format!(
            "vsc-light-extension-host-test-{}",
            std::process::id()
        ));
        let id = hosts.call("create", &json!({})).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        hosts
            .call(
                "start",
                &json!({ "id": id, "options": { "env": {}, "execArgv": [] } }),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut pid = None;
        let mut ready = false;
        let mut initialized = false;
        let mut exited = false;
        let mut closed = false;
        while Instant::now() < deadline && !closed {
            for event in hosts.drain() {
                match event["event"].as_str().unwrap() {
                    "started" => pid = event["pid"].as_i64(),
                    "data" if event["bytes"] == json!([2]) => {
                        ready = true;
                        let data = json!({ "parentPid": 0, "environment": {}, "extensions": { "versionId": 0, "allExtensions": [], "myExtensions": [], "activationEvents": {} }, "telemetryInfo": {}, "loggers": [], "remote": {}, "consoleForward": {}, "logsLocation": { "scheme": "file", "path": logs }, "autoStart": false, "uiKind": 1 });
                        hosts
                            .call(
                                "send",
                                &json!({ "id": id, "bytes": data.to_string().as_bytes() }),
                            )
                            .unwrap();
                    }
                    "data" if event["bytes"] == json!([1]) => {
                        initialized = true;
                        // Exercise the same EOF shutdown as a window reload/close.
                        hosts.sessions.clear();
                    }
                    "exit" => {
                        assert_eq!(event["code"], 0);
                        exited = true;
                    }
                    "closed" => closed = true,
                    "error" => panic!("Extension host error: {event}"),
                    _ => {}
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ready && initialized && exited && closed,
            "incomplete Node handshake or cleanup"
        );
        assert!(hosts.sessions.is_empty());
        let pid = pid.expect("Node pid") as i32;
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "Node extension host was orphaned"
        );

        let id = hosts.call("create", &json!({})).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        hosts
            .call(
                "start",
                &json!({ "id": id, "options": { "env": {}, "execArgv": [] } }),
            )
            .unwrap();
        hosts.call("kill", &json!({ "id": id })).unwrap();
        assert!(hosts.sessions.is_empty(), "cancelled host was retained");
        assert!(
            hosts
                .call("send", &json!({ "id": id, "bytes": [1] }))
                .is_err()
        );
        let _ = std::fs::remove_dir_all(logs);
    }
}
