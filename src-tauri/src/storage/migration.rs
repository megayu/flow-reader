use crate::storage_activity::StorageAccess;

use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window, ipc::Channel};

use super::{APP_DATA_DIR_ENV, AppCloseInput, AppStorage, default_data_root, persist_app_close_state};
use crate::{
    atomic_file::{self, Durability},
    dictionary::session::DictionarySessionManager,
    storage_activity::StorageMigration,
};

const LOCATION_FILE: &str = "storage-location.json";
const TARGET_FOLDER: &str = "Flow Reader";
const REFERENCE_FILES: [(&str, &str); 2] = [
    ("library.json", "books"),
    ("dictionaries/registry.json", "dictionaries"),
];

fn portable_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path.into()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageLocation {
    data_directory: PathBuf,
}

pub(super) fn configured_data_root(default: &Path) -> Result<PathBuf, String> {
    let path = default.join(LOCATION_FILE);
    atomic_file::cleanup_interrupted_json_write(&path)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(default.into()),
        Err(error) => return Err(format!("Cannot read storage location {}: {error}", path.display())),
    };
    let location: StorageLocation = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if !location.data_directory.is_absolute() || !location.data_directory.is_dir() {
        return Err(format!(
            "Storage directory is unavailable: {}",
            location.data_directory.display()
        ));
    }
    fs::read_dir(&location.data_directory).map_err(|error| format!("Cannot access storage directory: {error}"))?;
    Ok(location.data_directory)
}

