use super::*;

pub(super) fn ensure_book_package_path_with_unpacker(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &LibraryBook,
    unpacker: impl FnOnce(&Path, &Path) -> Result<(), String>,
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
        diagnostics::record_timing("epub-unpack", started.elapsed(), &fields);
        return Ok(opf_path);
    }

    let key = unpack_epub_task_key(book);
    let storage = storage.clone();
    let book = book.clone();
    let diagnostics_storage = storage.clone();
    let diagnostics_book_id = book.id.clone();
    let task_runner = tasks.clone();
    let result = tasks.get_or_run(key, TaskPriority::Foreground, move || {
        task_runner.run_book_exclusive(&book.id, TaskPriority::Foreground, || {
            task_runner.run_io_observed(storage.root(), book.size, TaskPriority::Foreground, || {
                publish_unpacked_book_package(&storage, &book, unpacker)
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
        diagnostics::record_timing("epub-unpack", started.elapsed(), &fields);
    }
    result
}

pub(super) fn ensure_book_package_path(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &LibraryBook,
) -> Result<PathBuf, String> {
    ensure_book_package_path_with_unpacker(storage, tasks, book, unpack_epub)
}

pub(super) fn set_book_content_access(
    storage: &AppStorage,
    id: &str,
    mode: BookContentMode,
    flags: Vec<BookContentFlag>,
) -> Result<(), String> {
    let (changed, external) = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        if let Some(book) = state.library.books.iter_mut().find(|book| book.id == id) {
            if book.content_mode == mode && book.content_flags == flags {
                (false, false)
            } else {
                book.content_mode = mode;
                book.content_flags = flags;
                (true, false)
            }
        } else if let Some(book) = state.external.books.iter_mut().find(|book| book.id == id) {
            if book.content_mode == mode && book.content_flags == flags {
                (false, true)
            } else {
                book.content_mode = mode;
                book.content_flags = flags;
                (true, true)
            }
        } else {
            return Err("Book not found".to_string());
        }
    };

    if changed {
        if external {
            storage.mark_external_dirty();
        } else {
            storage.mark_library_dirty();
        }
        storage.flush_dirty()?;
    }

    Ok(())
}

pub(super) fn inspect_and_store_book_content_access(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<BookContentMode, String> {
    if book.content_mode == BookContentMode::ArchiveOnly {
        return Ok(BookContentMode::ArchiveOnly);
    }
    if storage.book_source_format(book) != BookSourceFormat::Epub {
        return Ok(BookContentMode::Normal);
    }

    let book_path = storage.book_dir(&book.id).join(BOOK_FILE);
    if !book_path.exists() {
        return Ok(BookContentMode::Normal);
    }

    let access = inspect_epub_access(&book_path)?;
    set_book_content_access(storage, &book.id, access.mode, access.flags)?;
    Ok(access.mode)
}

pub(super) fn book_original_source_path(storage: &AppStorage, book: &LibraryBook) -> Option<PathBuf> {
    match book.source_storage {
        SourceStorage::Managed => Some(storage.book_dir(&book.id).join(BOOK_FILE)),
        SourceStorage::Referenced => book.source_path.clone(),
    }
}

const BOOK_SOURCE_MISSING_ERROR: &str = "BOOK_SOURCE_MISSING";
const BOOK_SOURCE_UNREADABLE_ERROR: &str = "BOOK_SOURCE_UNREADABLE";
const BOOK_SOURCE_CHANGED_ERROR: &str = "BOOK_SOURCE_CHANGED";

pub(super) fn source_path_status(path: Option<&Path>, expected_source: Option<(u64, &str)>) -> BookSourceStatus {
    let Some(path) = path else {
        return BookSourceStatus::Missing;
    };
    let metadata = match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return BookSourceStatus::Unreadable,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return BookSourceStatus::Missing;
        }
        Err(_) => return BookSourceStatus::Unreadable,
    };
    let Some((expected_size, expected_hash)) = expected_source else {
        return BookSourceStatus::Available;
    };
    if metadata.len() != expected_size {
        return BookSourceStatus::Changed;
    }
    match hash_file(path) {
        Ok(hash) if expected_hash.is_empty() || hash == expected_hash => BookSourceStatus::Available,
        Ok(_) => BookSourceStatus::Changed,
        Err(_) => BookSourceStatus::Unreadable,
    }
}

pub(super) fn source_status_error(status: BookSourceStatus) -> Option<&'static str> {
    match status {
        BookSourceStatus::Available => None,
        BookSourceStatus::Changed => Some(BOOK_SOURCE_CHANGED_ERROR),
        BookSourceStatus::Missing => Some(BOOK_SOURCE_MISSING_ERROR),
        BookSourceStatus::Unreadable => Some(BOOK_SOURCE_UNREADABLE_ERROR),
    }
}

pub(super) fn archive_only_source_path(storage: &AppStorage, book: &LibraryBook) -> Result<PathBuf, String> {
    let path = book_original_source_path(storage, book);
    let expected_source =
        (book.source_storage == SourceStorage::Referenced).then_some((book.size, book.content_hash.as_str()));
    let status = source_path_status(path.as_deref(), expected_source);
    if let Some(error) = source_status_error(status) {
        return Err(error.to_string());
    }
    let path = path.expect("available source status requires a file path");
    Ok(path)
}

pub(super) fn referenced_archive_source_status(book: &LibraryBook) -> BookSourceStatus {
    source_path_status(
        book.source_path.as_deref(),
        Some((book.size, book.content_hash.as_str())),
    )
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
            .filter_map(|id| state.library.books.iter().find(|book| book.id == id).cloned())
            .collect::<Vec<_>>()
    };

    Ok(books
        .into_iter()
        .filter(|book| {
            book.source_storage == SourceStorage::Referenced && book.content_mode == BookContentMode::ArchiveOnly
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
    book: &LibraryBook,
) -> Result<BookReaderSource, String> {
    let book_dir = storage.book_dir(&book.id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);
    if let Ok(opf_path) = find_unpacked_opf_path(&unpacked_dir) {
        if let Ok(opf_xml) = fs::read_to_string(&opf_path) {
            deobfuscate_unpacked_idpf_fonts(&unpacked_dir, &opf_xml)?;
        }
        return Ok(BookReaderSource {
            mode: BookReaderSourceMode::Opf,
            path: path_to_client_string(&opf_path),
            root_path: Some(path_to_client_string(&unpacked_dir)),
            book: None,
        });
    }

    if inspect_and_store_book_content_access(storage, book)? == BookContentMode::ArchiveOnly {
        let book_path = archive_only_source_path(storage, book)?;
        return Ok(BookReaderSource {
            mode: BookReaderSourceMode::Epub,
            path: path_to_client_string(&book_path),
            root_path: None,
            book: None,
        });
    }

    let opf_path = ensure_book_package_path(storage, tasks, book)?;
    let current_book = storage.library_book(&book.id)?;
    let updated_book = (current_book.content_version != book.content_version
        || current_book.content_hash != book.content_hash)
        .then(|| commands::get_book_impl(storage, book.id.clone()))
        .transpose()?
        .flatten();
    Ok(BookReaderSource {
        mode: BookReaderSourceMode::Opf,
        path: path_to_client_string(&opf_path),
        root_path: Some(path_to_client_string(&unpacked_dir)),
        book: updated_book,
    })
}

pub(super) fn publish_unpacked_book_package(
    storage: &AppStorage,
    book: &LibraryBook,
    unpacker: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let book_dir = storage.book_dir(&book.id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);

    if let Ok(opf_path) = find_unpacked_opf_path(&unpacked_dir) {
        return Ok(opf_path);
    }

    let book_path = book_dir.join(BOOK_FILE);
    if !book_path.exists() {
        return Err("Book package is unavailable".to_string());
    }

    let temp_dir = unpack_temp_dir(&unpacked_dir);
    let _ = fs::remove_dir_all(&temp_dir);
    if let Err(error) = unpacker(&book_path, &temp_dir) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(error);
    }
    let normalized = normalize_unpacked_epub_structure(&temp_dir)?;

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

    if normalized && mark_library_book_content_updated(storage, &book.id)?.is_some() {
        storage.flush_dirty()?;
    }

    Ok(unpacked_dir.join(opf_relative_path))
}

pub(super) fn unpack_epub_task_key(book: &LibraryBook) -> TaskKey {
    TaskKey::new(
        TaskKind::EpubUnpack,
        format!("{}:{}:{}", book.id, book.content_hash, book.content_version),
    )
}

pub(super) fn unpack_temp_dir(unpacked_dir: &Path) -> PathBuf {
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

pub(super) fn book_content_still_current(storage: &AppStorage, book: &LibraryBook) -> Result<bool, String> {
    let current = storage.library_book(&book.id)?;
    Ok(current.content_hash == book.content_hash && current.content_version == book.content_version)
}
