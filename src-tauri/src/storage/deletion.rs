use super::*;

fn unedited_source_path(storage: &AppStorage, book: &LibraryBook) -> Option<PathBuf> {
    if book.source_format == BookSourceFormat::Txt
        && book.source_storage == SourceStorage::Managed
        && book.content_edited_at.is_some()
    {
        return book.source_path.clone();
    }

    match book.source_storage {
        SourceStorage::Managed => Some(storage.book_dir(&book.id).join(match book.source_format {
            BookSourceFormat::Epub => BOOK_FILE,
            BookSourceFormat::Txt => SOURCE_TEXT_FILE,
        })),
        SourceStorage::Referenced => book.source_path.clone(),
    }
}

fn remove_book_derived_cache_files(storage: &AppStorage, id: &str) -> Result<(), String> {
    let book_dir = storage.book_dir(id);
    if !book_dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(book_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().map_err(|error| error.to_string())?.is_file()
            && entry.file_name().to_str().is_some_and(is_derived_cache_file_name)
        {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn clear_book_caches_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    discard_unexported_edits: bool,
    preserved_unpacked_book_ids: HashSet<String>,
    mut report_progress: impl FnMut(usize, usize),
) -> Result<Vec<BookRecord>, String> {
    let (library_books, external_ids) = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        (
            state.library.books.clone(),
            state
                .external
                .books
                .iter()
                .map(|book| book.id.clone())
                .collect::<Vec<_>>(),
        )
    };
    let mut all_ids = library_books.iter().map(|book| book.id.clone()).collect::<Vec<_>>();
    all_ids.extend(external_ids);
    let total = all_ids.len();
    report_progress(0, total);

    let edited_book_ids = library_books
        .iter()
        .filter(|book| book.content_edited_at.is_some())
        .map(|book| book.id.clone())
        .collect::<HashSet<_>>();
    let source_restorations = if discard_unexported_edits {
        library_books
            .iter()
            .filter(|book| book.content_edited_at.is_some() && !preserved_unpacked_book_ids.contains(&book.id))
            .map(|book| {
                let path =
                    unedited_source_path(storage, book).ok_or_else(|| "Book source is unavailable".to_string())?;
                let size = fs::metadata(&path).map_err(|error| error.to_string())?.len();
                let restore_managed_text =
                    book.source_format == BookSourceFormat::Txt && book.source_storage == SourceStorage::Managed;
                Ok((
                    book.id.clone(),
                    (path.clone(), size, hash_file(&path)?, restore_managed_text),
                ))
            })
            .collect::<Result<HashMap<_, _>, String>>()?
    } else {
        HashMap::new()
    };

    let mut completed = 0;
    let mut restored_source_ids = Vec::new();
    for id in all_ids {
        let restored_source = tasks.run_book_exclusive(&id, TaskPriority::Critical, || {
            let preserve_unpacked = preserved_unpacked_book_ids.contains(&id)
                || storage.derived_cache_is_active(&id)?
                || (edited_book_ids.contains(&id) && !discard_unexported_edits);
            {
                let _flush_guard = storage
                    .inner
                    .derived_cache_flush_lock
                    .lock()
                    .map_err(|_| "derived cache flush lock poisoned".to_string())?;
                storage.remove_derived_memory_caches(&id);
                remove_book_derived_cache_files(storage, &id)?;
            }
            if !preserve_unpacked {
                if let Some((source_path, _, _, true)) = source_restorations.get(&id) {
                    fs::copy(source_path, storage.book_dir(&id).join(SOURCE_TEXT_FILE))
                        .map_err(|error| error.to_string())?;
                }
                let unpacked = storage.book_dir(&id).join(UNPACKED_DIR);
                if unpacked.exists() {
                    fs::remove_dir_all(unpacked).map_err(|error| error.to_string())?;
                }
            }
            Ok(!preserve_unpacked && source_restorations.contains_key(&id))
        })?;
        if restored_source {
            restored_source_ids.push(id);
        }
        completed += 1;
        if completed < total {
            report_progress(completed, total);
        }
    }

    if restored_source_ids.is_empty() {
        report_progress(total, total);
        return Ok(Vec::new());
    }

    let restored_source_ids = restored_source_ids.into_iter().collect::<HashSet<_>>();
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        for book in &mut state.library.books {
            if !restored_source_ids.contains(&book.id) {
                continue;
            }
            let Some((_, size, content_hash, _)) = source_restorations.get(&book.id) else {
                continue;
            };
            book.size = *size;
            book.content_hash = content_hash.clone();
            book.content_version = book.content_version.saturating_add(1).max(1);
            book.content_edited_at = None;
        }
    }
    storage.mark_library_dirty();
    storage.flush_dirty()?;

    let updated_books = restored_source_ids
        .into_iter()
        .map(|id| commands::get_book_impl(storage, id)?.ok_or_else(|| "Book not found after cache clear".to_string()))
        .collect::<Result<Vec<_>, String>>()?;
    report_progress(total, total);
    Ok(updated_books)
}

