use super::*;

#[cfg(test)]
pub(super) fn ensure_book_package_path_with_unpacker(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
    unpacker: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    ensure_book_package_path_with(storage, tasks, book, move |storage, book| {
        publish_unpacked_book_package_with(storage, book, move |source_path, unpacked_dir| {
            unpacker(source_path, unpacked_dir)?;
            normalize_unpacked_epub_structure(unpacked_dir)
        })
    })
}

fn ensure_book_package_path_with(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
    materialize: impl FnOnce(&AppStorage, &StoredBook) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let started = Instant::now();
    if let Ok(opf_path) = find_unpacked_opf_path(&storage.book_dir(&book.id).join(UNPACKED_DIR)) {
        let mut fields = vec![
            ("book", book.id.clone()),
            ("cache", "hit".to_string()),
            (
                "search_memory_caches",
                storage.search_text_memory_cache_len().to_string(),
            ),
        ];
        fields.extend(tasks.diagnostic_fields());
        diagnostics::record_timing("book-materialize", started.elapsed(), &fields);
        return Ok(opf_path);
    }

    let key = book_materialize_task_key(book);
    let storage = storage.clone();
    let book = book.clone();
    let diagnostics_storage = storage.clone();
    let diagnostics_book_id = book.id.clone();
    let task_runner = tasks.clone();
    let result = tasks.get_or_run(key, TaskPriority::Foreground, move || {
        task_runner.run_book_exclusive(&book.id, TaskPriority::Foreground, || {
            task_runner.run_io_observed(storage.root(), book.size, TaskPriority::Foreground, || {
                materialize(&storage, &book)
            })
        })
    });
    if result.is_ok() {
        let mut fields = vec![
            ("book", diagnostics_book_id),
            ("cache", "miss".to_string()),
            (
                "search_memory_caches",
                diagnostics_storage.search_text_memory_cache_len().to_string(),
            ),
        ];
        fields.extend(tasks.diagnostic_fields());
        diagnostics::record_timing("book-materialize", started.elapsed(), &fields);
    }
    result
}

pub(super) fn ensure_book_package_path(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
) -> Result<PathBuf, String> {
    match book.source_format {
        BookSourceFormat::Epub => ensure_book_package_path_with(storage, tasks, book, publish_unpacked_book_package),
        BookSourceFormat::Txt => {
            ensure_book_package_path_with(storage, tasks, book, materialize_library_text_publication)
        }
    }
}

fn mode_switch_source_path(storage: &AppStorage, book: &StoredBook) -> PathBuf {
    match book.source_storage {
        SourceStorage::Managed => storage.book_dir(&book.id).join(BOOK_FILE),
        SourceStorage::Referenced => book.source_path.clone(),
    }
}

fn read_mode_switch_source(storage: &AppStorage, book: &StoredBook) -> (PathBuf, Option<(String, u64)>) {
    let path = mode_switch_source_path(storage, book);
    let source = fs::metadata(&path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .and_then(|metadata| hash_file(&path).ok().map(|hash| (hash, metadata.len())));
    (path, source)
}

fn mode_switch_conflict(book: &StoredBook, source: Option<&(String, u64)>) -> Option<BookModeSwitchConflict> {
    let source_matches = source.is_some_and(|(hash, _)| {
        (book.source_revision >= book.revision && hash == &book.source_hash)
            || (book.revision > book.source_revision
                && book.latest_export_revision == Some(book.revision)
                && book.latest_export_hash.as_ref() == Some(hash))
    });
    (!source_matches).then_some(if source.is_some() {
        BookModeSwitchConflict::Changed
    } else {
        BookModeSwitchConflict::Missing
    })
}

pub(super) fn check_book_content_mode_switch_impl(
    storage: &AppStorage,
    id: String,
    editable: bool,
) -> Result<Option<BookModeSwitchConflict>, String> {
    let book = storage.library_book(&id)?;
    if book.source_format != BookSourceFormat::Epub {
        return Err("TXT books do not support content mode switching".to_string());
    }
    if editable {
        if book.content_mode == BookContentMode::ArchiveOnly {
            return Err("Archive-only EPUBs cannot be unpacked".to_string());
        }
        return Ok(None);
    }
    if !book.editable {
        return Ok(None);
    }

    let (_, source) = read_mode_switch_source(storage, &book);
    Ok(mode_switch_conflict(&book, source.as_ref()))
}

fn replace_library_book(storage: &AppStorage, book: StoredBook) -> Result<BookRecord, String> {
    let previous = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let stored = state
            .library
            .books
            .iter_mut()
            .find(|stored| stored.id == book.id && stored.scope == BookScope::Library)
            .ok_or_else(|| "Book not found".to_string())?;
        let previous = stored.clone();
        *stored = book.clone();
        previous
    };
    storage.mark_library_dirty();
    if let Err(error) = storage.flush_content_dirty() {
        if let Ok(mut state) = storage.inner.state.lock()
            && let Some(stored) = state
                .library
                .books
                .iter_mut()
                .find(|stored| stored.id == previous.id && stored.scope == BookScope::Library)
        {
            *stored = previous;
            storage.mark_library_dirty();
        }
        return Err(error);
    }
    storage.compose_book(&book)
}

