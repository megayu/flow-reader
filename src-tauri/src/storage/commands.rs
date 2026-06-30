use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::tasks::{TaskPriority, TaskService};

use super::*;

fn clean_tag_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same_tag_name(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn tag_id_from_name(name: &str, created_at: u64) -> String {
    let slug = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() { "tag" } else { &slug };

    format!("tag-{slug}-{created_at}")
}

fn compose_book_summaries(storage: &AppStorage) -> Result<Vec<BookRecord>, String> {
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
pub fn create_tag(
    storage: State<'_, AppStorage>,
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
        let mut id = tag_id_from_name(&name, created_at);
        let mut suffix = 1;
        while state.library.tags.iter().any(|tag| tag.id == id) {
            suffix += 1;
            id = format!("{}-{suffix}", tag_id_from_name(&name, created_at));
        }

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

#[tauri::command]
pub fn delete_tag(storage: State<'_, AppStorage>, id: String) -> Result<Vec<BookRecord>, String> {
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        state.library.tags.retain(|tag| tag.id != id);
        for book in &mut state.library.books {
            book.tag_ids.retain(|tag_id| tag_id != &id);
        }
    }

    storage.mark_library_dirty();
    storage.flush_dirty()?;
    compose_book_summaries(&storage)
}

#[tauri::command]
pub fn update_book_tags(
    storage: State<'_, AppStorage>,
    ids: Vec<String>,
    add_tag_ids: Vec<String>,
    remove_tag_ids: Vec<String>,
) -> Result<Vec<BookRecord>, String> {
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
        for book in &mut state.library.books {
            if !id_set.contains(&book.id) {
                continue;
            }

            book.tag_ids
                .retain(|tag_id| !remove_tag_ids.contains(tag_id));
            for tag_id in &add_tag_ids {
                if existing_tags.contains(tag_id) && !book.tag_ids.contains(tag_id) {
                    book.tag_ids.push(tag_id.clone());
                }
            }
        }
    }

    storage.mark_library_dirty();
    storage.flush_dirty()?;
    compose_book_summaries(&storage)
}

#[tauri::command]
pub fn get_book(storage: State<'_, AppStorage>, id: String) -> Result<Option<BookRecord>, String> {
    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    let book = state
        .library
        .books
        .iter()
        .find(|book| book.id == id)
        .cloned();

    book.map(|book| storage.compose_book(&mut state, &book))
        .transpose()
}

#[tauri::command]
pub fn list_covers(storage: State<'_, AppStorage>) -> Result<Vec<CoverRecord>, String> {
    let ids = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state
            .library
            .books
            .iter()
            .map(|book| book.id.clone())
            .collect::<Vec<_>>()
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
pub fn get_cover(
    storage: State<'_, AppStorage>,
    id: String,
) -> Result<Option<CoverRecord>, String> {
    Ok(Some(CoverRecord {
        id: id.clone(),
        cover: read_cover(&storage, &id)?,
    }))
}

#[tauri::command]
pub fn update_cover(
    storage: State<'_, AppStorage>,
    id: String,
    cover: Option<CoverInput>,
) -> Result<(), String> {
    write_cover(&storage, &id, cover)
}

#[tauri::command]
pub async fn import_epub_paths(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    paths: Vec<String>,
    replace_existing: bool,
) -> Result<Vec<BookRecord>, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_epub_paths_impl(&storage, &tasks, paths, replace_existing)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) fn import_epub_paths_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    paths: Vec<String>,
    replace_existing: bool,
) -> Result<Vec<BookRecord>, String> {
    let mut books = Vec::new();

    for path in paths {
        let path = PathBuf::from(path);
        if !is_epub_file(&path) {
            continue;
        }

        books.push(tasks.run_io(TaskPriority::Foreground, || {
            import_epub_path_impl(storage, &path, replace_existing)
        })?);
    }

    Ok(books)
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
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<TextImportPreview>, String> {
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
    let paths = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| is_txt_file(path))
        .collect::<Vec<_>>();
    let rules = rules.as_ref();
    if paths.len() <= 1 {
        return Ok(paths
            .iter()
            .map(|path| preview_text_import_path(storage, tasks, path, &encodings, rules))
            .collect());
    }

    let queue = Arc::new(Mutex::new(
        paths.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));
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
            let storage = storage;
            let tasks = tasks;
            scope.spawn(move || loop {
                let item = queue.lock().ok().and_then(|mut queue| queue.pop_front());
                let Some((index, path)) = item else {
                    break;
                };
                let preview = preview_text_import_path(storage, tasks, &path, &encodings, rules);
                if let Ok(mut results) = results.lock() {
                    results[index] = Some(preview);
                }
            });
        }
    });

    let previews = results
        .lock()
        .map_err(|_| "text import results lock poisoned".to_string())?
        .iter_mut()
        .map(|result| {
            result
                .take()
                .ok_or_else(|| "text import preview worker did not produce a result".to_string())
        })
        .collect();
    previews
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
    let prepared = match load_or_prepare_text_import(storage, tasks, path, encoding, rules) {
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
    let cpus = std::thread::available_parallelism()
        .map(|cpus| cpus.get())
        .unwrap_or(1);
    file_count.min(cpus.saturating_mul(2).max(1)).max(1)
}

