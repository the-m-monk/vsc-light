//! Linux pseudoterminals. Blocking PTY reads run off the GTK thread.

use crate::host::{HostError, Result};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs::{self, File},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            fs::PermissionsExt,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
    },
    thread,
};

#[cfg(test)]
mod tests;

thread_local! { static TERMINALS: RefCell<Terminals> = RefCell::new(Terminals::new()); }

struct Process {
    master: File,
    writer: Sender<Vec<u8>>,
    pid: i32,
    cwd: PathBuf,
    outstanding: usize,
}
struct Session {
    config: Value,
    process: Option<Process>,
}
struct Terminals {
    next_id: u32,
    sessions: HashMap<u32, Session>,
    sender: SyncSender<Value>,
    receiver: Receiver<Value>,
}

pub(super) fn dispatch(operation: &str, args: &Value) -> Result<Value> {
    TERMINALS.with(|terminals| terminals.borrow_mut().call(operation, args))
}

pub(in crate::host) fn drain_events() -> Vec<Value> {
    TERMINALS.with(|terminals| terminals.borrow_mut().drain())
}

pub(in crate::host) fn shutdown_all() {
    TERMINALS.with(|terminals| terminals.borrow_mut().stop_all());
}

impl Terminals {
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
        match operation {
            "getEnvironment" => {
                return Ok(json!(
                    std::env::vars_os()
                        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
                        .collect::<HashMap<_, _>>()
                ));
            }
            "getDefaultSystemShell" => return Ok(json!(default_shell())),
            "getProfiles" => return Ok(profiles(args)),
            "createProcess" => {
                let id = self.next_id;
                self.next_id += 1;
                self.sessions.insert(
                    id,
                    Session {
                        config: args.clone(),
                        process: None,
                    },
                );
                return Ok(json!(id));
            }
            "shutdownAll" => {
                self.stop_all();
                return Ok(Value::Null);
            }
            _ => {}
        }
        let id = args["id"]
            .as_u64()
            .and_then(|id| u32::try_from(id).ok())
            .ok_or_else(|| HostError::invalid("terminal id is required"))?;
        if operation == "acknowledgeDataEvent" {
            if let Some(process) = self
                .sessions
                .get_mut(&id)
                .and_then(|session| session.process.as_mut())
            {
                process.outstanding = process
                    .outstanding
                    .saturating_sub(args["bytes"].as_u64().unwrap_or(0) as usize);
            }
            return Ok(Value::Null);
        }
        if operation == "shutdown" {
            if let Some(session) = self.sessions.remove(&id) {
                if let Some(process) = session.process {
                    terminate(&process)?;
                }
            }
            return Ok(Value::Null);
        }
        let session = self
            .sessions
            .get_mut(&id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "terminal does not exist"))?;
        if operation == "start" {
            if session.process.is_some() {
                return Err(HostError::invalid("terminal already started"));
            }
            let process = spawn(id, &session.config, self.sender.clone())?;
            let ready = json!({ "pid": process.pid, "cwd": process.cwd });
            session.process = Some(process);
            return Ok(ready);
        }
        let process = session
            .process
            .as_mut()
            .ok_or_else(|| HostError::invalid("terminal has not started"))?;
        match operation {
            "input" => {
                let data = args["data"]
                    .as_str()
                    .ok_or_else(|| HostError::invalid("terminal input must be a string"))?;
                process.writer.send(data.as_bytes().to_vec()).map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "terminal input closed")
                })?;
            }
            "processBinary" => {
                let bytes: Vec<u8> = serde_json::from_value(args["bytes"].clone())
                    .map_err(|error| HostError::invalid(error.to_string()))?;
                process.writer.send(bytes).map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "terminal input closed")
                })?;
            }
            "resize" => resize(&process.master, args)?,
            "sendSignal" => {
                let value = match args["signal"].as_str() {
                    Some("SIGINT") => libc::SIGINT,
                    Some("SIGTERM") => libc::SIGTERM,
                    Some("SIGHUP") => libc::SIGHUP,
                    Some("SIGKILL") => libc::SIGKILL,
                    Some("SIGQUIT") => libc::SIGQUIT,
                    _ => return Err(HostError::invalid("unsupported terminal signal")),
                };
                signal(process.pid, value)?;
            }
            "getCwd" => {
                return Ok(json!(
                    fs::read_link(format!("/proc/{}/cwd", process.pid))
                        .unwrap_or_else(|_| process.cwd.clone())
                ));
            }
            "getInitialCwd" => return Ok(json!(process.cwd)),
            "hasChildProcesses" => {
                return Ok(json!(
                    fs::read_to_string(format!("/proc/{0}/task/{0}/children", process.pid))
                        .is_ok_and(|children| !children.trim().is_empty())
                ));
            }
            _ => {
                return Err(HostError::unsupported(format!(
                    "unsupported host method: terminal.{operation}"
                )));
            }
        }
        Ok(Value::Null)
    }

    fn drain(&mut self) -> Vec<Value> {
        let mut events = Vec::new();
        while events.len() < 32 {
            // Let xterm's write acknowledgements bound output queued in the renderer.
            if self
                .sessions
                .values()
                .filter_map(|session| session.process.as_ref())
                .map(|process| process.outstanding)
                .sum::<usize>()
                >= 128 * 1024
            {
                break;
            }
            let Ok(event) = self.receiver.try_recv() else {
                break;
            };
            let id = event["id"].as_u64().unwrap() as u32;
            if let Some(process) = self
                .sessions
                .get_mut(&id)
                .and_then(|session| session.process.as_mut())
            {
                process.outstanding += event["bytes"].as_array().map_or(0, Vec::len);
            }
            if event["type"] == "exit" {
                self.sessions.remove(&id);
            }
            events.push(event);
        }
        events
    }

    fn stop_all(&mut self) {
        for (_, session) in self.sessions.drain() {
            if let Some(process) = session.process {
                let _ = terminate(&process);
            }
        }
        while self.receiver.try_recv().is_ok() {}
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn terminate(process: &Process) -> io::Result<()> {
    // Job-control shells put foreground commands in a separate process group.
    let foreground = unsafe { libc::tcgetpgrp(process.master.as_raw_fd()) };
    if foreground > 0 && foreground != process.pid {
        signal(foreground, libc::SIGKILL)?;
    }
    signal(process.pid, libc::SIGKILL)
}

fn signal(pid: i32, value: i32) -> io::Result<()> {
    // Each shell is its own session leader, so also terminate foreground child commands.
    if unsafe { libc::kill(-pid, value) } == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

fn dimensions(args: &Value) -> Result<libc::winsize> {
    let number = |key: &str, default| -> Result<u16> {
        let value = args.get(key).and_then(Value::as_u64).unwrap_or(default);
        u16::try_from(value)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| HostError::invalid(format!("invalid terminal {key}")))
    };
    Ok(libc::winsize {
        ws_col: number("cols", 80)?,
        ws_row: number("rows", 24)?,
        ws_xpixel: 0,
        ws_ypixel: 0,
    })
}

fn resize(master: &File, args: &Value) -> Result<()> {
    let size = dimensions(args)?;
    if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) } == -1 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}