fn mode_switch_work_path(source: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Book source has no parent directory".to_string())?;
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Book source filename is invalid".to_string())?;
    Ok(parent.join(format!(
        ".{name}.flow-reader-{}-{}-{suffix}",
        std::process::id(),
        now_ms()
    )))
}

fn write_defined_epub_from_unpacked(
    storage: &AppStorage,
    book: &StoredBook,
    source_path: &Path,
    unpacked_dir: &Path,
) -> Result<(String, u64, Option<PathBuf>), String> {
    storage.release_archive_resource(&book.id);
    let output = mode_switch_work_path(source_path, "new")?;
    let backup = source_path
        .exists()
        .then(|| mode_switch_work_path(source_path, "backup"))
        .transpose()?;
    let write_result = if source_path.exists() {
        write_epub_from_original_and_unpacked(source_path, unpacked_dir, &output)
    } else {
        write_epub_from_unpacked_dir(unpacked_dir, &output, None)
    };
    if let Err(error) = write_result {
        let _ = fs::remove_file(&output);
        return Err(error);
    }
    let validated = (|| {
        inspect_epub_access(&output)?;
        Ok((
            hash_file(&output)?,
            fs::metadata(&output).map_err(|error| error.to_string())?.len(),
        ))
    })();
    let (hash, size) = match validated {
        Ok(validated) => validated,
        Err(error) => {
            let _ = fs::remove_file(&output);
            return Err(error);
        }
    };
    if let Some(backup) = &backup
        && let Err(error) = fs::rename(source_path, backup)
    {
        let _ = fs::remove_file(&output);
        return Err(error.to_string());
    }
    if let Err(error) = fs::rename(&output, source_path) {
        if let Some(backup) = &backup {
            let _ = fs::rename(backup, source_path);
        }
        let _ = fs::remove_file(&output);
        return Err(error.to_string());
    }
    Ok((hash, size, backup))
}

fn rollback_defined_epub(source_path: &Path, backup: Option<&Path>) {
    if let Some(backup) = backup {
        let _ = fs::remove_file(source_path);
        let _ = fs::rename(backup, source_path);
    } else {
        let _ = fs::remove_file(source_path);
    }
}