#[tauri::command]
pub async fn import_text_paths(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    imports: Vec<TextImportSelection>,
    replace_existing: bool,
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<BookRecord>, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_text_paths_impl(&storage, &tasks, imports, replace_existing, rules)
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
) -> Result<Vec<BookRecord>, String> {
    let mut books = Vec::new();
    let rules = rules.as_ref();
    let imports = imports
        .into_iter()
        .filter(|import| is_txt_file(Path::new(&import.path)))
        .collect::<Vec<_>>();
    let prepared_imports = prepare_text_imports_for_import(storage, tasks, imports, rules)?;

    for (import, prepared) in prepared_imports {
        books.push(import_text_path_impl(
            storage,
            prepared,
            import.title.as_deref(),
            import.creator.as_deref(),
            replace_existing,
            rules,
        )?);
    }

    Ok(books)
}

fn prepare_text_imports_for_import(
    storage: &AppStorage,
    tasks: &TaskService,
    imports: Vec<TextImportSelection>,
    rules: Option<&TextImportRulesInput>,
) -> Result<Vec<(TextImportSelection, Arc<PreparedTextImport>)>, String> {
    if imports.len() <= 1 {
        return imports
            .into_iter()
            .map(|import| {
                let path = PathBuf::from(&import.path);
                let prepared = consume_or_prepare_text_import(
                    storage,
                    tasks,
                    &path,
                    import.encoding.as_deref(),
                    rules,
                )?;
                Ok((import, prepared))
            })
            .collect();
    }

    let queue = Arc::new(Mutex::new(
        imports.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));
    let result_len = queue
        .lock()
        .map_err(|_| "text import queue lock poisoned".to_string())?
        .len();
    let results = Arc::new(Mutex::new(
        std::iter::repeat_with(|| None)
            .take(result_len)
            .collect::<Vec<Option<Result<(TextImportSelection, Arc<PreparedTextImport>), String>>>>(
            ),
    ));
    let workers = text_import_prepare_worker_count(result_len);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            let queue = Arc::clone(&queue);
            let results = Arc::clone(&results);
            let storage = storage;
            let tasks = tasks;
            scope.spawn(move || loop {
                let item = queue.lock().ok().and_then(|mut queue| queue.pop_front());
                let Some((index, import)) = item else {
                    break;
                };
                let path = PathBuf::from(&import.path);
                let prepared = consume_or_prepare_text_import(
                    storage,
                    tasks,
                    &path,
                    import.encoding.as_deref(),
                    rules,
                );
                if let Ok(mut results) = results.lock() {
                    results[index] = Some(prepared.map(|prepared| (import, prepared)));
                }
            });
        }
    });

    let prepared = results
        .lock()
        .map_err(|_| "text import results lock poisoned".to_string())?
        .iter_mut()
        .map(|result| {
            result
                .take()
                .ok_or_else(|| "text import prepare worker did not produce a result".to_string())?
        })
        .collect();
    prepared
}

