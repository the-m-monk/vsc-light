//! Per-window state and asynchronous GTK folder selection.

use std::{
    cell::RefCell,
    fs, io,
    path::{Path, PathBuf},
    time::Instant,
};

use gtk4::{FileDialog, Window, gio, prelude::*};
use javascriptcore6::Value;
use serde_json::json;
use webkit6::{ScriptMessageReply, WebView};

use crate::host::HostError;

use super::bridge::respond;

pub(super) struct WindowState {
    folder: RefCell<Option<PathBuf>>,
    state_file: PathBuf,
}

impl Default for WindowState {
    fn default() -> Self {
        Self::restore(gtk4::glib::user_data_dir().join("vsc-light/window-state.json"))
    }
}

impl WindowState {
    fn restore(state_file: PathBuf) -> Self {
        let folder = match fs::read(&state_file) {
            Ok(contents) => {
                let result = serde_json::from_slice::<serde_json::Value>(&contents)
                    .map_err(|error| HostError::invalid(error.to_string()))
                    .and_then(|state| {
                        state["folder"]
                            .as_str()
                            .ok_or_else(|| HostError::invalid("saved folder path is missing"))
                            .and_then(validate_folder)
                    });
                match result {
                    Ok(folder) => {
                        eprintln!("[vsc-light:window] restoring folder {}", folder.display());
                        Some(folder)
                    }
                    Err(error) => {
                        eprintln!("[vsc-light:window] ignoring saved folder: {error}");
                        None
                    }
                }
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    eprintln!(
                        "[vsc-light:window] unable to read {}: {error}",
                        state_file.display()
                    );
                }
                None
            }
        };
        Self {
            folder: RefCell::new(folder),
            state_file,
        }
    }

    fn set_folder(&self, path: &str) -> crate::host::Result<()> {
        let folder = validate_folder(path)?;
        if let Err(error) = self.save_folder(&folder) {
            // An unwritable state directory must not prevent opening a valid folder.
            eprintln!(
                "[vsc-light:window] unable to remember folder in {}: {error}",
                self.state_file.display()
            );
        }
        *self.folder.borrow_mut() = Some(folder);
        Ok(())
    }

    fn save_folder(&self, folder: &Path) -> io::Result<()> {
        if let Some(parent) = self.state_file.parent() {
            fs::create_dir_all(parent)?;
        }
        let contents = json!({ "folder": folder }).to_string();
        gio::File::for_path(&self.state_file)
            .replace_contents(
                contents.as_bytes(),
                None,
                false,
                gio::FileCreateFlags::PRIVATE,
                None::<&gio::Cancellable>,
            )
            .map_err(io::Error::other)?;
        Ok(())
    }

    pub(super) fn handle(
        &self,
        request: &serde_json::Value,
        message: &Value,
        reply: &ScriptMessageReply,
        webview: &WebView,
    ) -> bool {
        let method = request["method"].as_str().unwrap_or_default();
        match method {
            "window.getState" => {
                let folder_id = self.folder.borrow().as_ref().map(|folder| {
                    gtk4::glib::compute_checksum_for_string(
                        gtk4::glib::ChecksumType::Md5,
                        folder.to_string_lossy().as_ref(),
                    )
                    .expect("MD5 checksum is supported")
                    .to_string()
                });
                respond(
                    message,
                    reply,
                    json!({ "id": request["id"], "ok": true,
                    "value": { "folder": *self.folder.borrow(), "folderId": folder_id,
                    "homeDir": std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()),
                    "userDataDir": std::env::var("VSC_LIGHT_USER_DATA_DIR").unwrap_or_else(|_| "/tmp/vsc-light-user-data".into()),
                    "extensionPaths": super::extensions::paths() } }),
                );
            }
            "window.validateFolder" | "window.setFolder" => {
                let result = request["args"]["path"]
                    .as_str()
                    .ok_or_else(|| HostError::invalid("folder path is required"))
                    .and_then(|path| {
                        if method == "window.setFolder" {
                            self.set_folder(path)
                        } else {
                            validate_folder(path).map(|_| ())
                        }
                    });
                let response = match result {
                    Ok(()) => json!({ "id": request["id"], "ok": true, "value": null }),
                    Err(error) => {
                        json!({ "id": request["id"], "ok": false, "error": error.to_json() })
                    }
                };
                respond(message, reply, response);
            }
            "dialog.pickFolder" => {
                let started = Instant::now();
                let id = request["id"].clone();
                let dialog = FileDialog::builder()
                    .title("Open Folder")
                    .modal(true)
                    .build();
                if let Some(path) = request["args"]["defaultPath"].as_str() {
                    dialog.set_initial_folder(Some(&gio::File::for_path(path)));
                }
                let parent = webview.root().and_downcast::<Window>();
                eprintln!(
                    "[vsc-light:picker] id={id} starting defaultPath={} parent={} webview_mapped={}",
                    request["args"]["defaultPath"],
                    parent.is_some(),
                    webview.is_mapped(),
                );
                if let Some(parent) = parent.as_ref() {
                    eprintln!(
                        "[vsc-light:picker] id={id} parent active={} visible={} mapped={}",
                        parent.is_active(),
                        parent.is_visible(),
                        parent.is_mapped(),
                    );
                }
                let message = message.clone();
                let reply = reply.clone();
                dialog.select_folder(parent.as_ref(), None::<&gio::Cancellable>, move |result| {
                    match &result {
                        Ok(file) => eprintln!(
                            "[vsc-light:picker] id={id} callback after={}ms uri={} path={:?}",
                            started.elapsed().as_millis(), file.uri(), file.path(),
                        ),
                        Err(error) => eprintln!(
                            "[vsc-light:picker] id={id} callback after={}ms cancelled={} domain={:?} code={} message={}",
                            started.elapsed().as_millis(),
                            error.matches(gtk4::DialogError::Dismissed) || error.matches(gtk4::DialogError::Cancelled),
                            error.domain(), error.code(), error.message(),
                        ),
                    }
                    let response = match result {
                        Ok(file) => match file.path() {
                            Some(path) => json!({ "id": id, "ok": true, "value": path }),
                            None => json!({ "id": id, "ok": false, "error": HostError::invalid("only local folders are supported").to_json() }),
                        },
                        Err(error) if error.matches(gtk4::DialogError::Dismissed) || error.matches(gtk4::DialogError::Cancelled) => {
                            json!({ "id": id, "ok": true, "value": null })
                        }
                        Err(error) => json!({ "id": id, "ok": false, "error": { "code": "EIO", "message": error.to_string() } }),
                    };
                    eprintln!("[vsc-light:picker] id={id} replying {response}");
                    respond(&message, &reply, response);
                });
            }
            _ => return false,
        }
        true
    }
}