pub(super) fn delete_books_to_tombstones(storage: &AppStorage, ids: &[String]) -> Result<Vec<PathBuf>, String> {
    let ids = ids.iter().filter(|id| !id.is_empty()).cloned().collect::<HashSet<_>>();

    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if ids.iter().any(|id| !is_valid_book_storage_id(id)) {
        return Err("Invalid book id".to_string());
    }

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        if ids
            .iter()
            .any(|id| !state.library.books.iter().any(|book| &book.id == id))
        {
            return Err("Book not found".to_string());
        }
        let deleted_authors = state
            .library
            .books
            .iter()
            .filter(|book| ids.contains(&book.id))
            .filter_map(library_book_author)
            .collect::<HashSet<_>>();
        state.library.books.retain(|book| !ids.contains(&book.id));
        for author in deleted_authors {
            if !state
                .library
                .books
                .iter()
                .filter_map(library_book_author)
                .any(|candidate| candidate == author)
            {
                state.library.pins.authors.retain(|candidate| candidate != &author);
            }
        }
        for id in &ids {
            state.book_states.remove(id);
        }
    }
    storage.mark_library_dirty();

    let mut tombstones = Vec::new();
    for id in &ids {
        storage.remove_derived_memory_caches(id);
        if let Some(tombstone) = move_book_dir_to_tombstone(storage, id) {
            tombstones.push(tombstone);
        }
    }

    Ok(tombstones)
}

fn move_book_dir_to_tombstone(storage: &AppStorage, id: &str) -> Option<PathBuf> {
    let book_dir = storage.book_dir(id);
    if !book_dir.exists() {
        return None;
    }

    let tombstones_root = delete_tombstones_root(storage.root());
    if let Err(error) = fs::create_dir_all(&tombstones_root) {
        eprintln!("Failed to prepare deleted book tombstone directory: {error}");
        remove_book_dir_directly(&book_dir);
        return None;
    }
    let tombstone = next_delete_tombstone_path(&tombstones_root, id);

    match fs::rename(&book_dir, &tombstone) {
        Ok(()) => Some(tombstone),
        Err(error) => {
            eprintln!("Failed to move deleted book directory to tombstone: {error}");
            remove_book_dir_directly(&book_dir);
            None
        }
    }
}

pub(super) fn move_path_to_delete_tombstone(
    storage: &AppStorage,
    path: &Path,
    name: &str,
) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let tombstones_root = delete_tombstones_root(storage.root());
    fs::create_dir_all(&tombstones_root).map_err(|error| error.to_string())?;
    let tombstone = next_delete_tombstone_path(&tombstones_root, name);
    fs::rename(path, &tombstone).map_err(|error| error.to_string())?;
    Ok(Some(tombstone))
}

fn remove_book_dir_directly(book_dir: &Path) {
    if let Err(error) = fs::remove_dir_all(book_dir) {
        eprintln!("Failed to delete book directory: {error}");
    }
}

fn next_delete_tombstone_path(root: &Path, id: &str) -> PathBuf {
    let stamp = now_ms();
    let pid = std::process::id();
    let id = sanitize_tombstone_name(id);
    for index in 0.. {
        let suffix = if index == 0 { String::new() } else { format!("-{index}") };
        let path = root.join(format!("{id}-{pid}-{stamp}{suffix}"));
        if !path.exists() {
            return path;
        }
    }

    unreachable!("tombstone path loop should return")
}