#[tauri::command]
pub async fn get_book_package_path(
    storage: State<'_, AppStorage>,
    tasks: State<'_, TaskService>,
    id: String,
) -> Result<String, String> {
    let storage = (*storage).clone();
    let tasks = (*tasks).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let book = storage.library_book(&id)?;
        let opf_path = ensure_book_package_path(&storage, &tasks, &book)?;
        Ok(path_to_client_string(&opf_path))
    })
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
pub async fn replace_book_text(
    storage: State<'_, AppStorage>,
    id: String,
    target: BookTextReplaceTarget,
    old_text: String,
    new_text: String,
) -> Result<BookTextReplaceResult, String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || {
        replace_book_text_impl(&storage, id, target, old_text, new_text)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn export_book(
    storage: State<'_, AppStorage>,
    id: String,
    format: BookExportFormat,
    output_path: String,
) -> Result<Option<BookRecord>, String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_book_impl(&storage, id, format, PathBuf::from(output_path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn unload_book_search_text(storage: State<'_, AppStorage>, id: String) -> Result<(), String> {
    storage.unload_search_text_cache(&id);
    Ok(())
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
    pub updated_at: u64,
    pub sequence: u64,
}

pub(super) fn record_reading_position_impl(
    storage: &AppStorage,
    position: ReadingPositionInput,
) -> Result<bool, String> {
    let mut sequences = storage
        .inner
        .reading_position_sequences
        .lock()
        .map_err(|_| "reading position sequence lock poisoned".to_string())?;

    if sequences
        .get(&position.book_id)
        .is_some_and(|current| position.sequence < *current)
    {
        return Ok(false);
    }

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book_index) = state
            .library
            .books
            .iter()
            .position(|book| book.id == position.book_id)
        else {
            return Ok(false);
        };

        {
            let Some(book_state) = state.book_states.get_mut(&position.book_id) else {
                return Err("Book state is not loaded for reading position".to_string());
            };
            book_state.cfi = position.cfi.clone();
            book_state.percentage = position.percentage;
            book_state.configuration = Some(configuration_with_recorded_spread(
                book_state.configuration.as_ref(),
                position.spread,
            ));
        }

        let book = &mut state.library.books[book_index];
        book.cfi = position.cfi;
        book.percentage = position.percentage;
        book.updated_at = Some(position.updated_at);
        book.last_read_at = Some(position.updated_at);
    }

    sequences.insert(position.book_id.clone(), position.sequence);
    drop(sequences);

    storage.mark_library_dirty();
    storage.mark_book_state_dirty(&position.book_id);
    storage.schedule_reading_position_flush();

    Ok(true)
}

fn configuration_with_recorded_spread(current: Option<&Value>, spread: Option<Value>) -> Value {
    let mut object = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

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
pub fn record_reading_position(
    storage: State<'_, AppStorage>,
    position: ReadingPositionInput,
) -> Result<bool, String> {
    record_reading_position_impl(&storage, position)
}

#[tauri::command]
pub fn update_book(
    storage: State<'_, AppStorage>,
    id: String,
    changes: Value,
) -> Result<Option<BookRecord>, String> {
    let mut library_changed = false;
    let mut state_changed = false;
    let mut immediate_flush = false;
    let mut reading_position_only = false;
    let book = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book_index) = state.library.books.iter().position(|book| book.id == id) else {
            return Ok(None);
        };
        let mut book = state.library.books[book_index].clone();

        if let Some(object) = changes.as_object() {
            let updates_reading_position =
                object.contains_key("cfi") || object.contains_key("percentage");
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
                write_metadata(&storage, &id, value)?;
                sync_unpacked_opf_metadata(&storage.book_dir(&id).join(UNPACKED_DIR), value)?;
                if is_generated_text_cover(&storage, &id)? {
                    let cover = create_text_cover_input(
                        value,
                        Path::new(&book.name)
                            .file_stem()
                            .and_then(|name| name.to_str()),
                    );
                    if book.source_format == Some(BookSourceFormat::Txt) {
                        if let Some(cover) = cover.as_ref() {
                            write_text_cover_to_unpacked(&storage, &id, cover)?;
                        }
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
                if updates_reading_position {
                    book.last_read_at = Some(value);
                }
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

            {
                let book_state = storage.ensure_book_state(&mut state, &id)?;
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
                    book_state.definitions =
                        serde_json::from_value(value.clone()).unwrap_or_default();
                    state_changed = true;
                    immediate_flush = true;
                }
                if let Some(value) = object.get("annotations") {
                    book_state.annotations =
                        serde_json::from_value(value.clone()).unwrap_or_default();
                    state_changed = true;
                    immediate_flush = true;
                }
                if let Some(value) = object.get("configuration") {
                    let spread_only = is_spread_only_configuration_update(
                        book_state.configuration.as_ref(),
                        value,
                    );
                    configuration_spread_only_update = spread_only;
                    book_state.configuration = Some(value.clone());
                    state_changed = true;
                    if !spread_only {
                        immediate_flush = true;
                    }
                }
            }

            let explicit_state_update = object.contains_key("definitions")
                || object.contains_key("annotations")
                || (object.contains_key("configuration") && !configuration_spread_only_update);
            reading_position_only =
                updates_reading_position && !explicit_state_update && allowed_reading_position_keys;
        }

        state.library.books[book_index] = book.clone();
        book
    };

    if library_changed {
        storage.mark_library_dirty();
    }
    if state_changed {
        storage.mark_book_state_dirty(&id);
    }

    if immediate_flush {
        storage.flush_dirty()?;
    } else if reading_position_only {
        storage.schedule_reading_position_flush();
    }

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    storage.compose_book(&mut state, &book).map(Some)
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

#[tauri::command]
pub fn flush_storage(storage: State<'_, AppStorage>) -> Result<(), String> {
    storage.flush_dirty()
}