fn spawn(id: u32, config: &Value, sender: SyncSender<Value>) -> Result<Process> {
    let launch = &config["shellLaunchConfig"];
    let executable = launch["executable"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(default_shell);
    let cwd = config["cwd"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(glib_home);
    let cwd = fs::canonicalize(cwd)?;
    let size = dimensions(config)?;
    let (mut master_fd, mut slave_fd) = (-1, -1);
    if unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null(),
            &size,
        )
    } == -1
    {
        return Err(io::Error::last_os_error().into());
    }
    // Own descriptors immediately, so every error path closes both ends.
    let master = unsafe { File::from_raw_fd(master_fd) };
    let slave = unsafe { File::from_raw_fd(slave_fd) };
    for file in [&master, &slave] {
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error().into());
        }
    }
    let mut command = Command::new(executable);
    if launch["strictEnv"].as_bool() == Some(true) {
        command.env_clear();
    }
    command
        .current_dir(&cwd)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("TERM_PROGRAM", "vsc-light");
    for environment in [&config["env"], &launch["env"]] {
        if let Some(environment) = environment.as_object() {
            for (key, value) in environment {
                match value {
                    Value::String(value) => {
                        command.env(key, value);
                    }
                    Value::Null => {
                        command.env_remove(key);
                    }
                    _ => {
                        return Err(HostError::invalid(
                            "terminal environment values must be strings or null",
                        ));
                    }
                }
            }
        }
    }
    if !launch["args"].is_null() {
        let args: Vec<String> = serde_json::from_value(launch["args"].clone())
            .map_err(|error| HostError::invalid(error.to_string()))?;
        command.args(args);
    }
    command
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    // Only async-signal-safe system calls run between fork and exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 || libc::ioctl(0, libc::TIOCSCTTY, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut reader = master.try_clone()?;
    let mut input = master.try_clone()?;
    let (writer, writes) = mpsc::channel::<Vec<u8>>();
    let mut child = command.spawn()?;
    let pid = child.id() as i32;
    // Large pastes can fill the tty input buffer; never block GTK while writing them.
    thread::spawn(move || {
        while let Ok(bytes) = writes.recv() {
            if input.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    let exited = Arc::new(AtomicBool::new(false));
    let reader_exited = exited.clone();
    let reader_sender = sender.clone();
    let output = thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            let mut poll = libc::pollfd {
                fd: reader.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut poll, 1, 100) };
            if result == 0 {
                if reader_exited.load(Ordering::Acquire) {
                    break;
                }
                continue;
            }
            if result < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    if reader_sender
                        .send(json!({ "id": id, "type": "data", "bytes": &buffer[..length] }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break, // Linux returns EIO when the slave closes.
            }
        }
    });
    thread::spawn(move || {
        let code = child
            .wait()
            .map(|status| status.code().unwrap_or(128 + status.signal().unwrap_or(0)))
            .unwrap_or(1);
        exited.store(true, Ordering::Release);
        // Flush final output before exit; a background job holding the slave must not hang exit.
        let _ = output.join();
        let _ = sender.send(json!({ "id": id, "type": "exit", "code": code }));
    });
    Ok(Process {
        master,
        writer,
        pid,
        cwd,
        outstanding: 0,
    })
}