fn overridden_by_environment() -> bool {
    std::env::var_os(APP_DATA_DIR_ENV).is_some_and(|value| !value.is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageLocationInfo {
    directory: PathBuf,
    overridden_by_environment: bool,
}

#[tauri::command]
pub(crate) fn get_storage_location(storage: StorageAccess<'_, AppStorage>) -> StorageLocationInfo {
    StorageLocationInfo {
        directory: portable_path(storage.root()),
        overridden_by_environment: overridden_by_environment(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationTarget {
    directory: PathBuf,
    create_directory: bool,
    issue: Option<&'static str>,
}

fn directory_is_available(directory: &Path, source: &Path, pointer: Option<&Path>) -> Result<bool, &'static str> {
    if directory == source {
        return Ok(false);
    }
    for entry in fs::read_dir(directory).map_err(|_| "unavailable")? {
        let entry = entry.map_err(|_| "unavailable")?;
        let path = entry.path();
        if path != source && Some(path.as_path()) != pointer {
            return Ok(false);
        }
    }
    Ok(true)
}

fn check_writable(target: &Path) -> Result<(), &'static str> {
    // Probe without replacing anything already in the selected directory.
    let probe = target.join(format!(".flow-reader-write-probe-{}", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| "unavailable")?;
    drop(file);
    fs::remove_file(&probe).map_err(|_| "unavailable")?;
    Ok(())
}

fn resolve_target(source: &Path, selected: &Path, pointer: &Path) -> Result<(PathBuf, bool), &'static str> {
    let source = fs::canonicalize(source).map_err(|_| "unavailable")?;
    let selected = fs::canonicalize(selected).map_err(|_| "unavailable")?;
    let pointer = fs::canonicalize(pointer).ok();
    if directory_is_available(&selected, &source, pointer.as_deref())? {
        check_writable(&selected)?;
        return Ok((selected, false));
    }
    for suffix in 1..=u64::MAX {
        let name = if suffix == 1 {
            TARGET_FOLDER.into()
        } else {
            format!("{TARGET_FOLDER} ({suffix})")
        };
        let target = selected.join(name);
        let metadata = match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                check_writable(&selected)?;
                return Ok((target, true));
            }
            Ok(metadata) => metadata,
            Err(_) => return Err("unavailable"),
        };
        if metadata.is_dir() && !metadata.is_symlink() && directory_is_available(&target, &source, pointer.as_deref())?
        {
            let target = fs::canonicalize(target).map_err(|_| "unavailable")?;
            check_writable(&target)?;
            return Ok((target, false));
        }
    }
    Err("unavailable")
}

struct PreparedTarget {
    directory: PathBuf,
    created: bool,
}

impl Drop for PreparedTarget {
    fn drop(&mut self) {
        if self.created {
            // Remove only an empty auto-created folder after an aborted migration.
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

fn prepare_target(target: &Path, create_directory: bool) -> Result<PreparedTarget, String> {
    if create_directory {
        fs::create_dir(target).map_err(|error| error.to_string())?;
    }
    Ok(PreparedTarget {
        directory: target.into(),
        created: create_directory,
    })
}

#[tauri::command]
pub(crate) async fn validate_storage_target(
    app: AppHandle,
    storage: StorageAccess<'_, AppStorage>,
    directory: PathBuf,
) -> Result<MigrationTarget, String> {
    let source = storage.root().to_path_buf();
    let pointer = default_data_root(&app)?.join(LOCATION_FILE);
    tauri::async_runtime::spawn_blocking(move || match resolve_target(&source, &directory, &pointer) {
        Ok((path, create_directory)) => MigrationTarget {
            directory: portable_path(&path),
            create_directory,
            issue: None,
        },
        Err(issue) => MigrationTarget {
            directory,
            create_directory: false,
            issue: Some(issue),
        },
    })
    .await
    .map_err(|error| error.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationProgress {
    completed: u64,
    total: u64,
}

#[tauri::command]
pub(crate) async fn migrate_storage(
    app: AppHandle,
    window: Window,
    storage: tauri::State<'_, AppStorage>,
    directory: PathBuf,
    create_directory: bool,
    close_state: AppCloseInput,
    on_progress: Channel<MigrationProgress>,
) -> Result<(), String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || {
        if overridden_by_environment() {
            return Err("Storage location is controlled by FLOW_READER_DATA_DIR".into());
        }
        let mut migration = StorageMigration::begin()?;
        persist_app_close_state(&window, &storage, close_state)?;
        storage.flush_all_derived_caches()?;
        app.state::<DictionarySessionManager>().release_all()?;
        let prepared_target = prepare_target(&directory, create_directory)?;
        let target = &prepared_target.directory;
        let default = default_data_root(&app)?;
        fs::create_dir_all(&default).map_err(|error| error.to_string())?;
        let pointer = default.join(LOCATION_FILE);
        storage
            .inner
            .archive_resources
            .lock()
            .map_err(|_| "archive resource lock poisoned")?
            .clear();
        relocate_directory(
            storage.root(),
            target,
            &pointer,
            |progress| {
                let _ = on_progress.send(progress);
            },
            || publish_location(&pointer, target),
        )?;
        migration.commit();
        app.restart();
    })
    .await
    .map_err(|error| error.to_string())?
}

struct Entry {
    relative: PathBuf,
    directory: bool,
    bytes: u64,
}

fn publish_location(pointer: &Path, target: &Path) -> Result<bool, String> {
    let default =
        fs::canonicalize(pointer.parent().ok_or("Invalid storage pointer")?).map_err(|error| error.to_string())?;
    if fs::canonicalize(target).map_err(|error| error.to_string())? == default {
        match fs::remove_file(pointer) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        #[cfg(not(windows))]
        if let Err(error) = fs::File::open(&default).and_then(|file| file.sync_all()) {
            // The pointer is already gone: keep the target instead of rolling back.
            eprintln!("Cannot sync default storage directory: {error}");
            return Ok(false);
        }
        return Ok(true);
    }
    let location = StorageLocation {
        data_directory: portable_path(target),
    };
    match atomic_file::write_json(pointer, &location, Durability::Synced) {
        Ok(()) => Ok(true),
        Err(error) => {
            // A Unix parent-directory sync may fail after atomic replacement.
            // Once the pointer names the target, rollback must not delete it.
            let replaced = fs::read(pointer)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<StorageLocation>(&bytes).ok())
                .is_some_and(|saved| saved.data_directory == location.data_directory);
            if replaced {
                eprintln!("{error}; retaining remaining source files");
                Ok(false)
            } else {
                Err(error)
            }
        }
    }
}

fn inventory(source: &Path, target: &Path, pointer: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        for entry in fs::read_dir(source.join(&relative)).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path == target || path == pointer {
                continue;
            }
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
                return Err(format!("Cannot migrate linked or special file: {}", path.display()));
            }
            let relative = relative.join(entry.file_name());
            if kind.is_dir() {
                pending.push(relative.clone());
            }
            entries.push(Entry {
                relative,
                directory: kind.is_dir(),
                bytes: if kind.is_file() { metadata.len() } else { 0 },
            });
        }
    }
    Ok(entries)
}

fn rebase_reference(value: &mut serde_json::Value, source: &Path, target: &Path) {
    let Some(path) = value.as_str() else {
        return;
    };
    let original = Path::new(path);
    let resolved = portable_path(&fs::canonicalize(original).unwrap_or_else(|_| original.to_path_buf()));
    if let Ok(relative) = resolved.strip_prefix(portable_path(source)) {
        *value = serde_json::json!(portable_path(target).join(relative));
    }
}