pub(super) fn switch_book_content_mode_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    id: String,
    editable: bool,
    resolution: Option<BookModeSwitchResolution>,
) -> Result<BookModeSwitchResult, String> {
    let book = storage.library_book(&id)?;
    if book.source_format != BookSourceFormat::Epub {
        return Err("TXT books do not support content mode switching".to_string());
    }
    if editable {
        if book.content_mode == BookContentMode::ArchiveOnly {
            return Err("Archive-only EPUBs cannot be unpacked".to_string());
        }
        if book.editable {
            return Ok(BookModeSwitchResult {
                book: Some(storage.compose_book(&book)?),
                conflict: None,
            });
        }
        ensure_book_package_path(storage, tasks, &book)?;
        let mut updated = storage.library_book(&id)?;
        updated.editable = true;
        updated.updated_at = Some(now_ms());
        let record = replace_library_book(storage, updated)?;
        storage.release_archive_resource(&id);
        return Ok(BookModeSwitchResult {
            book: Some(record),
            conflict: None,
        });
    }
    if !book.editable {
        return Ok(BookModeSwitchResult {
            book: Some(storage.compose_book(&book)?),
            conflict: None,
        });
    }

    let (source_path, source) = read_mode_switch_source(storage, &book);
    if let Some(conflict) = mode_switch_conflict(&book, source.as_ref()).filter(|_| resolution.is_none()) {
        return Ok(BookModeSwitchResult {
            book: None,
            conflict: Some(conflict),
        });
    }

    let unpacked_dir = storage.book_dir(&id).join(UNPACKED_DIR);
    let mut updated = book.clone();
    let mut source_backup = None;
    match resolution {
        Some(BookModeSwitchResolution::Overwrite) => {
            find_unpacked_opf_path(&unpacked_dir)?;
            let exported_revision = current_book_revision(&book);
            let (hash, size, backup) = write_defined_epub_from_unpacked(storage, &book, &source_path, &unpacked_dir)?;
            source_backup = backup;
            mark_book_exported(&mut updated, exported_revision, Some(hash.clone()));
            adopt_book_source_fields(&mut updated, hash, size)?;
        }
        Some(BookModeSwitchResolution::Adopt) => {
            let (hash, size) = source.ok_or_else(|| "Book source is unavailable".to_string())?;
            inspect_epub_access(&source_path)?;
            adopt_book_source_fields(&mut updated, hash, size)?;
        }
        None if book.revision > book.source_revision => {
            let (hash, size) = source.expect("matching source was checked");
            adopt_book_source_fields(&mut updated, hash, size)?;
        }
        None => {}
    }
    if updated.source_revision != book.source_revision
        && let Err(error) = remove_book_derived_cache_files(storage, &id)
    {
        rollback_defined_epub(&source_path, source_backup.as_deref());
        return Err(error);
    }
    updated.editable = false;
    updated.updated_at = Some(now_ms());

    let unpacked_backup = if unpacked_dir.exists() {
        let backup = mode_switch_work_path(&unpacked_dir, "backup")?;
        if let Err(error) = fs::rename(&unpacked_dir, &backup) {
            rollback_defined_epub(&source_path, source_backup.as_deref());
            return Err(error.to_string());
        }
        Some(backup)
    } else {
        None
    };
    let record = match replace_library_book(storage, updated) {
        Ok(record) => record,
        Err(error) => {
            if let Some(backup) = &unpacked_backup {
                let _ = fs::rename(backup, &unpacked_dir);
            }
            rollback_defined_epub(&source_path, source_backup.as_deref());
            return Err(error);
        }
    };
    if let Some(backup) = unpacked_backup {
        let _ = fs::remove_dir_all(backup);
    }
    if let Some(backup) = source_backup {
        let _ = fs::remove_file(backup);
    }
    storage.remove_derived_memory_caches(&id);
    Ok(BookModeSwitchResult {
        book: Some(record),
        conflict: None,
    })
}

pub(super) fn set_book_content_access(storage: &AppStorage, id: &str, mode: BookContentMode) -> Result<(), String> {
    let changed = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        let book = state
            .library
            .books
            .iter_mut()
            .find(|book| book.id == id)
            .ok_or_else(|| "Book not found".to_string())?;
        let editable = book.editable && mode != BookContentMode::ArchiveOnly;
        if book.content_mode == mode && book.editable == editable {
            false
        } else {
            book.content_mode = mode;
            book.editable = editable;
            true
        }
    };

    if changed {
        storage.mark_library_dirty();
        storage.flush_content_dirty()?;
    }

    Ok(())
}