fn glib_home() -> PathBuf {
    gtk4::glib::home_dir()
}
fn executable(path: &Path) -> bool {
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}
fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|path| executable(Path::new(path)))
        .unwrap_or_else(|| {
            if executable(Path::new("/bin/bash")) {
                "/bin/bash".into()
            } else {
                "/bin/sh".into()
            }
        })
}

fn profiles(args: &Value) -> Value {
    let default = default_shell();
    let mut paths: Vec<_> = fs::read_to_string("/etc/shells")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with('/') && executable(Path::new(line)))
        .map(str::to_owned)
        .collect();
    paths.insert(0, default.clone());
    let mut profiles = HashMap::new();
    for path in paths {
        let name = Path::new(&path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        profiles
            .entry(name.clone())
            .or_insert(json!({ "profileName": name, "path": path, "isDefault": path == default }));
    }
    if let Some(configured) = args["profiles"].as_object() {
        for (name, profile) in configured {
            if profile.is_null() {
                profiles.remove(name);
                continue;
            }
            let candidates: Vec<_> = match &profile["path"] {
                Value::String(path) => vec![path.as_str()],
                Value::Array(paths) => paths.iter().filter_map(Value::as_str).collect(),
                _ => continue,
            };
            if let Some(path) = candidates
                .into_iter()
                .find(|path| executable(Path::new(path)))
            {
                let mut result = profile.clone();
                result["profileName"] = json!(name);
                result["path"] = json!(path);
                profiles.insert(name.clone(), result);
            }
        }
    }
    if let Some(name) = args["defaultProfile"].as_str() {
        for (profile_name, profile) in &mut profiles {
            profile["isDefault"] = json!(profile_name == name);
        }
    }
    let mut profiles: Vec<_> = profiles.into_values().collect();
    profiles.sort_by(|a, b| a["profileName"].as_str().cmp(&b["profileName"].as_str()));
    json!(profiles)
}
