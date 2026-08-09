use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, mpsc},
    time::Instant,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, ipc::Channel};

use crate::{
    diagnostics,
    tasks::{TaskPriority, TaskService},
};

use super::model::ReadingStatus;
use super::*;

pub(super) fn clean_tag_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same_tag_name(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn spawn_directory_command(program: &str, path: &Path) -> Result<(), String> {
    Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open directory: {error}"))
}

fn open_directory_in_file_manager(path: &Path) -> Result<(), String> {
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
        spawn_directory_command("xdg-open", path)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = path;
        Err("opening directories is not supported on this platform".to_string())
    }
}

fn reveal_file_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
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
        let Some(parent) = path.parent() else {
            return Err("source file has no parent directory".to_string());
        };
        spawn_directory_command("xdg-open", parent)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = path;
        Err("revealing files is not supported on this platform".to_string())
    }
}

pub(super) fn revealable_book_source_path(book: &LibraryBook) -> Option<&Path> {
    if book.source_storage != SourceStorage::Referenced {
        return None;
    }

    book.source_path.as_deref().filter(|path| path.is_file())
}

fn tag_id(created_at: u64) -> String {
    format!("tag-{created_at}")
}

pub(super) fn next_tag_id(tags: &[LibraryTagRecord], created_at: u64) -> String {
    let base_id = tag_id(created_at);
    if !tags.iter().any(|tag| tag.id == base_id) {
        return base_id;
    }

    let mut suffix = 2;
    loop {
        let id = format!("{base_id}-{suffix}");
        if !tags.iter().any(|tag| tag.id == id) {
            return id;
        }
        suffix += 1;
    }
}

#[tauri::command]
pub fn list_books(storage: State<'_, AppStorage>) -> Result<Vec<BookRecord>, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(state
        .library
        .books
        .iter()
        .map(|book| storage.compose_book_summary(book))
        .collect())
}

#[tauri::command]
pub fn list_tags(storage: State<'_, AppStorage>) -> Result<Vec<LibraryTagRecord>, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;

    Ok(state.library.tags.clone())
}

#[tauri::command]
pub fn get_library_pins(storage: State<'_, AppStorage>) -> Result<LibraryPins, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(state.library.pins.clone())
}

#[tauri::command]
pub fn get_recent_book_ids(storage: State<'_, AppStorage>) -> Result<Vec<String>, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(state.library.recent_book_ids.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryPinKind {
    Author,
    Tag,
}

#[tauri::command]
pub fn update_library_pin(
    storage: State<'_, AppStorage>,
    kind: LibraryPinKind,
    id: String,
    pinned: bool,
) -> Result<LibraryPins, String> {
    let changed = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        let (items, value) = match kind {
            LibraryPinKind::Author => {
                let author = clean_tag_name(&id);
                if pinned
                    && !state
                        .library
                        .books
                        .iter()
                        .filter_map(library_book_author)
                        .any(|candidate| candidate == author)
                {
                    return Ok(state.library.pins.clone());
                }
                (&mut state.library.pins.authors, author)
            }
            LibraryPinKind::Tag => {
                let tag_id = id.trim().to_string();
                if pinned && !state.library.tags.iter().any(|tag| tag.id == tag_id) {
                    return Ok(state.library.pins.clone());
                }
                (&mut state.library.pins.tag_ids, tag_id)
            }
        };

        if value.is_empty() {
            return Ok(state.library.pins.clone());
        }

        let previous = items.clone();
        items.retain(|item| item != &value);
        if pinned {
            items.insert(0, value);
        }
        previous != *items
    };

    if changed {
        storage.mark_library_dirty();
        storage.flush_dirty()?;
    }
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(state.library.pins.clone())
}

#[tauri::command]
pub fn create_tag(storage: State<'_, AppStorage>, name: String) -> Result<Option<LibraryTagRecord>, String> {
    let name = clean_tag_name(&name);
    if name.is_empty() {
        return Ok(None);
    }

    let tag = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        if let Some(tag) = state
            .library
            .tags
            .iter()
            .find(|tag| same_tag_name(&tag.name, &name))
            .cloned()
        {
            return Ok(Some(tag));
        }

        let created_at = now_ms();
        let id = next_tag_id(&state.library.tags, created_at);

        let tag = LibraryTagRecord {
            id,
            name,
            created_at,
            updated_at: None,
        };
        state.library.tags.push(tag.clone());
        tag
    };

    storage.mark_library_dirty();
    storage.flush_dirty()?;
    Ok(Some(tag))
}

#[tauri::command]
pub fn update_tag(
    storage: State<'_, AppStorage>,
    id: String,
    name: String,
) -> Result<Option<LibraryTagRecord>, String> {
    let name = clean_tag_name(&name);
    if name.is_empty() {
        return Ok(None);
    }

    let tag = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        if state
            .library
            .tags
            .iter()
            .any(|tag| tag.id != id && same_tag_name(&tag.name, &name))
        {
            return Ok(None);
        }

        let Some(tag) = state.library.tags.iter_mut().find(|tag| tag.id == id) else {
            return Ok(None);
        };

        tag.name = name;
        tag.updated_at = Some(now_ms());
        tag.clone()
    };

    storage.mark_library_dirty();
    storage.flush_dirty()?;
    Ok(Some(tag))
}