pub(super) fn inspect_and_store_book_content_access(
    storage: &AppStorage,
    book: &StoredBook,
) -> Result<BookContentMode, String> {
    if book.content_mode == BookContentMode::ArchiveOnly {
        return Ok(BookContentMode::ArchiveOnly);
    }
    if book.source_format != BookSourceFormat::Epub {
        return Ok(BookContentMode::Normal);
    }

    let book_path = storage.book_dir(&book.id).join(BOOK_FILE);
    if !book_path.exists() {
        return Ok(BookContentMode::Normal);
    }

    let content_mode = inspect_epub_access(&book_path)?;
    set_book_content_access(storage, &book.id, content_mode)?;
    Ok(content_mode)
}

const BOOK_SOURCE_MISSING_ERROR: &str = "BOOK_SOURCE_MISSING";
const BOOK_SOURCE_UNREADABLE_ERROR: &str = "BOOK_SOURCE_UNREADABLE";

pub(super) fn source_path_status(path: Option<&Path>) -> BookSourceStatus {
    let Some(path) = path else {
        return BookSourceStatus::Missing;
    };
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => BookSourceStatus::Available,
        Ok(_) => BookSourceStatus::Unreadable,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BookSourceStatus::Missing,
        Err(_) => BookSourceStatus::Unreadable,
    }
}

pub(super) fn source_status_error(status: BookSourceStatus) -> Option<&'static str> {
    match status {
        BookSourceStatus::Available => None,
        BookSourceStatus::Missing => Some(BOOK_SOURCE_MISSING_ERROR),
        BookSourceStatus::Unreadable => Some(BOOK_SOURCE_UNREADABLE_ERROR),
    }
}

pub(super) fn available_book_source_path(storage: &AppStorage, book: &StoredBook) -> Result<PathBuf, String> {
    let path = match book.source_storage {
        SourceStorage::Managed => Some(storage.book_dir(&book.id).join(match book.source_format {
            BookSourceFormat::Epub => BOOK_FILE,
            BookSourceFormat::Txt => SOURCE_TEXT_FILE,
        })),
        SourceStorage::Referenced => Some(book.source_path.clone()),
    };
    let status = source_path_status(path.as_deref());
    if let Some(error) = source_status_error(status) {
        return Err(error.to_string());
    }
    let path = path.expect("available source status requires a file path");
    Ok(path)
}

pub(super) fn referenced_archive_source_status(book: &StoredBook) -> BookSourceStatus {
    source_path_status(Some(book.source_path.as_path()))
}

pub(super) fn check_book_source_statuses_impl(
    storage: &AppStorage,
    ids: Vec<String>,
) -> Result<Vec<BookSourceStatusRecord>, String> {
    let books = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        ids.into_iter()
            .filter_map(|id| {
                state
                    .library
                    .books
                    .iter()
                    .find(|book| book.id == id && book.scope == BookScope::Library)
                    .cloned()
            })
            .collect::<Vec<_>>()
    };

    Ok(books
        .into_iter()
        .filter(|book| {
            book.source_storage == SourceStorage::Referenced
                && book.source_format == BookSourceFormat::Epub
                && !book.editable
        })
        .map(|book| {
            let status = referenced_archive_source_status(&book);
            BookSourceStatusRecord { id: book.id, status }
        })
        .collect())
}

