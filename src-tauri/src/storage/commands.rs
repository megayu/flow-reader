use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use serde_json::Value;
use tauri::State;

use super::*;
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
pub fn import_epub_paths(
    storage: State<'_, AppStorage>,
    paths: Vec<String>,
    replace_existing: bool,
) -> Result<Vec<BookRecord>, String> {
    let mut books = Vec::new();

    for path in paths {
        let path = PathBuf::from(path);
        if !is_epub_file(&path) {
            continue;
        }

        books.push(import_epub_path_impl(&storage, &path, replace_existing)?);
    }

    Ok(books)
}

#[tauri::command]
pub fn get_text_import_encodings() -> Vec<TextImportEncodingOption> {
    text_import_encoding_options()
}

#[tauri::command]
pub fn preview_text_import_paths(
    storage: State<'_, AppStorage>,
    paths: Vec<String>,
    encodings: HashMap<String, String>,
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<TextImportPreview>, String> {
    let rules = rules.as_ref();
    Ok(paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| is_txt_file(path))
        .map(|path| {
            let key = path_to_client_string(&path);
            if should_skip_text_import_preview(&storage, &path).unwrap_or(false) {
                return create_skipped_text_import_preview(&path);
            }

            create_text_import_preview(&path, encodings.get(&key).map(String::as_str), rules)
        })
        .collect())
}

#[tauri::command]
pub fn import_text_paths(
    storage: State<'_, AppStorage>,
    imports: Vec<TextImportSelection>,
    replace_existing: bool,
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<BookRecord>, String> {
    let mut books = Vec::new();
    let rules = rules.as_ref();

    for import in imports {
        let path = PathBuf::from(&import.path);
        if !is_txt_file(&path) {
            continue;
        }

        books.push(import_text_path_impl(
            &storage,
            &path,
            import.encoding.as_deref(),
            replace_existing,
            rules,
        )?);
    }

    Ok(books)
}

#[tauri::command]
pub fn get_book_package_path(storage: State<'_, AppStorage>, id: String) -> Result<String, String> {
    let dir = storage.book_dir(&id);
    let unpacked_dir = dir.join(UNPACKED_DIR);

    if let Ok(opf_path) = find_unpacked_opf_path(&unpacked_dir) {
        return Ok(path_to_client_string(&opf_path));
    }

    let book_path = dir.join(BOOK_FILE);
    if book_path.exists() {
        unpack_epub(&dir.join(BOOK_FILE), &unpacked_dir)?;
        return Ok(path_to_client_string(&find_unpacked_opf_path(
            &unpacked_dir,
        )?));
    }

    Err("Book package is unavailable".to_string())
}

#[tauri::command]
pub async fn search_book_text(
    storage: State<'_, AppStorage>,
    id: String,
    keyword: String,
    limit: Option<usize>,
) -> Result<Vec<SearchTextResult>, String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let book = storage.library_book(&id)?;
        let cache = load_or_build_search_text_cache(&storage, &book)?;
        Ok(search_text_in_cache(
            &cache,
            &keyword,
            limit.unwrap_or(SEARCH_TEXT_DEFAULT_LIMIT),
        ))
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
                if is_generated_text_cover(&storage, &id)? {
                    write_cover(
                        &storage,
                        &id,
                        create_text_cover_input(
                            value,
                            Path::new(&book.name)
                                .file_stem()
                                .and_then(|name| name.to_str()),
                        ),
                    )?;
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
pub fn delete_books(storage: State<'_, AppStorage>, ids: Vec<String>) -> Result<(), String> {
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.library.books.retain(|book| !ids.contains(&book.id));
        for id in &ids {
            state.book_states.remove(id);
        }
    }

    for id in ids {
        storage.unload_search_text_cache(&id);
        let _ = fs::remove_dir_all(storage.book_dir(&id));
    }

    storage.mark_library_dirty();
    storage.flush_dirty()
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
