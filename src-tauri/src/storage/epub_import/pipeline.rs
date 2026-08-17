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

struct ManagedSourceReplacement {
    target: PathBuf,
    backup: Option<PathBuf>,
}

impl ManagedSourceReplacement {
    fn replace(temp: &Path, target: PathBuf) -> Result<Self, String> {
        let backup = target
            .exists()
            .then(|| {
                let parent = target
                    .parent()
                    .ok_or_else(|| "Managed EPUB source has no parent".to_string())?;
                let name = target.file_name().and_then(|name| name.to_str()).unwrap_or(BOOK_FILE);
                Ok::<_, String>(import_work_path(parent, "source-backup", name))
            })
            .transpose()?;
        if let Some(backup) = &backup {
            fs::rename(&target, backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(temp, &target) {
            if let Some(backup) = &backup
                && let Err(restore_error) = fs::rename(backup, &target)
            {
                return Err(format!(
                    "{error}; failed to restore managed EPUB source: {restore_error}"
                ));
            }
            return Err(error.to_string());
        }
        Ok(Self { target, backup })
    }

    fn rollback(self) -> Result<(), String> {
        if self.target.exists() {
            fs::remove_file(&self.target).map_err(|error| error.to_string())?;
        }
        if let Some(backup) = self.backup {
            fs::rename(backup, self.target).map_err(|error| error.to_string())?;
        }
        Ok(())
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
    import_index: Option<&BookImportLookupIndex>,
    source_path: &Path,
    hash: &str,
) -> Result<bool, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(
        match existing_book_import(import_index, &state.library.books, source_path, hash) {
            Some(ExistingBookImport::ReplaceContent(_)) => true,
            Some(_) => false,
            None => true,
        },
    )
}

fn external_book_for_hash(
    import_index: Option<&BookImportLookupIndex>,
    books: &[StoredBook],
    hash: &str,
) -> Option<StoredBook> {
    import_index
        .and_then(|index| index.external_book(hash).cloned())
        .or_else(|| {
            books
                .iter()
                .find(|book| book.scope == BookScope::External && book.source_hash == hash)
                .cloned()
        })
}

pub(in crate::storage) fn prepare_epub_import(
    storage: &AppStorage,
    import_index: &BookImportLookupIndex,
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
    mut import_index: Option<&mut BookImportLookupIndex>,
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

    let mut file_transaction = None;
    let mut promoted_managed_source = None;
    let mut managed_source_replacement = None;
    let default_editable = storage.default_epub_editable();
    let result = (|| -> Result<Option<(BookRecord, ImportFinalizer)>, String> {
        if inspection.is_none()
            && epub_import_requires_inspection(storage, import_index.as_deref(), &source_path, &hash)?
        {
            let inspected_path = if source_storage == SourceStorage::Managed {
                temp_path.as_path()
            } else {
                source_path.as_path()
            };
            inspection = Some(inspect_epub_info(inspected_path)?);
        }

        let (mut book, id, refresh_content, adopt_source_only, is_new, external_promotion) = {
            let state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let existing = existing_book_import(import_index.as_deref(), &state.library.books, &source_path, &hash);
            let external_promotion = existing
                .is_none()
                .then(|| external_book_for_hash(import_index.as_deref(), &state.library.books, &hash))
                .flatten();

            if let Some(ExistingBookImport::SameContent(index)) = existing {
                let mut book = state.library.books[index].clone();
                let source_changed = book.name != name || book.source_path != source_path;
                book.name = name.clone();
                book.size = size;
                book.source_path = source_path.clone();
                if source_changed {
                    book.updated_at = Some(now_ms());
                }
                let id = book.id.clone();
                (book, id, false, false, false, external_promotion)
            } else if let Some(ExistingBookImport::AdoptSource(index)) = existing {
                let mut book = state.library.books[index].clone();
                book.name = name.clone();
                adopt_book_source_fields(&mut book, hash.clone(), size)?;
                book.source_storage = source_storage;
                book.source_path = source_path.clone();
                book.updated_at = Some(now_ms());
                let id = book.id.clone();
                (book, id, false, true, false, external_promotion)
            } else if let Some(ExistingBookImport::ReplaceContent(index)) = existing {
                let (parsed, content_mode) = inspection
                    .as_ref()
                    .ok_or_else(|| "EPUB inspection is unavailable for changed content".to_string())?;
                let mut book = state.library.books[index].clone();
                book.name = name.clone();
                adopt_book_source_fields(&mut book, hash.clone(), size)?;
                book.generated_cover = parsed.generated_cover;
                book.content_mode = *content_mode;
                if *content_mode == BookContentMode::ArchiveOnly {
                    book.editable = false;
                }
                book.source_storage = source_storage;
                book.source_path = source_path.clone();
                book.updated_at = Some(now_ms());
                let id = book.id.clone();
                (book, id, true, false, false, external_promotion)
            } else if matches!(existing, Some(ExistingBookImport::Skip)) {
                return Ok(None);
            } else {
                let id = id_from_hash(&hash);
                let now = now_ms();
                let book = if let Some(mut book) = external_promotion.clone() {
                    let (_, content_mode) = inspection
                        .as_ref()
                        .ok_or_else(|| "EPUB inspection is unavailable for external promotion".to_string())?;
                    book.scope = BookScope::Library;
                    book.name = name.clone();
                    book.size = size;
                    book.content_mode = *content_mode;
                    book.editable = *content_mode == BookContentMode::Normal && default_editable;
                    book.source_storage = source_storage;
                    book.source_path = source_path.clone();
                    book.created_at = now;
                    book.updated_at = Some(now);
                    book
                } else {
                    let (parsed, content_mode) = inspection
                        .as_ref()
                        .ok_or_else(|| "EPUB inspection is unavailable for new content".to_string())?;
                    StoredBook {
                        id: id.clone(),
                        scope: BookScope::Library,
                        name: name.clone(),
                        size,
                        reading_status: None,
                        source_format: BookSourceFormat::Epub,
                        generated_cover: parsed.generated_cover,
                        content_edited_at: None,
                        source_hash: hash.clone(),
                        source_revision: 1,
                        revision: 1,
                        latest_export_revision: None,
                        latest_export_hash: None,
                        content_mode: *content_mode,
                        editable: *content_mode == BookContentMode::Normal && default_editable,
                        source_storage,
                        source_path: source_path.clone(),
                        metadata: parsed.metadata.clone(),
                        created_at: now,
                        updated_at: None,
                        last_read_at: None,
                        cfi: None,
                        percentage: None,
                        tag_ids: Vec::new(),
                    }
                };
                let refresh_content = external_promotion.is_none();
                (book, id, refresh_content, false, true, external_promotion)
            }
        };
        let normalize_new_cover = refresh_content && is_new;
        let mut publication_changed = false;

        if let Some(book) = &external_promotion {
            storage.read_book_state(&book.id)?;
        }
        if external_promotion.is_some() {
            if source_storage == SourceStorage::Managed {
                let managed_source = storage.book_dir(&id).join(BOOK_FILE);
                if managed_source.exists() {
                    fs::remove_file(&managed_source).map_err(|error| error.to_string())?;
                }
                fs::rename(&temp_path, &managed_source).map_err(|error| error.to_string())?;
                promoted_managed_source = Some(managed_source);
            } else {
                remove_epub_import_temp(&temp_path);
            }
        } else if adopt_source_only {
            storage.remove_derived_memory_caches(&id);
            remove_book_derived_cache_files(storage, &id)?;
            if source_storage == SourceStorage::Managed {
                let book_path = storage.book_dir(&id).join(BOOK_FILE);
                managed_source_replacement = Some(ManagedSourceReplacement::replace(&temp_path, book_path)?);
            } else {
                remove_epub_import_temp(&temp_path);
            }
        } else if refresh_content {
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
            if eager_import_materialization_enabled() && book.editable && content_mode == BookContentMode::Normal {
                publication_changed |= materialize_epub_package(package_path, &unpacked_dir)?;
            }
            write_cover(storage, &id, cover.map(|cover| cover.input))?;
        } else {
            remove_epub_import_temp(&temp_path);
        }

        if publication_changed {
            let now = now_ms();
            mark_book_content_updated_fields(&mut book, now)?;
            book.updated_at = Some(now);
        }

        let stored_index = {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            if external_promotion.is_some() {
                let stored_index = state
                    .library
                    .books
                    .iter()
                    .position(|stored| stored.id == id && stored.scope == BookScope::External)
                    .ok_or_else(|| "External book changed while it was being added to the library".to_string())?;
                state.library.books[stored_index] = book.clone();
                stored_index
            } else if is_new {
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
                book.cfi = stored.cfi.clone();
                book.percentage = stored.percentage;
                book.tag_ids = stored.tag_ids.clone();
                *stored = book.clone();
                stored_index
            }
        };
        if let Some(index) = import_index.as_deref_mut() {
            index.remember(stored_index, &book);
        }
        let record = storage.compose_book(&book)?;

        storage.mark_library_dirty();
        let source_backup = managed_source_replacement
            .take()
            .and_then(|replacement| replacement.backup);
        let finalizer = ImportFinalizer::new(file_transaction.take()).with_cleanup_path(source_backup);
        Ok(Some((record, finalizer)))
    })();

    if result.as_ref().is_ok_and(Option::is_none) {
        remove_epub_import_temp(&temp_path);
    }
    if result.is_err() {
        if let Some(replacement) = managed_source_replacement.take()
            && let Err(error) = replacement.rollback()
        {
            eprintln!("Failed to roll back managed EPUB source adoption: {error}");
        }
        if let Some(managed_source) = promoted_managed_source.take()
            && let Err(error) = fs::remove_file(&managed_source)
            && managed_source.exists()
        {
            eprintln!("Failed to remove managed source after promotion failure: {error}");
        }
        remove_epub_import_temp(&temp_path);
        if let Some(transaction) = file_transaction
            && let Err(error) = transaction.rollback()
        {
            eprintln!("Failed to roll back EPUB import files: {error}");
        }
    }

    result
}

#[cfg(test)]
pub(in crate::storage) fn open_external_epub_path_impl(
    storage: &AppStorage,
    path: &Path,
) -> Result<BookRecord, String> {
    let result = open_external_epub_path_unflushed_impl(storage, path);
    let flush_result = storage.flush_content_dirty();
    match (result, flush_result) {
        (Ok(book), Ok(())) => Ok(book),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub(in crate::storage) fn open_external_epub_path_unflushed_impl(
    storage: &AppStorage,
    path: &Path,
) -> Result<BookRecord, String> {
    if let Some(book) = managed_library_book_for_epub_path(storage, path)? {
        return Ok(book);
    }

    fs::create_dir_all(books_root(storage.root())).map_err(|error| error.to_string())?;

    let source_path = path.to_path_buf();
    let size = fs::metadata(&source_path).map_err(|error| error.to_string())?.len();
    let name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.epub".to_string());
    let hash = hash_file(&source_path)?;
    let id = id_from_hash(&hash);

    let existing = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        if let Some(book) = state
            .library
            .books
            .iter()
            .find(|book| book.id == id && book.scope == BookScope::Library)
        {
            return storage.compose_book(book);
        }
        state
            .library
            .books
            .iter()
            .find(|book| book.id == id && book.scope == BookScope::External)
            .cloned()
    };

    let book_dir = storage.book_dir(&id);
    fs::create_dir_all(&book_dir).map_err(|error| error.to_string())?;
    let needs_assets = existing.is_none();
    let mut inspection = needs_assets.then(|| inspect_epub_info(&source_path)).transpose()?;
    if let Some((parsed, _)) = inspection.as_mut() {
        write_cover(storage, &id, parsed.cover.take().map(|cover| cover.input))?;
    }

    let now = now_ms();
    let book = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        if let Some(book) = state
            .library
            .books
            .iter()
            .find(|book| book.id == id && book.scope == BookScope::Library)
            .cloned()
        {
            return storage.compose_book(&book);
        }
        if let Some(book) = state
            .library
            .books
            .iter_mut()
            .find(|book| book.id == id && book.scope == BookScope::External)
        {
            book.name = name;
            book.size = size;
            book.source_path = source_path;
            book.last_read_at = Some(now);
            book.clone()
        } else {
            let (parsed, content_mode) = inspection
                .as_ref()
                .ok_or_else(|| "EPUB inspection is unavailable for external content".to_string())?;
            let book = StoredBook {
                id,
                scope: BookScope::External,
                name,
                size,
                reading_status: None,
                source_format: BookSourceFormat::Epub,
                generated_cover: parsed.generated_cover,
                content_edited_at: None,
                source_hash: hash,
                source_revision: 1,
                revision: 1,
                latest_export_revision: None,
                latest_export_hash: None,
                content_mode: *content_mode,
                editable: false,
                source_storage: SourceStorage::Referenced,
                source_path,
                metadata: parsed.metadata.clone(),
                created_at: now,
                updated_at: None,
                last_read_at: Some(now),
                cfi: None,
                percentage: None,
                tag_ids: Vec::new(),
            };
            state.library.books.push(book.clone());
            book
        }
    };
    storage.mark_library_dirty();
    storage.compose_book(&book)
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
    let Some(book) = state
        .library
        .books
        .iter()
        .find(|book| book.id == id && book.scope == BookScope::Library)
        .cloned()
    else {
        return Ok(None);
    };

    storage.compose_book(&book).map(Some)
}