fn remove_library_tags(library: &mut Library, ids: &HashSet<String>, updated_at: u64) {
    library.tags.retain(|tag| !ids.contains(&tag.id));
    for book in &mut library.books {
        let previous_len = book.tag_ids.len();
        book.tag_ids.retain(|tag_id| !ids.contains(tag_id));
        if book.tag_ids.len() != previous_len {
            book.updated_at = Some(updated_at);
        }
    }
    library.pins.tag_ids.retain(|tag_id| !ids.contains(tag_id));
}

pub(super) fn delete_tags_impl(storage: &AppStorage, ids: Vec<String>) -> Result<(), String> {
    let ids = ids.into_iter().filter(|id| !id.is_empty()).collect::<HashSet<_>>();
    if ids.is_empty() {
        return Ok(());
    }

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        remove_library_tags(&mut state.library, &ids, now_ms());
    }

    storage.mark_library_dirty();
    storage.flush_dirty()?;
    Ok(())
}

#[tauri::command]
pub fn delete_tags(storage: State<'_, AppStorage>, ids: Vec<String>) -> Result<(), String> {
    delete_tags_impl(&storage, ids)
}

pub(super) fn merge_tags_impl(
    storage: &AppStorage,
    ids: Vec<String>,
    target_id: Option<String>,
    target_name: Option<String>,
) -> Result<LibraryTagRecord, String> {
    let source_ids = ids.into_iter().filter(|id| !id.is_empty()).collect::<HashSet<_>>();
    if source_ids.len() < 2 {
        return Err("at least two tags are required".to_string());
    }

    let target = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        if source_ids
            .iter()
            .any(|id| !state.library.tags.iter().any(|tag| &tag.id == id))
        {
            return Err("selected tag does not exist".to_string());
        }

        let target = if let Some(target_id) = target_id {
            if !source_ids.contains(&target_id) {
                return Err("merge target must be selected".to_string());
            }
            state
                .library
                .tags
                .iter()
                .find(|tag| tag.id == target_id)
                .cloned()
                .ok_or_else(|| "merge target does not exist".to_string())?
        } else {
            let name = clean_tag_name(target_name.as_deref().unwrap_or_default());
            if name.is_empty() {
                return Err("merge target name is required".to_string());
            }
            if let Some(existing) = state
                .library
                .tags
                .iter()
                .find(|tag| same_tag_name(&tag.name, &name))
                .cloned()
            {
                if !source_ids.contains(&existing.id) {
                    return Err("merge target name already exists".to_string());
                }
                existing
            } else {
                let created_at = now_ms();
                let tag = LibraryTagRecord {
                    id: next_tag_id(&state.library.tags, created_at),
                    name,
                    created_at,
                    updated_at: None,
                };
                state.library.tags.push(tag.clone());
                tag
            }
        };

        let updated_at = now_ms();
        for book in &mut state.library.books {
            if !book.tag_ids.iter().any(|tag_id| source_ids.contains(tag_id)) {
                continue;
            }
            book.tag_ids.retain(|tag_id| !source_ids.contains(tag_id));
            book.tag_ids.push(target.id.clone());
            book.updated_at = Some(updated_at);
        }

        let pinned = state
            .library
            .pins
            .tag_ids
            .iter()
            .any(|tag_id| source_ids.contains(tag_id));
        state.library.pins.tag_ids.retain(|tag_id| !source_ids.contains(tag_id));
        if pinned {
            state.library.pins.tag_ids.insert(0, target.id.clone());
        }
        state
            .library
            .tags
            .retain(|tag| !source_ids.contains(&tag.id) || tag.id == target.id);
        target
    };

    storage.mark_library_dirty();
    storage.flush_dirty()?;
    Ok(target)
}

#[tauri::command]
pub fn merge_tags(
    storage: State<'_, AppStorage>,
    ids: Vec<String>,
    target_id: Option<String>,
    target_name: Option<String>,
) -> Result<LibraryTagRecord, String> {
    merge_tags_impl(&storage, ids, target_id, target_name)
}

#[tauri::command]
pub fn update_book_tags(
    storage: State<'_, AppStorage>,
    ids: Vec<String>,
    add_tag_ids: Vec<String>,
    remove_tag_ids: Vec<String>,
) -> Result<(), String> {
    let id_set = ids.into_iter().collect::<std::collections::HashSet<_>>();
    let add_tag_ids = add_tag_ids
        .into_iter()
        .filter(|tag_id| !tag_id.is_empty())
        .collect::<Vec<_>>();
    let remove_tag_ids = remove_tag_ids
        .into_iter()
        .filter(|tag_id| !tag_id.is_empty())
        .collect::<std::collections::HashSet<_>>();

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        let existing_tags = state
            .library
            .tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let updated_at = now_ms();
        for book in &mut state.library.books {
            if !id_set.contains(&book.id) {
                continue;
            }

            let previous_tag_ids = book.tag_ids.clone();
            book.tag_ids.retain(|tag_id| !remove_tag_ids.contains(tag_id));
            for tag_id in &add_tag_ids {
                if existing_tags.contains(tag_id) && !book.tag_ids.contains(tag_id) {
                    book.tag_ids.push(tag_id.clone());
                }
            }
            if book.tag_ids != previous_tag_ids {
                book.updated_at = Some(updated_at);
            }
        }
    }

    storage.mark_library_dirty();
    storage.flush_dirty()
}

