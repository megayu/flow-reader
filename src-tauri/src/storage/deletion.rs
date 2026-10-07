use super::*;

// Cleanup tasks use the path as their identity; do not reuse one during this process.
static DELETE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(super) fn remove_obsolete_schema_caches(
    storage: &AppStorage,
    id: &str,
    prefix: &str,
    current_version: u32,
    has_revision: bool,
) -> Result<(), String> {
    let entries = match fs::read_dir(storage.book_dir(id)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().map_err(|error| error.to_string())?.is_file()
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| is_obsolete_schema_cache(name, prefix, current_version, has_revision))
        {
            match fs::remove_file(entry.path()) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(())
}

fn is_obsolete_schema_cache(name: &str, prefix: &str, current_version: u32, has_revision: bool) -> bool {
    let Some(stem) = name.strip_suffix(".json.zst") else {
        return false;
    };
    let Some((version, revisions)) = stem.strip_prefix(prefix).and_then(|rest| rest.split_once(".s")) else {
        return false;
    };
    let valid_number = |value: &str| {
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) && value.parse::<u32>().is_ok()
    };
    let valid_revisions = if has_revision {
        revisions
            .split_once(".r")
            .is_some_and(|(source, revision)| valid_number(source) && valid_number(revision))
    } else {
        valid_number(revisions)
    };
    // Keep newer schemas so downgrading the application does not destroy their caches.
    valid_revisions && valid_number(version) && version.parse::<u32>().is_ok_and(|version| version < current_version)
}

fn unedited_source_path(storage: &AppStorage, book: &StoredBook) -> Option<PathBuf> {
    if book.source_format == BookSourceFormat::Txt
        && book.source_storage == SourceStorage::Managed
        && has_unexported_book_changes(book)
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

pub(super) fn remove_book_derived_cache_files(storage: &AppStorage, id: &str) -> Result<(), String> {
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
    let _import_guard = storage.lock_import()?;
    let all_books = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.library.books.clone()
    };
    let total = all_books.len();
    report_progress(0, total);

    let mut source_restorations = HashMap::new();
    if discard_unexported_edits {
        for book in &all_books {
            if book.scope != BookScope::Library
                || !has_unexported_book_changes(book)
                || preserved_unpacked_book_ids.contains(&book.id)
                || storage.derived_cache_is_active(&book.id)?
            {
                continue;
            }
            let path = unedited_source_path(storage, book).ok_or_else(|| "Book source is unavailable".to_string())?;
            let size = fs::metadata(&path).map_err(|error| error.to_string())?.len();
            let restore_managed_text =
                book.source_format == BookSourceFormat::Txt && book.source_storage == SourceStorage::Managed;
            let hash = hash_file(&path)?;
            source_restorations.insert(book.id.clone(), (path, size, hash, restore_managed_text));
        }
    }

    let mut completed = 0;
    let mut restored_source_ids = Vec::new();
    for (book_index, book) in all_books.into_iter().enumerate() {
        let id = book.id;
        let restored_source = tasks.run_book_exclusive(&id, TaskPriority::Critical, || {
            // The import lock keeps vector positions stable across this batch.
            let book = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?
                .library
                .books
                .get(book_index)
                .filter(|book| book.id == id)
                .cloned()
                .ok_or_else(|| "Book changed during cache clear".to_string())?;
            // Editable publications are working copies even when their revisions are equal.
            let has_working_copy = book.scope == BookScope::Library
                && (book.source_format == BookSourceFormat::Txt
                    || book.editable
                    || book.revision > book.source_revision);
            let preserve_unpacked = preserved_unpacked_book_ids.contains(&id)
                || storage.derived_cache_is_active(&id)?
                || (has_working_copy && !source_restorations.contains_key(&id));
            if !preserve_unpacked && source_restorations.contains_key(&id) {
                next_book_revision(&book)?;
            }
            let _flush_guard = storage
                .inner
                .derived_cache_flush_lock
                .lock()
                .map_err(|_| "derived cache flush lock poisoned".to_string())?;
            {
                storage.remove_derived_memory_cache_data(&id);
                // Keep active-reader ownership while forgetting only the discarded indexes.
                {
                    let mut states = storage
                        .inner
                        .derived_cache_states
                        .lock()
                        .map_err(|_| "derived cache state lock poisoned".to_string())?;
                    if let Some(state) = states.get_mut(&id).filter(|state| state.active) {
                        state.search_dirty = false;
                        state.image_dirty = false;
                    } else {
                        states.remove(&id);
                    }
                }
                remove_book_derived_cache_files(storage, &id)?;
            }
            if !preserve_unpacked {
                if let Some((source_path, _, _, true)) = source_restorations.get(&id) {
                    fs::copy(source_path, storage.book_dir(&id).join(SOURCE_TEXT_FILE))
                        .map_err(|error| error.to_string())?;
                }
                if book.scope == BookScope::External {
                    cleanup_external_book_heavy_files(storage, &id)?;
                } else {
                    let unpacked = storage.book_dir(&id).join(UNPACKED_DIR);
                    if unpacked.exists() {
                        fs::remove_dir_all(unpacked).map_err(|error| error.to_string())?;
                    }
                }
            }
            let restored = !preserve_unpacked && source_restorations.contains_key(&id);
            if restored {
                let (_, size, hash, _) = &source_restorations[&id];
                let mut state = storage
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "storage state lock poisoned".to_string())?;
                let book = state
                    .library
                    .books
                    .get_mut(book_index)
                    .filter(|book| book.id == id)
                    .ok_or_else(|| "Book not found after cache clear".to_string())?;
                adopt_book_source_fields(book, hash.clone(), *size)?;
                book.updated_at = Some(now_ms());
                drop(state);
                storage.mark_library_dirty();
            }
            Ok(restored)
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
        storage.release_archive_resource(id);
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
            if !state.library.pins.authors.contains(&author) {
                continue;
            }
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
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Delete target has no parent directory".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "Delete target has no file name".to_string())?;
    let base = format!("{PENDING_DELETE_PREFIX}{}", name.to_string_lossy());
    loop {
        let index = DELETE_SEQUENCE
            .fetch_update(
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
                |index| index.checked_add(1),
            )
            .map_err(|_| "Deferred-delete sequence exhausted".to_string())?;
        // Book IDs cannot contain '.', so the collision suffix is unambiguous on restart.
        let renamed_path = parent.join(format!("{base}.{index}"));
        match fs::symlink_metadata(&renamed_path) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::rename(path, &renamed_path).map_err(|error| error.to_string())?;
                return Ok(Some(renamed_path));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
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
            } else if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(".import-backup-"))
            {
                eprintln!("Import backup retained for recovery: {}", entry.path().display());
            }
        }
    }

    Ok(paths)
}

