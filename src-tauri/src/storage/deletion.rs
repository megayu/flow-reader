use super::*;

fn unedited_source_path(storage: &AppStorage, book: &StoredBook) -> Option<PathBuf> {
    if book.source_format == BookSourceFormat::Txt
        && book.source_storage == SourceStorage::Managed
        && book.content_edited_at.is_some()
    {
        return Some(book.source_path.clone());
    }

    match book.source_storage {
        SourceStorage::Managed => Some(storage.book_dir(&book.id).join(match book.source_format {
            BookSourceFormat::Epub => BOOK_FILE,
            BookSourceFormat::Txt => SOURCE_TEXT_FILE,
        })),
        SourceStorage::Referenced => Some(book.source_path.clone()),
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
    let all_books = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.library.books.clone()
    };
    let all_ids = all_books.iter().map(|book| book.id.clone()).collect::<Vec<_>>();
    let external_ids = all_books
        .iter()
        .filter(|book| book.scope == BookScope::External)
        .map(|book| book.id.clone())
        .collect::<HashSet<_>>();
    let total = all_ids.len();
    report_progress(0, total);

    let edited_book_ids = all_books
        .iter()
        .filter(|book| book.scope == BookScope::Library && book.content_edited_at.is_some())
        .map(|book| book.id.clone())
        .collect::<HashSet<_>>();
    let source_restorations = if discard_unexported_edits {
        all_books
            .iter()
            .filter(|book| {
                book.scope == BookScope::Library
                    && book.content_edited_at.is_some()
                    && !preserved_unpacked_book_ids.contains(&book.id)
            })
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
                if external_ids.contains(&id) {
                    cleanup_external_book_heavy_files(storage, &id)?;
                } else {
                    let unpacked = storage.book_dir(&id).join(UNPACKED_DIR);
                    if unpacked.exists() {
                        fs::remove_dir_all(unpacked).map_err(|error| error.to_string())?;
                    }
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
        let updated_at = now_ms();
        for book in &mut state.library.books {
            if !restored_source_ids.contains(&book.id) {
                continue;
            }
            let Some((_, size, content_hash, _)) = source_restorations.get(&book.id) else {
                continue;
            };
            book.size = *size;
            book.content_hash = content_hash.clone();
            book.revision = next_revision(book.revision)?;
            book.content_edited_at = None;
            book.updated_at = Some(updated_at);
        }
    }
    storage.mark_library_dirty();
    storage.flush_content_dirty()?;

    let updated_books = restored_source_ids
        .into_iter()
        .map(|id| commands::get_book_impl(storage, id)?.ok_or_else(|| "Book not found after cache clear".to_string()))
        .collect::<Result<Vec<_>, String>>()?;
    report_progress(total, total);
    Ok(updated_books)
}

pub(super) fn rename_books_for_deletion(storage: &AppStorage, ids: &[String]) -> Result<Vec<PathBuf>, String> {
    let ids = ids.iter().filter(|id| !id.is_empty()).cloned().collect::<HashSet<_>>();

    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if ids.iter().any(|id| !is_valid_book_storage_id(id)) {
        return Err("Invalid book id".to_string());
    }

    {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        if ids.iter().any(|id| {
            !state
                .library
                .books
                .iter()
                .any(|book| &book.id == id && book.scope == BookScope::Library)
        }) {
            return Err("Book not found".to_string());
        }
    }

    let mut renamed_books = Vec::new();
    for id in &ids {
        storage.remove_derived_memory_caches(id);
        match rename_path_for_deletion(&storage.book_dir(id)) {
            Ok(Some(path)) => renamed_books.push((id.clone(), path)),
            Ok(None) => {}
            Err(error) => {
                restore_renamed_book_directories(storage, &renamed_books);
                return Err(format!("Failed to prepare book '{id}' for deletion: {error}"));
            }
        }
    }

    {
        let mut state = storage.inner.state.lock().map_err(|error| {
            restore_renamed_book_directories(storage, &renamed_books);
            format!("storage state lock poisoned: {error}")
        })?;
        let deleted_authors = state
            .library
            .books
            .iter()
            .filter(|book| book.scope == BookScope::Library && ids.contains(&book.id))
            .filter_map(library_book_author)
            .collect::<HashSet<_>>();
        state.library.books.retain(|book| !ids.contains(&book.id));
        for author in deleted_authors {
            if !state
                .library
                .books
                .iter()
                .filter(|book| book.scope == BookScope::Library)
                .filter_map(library_book_author)
                .any(|candidate| candidate == author)
            {
                state.library.pins.authors.retain(|candidate| candidate != &author);
            }
        }
    }
    storage.mark_library_dirty();

    Ok(renamed_books.into_iter().map(|(_, path)| path).collect())
}

fn restore_renamed_book_directories(storage: &AppStorage, renamed_books: &[(String, PathBuf)]) {
    for (id, renamed_path) in renamed_books.iter().rev() {
        let original_path = storage.book_dir(id);
        if let Err(error) = fs::rename(renamed_path, original_path) {
            eprintln!("Failed to restore book directory after deferred-delete rename failure: {error}");
        }
    }
}

pub(super) fn rename_path_for_deletion(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Delete target has no parent directory".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "Delete target has no file name".to_string())?;
    let base = format!("{PENDING_DELETE_PREFIX}{}", name.to_string_lossy());
    for index in 0.. {
        let suffix = if index == 0 { String::new() } else { format!("-{index}") };
        let renamed_path = parent.join(format!("{base}{suffix}"));
        if !renamed_path.exists() {
            fs::rename(path, &renamed_path).map_err(|error| error.to_string())?;
            return Ok(Some(renamed_path));
        }
    }

    unreachable!("pending-delete path loop should return")
}

fn list_pending_delete_paths(storage: &AppStorage) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for root in [books_root(storage.root())] {
        if !root.exists() {
            continue;
        }
        for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(PENDING_DELETE_PREFIX))
            {
                paths.push(entry.path());
            }
        }
    }

    Ok(paths)
}

