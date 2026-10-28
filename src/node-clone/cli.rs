//! The subset of Node's command line used by the local extension host.

use std::{ffi::OsString, net::Ipv6Addr, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DnsResultOrder {
    Ipv4First,
    Ipv6First,
    Verbatim,
}

impl DnsResultOrder {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ipv4First => "ipv4first",
            Self::Ipv6First => "ipv6first",
            Self::Verbatim => "verbatim",
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum InspectorMode {
    #[default]
    Disabled,
    Inspect,
    Break,
}

impl InspectorMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Inspect => "inspect",
            Self::Break => "inspect-brk",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct InspectorOptions {
    pub mode: InspectorMode,
    pub host: String,
    pub port: u16,
}

impl Default for InspectorOptions {
    fn default() -> Self {
        Self {
            mode: InspectorMode::Disabled,
            host: "127.0.0.1".into(),
            port: 9229,
        }
    }
}

impl InspectorOptions {
    fn set_address(&mut self, address: &str) -> Result<(), String> {
        if address.is_empty() || address.chars().any(char::is_whitespace) {
            return Err("inspector address must not be empty or contain whitespace".into());
        }
        let port = if let Some(ipv6) = address.strip_prefix('[') {
            let (host, suffix) = ipv6
                .split_once(']')
                .ok_or("inspector IPv6 address requires a closing ']' bracket")?;
            host.parse::<Ipv6Addr>()
                .map_err(|_| "invalid inspector IPv6 address")?;
            self.host = host.into();
            if suffix.is_empty() {
                None
            } else {
                Some(
                    suffix
                        .strip_prefix(':')
                        .ok_or("expected ':' after inspector IPv6 address")?,
                )
            }
        } else if address.bytes().all(|byte| byte.is_ascii_digit()) {
            Some(address)
        } else if let Some((host, port)) = address.split_once(':') {
            if host.contains(':') || port.contains(':') {
                return Err("inspector IPv6 addresses must be enclosed in brackets".into());
            }
            if !host.is_empty() {
                self.host = host.into();
            }
            Some(port)
        } else {
            if address.starts_with('-') || address.contains(['[', ']']) {
                return Err("invalid inspector address".into());
            }
            self.host = address.into();
            None
        };
        if let Some(port) = port {
            if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("inspector port must be a decimal number".into());
            }
            self.port = port
                .parse::<u16>()
                .map_err(|_| "inspector port must be 0 or in range 1024–65535")?;
            if self.port != 0 && self.port < 1024 {
                return Err("inspector port must be 0 or in range 1024–65535".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct RuntimeOptions {
    pub dns_result_order: Option<DnsResultOrder>,
    pub experimental_network_inspection: bool,
    pub inspector: InspectorOptions,
    pub lazy_compilation: bool,
    pub expose_gc: bool,
    pub prof: bool,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            dns_result_order: None,
            experimental_network_inspection: false,
            inspector: InspectorOptions::default(),
            lazy_compilation: true,
            expose_gc: false,
            prof: false,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub runtime: RuntimeOptions,
    pub script: Option<PathBuf>,
    pub script_args: Vec<OsString>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Run(Options),
}

pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Command, String> {
    let mut args = args.into_iter();
    let mut options = Options::default();
    while let Some(arg) = args.next() {
        if arg == "--" {
            options.script = args.next().map(PathBuf::from);
            options.script_args.extend(args);
            break;
        }
        // Stop runtime option parsing at the script; retain its arguments verbatim.
        if arg == "-" || !arg.as_encoded_bytes().starts_with(b"-") {
            options.script = Some(PathBuf::from(arg));
            options.script_args.extend(args);
            break;
        }
        let text = arg.to_str().ok_or("runtime options must be valid UTF-8")?;
        let (flag, inline) = text
            .split_once('=')
            .map_or((text, None), |(flag, value)| (flag, Some(value)));
        match flag {
            "--help" | "-h" if inline.is_none() => return Ok(Command::Help),
            "--dns-result-order" => {
                let value = required_value(flag, inline, &mut args)?;
                options.runtime.dns_result_order = Some(match value.as_str() {
                    "ipv4first" => DnsResultOrder::Ipv4First,
                    "ipv6first" => DnsResultOrder::Ipv6First,
                    "verbatim" => DnsResultOrder::Verbatim,
                    _ => {
                        return Err(
                            "--dns-result-order expects ipv4first, ipv6first, or verbatim".into(),
                        );
                    }
                });
            }
            "--inspect-port" => {
                let value = required_value(flag, inline, &mut args)?;
                options
                    .runtime
                    .inspector
                    .set_address(&value)
                    .map_err(|error| format!("{flag}: {error}"))?;
            }
            "--inspect" | "--inspect-brk" => {
                options.runtime.inspector.mode = if flag == "--inspect" {
                    InspectorMode::Inspect
                } else {
                    InspectorMode::Break
                };
                if let Some(value) = inline {
                    options
                        .runtime
                        .inspector
                        .set_address(value)
                        .map_err(|error| format!("{flag}: {error}"))?;
                }
            }
            "--experimental-network-inspection" if inline.is_none() => {
                options.runtime.experimental_network_inspection = true
            }
            "--nolazy" if inline.is_none() => options.runtime.lazy_compilation = false,
            "--expose-gc" if inline.is_none() => options.runtime.expose_gc = true,
            "--prof" if inline.is_none() => options.runtime.prof = true,
            _ => return Err(format!("unsupported runtime option: {text}")),
        }
    }
    Ok(Command::Run(options))
}

fn required_value(
    flag: &str,
    inline: Option<&str>,
    args: &mut impl Iterator<Item = OsString>,
) -> Result<String, String> {
    let value = match inline {
        Some(value) => value.to_owned(),
        None => args
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?
            .into_string()
            .map_err(|_| format!("{flag} requires a UTF-8 value"))?,
    };
    if value.is_empty() || value.starts_with("--") {
        return Err(format!("{flag} requires a value"));
    }
    Ok(value)
}

pub const HELP: &str = "Usage: node-clone [runtime options] [--] [script [script arguments...]]

Runtime options:
  --dns-result-order=ORDER          ipv4first, ipv6first, or verbatim
  --experimental-network-inspection
  --inspect-port=[HOST:]PORT        Configure inspector address without enabling it
  --inspect[=[HOST:]PORT]           Enable inspector (default: 127.0.0.1:9229)
  --inspect-brk[=[HOST:]PORT]        Enable inspector and break at startup
  --nolazy                         Disable lazy compilation
  --expose-gc                      Expose garbage collection
  --prof                           Enable profiling
  -h, --help                       Show this help

Extension-host script options (after script):
  --skipWorkspaceStorageLock[=true|false]
  --supportGlobalNavigator[=true|false]

Extension-host environment:
  VSCODE_ESM_ENTRYPOINT, VSCODE_EXTHOST_IPC_HOOK,
  VSCODE_HANDLES_UNCAUGHT_ERRORS, VSCODE_PARENT_PID, VSCODE_NLS_CONFIG

This scaffold only parses and reports configuration. JavaScript execution,
inspector, profiling, networking, and garbage-collection controls are not implemented.";

#[cfg(test)]
mod tests;