pub(super) fn get_book_reader_source_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
) -> Result<BookReaderSource, String> {
    let book_dir = storage.book_dir(&book.id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);
    let content_mode = inspect_and_store_book_content_access(storage, book)?;
    let reads_archive = book.source_format == BookSourceFormat::Epub
        && (!book.editable || content_mode == BookContentMode::ArchiveOnly);
    let (mode, source_path, root_path, updated_book) = if reads_archive {
        let book_path = available_book_source_path(storage, book)?;
        let current_book = storage.stored_book(&book.id)?;
        let updated_book = (current_book.content_mode != book.content_mode || current_book.editable != book.editable)
            .then(|| commands::get_book_impl(storage, book.id.clone()))
            .transpose()?
            .flatten();
        (BookReaderSourceMode::Epub, book_path, None, updated_book)
    } else {
        let opf_path = ensure_book_package_path(storage, tasks, book)?;
        if let Ok(opf_xml) = read_epub_xml_file(&opf_path, "EPUB package document") {
            deobfuscate_unpacked_idpf_fonts(&unpacked_dir, &opf_xml)?;
        }
        let current_book = storage.stored_book(&book.id)?;
        let updated_book = (current_book.source_revision != book.source_revision
            || current_book.revision != book.revision)
            .then(|| commands::get_book_impl(storage, book.id.clone()))
            .transpose()?
            .flatten();
        (BookReaderSourceMode::Opf, opf_path, Some(unpacked_dir), updated_book)
    };

    let archive_urls = (mode == BookReaderSourceMode::Epub)
        .then(|| storage.register_archive_resource(&book.id, &source_path))
        .transpose()?;

    let metrics_book = storage.stored_book(&book.id)?;
    let reading_metrics = super::reading_metrics::load_or_build_reading_metrics(
        storage,
        tasks,
        &book.id,
        metrics_book.source_revision,
        mode,
        root_path.as_deref(),
    )
    .inspect_err(|error| eprintln!("Failed to load reading metrics for {}: {error}", book.id))
    .ok();

    let (mode, path, root_path) = if let Some(urls) = archive_urls {
        (BookReaderSourceMode::Opf, urls.package, Some(urls.root))
    } else {
        (
            mode,
            path_to_client_string(&source_path),
            root_path.as_deref().map(path_to_client_string),
        )
    };

    Ok(BookReaderSource {
        mode,
        path,
        root_path,
        updated_book,
        reading_metrics,
    })
}

fn publish_unpacked_book_package(storage: &AppStorage, book: &StoredBook) -> Result<PathBuf, String> {
    publish_unpacked_book_package_with(storage, book, materialize_epub_package)
}

fn publish_unpacked_book_package_with(
    storage: &AppStorage,
    book: &StoredBook,
    materialize: impl FnOnce(&Path, &Path) -> Result<bool, String>,
) -> Result<PathBuf, String> {
    let book_dir = storage.book_dir(&book.id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);
    let book_path = available_book_source_path(storage, book)?;

    let temp_dir = unpack_temp_dir(&unpacked_dir);
    let _ = fs::remove_dir_all(&temp_dir);
    let publication_changed = materialize(&book_path, &temp_dir).inspect_err(|_| {
        let _ = fs::remove_dir_all(&temp_dir);
    })?;
    let temp_opf_path = match find_unpacked_opf_path(&temp_dir) {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(error);
        }
    };
    let opf_relative_path = temp_opf_path
        .strip_prefix(&temp_dir)
        .map_err(|error| error.to_string())?
        .to_path_buf();

    if !book_content_still_current(storage, book)? {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err("Unpacked package is stale".to_string());
    }

    if unpacked_dir.exists() {
        fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp_dir, &unpacked_dir).map_err(|error| error.to_string())?;

    if !book_content_still_current(storage, book)? {
        let _ = fs::remove_dir_all(&unpacked_dir);
        return Err("Unpacked package is stale".to_string());
    }

    if publication_changed {
        storage.remove_derived_memory_caches(&book.id);
        remove_book_derived_cache_files(storage, &book.id)?;
        if mark_library_book_content_updated(storage, &book.id)?.is_some() {
            storage.flush_content_dirty()?;
        }
    }

    Ok(unpacked_dir.join(opf_relative_path))
}

fn book_materialize_task_key(book: &StoredBook) -> TaskKey {
    TaskKey::new(
        TaskKind::BookMaterialize,
        format!("{}:{}:{}", book.id, book.source_revision, book.revision),
    )
}

fn unpack_temp_dir(unpacked_dir: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let name = unpacked_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unpacked");
    unpacked_dir.with_file_name(format!("{name}.tmp-{}-{nonce}", std::process::id()))
}

fn book_content_still_current(storage: &AppStorage, book: &StoredBook) -> Result<bool, String> {
    let current = storage.stored_book(&book.id)?;
    Ok(current.source_revision == book.source_revision && current.revision == book.revision)
}