fn rebase_references(source: &Path, target: &Path) -> Result<(), String> {
    for (file, collection) in REFERENCE_FILES {
        let path = target.join(file);
        if !path.is_file() {
            continue;
        }
        let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        if let Some(records) = value.get_mut(collection).and_then(serde_json::Value::as_array_mut) {
            for record in records {
                if let Some(path) = record.get_mut("sourcePath") {
                    rebase_reference(path, source, target);
                }
            }
        }
        atomic_file::write_json(&path, &value, Durability::Synced)?;
    }
    Ok(())
}

fn relocate_directory(
    source: &Path,
    target: &Path,
    pointer: &Path,
    mut report: impl FnMut(MigrationProgress),
    publish: impl FnOnce() -> Result<bool, String>,
) -> Result<(), String> {
    let source = fs::canonicalize(source).map_err(|error| error.to_string())?;
    let target = fs::canonicalize(target).map_err(|error| error.to_string())?;
    // Canonicalize the parent because the pointer may not exist yet.
    let pointer = fs::canonicalize(pointer.parent().ok_or("Invalid storage pointer")?)
        .map_err(|error| error.to_string())?
        .join(pointer.file_name().ok_or("Invalid storage pointer")?);
    let entries = inventory(&source, &target, &pointer)?;
    let total = entries.iter().map(|entry| entry.bytes).sum::<u64>().saturating_add(1);
    let mut completed = 0;
    let mut last_report = Instant::now();
    let mut transferred = Vec::new();
    let mut moved_paths = HashSet::new();
    report(MigrationProgress { completed, total });
    let result = (|| {
        let mut buffer = vec![0; 1024 * 1024];
        for entry in &entries {
            if entry.relative.ancestors().any(|path| moved_paths.contains(path)) {
                completed += entry.bytes;
                continue;
            }
            let original = source.join(&entry.relative);
            let destination = target.join(&entry.relative);
            // Keep the target, fixed pointer and original reference files in place
            // until commit. Other same-volume subtrees move in a single operation.
            let can_move = !target.starts_with(&original)
                && !pointer.starts_with(&original)
                && !REFERENCE_FILES
                    .iter()
                    .any(|(file, _)| Path::new(file).starts_with(&entry.relative));
            if can_move {
                match fs::rename(&original, &destination) {
                    Ok(()) => {
                        moved_paths.insert(entry.relative.clone());
                        transferred.push((entry, true));
                        completed += entry.bytes;
                        continue;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            if entry.directory {
                fs::create_dir(&destination).map_err(|error| error.to_string())?;
                transferred.push((entry, false));
                continue;
            }
            let mut input = fs::File::open(&original).map_err(|error| error.to_string())?;
            let modified = input
                .metadata()
                .and_then(|metadata| metadata.modified())
                .map_err(|error| error.to_string())?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|error| error.to_string())?;
            transferred.push((entry, false));
            loop {
                let size = input.read(&mut buffer).map_err(|error| error.to_string())?;
                if size == 0 {
                    break;
                }
                output.write_all(&buffer[..size]).map_err(|error| error.to_string())?;
                completed += size as u64;
                if last_report.elapsed() >= Duration::from_millis(50) {
                    report(MigrationProgress { completed, total });
                    last_report = Instant::now();
                }
            }
            output
                .set_times(fs::FileTimes::new().set_modified(modified))
                .map_err(|error| error.to_string())?;
        }
        rebase_references(&source, &target)?;
        #[cfg(not(windows))]
        {
            for (entry, _) in transferred.iter().rev() {
                if entry.directory {
                    fs::File::open(target.join(&entry.relative))
                        .and_then(|file| file.sync_all())
                        .map_err(|error| error.to_string())?;
                }
            }
            for path in [Some(target.as_path()), target.parent()].into_iter().flatten() {
                fs::File::open(path)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| error.to_string())?;
            }
        }
        publish()
    })();
    if let Err(error) = result {
        for (entry, moved) in transferred.iter().rev() {
            let path = target.join(&entry.relative);
            let result = if *moved {
                fs::rename(&path, source.join(&entry.relative))
            } else if entry.directory {
                fs::remove_dir(&path)
            } else {
                fs::remove_file(&path)
            };
            if let Err(cleanup) = result {
                eprintln!("Cannot clean failed migration {}: {cleanup}", path.display());
            }
        }
        return Err(error);
    }
    // Remove copied source files after commit; moved subtrees are already gone.
    // Keep target ancestors and the fixed pointer when migrating into a descendant.
    if result == Ok(true) {
        for entry in entries.iter().rev() {
            if entry.relative.ancestors().any(|path| moved_paths.contains(path)) {
                continue;
            }
            let path = source.join(&entry.relative);
            let result = if entry.directory {
                fs::remove_dir(&path)
            } else {
                remove_old_file(&path)
            };
            if let Err(error) = result
                && !(entry.directory && target.starts_with(&path))
            {
                eprintln!("Cannot clean old storage {}: {error}", path.display());
            }
        }
        let _ = fs::remove_dir(&source);
    }
    report(MigrationProgress {
        completed: total,
        total,
    });
    Ok(())
}

fn remove_old_file(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
        use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_READONLY, SetFileAttributesW};
        let metadata = fs::metadata(path)?;
        if metadata.permissions().readonly() {
            let attributes = metadata.file_attributes() & !FILE_ATTRIBUTE_READONLY;
            let wide_path = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            // The UTF-16 buffer is terminated and stays alive for the call.
            if unsafe { SetFileAttributesW(wide_path.as_ptr(), attributes) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
    }
    fs::remove_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn target_selection_uses_empty_folders_or_flow_reader_without_overwriting_files() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let workspace = std::env::temp_dir().join(format!("flow-storage-target-{}-{unique}", std::process::id()));
        let source = workspace.join("source");
        let pointer = workspace.join(LOCATION_FILE);
        fs::create_dir_all(&source).unwrap();
        for (name, occupied_parent, child_state) in [
            ("empty", false, None),
            ("occupied", true, None),
            ("empty-child", true, Some(false)),
            ("occupied-child", true, Some(true)),
        ] {
            let selected = workspace.join(name);
            fs::create_dir_all(&selected).unwrap();
            if occupied_parent {
                fs::write(selected.join("existing.txt"), b"original parent data").unwrap();
            }
            let child = selected.join("Flow Reader");
            if let Some(occupied_child) = child_state {
                fs::create_dir(&child).unwrap();
                if occupied_child {
                    fs::write(child.join("existing.txt"), b"original child data").unwrap();
                }
            }
            let folder = if child_state == Some(true) {
                "Flow Reader (2)"
            } else if occupied_parent {
                "Flow Reader"
            } else {
                ""
            };
            let expected = selected.join(folder);
            let (resolved, create_directory) = resolve_target(&source, &selected, &pointer).unwrap();
            assert_eq!(resolved, fs::canonicalize(&selected).unwrap().join(folder));
            assert_eq!(expected.exists(), !occupied_parent || child_state == Some(false));
            let prepared = prepare_target(&resolved, create_directory).unwrap();
            assert_eq!(
                fs::canonicalize(&prepared.directory).unwrap(),
                fs::canonicalize(&expected).unwrap()
            );
            assert!(prepared.directory.is_dir());
            if child_state == Some(true) {
                assert_eq!(fs::read(child.join("existing.txt")).unwrap(), b"original child data");
            }
            if occupied_parent {
                assert_eq!(
                    fs::read(selected.join("existing.txt")).unwrap(),
                    b"original parent data"
                );
            }
        }
        let (target, create_directory) = resolve_target(&source, &source, &pointer).unwrap();
        assert_eq!(target, fs::canonicalize(&source).unwrap().join(TARGET_FOLDER));
        assert!(create_directory);
        assert!(!target.exists());
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn migration_back_to_default_removes_pointer_only_on_success() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let workspace = std::env::temp_dir().join(format!("flow-storage-return-{}-{unique}", std::process::id()));
        for fail_commit in [false, true] {
            let root = workspace.join(if fail_commit { "rollback" } else { "success" });
            let default = root.join("default");
            fs::create_dir_all(&default).unwrap();
            fs::write(default.join("book.epub"), b"book data").unwrap();
            let pointer = default.join(LOCATION_FILE);
            let (custom, create_directory) = resolve_target(&default, &default, &pointer).unwrap();
            let prepared = prepare_target(&custom, create_directory).unwrap();
            let custom = portable_path(&prepared.directory);
            relocate_directory(
                &default,
                &custom,
                &pointer,
                |_| {},
                || publish_location(&pointer, &custom),
            )
            .unwrap();
            assert!(pointer.exists());
            let (target, create_directory) = resolve_target(&custom, &default, &pointer).unwrap();
            assert_eq!(target, fs::canonicalize(&default).unwrap());
            assert!(!create_directory);
            let result = relocate_directory(
                &custom,
                &target,
                &pointer,
                |_| {},
                || {
                    assert!(pointer.exists());
                    if fail_commit {
                        Err("commit failed".into())
                    } else {
                        publish_location(&pointer, &target)
                    }
                },
            );
            if fail_commit {
                assert!(result.is_err());
                assert!(pointer.exists());
                assert_eq!(fs::read(custom.join("book.epub")).unwrap(), b"book data");
                assert_eq!(configured_data_root(&default).unwrap(), custom);
            } else {
                result.unwrap();
                assert!(!pointer.exists());
                assert_eq!(fs::read(default.join("book.epub")).unwrap(), b"book data");
                assert_eq!(configured_data_root(&default).unwrap(), default);
            }
        }
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn relocation_moves_data_and_restores_it_on_commit_failure() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let workspace = std::env::temp_dir().join(format!("flow-storage-migration-{}-{unique}", std::process::id()));
        for (name, nested, fail_commit) in [
            ("sibling", false, false),
            ("child", true, false),
            ("rollback", true, true),
            ("parent", false, false),
        ] {
            let source = workspace.join(name).join("source");
            let target = if nested {
                source.join("nested").join("target")
            } else if name == "parent" {
                workspace.join(name).join(TARGET_FOLDER)
            } else {
                workspace.join(name).join("target")
            };
            fs::create_dir_all(source.join("books/book")).unwrap();
            fs::create_dir_all(&target).unwrap();
            fs::write(source.join("books/book/book.epub"), b"complete book data").unwrap();
            let external = workspace.join("external.epub");
            let missing = portable_path(&fs::canonicalize(&source).unwrap()).join("missing.epub");
            let library = serde_json::json!({"books": [
                {"sourcePath": source.join("books/book/book.epub")},
                {"sourcePath": missing},
                {"sourcePath": external},
            ]});
            fs::write(source.join("library.json"), serde_json::to_vec(&library).unwrap()).unwrap();
            if name == "parent" {
                let (resolved, _) =
                    resolve_target(&source, source.parent().unwrap(), &source.join(LOCATION_FILE)).unwrap();
                assert_eq!(resolved, fs::canonicalize(&target).unwrap());
            }
            let pointer = source.join("storage-location.json");
            let mut committed = false;
            let result = relocate_directory(
                &source,
                &target,
                &pointer,
                |_| {},
                || {
                    assert_eq!(
                        fs::read(target.join("books/book/book.epub")).unwrap(),
                        b"complete book data"
                    );
                    assert!(!source.join("books/book/book.epub").exists());
                    if fail_commit {
                        return Err("commit failed".to_string());
                    }
                    fs::write(&pointer, b"directory pointer").unwrap();
                    committed = true;
                    Ok(true)
                },
            );
            if fail_commit {
                assert!(result.is_err());
                assert!(!committed);
                assert_eq!(
                    fs::read(source.join("books/book/book.epub")).unwrap(),
                    b"complete book data"
                );
                assert!(fs::read_dir(&target).unwrap().next().is_none());
                let restored: serde_json::Value =
                    serde_json::from_slice(&fs::read(source.join("library.json")).unwrap()).unwrap();
                assert_eq!(restored, library);
            } else {
                result.unwrap();
                assert!(committed);
                assert_eq!(
                    fs::read(target.join("books/book/book.epub")).unwrap(),
                    b"complete book data"
                );
                let copied: serde_json::Value =
                    serde_json::from_slice(&fs::read(target.join("library.json")).unwrap()).unwrap();
                assert_eq!(
                    fs::canonicalize(copied["books"][0]["sourcePath"].as_str().unwrap()).unwrap(),
                    fs::canonicalize(target.join("books/book/book.epub")).unwrap()
                );
                assert_eq!(
                    Path::new(copied["books"][1]["sourcePath"].as_str().unwrap()),
                    portable_path(&fs::canonicalize(&target).unwrap()).join("missing.epub")
                );
                assert_eq!(Path::new(copied["books"][2]["sourcePath"].as_str().unwrap()), external);
                assert!(!source.join("books").exists());
                assert!(pointer.exists());
                assert!(!target.join("storage-location.json").exists());
            }
        }
        fs::remove_dir_all(workspace).unwrap();
    }
}
