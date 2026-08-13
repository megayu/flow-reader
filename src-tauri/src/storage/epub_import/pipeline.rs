//! EPUB import and external-open workflow orchestration.

use super::*;

pub(super) fn epub_import_temp_path(root: &Path, name: &str) -> PathBuf {
    import_work_path(root, "import", name)
}

pub(super) fn copy_epub_and_hash(source: &Path, target: &Path) -> Result<String, String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut input = BufReader::new(fs::File::open(source).map_err(|error| error.to_string())?);
    let mut output = BufWriter::new(fs::File::create(target).map_err(|error| error.to_string())?);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];

    loop {
        let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
    }
    output.flush().map_err(|error| error.to_string())?;

    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) fn remove_epub_import_temp(path: &Path) {
    if let Err(error) = fs::remove_file(path)
        && path.exists()
    {
        eprintln!("Failed to remove temporary EPUB import file: {error}");
    }
}

pub(in crate::storage) fn materialize_epub_package(source_path: &Path, unpacked_dir: &Path) -> Result<bool, String> {
    unpack_epub(source_path, unpacked_dir)?;
    let mut changed = normalize_unpacked_epub_structure(unpacked_dir)?;
    if let Some((archive_path, data)) = read_epub_cover_png_repair(source_path)? {
        fs::write(unpacked_resource_path(unpacked_dir, &archive_path), data).map_err(|error| error.to_string())?;
        changed = true;
    }
    Ok(changed)
}

pub(in crate::storage) struct PreparedEpubImport {
    source_path: PathBuf,
    source_storage: SourceStorage,
    size: u64,
    name: String,
    inspection: Option<(ParsedEpubInfo, BookContentMode)>,
    temp_path: PathBuf,
    hash: String,
}

fn epub_import_requires_inspection(
    storage: &AppStorage,
    import_index: Option<&LibraryBookLookupIndex>,
    source_path: &Path,
    hash: &str,
) -> Result<bool, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(matches!(
        existing_book_import(import_index, &state.library.books, source_path, hash),
        None | Some(ExistingBookImport::ReplaceContent(_))
    ))
}

pub(in crate::storage) fn prepare_epub_import(
    storage: &AppStorage,
    import_index: &LibraryBookLookupIndex,
    path: &Path,
) -> Result<PreparedEpubImport, String> {
    let books_root = books_root(storage.root());
    fs::create_dir_all(&books_root).map_err(|error| error.to_string())?;
    let source_path = path.to_path_buf();
    let source_storage = storage.import_source_storage();
    let size = fs::metadata(&source_path).map_err(|error| error.to_string())?.len();
    let name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.epub".to_string());
    let temp_path = epub_import_temp_path(&books_root, &name);

    let result = (|| {
        let hash = if source_storage == SourceStorage::Managed {
            copy_epub_and_hash(&source_path, &temp_path)?
        } else {
            hash_file(&source_path)?
        };
        let inspection = if epub_import_requires_inspection(storage, Some(import_index), &source_path, &hash)? {
            let inspected_path = if source_storage == SourceStorage::Managed {
                temp_path.as_path()
            } else {
                source_path.as_path()
            };
            Some(inspect_epub_info(inspected_path)?)
        } else {
            None
        };
        Ok(PreparedEpubImport {
            source_path,
            source_storage,
            size,
            name,
            inspection,
            temp_path: temp_path.clone(),
            hash,
        })
    })();

    if result.is_err() {
        remove_epub_import_temp(&temp_path);
    }
    result
}

