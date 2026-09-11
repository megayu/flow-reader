use std::path::Path;

#[cfg(all(unix, not(target_os = "macos")))]
use std::path::PathBuf;
#[cfg(any(target_os = "windows", target_os = "macos", unix))]
use std::process::Command;

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn spawn_directory_command(program: &str, path: &Path) -> Result<(), String> {
    Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open directory: {error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_desktop_command(program: &str) -> Result<Command, String> {
    let mut command = Command::new(program);
    // System applications must not load libraries or GTK modules from the AppImage.
    // Keep host entries and the desktop session environment intact.
    if let Some(app_dir) = std::env::var_os("APPDIR").filter(|value| !value.is_empty()) {
        let app_dir = PathBuf::from(app_dir);
        for name in [
            "PATH",
            "LD_LIBRARY_PATH",
            "GTK_PATH",
            "GTK_EXE_PREFIX",
            "GTK_DATA_PREFIX",
            "GIO_MODULE_DIR",
            "GIO_EXTRA_MODULES",
            "GI_TYPELIB_PATH",
            "GSETTINGS_SCHEMA_DIR",
            "GDK_PIXBUF_MODULE_FILE",
            "GDK_PIXBUF_MODULEDIR",
            "GTK_IM_MODULE_FILE",
            "XDG_DATA_DIRS",
        ] {
            if let Some(value) = std::env::var_os(name) {
                let paths: Vec<_> = std::env::split_paths(&value)
                    .filter(|entry| !entry.starts_with(&app_dir))
                    .collect();
                if paths.is_empty() {
                    command.env_remove(name);
                } else {
                    command.env(name, std::env::join_paths(paths).map_err(|error| error.to_string())?);
                }
            }
        }
    }
    Ok(command)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn select_linux_file(path: &Path) -> Result<bool, String> {
    let path = std::path::absolute(path).map_err(|error| format!("failed to resolve file path: {error}"))?;
    let uri = tauri::Url::from_file_path(&path).map_err(|_| "failed to encode file URI".to_string())?;
    // dbus-send uses commas to separate array elements, even within a URI.
    let uris = format!("array:string:{}", uri.as_str().replace(',', "%2C"));
    let output = linux_desktop_command("dbus-send")?
        .args([
            "--session",
            "--type=method_call",
            "--print-reply",
            "--reply-timeout=5000",
            "--dest=org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
        ])
        .arg("org.freedesktop.FileManager1.ShowItems")
        .args([uris.as_str(), "string:"])
        .output();
    let output = match output {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("failed to contact file manager: {error}")),
    };
    if output.status.success() {
        return Ok(true);
    }
    let error = String::from_utf8_lossy(&output.stderr);
    if [
        "org.freedesktop.DBus.Error.ServiceUnknown",
        "org.freedesktop.DBus.Error.NameHasNoOwner",
        "org.freedesktop.DBus.Error.UnknownMethod",
        "org.freedesktop.DBus.Error.UnknownInterface",
    ]
    .iter()
    .any(|name| error.contains(name))
    {
        return Ok(false);
    }
    Err(format!(
        "file manager ShowItems failed ({}): {}",
        output.status,
        error.trim()
    ))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_linux_directory(path: &Path) -> Result<(), String> {
    let status = linux_desktop_command("xdg-open")?
        .arg(path)
        .status()
        .map_err(|error| format!("failed to open directory: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("file manager failed to open {}: {status}", path.display()))
    }
}

pub(crate) fn open_directory_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        spawn_directory_command("explorer", path)
    }

    #[cfg(target_os = "macos")]
    {
        spawn_directory_command("open", path)
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        open_linux_directory(path)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = path;
        Err("opening directories is not supported on this platform".to_string())
    }
}

pub(crate) fn reveal_file_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let path = std::path::absolute(path).map_err(|error| format!("failed to resolve file path: {error}"))?;
        Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal file: {error}"))
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R"])
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal file: {error}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if select_linux_file(path)? {
            return Ok(());
        }
        let Some(parent) = path.parent() else {
            return Err("source file has no parent directory".to_string());
        };
        open_linux_directory(parent)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = path;
        Err("revealing files is not supported on this platform".to_string())
    }
}