fn validate_folder(path: &str) -> crate::host::Result<PathBuf> {
    let path = std::fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(HostError::invalid("selected path is not a directory"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::{WindowState, validate_folder};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "vsc-light-window-test-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn last_folder_survives_restart_and_invalid_selection_keeps_previous_folder() {
        let directory = Directory::new();
        let state_file = directory.0.join("user-data/window-state.json");
        let folder = directory.0.join("folder with spaces 你好");
        fs::create_dir(&folder).unwrap();
        let folder = fs::canonicalize(folder).unwrap();
        let state = WindowState::restore(state_file.clone());
        assert!(state.folder.borrow().is_none());
        state.set_folder(folder.to_str().unwrap()).unwrap();
        drop(state);

        let state = WindowState::restore(state_file.clone());
        assert_eq!(state.folder.borrow().as_ref(), Some(&folder));
        assert!(
            state
                .set_folder(directory.0.join("missing").to_str().unwrap())
                .is_err()
        );
        assert_eq!(
            WindowState::restore(state_file.clone())
                .folder
                .borrow()
                .as_ref(),
            Some(&folder)
        );

        let next_folder = directory.0.join("next");
        fs::create_dir(&next_folder).unwrap();
        let next_folder = fs::canonicalize(next_folder).unwrap();
        state.set_folder(next_folder.to_str().unwrap()).unwrap();
        assert_eq!(
            WindowState::restore(state_file).folder.borrow().as_ref(),
            Some(&next_folder)
        );
    }

    #[test]
    fn missing_folders_and_corrupt_state_start_with_an_empty_window() {
        let directory = Directory::new();
        let state_file = directory.0.join("window-state.json");
        let folder = directory.0.join("removed");
        fs::create_dir(&folder).unwrap();
        WindowState::restore(state_file.clone())
            .set_folder(folder.to_str().unwrap())
            .unwrap();
        fs::remove_dir(&folder).unwrap();
        assert!(
            WindowState::restore(state_file.clone())
                .folder
                .borrow()
                .is_none()
        );
        fs::write(&state_file, "invalid JSON").unwrap();
        assert!(
            WindowState::restore(state_file.clone())
                .folder
                .borrow()
                .is_none()
        );
        fs::write(&state_file, "{}").unwrap();
        assert!(WindowState::restore(state_file).folder.borrow().is_none());
    }

    #[test]
    fn a_failed_state_write_does_not_block_opening_a_folder() {
        let directory = Directory::new();
        let blocker = directory.0.join("not-a-directory");
        fs::write(&blocker, "keep").unwrap();
        let state = WindowState::restore(blocker.join("window-state.json"));
        state.set_folder(directory.0.to_str().unwrap()).unwrap();
        assert_eq!(
            state.folder.borrow().as_ref(),
            Some(&fs::canonicalize(&directory.0).unwrap())
        );
        assert_eq!(fs::read_to_string(blocker).unwrap(), "keep");
    }

    #[test]
    fn folder_validation_rejects_files_and_missing_paths() {
        assert!(
            validate_folder(env!("CARGO_MANIFEST_DIR"))
                .unwrap()
                .is_absolute()
        );
        assert!(validate_folder(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).is_err());
        assert_eq!(
            validate_folder("/does-not-exist/vsc-light")
                .unwrap_err()
                .code,
            "ENOENT"
        );
    }
}