fn cleanup_pending_delete_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

pub(super) fn enqueue_pending_delete_cleanup(tasks: &TaskService, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }

    let tasks = tasks.clone();
    std::thread::spawn(move || {
        for path in paths {
            let key = TaskKey::new(TaskKind::PendingDeleteCleanup, path.to_string_lossy().into_owned());
            let runner = tasks.clone();
            let cleanup_path = path.clone();
            if let Err(error) = tasks.get_or_run(key, TaskPriority::Background, move || {
                runner.run_background(|| cleanup_pending_delete_path(&cleanup_path))
            }) {
                eprintln!("Failed to cleanup deferred-delete path: {error}");
            }
        }
    });
}

pub(super) fn delete_books_impl(storage: &AppStorage, tasks: &TaskService, ids: Vec<String>) -> Result<(), String> {
    let started = Instant::now();
    let source_count = ids.len();
    let pending_deletes = rename_books_for_deletion(storage, &ids)?;
    let pending_delete_count = pending_deletes.len();
    storage.flush_content_dirty()?;
    enqueue_pending_delete_cleanup(tasks, pending_deletes);
    let mut fields = vec![
        ("sources", source_count.to_string()),
        ("pending_deletes", pending_delete_count.to_string()),
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

    let dir = storage.book_dir(id);
    let book_path = dir.join(BOOK_FILE);
    if book_path.exists() {
        fs::remove_file(book_path).map_err(|error| error.to_string())?;
    }

    let unpacked_dir = dir.join(UNPACKED_DIR);
    if unpacked_dir.exists() {
        fs::remove_dir_all(unpacked_dir).map_err(|error| error.to_string())?;
    }
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
            .library
            .books
            .iter()
            .filter(|book| book.scope == BookScope::External)
            .map(|book| book.id.clone())
            .collect::<Vec<_>>()
    };

    for id in ids {
        cleanup_external_book_heavy_files(storage, &id)?;
    }
    Ok(())
}

pub fn schedule_existing_pending_delete_cleanup(storage: &AppStorage, tasks: &TaskService) {
    match list_pending_delete_paths(storage) {
        Ok(paths) => enqueue_pending_delete_cleanup(tasks, paths),
        Err(error) => eprintln!("Failed to list deferred-delete paths: {error}"),
    }
}
