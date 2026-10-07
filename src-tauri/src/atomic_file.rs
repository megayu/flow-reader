use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::Serialize;

pub(crate) enum Durability {
    Buffered,
    Synced,
}

/// Only call during exclusive startup, before any writers or background tasks start.
/// The application establishes single-instance ownership before loading storage.
pub(crate) fn cleanup_interrupted_json_write(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid JSON target name: {}", path.display()))?;
    let prefix = format!(".{name}.flow-reader-");
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Cannot inspect interrupted writes for {}: {error}",
                path.display()
            ));
        }
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("Cannot inspect {}: {error}", parent.display()))?;
        let file_name = entry.file_name();
        let Some((pid, sequence)) = file_name
            .to_str()
            .and_then(|name| name.strip_prefix(&prefix))
            .and_then(|name| name.strip_suffix(".tmp"))
            .and_then(|name| name.split_once('-'))
        else {
            continue;
        };
        let decimal = |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
        if !decimal(pid) || pid.parse::<u32>().is_err() || !decimal(sequence) || sequence.parse::<u64>().is_err() {
            continue;
        }
        let temp = entry.path();
        if !entry
            .file_type()
            .map_err(|error| format!("Cannot inspect {}: {error}", temp.display()))?
            .is_file()
        {
            continue;
        }
        fs::remove_file(&temp)
            .map_err(|error| format!("Cannot clean interrupted write {}: {error}", temp.display()))?;
    }
    Ok(())
}

/// Publishes a complete JSON file without moving or deleting the old destination first.
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T, durability: Durability) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Cannot serialize JSON for {}: {error}", path.display()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create parent directory for {}: {error}", path.display()))?;
    }
    write_file(path, durability, |file| file.write_all(&data))
}

/// The callback must flush its buffers and close source handles before returning.
/// Only a successful callback can publish the staged file.
/// The destination directory must already exist.
pub(crate) fn write_file(
    path: &Path,
    durability: Durability,
    write: impl FnOnce(&mut fs::File) -> io::Result<()>,
) -> Result<(), String> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    let context =
        |stage: &str, error: &dyn std::fmt::Display| format!("Cannot {stage} for {}: {error}", path.display());
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| format!("Missing file name: {}", path.display()))?;

    let mut staged = None;
    for _ in 0..32 {
        let mut temp_name = std::ffi::OsString::from(".");
        temp_name.push(name);
        temp_name.push(format!(
            ".flow-reader-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let temp = parent.join(temp_name);
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => {
                staged = Some((temp, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(context("create temporary file", &error)),
        }
    }
    let (temp, mut file) = staged.ok_or_else(|| context("create temporary file", &"name collisions"))?;
    let result = (|| {
        write(&mut file).map_err(|error| context("write temporary file", &error))?;
        if matches!(durability, Durability::Synced) {
            file.sync_all()
                .map_err(|error| context("sync temporary file", &error))?;
        }
        Ok(())
    })();
    // Close the handle before replacement or cleanup, including on write/sync failure.
    drop(file);
    let result = result.and_then(|()| fs::rename(&temp, path).map_err(|error| context("replace target", &error)));
    if let Err(error) = result {
        return match fs::remove_file(&temp) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!(
                "{error}; cannot remove temporary file {}: {cleanup}",
                temp.display()
            )),
        };
    }

    #[cfg(not(windows))]
    if matches!(durability, Durability::Synced) {
        // Replacement has already committed; a directory sync error cannot safely roll it back.
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| context("sync parent directory (target already replaced)", &error))?;
    }
    Ok(())
}
