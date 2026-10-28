mod cli;
mod extension_host;

use std::{env, process::ExitCode};

use serde_json::json;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("node-clone: {error}");
            ExitCode::from(9)
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let has_cli_args = !args.is_empty();
    let cli::Command::Run(options) = cli::parse(args)? else {
        println!("{}", cli::HELP);
        return Ok(());
    };
    let extension = extension_host::Options::parse(&options.script_args, |name| env::var_os(name))?;
    if !has_cli_args && extension == extension_host::Options::default() {
        println!("Hello, world!");
        return Ok(());
    }
    let runtime = options.runtime;
    let parsed = json!({
        "mode": "parse-only",
        "script": options.script.as_deref().map(|path| path.to_string_lossy()),
        "script_args": options.script_args.iter().map(|arg| arg.to_string_lossy()).collect::<Vec<_>>(),
        "runtime": {
            "dns_result_order": runtime.dns_result_order.map(cli::DnsResultOrder::as_str),
            "experimental_network_inspection": runtime.experimental_network_inspection,
            "inspector": { "mode": runtime.inspector.mode.as_str(), "host": runtime.inspector.host, "port": runtime.inspector.port },
            "lazy_compilation": runtime.lazy_compilation,
            "expose_gc": runtime.expose_gc,
            "prof": runtime.prof,
        },
        "extension_host": {
            "entrypoint": extension.entrypoint,
            "ipc_hook": extension.ipc_hook.as_deref().map(|path| path.to_string_lossy()),
            "handles_uncaught_errors": extension.handles_uncaught_errors,
            "parent_pid": extension.parent_pid,
            "nls_config": extension.nls_config,
            "skip_workspace_storage_lock": extension.skip_workspace_storage_lock,
            "support_global_navigator": extension.support_global_navigator,
        },
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&parsed).expect("configuration is JSON")
    );
    Ok(())
}
