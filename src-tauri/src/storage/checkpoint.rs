use super::*;
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStateCheckpoint {
    pub(super) cfi: Option<String>,
    pub(super) percentage: Option<f64>,
    #[serde(default)]
    pub(super) definitions: Vec<String>,
    #[serde(default)]
    pub(super) annotations: Vec<Value>,
    pub(super) configuration: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStateCheckpointInput {
    pub(super) id: String,
    pub(super) state: BookStateCheckpoint,
    pub(super) state_updated_at: Option<u64>,
    pub(super) last_read_at: Option<u64>,
}

#[tauri::command]
pub async fn persist_book_state(
    storage: tauri::State<'_, AppStorage>,
    checkpoint: BookStateCheckpointInput,
) -> Result<(), String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || apply_book_state_checkpoints(&storage, vec![checkpoint]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn persist_book_on_close(
    storage: tauri::State<'_, AppStorage>,
    checkpoint: BookStateCheckpointInput,
) -> Result<(), String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || persist_book_states_and_flush(&storage, vec![checkpoint]))
        .await
        .map_err(|error| error.to_string())?
}

pub(super) fn persist_book_states_and_flush(
    storage: &AppStorage,
    books: Vec<BookStateCheckpointInput>,
) -> Result<(), String> {
    apply_book_state_checkpoints(storage, books)?;
    storage.flush_content_dirty()
}

pub(super) fn apply_book_state_checkpoints(
    storage: &AppStorage,
    books: Vec<BookStateCheckpointInput>,
) -> Result<(), String> {
    if books.is_empty() {
        return Ok(());
    }

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    let mut seen = HashSet::with_capacity(books.len());
    let mut resolved = Vec::with_capacity(books.len());

    for checkpoint in &books {
        if checkpoint.id.is_empty() || !is_valid_book_storage_id(&checkpoint.id) {
            return Err("Invalid book id".to_string());
        }
        if !seen.insert(checkpoint.id.as_str()) {
            return Err(format!("Duplicate book checkpoint: {}", checkpoint.id));
        }

        let index = state
            .library
            .books
            .iter()
            .position(|book| book.id == checkpoint.id)
            .ok_or_else(|| format!("Book not found: {}", checkpoint.id))?;
        resolved.push(index);
    }

    for checkpoint in &books {
        storage.write_book_state(
            &checkpoint.id,
            &BookState {
                version: BOOK_STATE_VERSION,
                cfi: checkpoint.state.cfi.clone(),
                percentage: checkpoint.state.percentage,
                definitions: checkpoint.state.definitions.clone(),
                annotations: checkpoint.state.annotations.clone(),
                configuration: checkpoint.state.configuration.clone(),
            },
        )?;
    }

    for (checkpoint, index) in books.iter().zip(resolved) {
        let book = &mut state.library.books[index];
        book.cfi = checkpoint.state.cfi.clone();
        book.percentage = checkpoint.state.percentage;
        merge_monotonic_timestamp(&mut book.updated_at, checkpoint.state_updated_at);
        merge_monotonic_timestamp(&mut book.last_read_at, checkpoint.last_read_at);
    }
    drop(state);

    storage.mark_library_dirty();
    Ok(())
}

fn merge_monotonic_timestamp(current: &mut Option<u64>, incoming: Option<u64>) {
    if let Some(incoming) = incoming
        && current.is_none_or(|current| incoming > current)
    {
        *current = Some(incoming);
    }
}