#[tauri::command]
pub fn update_book_reading_status(
    storage: State<'_, AppStorage>,
    ids: Vec<String>,
    reading_status: Option<ReadingStatus>,
) -> Result<(), String> {
    let id_set = ids.into_iter().collect::<std::collections::HashSet<_>>();

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        let updated_at = now_ms();
        for book in &mut state.library.books {
            if id_set.contains(&book.id) && book.reading_status != reading_status {
                book.reading_status = reading_status.clone();
                book.updated_at = Some(updated_at);
            }
        }
    }

    storage.mark_library_dirty();
    storage.flush_dirty()
}

#[tauri::command]
pub fn get_book(storage: State<'_, AppStorage>, id: String) -> Result<Option<BookRecord>, String> {
    get_book_impl(&storage, id)
}

pub(super) fn get_book_impl(storage: &AppStorage, id: String) -> Result<Option<BookRecord>, String> {
    let book = match storage.library_book(&id) {
        Ok(book) => book,
        Err(error) if error == "Book not found" => return Ok(None),
        Err(error) => return Err(error),
    };

    storage.compose_book(&book).map(Some)
}

#[tauri::command]
pub fn open_book_directory(storage: State<'_, AppStorage>, id: String) -> Result<(), String> {
    let path = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        if !state.library.books.iter().any(|book| book.id == id) {
            return Err("book not found".to_string());
        }

        storage.book_dir(&id)
    };

    if !path.is_dir() {
        return Err(format!("book directory does not exist: {}", path.display()));
    }

    open_directory_in_file_manager(&path)
}

#[tauri::command]
pub fn reveal_book_source(storage: State<'_, AppStorage>, id: String) -> Result<bool, String> {
    let path = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.library.books.iter().find(|book| book.id == id) else {
            return Ok(false);
        };

        revealable_book_source_path(book).map(Path::to_path_buf)
    };

    let Some(path) = path else {
        return Ok(false);
    };
    reveal_file_in_file_manager(&path)?;
    Ok(true)
}

#[tauri::command]
pub fn reveal_exported_file(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("exported file path must be absolute".to_string());
    }
    if !path.is_file() {
        return Err(format!("exported file does not exist: {}", path.display()));
    }
    reveal_file_in_file_manager(&path)
}