pub(in crate::storage) fn commit_prepared_epub_import(
    storage: &AppStorage,
    prepared: PreparedEpubImport,
    mut import_index: Option<&mut LibraryBookLookupIndex>,
) -> Result<Option<(BookRecord, ImportFinalizer)>, String> {
    let _import_guard = storage
        .inner
        .import_lock
        .lock()
        .map_err(|_| "storage import lock poisoned".to_string())?;
    let PreparedEpubImport {
        source_path,
        source_storage,
        size,
        name,
        mut inspection,
        temp_path,
        hash,
    } = prepared;

    if inspection.is_none() && epub_import_requires_inspection(storage, import_index.as_deref(), &source_path, &hash)? {
        let inspected_path = if source_storage == SourceStorage::Managed {
            temp_path.as_path()
        } else {
            source_path.as_path()
        };
        inspection = Some(inspect_epub_info(inspected_path)?);
    }

    struct ExternalPromotion {
        book: ExternalBook,
    }

    let mut file_transaction = None;
    let result = (|| -> Result<Option<(BookRecord, ImportFinalizer)>, String> {
        let (mut book, id, refresh_content, is_new, external_promotion) = {
            let state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let existing = existing_book_import(import_index.as_deref(), &state.library.books, &source_path, &hash);
            let external_promotion = state
                .external
                .books
                .iter()
                .find(|book| !book.content_hash.is_empty() && book.content_hash == hash)
                .cloned()
                .map(|book| ExternalPromotion { book });

            if let Some(ExistingBookImport::SameContent(index)) = existing {
                let mut book = state.library.books[index].clone();
                let source_changed = book.name != name || book.source_path.as_ref() != Some(&source_path);
                book.name = name.clone();
                book.size = size;
                book.source_path = Some(source_path.clone());
                if source_changed {
                    book.updated_at = Some(now_ms());
                }
                let id = book.id.clone();
                (book, id, false, false, external_promotion)
            } else if let Some(ExistingBookImport::ReplaceContent(index)) = existing {
                let (parsed, content_mode) = inspection
                    .as_ref()
                    .ok_or_else(|| "EPUB inspection is unavailable for changed content".to_string())?;
                let mut book = state.library.books[index].clone();
                book.name = name.clone();
                book.size = size;
                book.content_hash = hash.clone();
                book.content_version = book.content_version.saturating_add(1).max(1);
                book.generated_cover = parsed.generated_cover;
                book.content_mode = *content_mode;
                book.source_storage = source_storage;
                book.source_path = Some(source_path.clone());
                book.updated_at = Some(now_ms());
                book.content_edited_at = None;
                let id = book.id.clone();
                (book, id, true, false, external_promotion)
            } else if matches!(existing, Some(ExistingBookImport::Skip)) {
                return Ok(None);
            } else {
                let (parsed, content_mode) = inspection
                    .as_ref()
                    .ok_or_else(|| "EPUB inspection is unavailable for new content".to_string())?;
                let created_at = now_ms();
                let id = id_from_hash(&hash);
                let book = LibraryBook {
                    id: id.clone(),
                    name: name.clone(),
                    size,
                    reading_status: None,
                    source_format: BookSourceFormat::Epub,
                    generated_cover: parsed.generated_cover,
                    content_edited_at: None,
                    content_hash: hash.clone(),
                    content_version: 1,
                    content_mode: *content_mode,
                    source_storage,
                    source_path: Some(source_path.clone()),
                    metadata: empty_object(),
                    created_at,
                    updated_at: None,
                    last_read_at: None,
                    cfi: None,
                    percentage: None,
                    tag_ids: Vec::new(),
                };
                (book, id, true, true, external_promotion)
            }
        };
        let normalize_new_cover = refresh_content && is_new;
        let mut publication_changed = false;

        let promotion = external_promotion
            .map(|promotion| {
                let external_dir = storage.external_book_dir(&promotion.book.id);
                let state: BookState = read_json_or_default(&external_dir.join(STATE_FILE))?;
                Ok::<_, String>((promotion.book, state))
            })
            .transpose()?;
        let promoted_metadata = promotion.as_ref().map(|(book, _)| book.metadata.clone());
        let imported_metadata = inspection
            .as_ref()
            .map(|(parsed, _)| parsed.metadata.clone())
            .unwrap_or_else(empty_object);

        if refresh_content {
            let (parsed, content_mode) = inspection
                .take()
                .ok_or_else(|| "EPUB inspection is unavailable for imported content".to_string())?;
            storage.remove_derived_memory_caches(&id);
            file_transaction = Some(ImportFileTransaction::begin(storage, &id)?);
            let dir = storage.book_dir(&id);
            let book_path = dir.join(BOOK_FILE);
            let unpacked_dir = dir.join(UNPACKED_DIR);
            let package_path = if source_storage == SourceStorage::Managed {
                fs::rename(&temp_path, &book_path).map_err(|error| error.to_string())?;
                book_path.as_path()
            } else {
                source_path.as_path()
            };
            let mut cover = parsed.cover;
            if normalize_new_cover && content_mode == BookContentMode::Normal {
                normalize_epub_cover_png(&mut cover);
            }
            if eager_import_materialization_enabled() && content_mode == BookContentMode::Normal {
                publication_changed |= materialize_epub_package(package_path, &unpacked_dir)?;
            }
            write_cover(storage, &id, cover.map(|cover| cover.input))?;
        } else {
            remove_epub_import_temp(&temp_path);
        }

        if is_new {
            let metadata = promoted_metadata
                .filter(|metadata| *metadata != json!({}))
                .or_else(|| (imported_metadata != json!({})).then_some(imported_metadata));
            if let Some(metadata) = metadata {
                book.metadata = metadata;
            }
        }

        let promotion = promotion.map(|(external_book, external_state)| {
            let external_id = external_book.id.clone();
            let last_opened_at = external_book.last_opened_at;
            book.cfi = external_state.cfi.clone();
            book.percentage = external_state.percentage;
            book.last_read_at = Some(last_opened_at);
            book.updated_at = Some(now_ms());
            (external_id, external_state)
        });

        if publication_changed {
            let now = now_ms();
            book.content_version = book.content_version.saturating_add(1).max(1);
            book.content_edited_at = Some(now);
            book.content_hash = edited_book_content_hash(&book.id, book.content_version, now);
            book.updated_at = Some(now);
        }

        let stored_index = {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let stored_index = if is_new {
                if state.library.books.iter().any(|stored| stored.id == id)
                    || existing_book_import(None, &state.library.books, &source_path, &hash).is_some()
                {
                    return Err("Library changed while the book was being imported".to_string());
                }
                state.library.books.push(book.clone());
                state.library.books.len() - 1
            } else {
                let stored_index = state
                    .library
                    .books
                    .iter()
                    .position(|stored| stored.id == id)
                    .ok_or_else(|| "Book was removed while it was being imported".to_string())?;
                let stored = &mut state.library.books[stored_index];
                book.reading_status = stored.reading_status.clone();
                book.cfi = promotion
                    .as_ref()
                    .map_or_else(|| stored.cfi.clone(), |_| book.cfi.clone());
                book.percentage = promotion.as_ref().map_or(stored.percentage, |_| book.percentage);
                book.tag_ids = stored.tag_ids.clone();
                *stored = book.clone();
                stored_index
            };
            if let Some((external_id, _)) = &promotion {
                state.external.books.retain(|stored| stored.id != *external_id);
            }
            stored_index
        };
        if let Some((_, external_state)) = &promotion {
            storage.write_book_state(&id, external_state)?;
        }
        if let Some(index) = import_index.as_deref_mut() {
            index.remember(stored_index, &book);
        }
        let record = storage.compose_book(&book)?;

        storage.mark_library_dirty();
        if let Some((external_id, _)) = &promotion {
            storage.remove_derived_memory_caches(external_id);
            storage.mark_external_dirty();
        }
        let mut finalizer = ImportFinalizer::new(file_transaction.take());
        if let Some((external_id, _)) = promotion {
            finalizer = finalizer.with_cleanup_path(storage.external_book_dir(&external_id));
        }
        Ok(Some((record, finalizer)))
    })();

    if result.as_ref().is_ok_and(Option::is_none) {
        remove_epub_import_temp(&temp_path);
    }
    if result.is_err() {
        remove_epub_import_temp(&temp_path);
        if let Some(transaction) = file_transaction
            && let Err(error) = transaction.rollback()
        {
            eprintln!("Failed to roll back EPUB import files: {error}");
        }
    }

    result
}