fn sanitize_tombstone_name(value: &str) -> String {
    let name = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    if name.is_empty() { "book".to_string() } else { name }
}

#[cfg(test)]
pub(super) fn cleanup_delete_tombstones(storage: &AppStorage) -> Result<(), String> {
    let tombstones = list_delete_tombstones(storage)?;
    for tombstone in tombstones {
        cleanup_delete_tombstone_path(&tombstone)?;
    }

    let root = delete_tombstones_root(storage.root());
    if root.exists() {
        let is_empty = fs::read_dir(&root).map_err(|error| error.to_string())?.next().is_none();
        if is_empty {
            fs::remove_dir(&root).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn list_delete_tombstones(storage: &AppStorage) -> Result<Vec<PathBuf>, String> {
    let root = delete_tombstones_root(storage.root());
    if !root.exists() {
        return Ok(Vec::new());
    }

    fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .map(|entry| entry.map(|entry| entry.path()).map_err(|error| error.to_string()))
        .collect()
}

fn cleanup_delete_tombstone_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

pub(super) fn enqueue_delete_tombstone_cleanup(tasks: &TaskService, tombstones: Vec<PathBuf>) {
    if tombstones.is_empty() {
        return;
    }

    let tasks = tasks.clone();
    std::thread::spawn(move || {
        for tombstone in tombstones {
            let key = TaskKey::new(TaskKind::TombstoneCleanup, tombstone.to_string_lossy().into_owned());
            let runner = tasks.clone();
            let cleanup_path = tombstone.clone();
            if let Err(error) = tasks.get_or_run(key, TaskPriority::Background, move || {
                runner.run_background(|| cleanup_delete_tombstone_path(&cleanup_path))
            }) {
                eprintln!("Failed to cleanup deleted book tombstone: {error}");
            }
        }
    });
}

pub(super) fn delete_books_impl(storage: &AppStorage, tasks: &TaskService, ids: Vec<String>) -> Result<(), String> {
    let started = Instant::now();
    let source_count = ids.len();
    let tombstones = delete_books_to_tombstones(storage, &ids)?;
    let tombstone_count = tombstones.len();
    storage.flush_dirty()?;
    enqueue_delete_tombstone_cleanup(tasks, tombstones);
    let mut fields = vec![
        ("sources", source_count.to_string()),
        ("tombstones", tombstone_count.to_string()),
        (
            "search_memory_caches",
            storage.search_text_memory_cache_len().to_string(),
        ),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("delete-books", started.elapsed(), &fields);
    Ok(())
}

pub(super) fn cleanup_external_book_heavy_files(storage: &AppStorage, id: &str) -> Result<(), String> {
    storage.ensure_external_book(id)?;

    let dir = storage.external_book_dir(id);
    let book_path = dir.join(BOOK_FILE);
    if book_path.exists() {
        fs::remove_file(book_path).map_err(|error| error.to_string())?;
    }

    let unpacked_dir = dir.join(UNPACKED_DIR);
    if unpacked_dir.exists() {
        fs::remove_dir_all(unpacked_dir).map_err(|error| error.to_string())?;
    }
    remove_cover_files(storage, id)?;
    Ok(())
}

pub fn cleanup_all_external_book_heavy_files(storage: &AppStorage) -> Result<(), String> {
    let ids = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state
            .external
            .books
            .iter()
            .map(|book| book.id.clone())
            .collect::<Vec<_>>()
    };

    for id in ids {
        cleanup_external_book_heavy_files(storage, &id)?;
    }
    Ok(())
}

pub fn schedule_existing_delete_tombstone_cleanup(storage: &AppStorage, tasks: &TaskService) {
    match list_delete_tombstones(storage) {
        Ok(tombstones) => enqueue_delete_tombstone_cleanup(tasks, tombstones),
        Err(error) => eprintln!("Failed to list deleted book tombstones: {error}"),
    }
}