#[tauri::command]
pub fn list_covers(storage: State<'_, AppStorage>, ids: Option<Vec<String>>) -> Result<Vec<CoverRecord>, String> {
    let ids = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        match ids {
            Some(ids) => {
                let requested = ids.into_iter().collect::<HashSet<_>>();
                state
                    .library
                    .books
                    .iter()
                    .filter(|book| requested.contains(&book.id))
                    .map(|book| book.id.clone())
                    .collect::<Vec<_>>()
            }
            None => state
                .library
                .books
                .iter()
                .map(|book| book.id.clone())
                .collect::<Vec<_>>(),
        }
    };

    ids.into_iter()
        .map(|id| {
            Ok(CoverRecord {
                cover: read_cover(&storage, &id)?,
                id,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn import_epub_paths(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    paths: Vec<String>,
    replace_existing: bool,
    on_progress: Channel<BookImportProgress>,
) -> Result<BookImportResult, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_epub_paths_impl(&storage, &tasks, paths, replace_existing, Some(on_progress))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) fn import_epub_paths_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    paths: Vec<String>,
    replace_existing: bool,
    on_progress: Option<Channel<BookImportProgress>>,
) -> Result<BookImportResult, String> {
    let started = Instant::now();
    let source_count = paths.len();
    let total = paths.iter().filter(|path| is_epub_file(Path::new(path))).count();
    let mut books = Vec::new();
    let mut failures = Vec::new();
    let mut finalizers = Vec::new();
    let mut import_index = LibraryBookLookupIndex::load(storage)?;
    let mut progress = BookImportProgressReporter::new(on_progress, total);

    let paths = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| is_epub_file(path))
        .collect::<Vec<_>>();
    let prepare_window = tasks.io_writer_limit().clamp(1, 4);

    for chunk in paths.chunks(prepare_window) {
        let prepared = std::thread::scope(|scope| {
            let handles = chunk
                .iter()
                .map(|path| {
                    scope.spawn(move || {
                        let bytes = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
                        tasks.run_io_observed(storage.root(), bytes, TaskPriority::Foreground, || {
                            prepare_epub_import(storage, path)
                        })
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|_| Err("EPUB import prepare worker panicked".to_string()))
                })
                .collect::<Vec<_>>()
        });

        for (path, prepared) in chunk.iter().zip(prepared) {
            let result = prepared.and_then(|prepared| {
                commit_prepared_epub_import(storage, prepared, replace_existing, Some(&mut import_index))
            });
            match result {
                Ok((book, finalizer)) => {
                    if let Some(book) = progress.emit_success(storage, book) {
                        books.push(book);
                    }
                    finalizers.push(finalizer);
                }
                Err(error) => {
                    let failure = book_import_failure(path, error);
                    progress.emit_failure();
                    failures.push(failure);
                }
            }
        }
    }

    finalize_import_batch(storage, tasks, finalizers)?;

    let mut fields = vec![
        ("sources", source_count.to_string()),
        ("imported", progress.imported.to_string()),
        ("failed", failures.len().to_string()),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("epub-import", started.elapsed(), &fields);
    Ok(BookImportResult { books, failures })
}

fn book_import_failure(path: &Path, error: String) -> BookImportFailure {
    BookImportFailure {
        filename: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        path: path.to_string_lossy().to_string(),
        error,
    }
}

#[tauri::command]
pub async fn open_external_epub_paths(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    paths: Vec<String>,
) -> Result<BookImportResult, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || open_external_epub_paths_impl(&storage, &tasks, paths))
        .await
        .map_err(|error| error.to_string())?
}

pub(super) fn open_external_epub_paths_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    paths: Vec<String>,
) -> Result<BookImportResult, String> {
    let started = Instant::now();
    let source_count = paths.len();
    let mut books = Vec::new();
    let mut failures = Vec::new();

    for path in paths {
        let path = PathBuf::from(path);
        if !is_epub_file(&path) {
            continue;
        }

        let bytes = std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
        match tasks.run_io_observed(storage.root(), bytes, TaskPriority::Foreground, || {
            open_external_epub_path_impl(storage, &path)
        }) {
            Ok(book) => books.push(book),
            Err(error) => failures.push(book_import_failure(&path, error)),
        }
    }

    let mut fields = vec![
        ("sources", source_count.to_string()),
        ("opened", books.len().to_string()),
        ("failed", failures.len().to_string()),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("epub-open-external", started.elapsed(), &fields);
    Ok(BookImportResult { books, failures })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportFailure {
    pub path: String,
    pub filename: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportResult {
    pub books: Vec<BookRecord>,
    pub failures: Vec<BookImportFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportProgress {
    total: usize,
    completed: usize,
    imported: usize,
    failed: usize,
    book: Option<Arc<BookRecord>>,
    cover: Option<CoverRecord>,
}

struct BookImportProgressReporter {
    channel: Option<Channel<BookImportProgress>>,
    total: usize,
    completed: usize,
    imported: usize,
    failed: usize,
}

impl BookImportProgressReporter {
    fn new(channel: Option<Channel<BookImportProgress>>, total: usize) -> Self {
        Self {
            channel,
            total,
            completed: 0,
            imported: 0,
            failed: 0,
        }
    }

    fn emit(&mut self, book: Option<BookRecord>, cover: Option<CoverRecord>) -> Option<BookRecord> {
        self.completed += 1;
        if book.is_some() {
            self.imported += 1;
        } else {
            self.failed += 1;
        }

        let Some(channel) = &self.channel else {
            return book;
        };

        let book = book.map(Arc::new);
        let fallback = book.as_ref().map(Arc::clone);
        if channel
            .send(BookImportProgress {
                total: self.total,
                completed: self.completed,
                imported: self.imported,
                failed: self.failed,
                book,
                cover,
            })
            .is_err()
        {
            return fallback.and_then(|book| Arc::try_unwrap(book).ok());
        }
        None
    }

    fn emit_success(&mut self, storage: &AppStorage, book: BookRecord) -> Option<BookRecord> {
        let cover = read_cover(storage, &book.id).ok().map(|cover| CoverRecord {
            id: book.id.clone(),
            cover,
        });
        self.emit(Some(book), cover)
    }

    fn emit_failure(&mut self) {
        let _ = self.emit(None, None);
    }
}

#[tauri::command]
pub fn get_text_import_encodings() -> Vec<TextImportEncodingOption> {
    text_import_encoding_options()
}

#[tauri::command]
pub async fn preview_text_import_paths(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    paths: Vec<String>,
    encodings: HashMap<String, String>,
) -> Result<Vec<TextImportPreview>, String> {
    let rules = storage.text_import_rules()?;
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        preview_text_import_paths_impl(&storage, &tasks, paths, encodings, rules)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) fn preview_text_import_paths_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    paths: Vec<String>,
    encodings: HashMap<String, String>,
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<TextImportPreview>, String> {
    let started = Instant::now();
    let paths = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| is_txt_file(path))
        .collect::<Vec<_>>();
    let source_count = paths.len();
    let rules = rules.as_ref();
    let result = if paths.len() <= 1 {
        Ok(paths
            .iter()
            .map(|path| preview_text_import_path(storage, tasks, path, &encodings, rules))
            .collect::<Vec<_>>())
    } else {
        let queue = Arc::new(Mutex::new(paths.into_iter().enumerate().collect::<VecDeque<_>>()));
        let results = Arc::new(Mutex::new(
            std::iter::repeat_with(|| None)
                .take(
                    queue
                        .lock()
                        .map_err(|_| "text import queue lock poisoned".to_string())?
                        .len(),
                )
                .collect::<Vec<Option<TextImportPreview>>>(),
        ));
        let workers = text_import_prepare_worker_count(results.lock().unwrap().len());

        std::thread::scope(|scope| {
            for _ in 0..workers {
                let queue = Arc::clone(&queue);
                let results = Arc::clone(&results);
                let encodings = &encodings;
                scope.spawn(move || {
                    loop {
                        let item = queue.lock().ok().and_then(|mut queue| queue.pop_front());
                        let Some((index, path)) = item else {
                            break;
                        };
                        let preview = preview_text_import_path(storage, tasks, &path, encodings, rules);
                        if let Ok(mut results) = results.lock() {
                            results[index] = Some(preview);
                        }
                    }
                });
            }
        });

        results
            .lock()
            .map_err(|_| "text import results lock poisoned".to_string())?
            .iter_mut()
            .map(|result| {
                result
                    .take()
                    .ok_or_else(|| "text import preview worker did not produce a result".to_string())
            })
            .collect()
    };
    if let Ok(previews) = &result {
        let mut fields = vec![
            ("sources", source_count.to_string()),
            ("previews", previews.len().to_string()),
        ];
        fields.extend(tasks.diagnostic_fields());
        diagnostics::record_timing("txt-preview", started.elapsed(), &fields);
    }
    result
}

fn preview_text_import_path(
    storage: &AppStorage,
    tasks: &TaskService,
    path: &Path,
    encodings: &HashMap<String, String>,
    rules: Option<&TextImportRulesInput>,
) -> TextImportPreview {
    let key = path_to_client_string(path);
    let encoding = encodings.get(&key).map(String::as_str);
    let prepared = match prepare_text_import(storage, tasks, path, encoding, rules) {
        Ok(prepared) => prepared,
        Err(error) => return create_text_import_error_preview(path, error),
    };
    if should_skip_prepared_text_import_preview(storage, &prepared).unwrap_or(false) {
        create_skipped_text_import_preview(path)
    } else {
        create_text_import_preview_from_prepared(&prepared)
    }
}

fn text_import_prepare_worker_count(file_count: usize) -> usize {
    file_count.clamp(1, 2)
}

#[tauri::command]
pub async fn import_text_paths(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    imports: Vec<TextImportSelection>,
    replace_existing: bool,
    on_progress: Channel<BookImportProgress>,
) -> Result<BookImportResult, String> {
    let rules = storage.text_import_rules()?;
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_text_paths_impl(&storage, &tasks, imports, replace_existing, rules, Some(on_progress))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) fn import_text_paths_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    imports: Vec<TextImportSelection>,
    replace_existing: bool,
    rules: Option<TextImportRulesInput>,
    on_progress: Option<Channel<BookImportProgress>>,
) -> Result<BookImportResult, String> {
    let started = Instant::now();
    let source_count = imports.len();
    let rules = rules.as_ref();
    let imports = imports
        .into_iter()
        .filter(|import| is_txt_file(Path::new(&import.path)))
        .collect::<Vec<_>>();
    let mut progress = BookImportProgressReporter::new(on_progress, imports.len());
    let mut import_index = LibraryBookLookupIndex::load(storage)?;
    let batch = if imports.len() <= 1 {
        import_text_paths_direct(
            storage,
            tasks,
            imports,
            replace_existing,
            rules,
            &mut import_index,
            &mut progress,
        )
    } else {
        import_text_paths_with_pipeline(
            storage,
            tasks,
            imports,
            replace_existing,
            rules,
            &mut import_index,
            &mut progress,
        )?
    };
    finalize_import_batch(storage, tasks, batch.finalizers)?;

    let mut fields = vec![
        ("sources", source_count.to_string()),
        ("imported", progress.imported.to_string()),
        ("failed", batch.failures.len().to_string()),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("txt-import", started.elapsed(), &fields);
    Ok(BookImportResult {
        books: batch.books,
        failures: batch.failures,
    })
}

struct TextImportBatch {
    books: Vec<BookRecord>,
    failures: Vec<BookImportFailure>,
    finalizers: Vec<ImportFinalizer>,
}

fn commit_prepared_text_selection(
    storage: &AppStorage,
    tasks: &TaskService,
    import: &TextImportSelection,
    prepared: Arc<PreparedTextImport>,
    replace_existing: bool,
    rules: Option<&TextImportRulesInput>,
    import_index: &mut LibraryBookLookupIndex,
) -> Result<(BookRecord, ImportFinalizer), BookImportFailure> {
    let bytes = prepared.size;
    tasks
        .run_io_observed(storage.root(), bytes, TaskPriority::Foreground, || {
            import_text_path_impl(
                storage,
                prepared,
                import.title.as_deref(),
                import.creator.as_deref(),
                replace_existing,
                rules,
                Some(import_index),
            )
        })
        .map_err(|error| book_import_failure(Path::new(&import.path), error))
}

fn import_text_paths_direct(
    storage: &AppStorage,
    tasks: &TaskService,
    imports: Vec<TextImportSelection>,
    replace_existing: bool,
    rules: Option<&TextImportRulesInput>,
    import_index: &mut LibraryBookLookupIndex,
    progress: &mut BookImportProgressReporter,
) -> TextImportBatch {
    let mut books = Vec::new();
    let mut failures = Vec::new();
    let mut finalizers = Vec::new();
    for import in imports {
        let path = PathBuf::from(&import.path);
        let prepared = match prepare_text_import(storage, tasks, &path, import.encoding.as_deref(), rules) {
            Ok(prepared) => prepared,
            Err(error) => {
                let failure = book_import_failure(&path, error);
                progress.emit_failure();
                failures.push(failure);
                continue;
            }
        };
        let (book, finalizer) = match commit_prepared_text_selection(
            storage,
            tasks,
            &import,
            prepared,
            replace_existing,
            rules,
            import_index,
        ) {
            Ok(result) => result,
            Err(failure) => {
                progress.emit_failure();
                failures.push(failure);
                continue;
            }
        };
        if let Some(book) = progress.emit_success(storage, book) {
            books.push(book);
        }
        finalizers.push(finalizer);
    }
    TextImportBatch {
        books,
        failures,
        finalizers,
    }
}

struct TextImportPrepareMessage {
    index: usize,
    import: TextImportSelection,
    prepared: Result<Arc<PreparedTextImport>, String>,
}

fn import_text_paths_with_pipeline(
    storage: &AppStorage,
    tasks: &TaskService,
    imports: Vec<TextImportSelection>,
    replace_existing: bool,
    rules: Option<&TextImportRulesInput>,
    import_index: &mut LibraryBookLookupIndex,
    progress: &mut BookImportProgressReporter,
) -> Result<TextImportBatch, String> {
    let queue = Arc::new(Mutex::new(imports.into_iter().enumerate().collect::<VecDeque<_>>()));
    let result_len = queue
        .lock()
        .map_err(|_| "text import queue lock poisoned".to_string())?
        .len();
    let workers = text_import_prepare_worker_count(result_len);
    let (sender, receiver) = mpsc::sync_channel::<TextImportPrepareMessage>(0);
    let mut books = std::iter::repeat_with(|| None)
        .take(result_len)
        .collect::<Vec<Option<BookRecord>>>();
    let mut failures = Vec::new();
    let mut finalizers = Vec::with_capacity(result_len);

    let pipeline_result: Result<(), String> = std::thread::scope(|scope| {
        for _ in 0..workers {
            let queue = Arc::clone(&queue);
            let sender = sender.clone();
            scope.spawn(move || {
                loop {
                    let item = queue.lock().ok().and_then(|mut queue| queue.pop_front());
                    let Some((index, import)) = item else {
                        break;
                    };
                    let path = PathBuf::from(&import.path);
                    let prepared = prepare_text_import(storage, tasks, &path, import.encoding.as_deref(), rules);
                    storage.begin_text_import_prepared_handoff();
                    if sender
                        .send(TextImportPrepareMessage {
                            index,
                            import,
                            prepared,
                        })
                        .is_err()
                    {
                        storage.end_text_import_prepared_handoff();
                        break;
                    }
                }
            });
        }
        drop(sender);

        for _ in 0..result_len {
            let message = receiver
                .recv()
                .map_err(|_| "text import prepare worker stopped before completing".to_string())?;
            match message.prepared {
                Ok(prepared) => {
                    let result = commit_prepared_text_selection(
                        storage,
                        tasks,
                        &message.import,
                        prepared,
                        replace_existing,
                        rules,
                        import_index,
                    );
                    storage.end_text_import_prepared_handoff();
                    match result {
                        Ok((book, finalizer)) => {
                            books[message.index] = progress.emit_success(storage, book);
                            finalizers.push(finalizer);
                        }
                        Err(failure) => {
                            progress.emit_failure();
                            failures.push(failure);
                        }
                    }
                }
                Err(error) => {
                    storage.end_text_import_prepared_handoff();
                    let failure = book_import_failure(Path::new(&message.import.path), error);
                    progress.emit_failure();
                    failures.push(failure);
                }
            }
        }

        Ok(())
    });
    if let Err(error) = pipeline_result {
        finalize_import_batch(storage, tasks, finalizers)?;
        return Err(error);
    }

    let books = books.into_iter().flatten().collect::<Vec<_>>();
    Ok(TextImportBatch {
        books,
        failures,
        finalizers,
    })
}

fn finalize_import_batch(
    storage: &AppStorage,
    tasks: &TaskService,
    finalizers: Vec<ImportFinalizer>,
) -> Result<(), String> {
    if finalizers.is_empty() {
        return Ok(());
    }

    storage.flush_dirty()?;
    let mut pending_deletes = Vec::new();
    for finalizer in finalizers {
        if let Err(error) = finalizer.finalize(&mut pending_deletes) {
            eprintln!("Failed to finalize committed import files: {error}");
        }
    }
    deletion::enqueue_pending_delete_cleanup(tasks, pending_deletes);
    Ok(())
}

#[tauri::command]
pub async fn get_book_reader_source(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    id: String,
) -> Result<BookReaderSource, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let book = storage.library_book(&id)?;
        get_book_reader_source_impl(&storage, &tasks, &book)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn check_book_source_statuses(
    storage: State<'_, AppStorage>,
    ids: Vec<String>,
) -> Result<Vec<BookSourceStatusRecord>, String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || check_book_source_statuses_impl(&storage, ids))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn search_book_text(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    id: String,
    keyword: String,
    limit: Option<usize>,
) -> Result<Vec<SearchTextResult>, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let book = storage.library_book(&id)?;
        let cache = load_or_build_search_text_cache(&storage, &tasks, &book)?;
        Ok(search_text_in_cache(&cache, &keyword, limit))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_book_image_index(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    id: String,
) -> Result<ImageIndexCache, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let book = storage.library_book(&id)?;
        if book.source_format == BookSourceFormat::Txt {
            return Ok(ImageIndexCache {
                version: IMAGE_INDEX_CACHE_VERSION,
                content_version: book.content_version,
                sections: Vec::new(),
            });
        }
        Ok((*load_or_build_image_index_cache(&storage, &tasks, &book)?).clone())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_book_cache_active(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        tasks.run_book_exclusive(&id, TaskPriority::Critical, || {
            storage.set_derived_cache_active(&id, active)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clear_book_caches(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    discard_unexported_edits: bool,
    preserved_unpacked_book_ids: Vec<String>,
    on_progress: Channel<BookCacheClearProgress>,
) -> Result<Vec<BookRecord>, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let preserved_unpacked_book_ids = preserved_unpacked_book_ids.into_iter().collect::<HashSet<_>>();
        clear_book_caches_impl(
            &storage,
            &tasks,
            discard_unexported_edits,
            preserved_unpacked_book_ids,
            |completed, total| {
                let _ = on_progress.send(BookCacheClearProgress { completed, total });
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCacheClearProgress {
    completed: usize,
    total: usize,
}

#[tauri::command]
pub async fn replace_book_text(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    id: String,
    target: BookTextReplaceTarget,
    old_text: String,
    new_text: String,
) -> Result<BookTextReplaceResult, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock_id = id.clone();
        tasks.run_book_exclusive(&lock_id, TaskPriority::Foreground, || {
            replace_book_text_impl(&storage, id, target, old_text, new_text)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn export_book(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    id: String,
    format: BookExportFormat,
    output_path: String,
) -> Result<Option<BookRecord>, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock_id = id.clone();
        tasks.run_book_exclusive(&lock_id, TaskPriority::Foreground, || {
            export_book_impl(&storage, id, format, PathBuf::from(output_path))
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cleanup_external_book(storage: State<'_, AppStorage>, id: String) -> Result<(), String> {
    cleanup_external_book_heavy_files(&storage, &id)
}

#[tauri::command]
pub fn cleanup_all_external_books(storage: State<'_, AppStorage>) -> Result<(), String> {
    cleanup_all_external_book_heavy_files(&storage)
}

#[tauri::command]
pub fn delete_external_book(storage: State<'_, AppStorage>, id: String) -> Result<(), String> {
    storage.ensure_external_book(&id)?;

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.external.books.retain(|book| book.id != id);
    }
    storage.mark_external_dirty();
    storage.remove_derived_memory_caches(&id);

    let dir = storage.external_book_dir(&id);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
    }
    storage.flush_dirty()
}

fn configuration_without_spread(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(object)) => {
            let mut object = object.clone();
            object.remove("spread");
            Value::Object(object)
        }
        Some(value) => value.clone(),
        None => Value::Object(Default::default()),
    }
}

fn is_spread_only_configuration_update(current: Option<&Value>, incoming: &Value) -> bool {
    configuration_without_spread(current) == configuration_without_spread(Some(incoming))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPositionInput {
    pub book_id: String,
    pub cfi: Option<String>,
    pub percentage: Option<f64>,
    #[serde(default)]
    pub spread: Option<Value>,
    pub last_read_at: u64,
}

pub(super) fn record_reading_position_impl(
    storage: &AppStorage,
    position: ReadingPositionInput,
) -> Result<bool, String> {
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        if let Some(book) = state.library.books.iter_mut().find(|book| book.id == position.book_id) {
            book.cfi = position.cfi.clone();
            book.percentage = position.percentage;
            book.last_read_at = Some(position.last_read_at);
        } else if let Some(book) = state.external.books.iter_mut().find(|book| book.id == position.book_id) {
            book.last_opened_at = position.last_read_at;
        } else {
            return Ok(false);
        }

        let mut book_state = storage.read_book_state(&position.book_id)?;
        book_state.cfi = position.cfi.clone();
        book_state.percentage = position.percentage;
        book_state.configuration = Some(configuration_with_recorded_spread(
            book_state.configuration.as_ref(),
            position.spread,
        ));
        storage.write_book_state(&position.book_id, &book_state)?;
    }

    if is_external_book_id(&position.book_id) {
        storage.mark_external_dirty();
    } else {
        storage.mark_library_dirty();
    }
    Ok(true)
}

fn configuration_with_recorded_spread(current: Option<&Value>, spread: Option<Value>) -> Value {
    let mut object = current.and_then(Value::as_object).cloned().unwrap_or_default();

    match spread {
        Some(spread) if !spread.is_null() => {
            object.insert("spread".to_string(), spread);
        }
        _ => {
            object.remove("spread");
        }
    }

    Value::Object(object)
}

#[tauri::command]
pub fn record_reading_position(storage: State<'_, AppStorage>, position: ReadingPositionInput) -> Result<(), String> {
    record_reading_position_impl(&storage, position)?;
    storage.flush_dirty()
}

#[tauri::command]
pub fn update_book(storage: State<'_, AppStorage>, id: String, changes: Value) -> Result<(), String> {
    if is_external_book_id(&id) {
        return update_external_book(&storage, id, changes);
    }

    let mut library_changed = false;
    let mut state_changed = false;
    let mut immediate_flush = false;
    let mut reading_position_only = false;
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book_index) = state.library.books.iter().position(|book| book.id == id) else {
            return Ok(());
        };
        let mut book = state.library.books[book_index].clone();
        let mut book_state = storage.read_book_state(&id)?;
        let previous_author = library_book_author(&book);

        if let Some(object) = changes.as_object() {
            let updates_reading_position = object.contains_key("cfi") || object.contains_key("percentage");
            let allowed_reading_position_keys = object.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "cfi" | "percentage" | "updatedAt" | "lastReadAt" | "configuration"
                )
            });
            let mut configuration_spread_only_update = !object.contains_key("configuration");

            if let Some(value) = object.get("name").and_then(Value::as_str) {
                book.name = value.to_string();
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("size").and_then(Value::as_u64) {
                book.size = value;
                library_changed = true;
                immediate_flush = true;
            }
            if object.contains_key("readingStatus") {
                book.reading_status = object
                    .get("readingStatus")
                    .and_then(|value| serde_json::from_value(value.clone()).ok());
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("metadata") {
                book.metadata = value.clone();
                if book.content_mode != BookContentMode::ArchiveOnly {
                    sync_unpacked_opf_metadata(&storage.book_dir(&id).join(UNPACKED_DIR), value)?;
                }
                if is_generated_text_cover(&storage, &id)? {
                    let cover = create_text_cover_input(
                        value,
                        Path::new(&book.name).file_stem().and_then(|name| name.to_str()),
                    );
                    if book.source_format == BookSourceFormat::Txt
                        && let Some(cover) = cover.as_ref()
                    {
                        write_text_cover_to_unpacked(&storage, &id, cover)?;
                    }
                    write_cover(&storage, &id, cover)?;
                }
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("createdAt").and_then(Value::as_u64) {
                book.created_at = value;
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("updatedAt").and_then(Value::as_u64) {
                book.updated_at = Some(value);
                library_changed = true;
            }
            if let Some(value) = object.get("lastReadAt").and_then(Value::as_u64) {
                book.last_read_at = Some(value);
                library_changed = true;
            }
            if let Some(value) = object.get("tagIds") {
                let mut seen = std::collections::HashSet::new();
                let tag_ids = value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|tag_id| !tag_id.is_empty())
                    .filter(|tag_id| seen.insert((*tag_id).to_string()))
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                book.tag_ids = tag_ids;
                library_changed = true;
                immediate_flush = true;
            }

            if let Some(value) = object.get("cfi") {
                let cfi = value.as_str().map(str::to_string);
                book_state.cfi = cfi.clone();
                book.cfi = cfi;
                library_changed = true;
                state_changed = true;
            }
            if let Some(value) = object.get("percentage") {
                let percentage = value.as_f64();
                book_state.percentage = percentage;
                book.percentage = percentage;
                library_changed = true;
                state_changed = true;
            }
            if let Some(value) = object.get("definitions") {
                book_state.definitions = serde_json::from_value(value.clone()).unwrap_or_default();
                state_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("annotations") {
                book_state.annotations = serde_json::from_value(value.clone()).unwrap_or_default();
                state_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("configuration") {
                let spread_only = is_spread_only_configuration_update(book_state.configuration.as_ref(), value);
                configuration_spread_only_update = spread_only;
                book_state.configuration = Some(value.clone());
                state_changed = true;
                if !spread_only {
                    immediate_flush = true;
                }
            }

            let explicit_state_update = object.contains_key("definitions")
                || object.contains_key("annotations")
                || (object.contains_key("configuration") && !configuration_spread_only_update);
            reading_position_only = updates_reading_position && !explicit_state_update && allowed_reading_position_keys;
        }

        if state_changed {
            storage.write_book_state(&id, &book_state)?;
        }
        state.library.books[book_index] = book;
        if let Some(previous_author) = previous_author
            && library_book_author(&state.library.books[book_index]).as_ref() != Some(&previous_author)
            && !state
                .library
                .books
                .iter()
                .filter_map(library_book_author)
                .any(|candidate| candidate == previous_author)
        {
            state.library.pins.authors.retain(|author| author != &previous_author);
        }
    }

    if library_changed {
        storage.mark_library_dirty();
    }
    if immediate_flush || reading_position_only {
        storage.flush_dirty()?;
    }

    Ok(())
}

fn update_external_book(storage: &AppStorage, id: String, changes: Value) -> Result<(), String> {
    let mut external_changed = false;
    let mut state_changed = false;
    let mut immediate_flush = false;
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.external.books.iter_mut().find(|book| book.id == id) else {
            return Ok(());
        };
        let mut book_state = storage.read_book_state(&id)?;

        if let Some(object) = changes.as_object() {
            if let Some(value) = object.get("name").and_then(Value::as_str) {
                book.name = value.to_string();
                external_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("size").and_then(Value::as_u64) {
                book.size = value;
                external_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("metadata") {
                book.metadata = value.clone();
                external_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("updatedAt").and_then(Value::as_u64) {
                book.last_opened_at = value;
                external_changed = true;
            }
            if let Some(value) = object.get("lastReadAt").and_then(Value::as_u64) {
                book.last_opened_at = value;
                external_changed = true;
            }

            if let Some(value) = object.get("cfi") {
                book_state.cfi = value.as_str().map(str::to_string);
                state_changed = true;
            }
            if let Some(value) = object.get("percentage") {
                book_state.percentage = value.as_f64();
                state_changed = true;
            }
            if let Some(value) = object.get("definitions") {
                book_state.definitions = serde_json::from_value(value.clone()).unwrap_or_default();
                state_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("annotations") {
                book_state.annotations = serde_json::from_value(value.clone()).unwrap_or_default();
                state_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("configuration") {
                book_state.configuration = Some(value.clone());
                state_changed = true;
                immediate_flush = true;
            }
        }
        if state_changed {
            storage.write_book_state(&id, &book_state)?;
        }
    }

    if external_changed {
        storage.mark_external_dirty();
    }
    if immediate_flush || state_changed || external_changed {
        storage.flush_dirty()?;
    }

    Ok(())
}

#[tauri::command]
pub fn delete_books(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    ids: Vec<String>,
) -> Result<(), String> {
    delete_books_impl(&storage, &tasks, ids)
}

#[tauri::command]
pub fn get_settings(storage: State<'_, AppStorage>) -> Result<Value, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(state.settings.clone())
}

#[tauri::command]
pub fn update_settings(storage: State<'_, AppStorage>, settings: Value) -> Result<(), String> {
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.settings = settings;
    }

    storage.mark_settings_dirty();
    storage.flush_dirty()
}