pub(super) fn recover_pending_delete_paths(storage: &AppStorage) -> Result<Vec<PathBuf>, String> {
    let paths = list_pending_delete_paths(storage)?;
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    // Memory can contain an unflushed deletion. Missing/invalid disk state proves nothing.
    // Unlike normal loading, recovery requires an explicit books list as commit evidence.
    #[derive(Deserialize)]
    struct PersistedLibrary {
        version: u32,
        books: Vec<StoredBook>,
    }
    let library_file = library_path(storage.root())?;
    let library: PersistedLibrary = serde_json::from_slice(&fs::read(&library_file).map_err(|error| {
        format!(
            "Cannot read {}; deferred deletes retained: {error}",
            library_file.display()
        )
    })?)
    .map_err(|error| format!("Invalid {}; deferred deletes retained: {error}", library_file.display()))?;
    let mut book_ids = HashSet::with_capacity(library.books.len());
    if library.version != LIBRARY_VERSION
        || library
            .books
            .iter()
            .any(|book| !is_valid_book_storage_id(&book.id) || !book_ids.insert(book.id.as_str()))
    {
        return Err("Unsupported or invalid library; deferred deletes retained".to_string());
    }

    let mut candidates: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut ambiguous_ids = HashSet::new();
    for path in paths {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        let name = name.strip_prefix(PENDING_DELETE_PREFIX).unwrap_or_default();
        let id = if let Some((id, suffix)) = name.rsplit_once('.') {
            if !suffix.is_empty()
                && suffix.bytes().all(|byte| byte.is_ascii_digit())
                && let Ok(index) = suffix.parse::<u64>()
                && let Some(next) = index.checked_add(1)
            {
                // Reserve names used by startup cleanup before new operations can allocate them.
                DELETE_SEQUENCE.fetch_max(next, std::sync::atomic::Ordering::Relaxed);
                is_valid_book_storage_id(id).then_some(id)
            } else {
                None
            }
        } else if is_valid_book_storage_id(name) {
            if let Some((base, suffix)) = name.rsplit_once('-')
                && !suffix.is_empty()
                && suffix.bytes().all(|byte| byte.is_ascii_digit())
            {
                // Legacy names cannot distinguish a numeric ID suffix from a collision suffix.
                ambiguous_ids.insert(name.to_string());
                ambiguous_ids.insert(base.to_string());
                None
            } else {
                // Recognize legacy hash IDs, or an exact ID still present in the library.
                (book_ids.contains(name) || (name.len() == 16 && name.bytes().all(|byte| byte.is_ascii_hexdigit())))
                    .then_some(name)
            }
        } else {
            None
        };
        if let Some(id) = id {
            candidates.entry(id.to_string()).or_default().push(path);
        } else {
            eprintln!(
                "Unrecognized or ambiguous deferred-delete path retained: {}",
                path.display()
            );
        }
    }

    let mut cleanup = Vec::new();
    for (id, paths) in candidates {
        if paths.len() != 1 || ambiguous_ids.contains(&id) {
            for path in paths {
                eprintln!("Conflicting deferred-delete path retained: {}", path.display());
            }
            continue;
        }
        let path = &paths[0];
        let original = storage.book_dir(&id);
        let result = (|| -> Result<(), String> {
            let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("Expected a book directory".to_string());
            }
            match fs::symlink_metadata(&original) {
                Ok(_) => return Err(format!("Destination already exists: {}", original.display())),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
            if book_ids.contains(id.as_str()) {
                fs::rename(path, &original).map_err(|error| error.to_string())?;
            } else {
                cleanup.push(path.clone());
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Deferred-delete path retained at {}: {error}", path.display());
        }
    }
    Ok(cleanup)
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
    let _import_guard = storage.lock_import()?;
    let pending_deletes = tasks.run_books_exclusive(&ids, TaskPriority::Critical, || {
        let _cache_flush_guard = storage
            .inner
            .derived_cache_flush_lock
            .lock()
            .map_err(|_| "derived cache flush lock poisoned".to_string())?;
        rename_books_for_deletion(storage, &ids)
    })?;
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
    match recover_pending_delete_paths(storage) {
        Ok(paths) => enqueue_pending_delete_cleanup(tasks, paths),
        Err(error) => eprintln!("Failed to recover deferred-delete paths: {error}"),
    }
}