pub(in crate::storage) fn open_external_epub_path_impl(
    storage: &AppStorage,
    path: &Path,
) -> Result<BookRecord, String> {
    if let Some(book) = managed_library_book_for_epub_path(storage, path)? {
        return Ok(book);
    }

    let external_root = external_books_root(storage.root());
    fs::create_dir_all(&external_root).map_err(|error| error.to_string())?;

    let source_path = path.to_path_buf();
    let size = fs::metadata(&source_path).map_err(|error| error.to_string())?.len();
    let name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.epub".to_string());
    let (parsed, content_mode) = inspect_epub_info(&source_path)?;
    let hash = hash_file(&source_path)?;

    // These values move once through open control flow; boxing would add avoidable allocations.
    #[allow(clippy::large_enum_variant)]
    enum OpenDecision {
        Library(BookRecord),
        External(ExternalBook),
    }

    (|| -> Result<BookRecord, String> {
        let decision = {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;

            if let Some(book) = state
                .library
                .books
                .iter()
                .find(|book| !book.content_hash.is_empty() && book.content_hash == hash)
                .cloned()
            {
                OpenDecision::Library(storage.compose_book(&book)?)
            } else if let Some(index) = state
                .external
                .books
                .iter()
                .position(|book| !book.content_hash.is_empty() && book.content_hash == hash)
            {
                let book = &mut state.external.books[index];
                book.name = name.clone();
                book.size = size;
                book.content_mode = content_mode;
                book.content_version = book.content_version.max(1);
                book.generated_cover = parsed.generated_cover;
                book.source_storage = SourceStorage::Referenced;
                book.source_path = Some(source_path.clone());
                book.last_opened_at = now_ms();
                if parsed.metadata != json!({}) {
                    book.metadata = parsed.metadata.clone();
                }
                OpenDecision::External(book.clone())
            } else {
                let now = now_ms();
                let id = format!("ext-{}", id_from_hash(&hash));
                let book = ExternalBook {
                    id,
                    name: name.clone(),
                    size,
                    content_hash: hash.clone(),
                    content_version: 1,
                    generated_cover: parsed.generated_cover,
                    content_mode,
                    source_storage: SourceStorage::Referenced,
                    source_path: Some(source_path.clone()),
                    metadata: parsed.metadata.clone(),
                    created_at: now,
                    last_opened_at: now,
                };
                state.external.books.push(book.clone());
                OpenDecision::External(book)
            }
        };

        let book = match decision {
            OpenDecision::Library(book) => {
                return Ok(book);
            }
            OpenDecision::External(book) => book,
        };

        let dir = storage.external_book_dir(&book.id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let book_path = dir.join(BOOK_FILE);
        let unpacked_dir = dir.join(UNPACKED_DIR);
        if unpacked_dir.exists() {
            fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
        }
        if book_path.exists() {
            fs::remove_file(&book_path).map_err(|error| error.to_string())?;
        }
        if content_mode == BookContentMode::Normal {
            unpack_epub(&source_path, &unpacked_dir)?;
            normalize_unpacked_epub_structure(&unpacked_dir)?;
        }
        storage.mark_external_dirty();
        storage.flush_content_dirty()?;

        let book = storage.external_to_library_book(&book);
        storage.compose_book(&book)
    })()
}

pub(super) fn managed_library_book_for_epub_path(
    storage: &AppStorage,
    path: &Path,
) -> Result<Option<BookRecord>, String> {
    let Ok(path) = fs::canonicalize(path) else {
        return Ok(None);
    };
    if !path.is_file() || !is_epub_file(&path) {
        return Ok(None);
    }
    let Ok(root) = fs::canonicalize(books_root(storage.root())) else {
        return Ok(None);
    };
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(None);
    };
    let mut components = relative.components();
    let Some(id) = components.next() else {
        return Ok(None);
    };
    let Some(filename) = components.next() else {
        return Ok(None);
    };
    if components.next().is_some() || filename.as_os_str() != BOOK_FILE {
        return Ok(None);
    }
    let Some(id) = id.as_os_str().to_str() else {
        return Ok(None);
    };

    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    let Some(book) = state.library.books.iter().find(|book| book.id == id).cloned() else {
        return Ok(None);
    };

    storage.compose_book(&book).map(Some)
}
