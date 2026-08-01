//! EPUB import and external-open workflow orchestration.

use super::*;

static IMPORT_WORK_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn import_work_path(root: &Path, prefix: &str, name: &str) -> PathBuf {
    let sequence = IMPORT_WORK_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    root.join(format!(".{prefix}-{}-{sequence}-{name}", std::process::id()))
}

pub(in crate::storage) struct ImportFileTransaction {
    book_dir: PathBuf,
    book_dir_existed: bool,
    backup_dir: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}

impl ImportFileTransaction {
    pub(in crate::storage) fn begin(storage: &AppStorage, id: &str) -> Result<Self, String> {
        let book_dir = storage.book_dir(id);
        let book_dir_existed = book_dir.exists();
        fs::create_dir_all(&book_dir).map_err(|error| error.to_string())?;
        let backup_dir = import_work_path(&books_root(storage.root()), "import-backup", id);
        fs::create_dir(&backup_dir).map_err(|error| error.to_string())?;

        let mut targets = [BOOK_FILE, SOURCE_TEXT_FILE, UNPACKED_DIR, METADATA_FILE]
            .into_iter()
            .map(|name| book_dir.join(name))
            .collect::<Vec<_>>();
        let entries = fs::read_dir(&book_dir).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&format!("{COVER_STEM}.")) || is_derived_cache_file_name(name))
            {
                targets.push(entry.path());
            }
        }

        let mut transaction = Self {
            book_dir,
            book_dir_existed,
            backup_dir,
            moved: Vec::new(),
        };
        for target in targets {
            if !target.exists() {
                continue;
            }
            let Some(name) = target.file_name() else {
                continue;
            };
            let backup = transaction.backup_dir.join(name);
            if let Err(error) = fs::rename(&target, &backup) {
                let _ = transaction.rollback();
                return Err(error.to_string());
            }
            transaction.moved.push((backup, target));
        }
        Ok(transaction)
    }

    pub(in crate::storage) fn restore_preserved(&mut self, name: &str) -> Result<(), String> {
        let Some(index) = self
            .moved
            .iter()
            .position(|(_, target)| target.file_name().is_some_and(|filename| filename == name))
        else {
            return Ok(());
        };
        let (backup, target) = self.moved.remove(index);
        if !target.exists() {
            fs::rename(backup, target).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(in crate::storage) fn commit(self) -> Result<(), String> {
        fs::remove_dir_all(self.backup_dir).map_err(|error| error.to_string())
    }

    pub(in crate::storage) fn rollback(self) -> Result<(), String> {
        let mut first_error = None;
        let mut current_targets = [BOOK_FILE, SOURCE_TEXT_FILE, UNPACKED_DIR, METADATA_FILE]
            .into_iter()
            .map(|name| self.book_dir.join(name))
            .collect::<Vec<_>>();
        if let Ok(entries) = fs::read_dir(&self.book_dir) {
            for entry in entries.flatten() {
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&format!("{COVER_STEM}.")) || is_derived_cache_file_name(name))
                {
                    current_targets.push(entry.path());
                }
            }
        }
        for target in current_targets {
            if let Err(error) = remove_import_artifact(&target)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        for (backup, target) in self.moved {
            if let Err(error) = fs::rename(backup, target).map_err(|error| error.to_string())
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        if let Err(error) = fs::remove_dir_all(self.backup_dir).map_err(|error| error.to_string())
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        if !self.book_dir_existed
            && let Err(error) = fs::remove_dir(&self.book_dir).map_err(|error| error.to_string())
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn remove_import_artifact(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

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

pub(in crate::storage) fn import_epub_path_impl(
    storage: &AppStorage,
    path: &Path,
    replace_existing: bool,
) -> Result<BookRecord, String> {
    let _import_guard = storage
        .inner
        .import_lock
        .lock()
        .map_err(|_| "storage import lock poisoned".to_string())?;
    let books_root = books_root(storage.root());
    fs::create_dir_all(&books_root).map_err(|error| error.to_string())?;

    let source_path = path.to_path_buf();
    let source_storage = storage.import_source_storage();
    let size = fs::metadata(&source_path).map_err(|error| error.to_string())?.len();
    let name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.epub".to_string());
    let parsed = parse_epub_info_result(&source_path)?;
    let access = inspect_epub_access(&source_path)?;
    let temp_path = epub_import_temp_path(&books_root, &name);
    let hash_result = if source_storage == SourceStorage::Managed {
        copy_epub_and_hash(&source_path, &temp_path)
    } else {
        hash_file(&source_path)
    };
    let hash = match hash_result {
        Ok(hash) => hash,
        Err(error) => {
            remove_epub_import_temp(&temp_path);
            return Err(error);
        }
    };

    struct ExternalPromotion {
        book: ExternalBook,
        state: Option<BookState>,
    }

    let mut file_transaction = None;
    let result = (|| -> Result<BookRecord, String> {
        let (mut book, id, should_copy, is_new, external_promotion) = {
            let state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let filename_index = state.library.books.iter().position(|book| book.name == name);
            let hash_index = state
                .library
                .books
                .iter()
                .position(|book| !book.content_hash.is_empty() && book.content_hash == hash);
            let external_promotion = state
                .external
                .books
                .iter()
                .find(|book| !book.content_hash.is_empty() && book.content_hash == hash)
                .cloned()
                .map(|book| ExternalPromotion {
                    state: state.book_states.get(&book.id).cloned(),
                    book,
                });

            if let Some(index) = filename_index {
                let storage_changed = state.library.books[index].source_storage != source_storage;
                let mut book = state.library.books[index].clone();
                if !replace_existing || (state.library.books[index].content_hash == hash && !storage_changed) {
                    book.source_path = Some(source_path.clone());
                    let id = book.id.clone();
                    (book, id, false, false, external_promotion)
                } else {
                    book.size = size;
                    book.content_hash = hash.clone();
                    book.content_version = book.content_version.saturating_add(1).max(1);
                    book.content_mode = access.mode;
                    book.source_storage = source_storage;
                    book.source_path = Some(source_path.clone());
                    book.updated_at = Some(now_ms());
                    book.last_read_at = book.updated_at;
                    let id = book.id.clone();
                    (book, id, true, false, external_promotion)
                }
            } else if let Some(index) = hash_index {
                let mut book = state.library.books[index].clone();
                book.name = name.clone();
                book.size = size;
                book.content_mode = access.mode;
                let storage_changed = book.source_storage != source_storage;
                book.source_storage = source_storage;
                book.source_path = Some(source_path.clone());
                book.updated_at = Some(now_ms());
                let id = book.id.clone();
                (book, id, storage_changed, false, external_promotion)
            } else {
                let created_at = now_ms();
                let id = id_from_hash(&hash);
                let book = LibraryBook {
                    id: id.clone(),
                    name: name.clone(),
                    size,
                    reading_status: None,
                    source_format: BookSourceFormat::Epub,
                    content_edited_at: None,
                    content_hash: hash.clone(),
                    content_version: 1,
                    content_mode: access.mode,
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
        let normalize_new_cover = should_copy && book.updated_at.is_none();
        let mut publication_changed = false;

        let promotion = external_promotion
            .map(|promotion| {
                let external_dir = storage.external_book_dir(&promotion.book.id);
                let metadata = read_json_value_or_default(&external_dir.join(METADATA_FILE))?;
                let state = match promotion.state {
                    Some(state) => state,
                    None => read_json_or_default(&external_dir.join(STATE_FILE))?,
                };
                Ok::<_, String>((promotion.book, metadata, state))
            })
            .transpose()?;
        let promoted_metadata = promotion.as_ref().map(|(_, metadata, _)| metadata.clone());

        if should_copy {
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
            if source_storage == SourceStorage::Referenced && access.mode == BookContentMode::Normal {
                unpack_epub(package_path, &unpacked_dir)?;
                publication_changed |= normalize_unpacked_epub_structure(&unpacked_dir)?;
            }
            let mut cover = parsed.cover;
            if normalize_new_cover
                && access.mode == BookContentMode::Normal
                && !access.declares_encryption
                && let Some(parsed_cover) = cover.as_mut()
                && (parsed_cover.input.mime_type == "image/png"
                    || parsed_cover.input.extension.eq_ignore_ascii_case("png"))
                && let (Some(archive_path), Some(normalized)) = (
                    parsed_cover.archive_path.as_deref(),
                    normalize_non_square_pixel_png(&parsed_cover.input.data),
                )
            {
                if !unpacked_dir.exists() {
                    unpack_epub(package_path, &unpacked_dir)?;
                    normalize_unpacked_epub_structure(&unpacked_dir)?;
                }
                fs::write(unpacked_resource_path(&unpacked_dir, archive_path), &normalized)
                    .map_err(|error| error.to_string())?;
                parsed_cover.input.data = normalized;
                publication_changed = true;
            }
            write_cover(storage, &id, cover.map(|cover| cover.input))?;
        } else {
            remove_epub_import_temp(&temp_path);
        }

        let metadata = promoted_metadata
            .filter(|metadata| *metadata != json!({}))
            .or_else(|| (parsed.metadata != json!({})).then(|| parsed.metadata.clone()));
        if let Some(metadata) = metadata {
            book.metadata = metadata;
            write_metadata(storage, &id, &book.metadata)?;
        } else if let Some(transaction) = file_transaction.as_mut() {
            transaction.restore_preserved(METADATA_FILE)?;
        }

        let promotion = promotion.map(|(external_book, _, external_state)| {
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

        let record = {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            if is_new {
                if state
                    .library
                    .books
                    .iter()
                    .any(|stored| stored.id == id || stored.name == name)
                {
                    return Err("Library changed while the book was being imported".to_string());
                }
                state.library.books.push(book.clone());
            } else {
                let stored = state
                    .library
                    .books
                    .iter_mut()
                    .find(|stored| stored.id == id)
                    .ok_or_else(|| "Book was removed while it was being imported".to_string())?;
                book.reading_status = stored.reading_status.clone();
                book.cfi = promotion
                    .as_ref()
                    .map_or_else(|| stored.cfi.clone(), |_| book.cfi.clone());
                book.percentage = promotion.as_ref().map_or(stored.percentage, |_| book.percentage);
                book.tag_ids = stored.tag_ids.clone();
                *stored = book.clone();
            }
            if let Some((external_id, external_state)) = &promotion {
                state.external.books.retain(|stored| stored.id != *external_id);
                state.book_states.remove(external_id);
                state.book_states.insert(id.clone(), external_state.clone());
            }
            storage.compose_book(&mut state, &book)?
        };

        storage.mark_library_dirty();
        if let Some((external_id, _)) = &promotion {
            storage.remove_derived_memory_caches(external_id);
            storage.mark_external_dirty();
            storage.mark_book_state_dirty(&id);
        }
        if let Some(transaction) = file_transaction.take()
            && let Err(error) = transaction.commit()
        {
            eprintln!("Failed to remove committed import backup: {error}");
        }
        storage.flush_dirty()?;

        if let Some((external_id, _)) = promotion {
            let external_dir = storage.external_book_dir(&external_id);
            if let Err(error) = fs::remove_dir_all(&external_dir)
                && external_dir.exists()
            {
                eprintln!("Failed to remove promoted external book files: {error}");
            }
        }
        Ok(record)
    })();

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
    let parsed = parse_epub_info_result(&source_path)?;
    let access = inspect_epub_access(&source_path)?;
    let hash = hash_file(&source_path)?;

    // These values move once through open control flow; boxing would add avoidable allocations.
    #[allow(clippy::large_enum_variant)]
    enum OpenDecision {
        Library(BookRecord),
        External { book: ExternalBook, is_new: bool },
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
                OpenDecision::Library(storage.compose_book(&mut state, &book)?)
            } else if let Some(index) = state
                .external
                .books
                .iter()
                .position(|book| !book.content_hash.is_empty() && book.content_hash == hash)
            {
                let book = &mut state.external.books[index];
                book.name = name.clone();
                book.size = size;
                book.content_mode = access.mode;
                book.content_version = book.content_version.max(1);
                book.source_storage = SourceStorage::Referenced;
                book.source_path = Some(source_path.clone());
                book.last_opened_at = now_ms();
                OpenDecision::External {
                    book: book.clone(),
                    is_new: false,
                }
            } else {
                let now = now_ms();
                let id = format!("ext-{}", id_from_hash(&hash));
                let book = ExternalBook {
                    id,
                    name: name.clone(),
                    size,
                    content_hash: hash.clone(),
                    content_version: 1,
                    content_mode: access.mode,
                    source_storage: SourceStorage::Referenced,
                    source_path: Some(source_path.clone()),
                    created_at: now,
                    last_opened_at: now,
                };
                state.external.books.push(book.clone());
                OpenDecision::External { book, is_new: true }
            }
        };

        let (book, is_new) = match decision {
            OpenDecision::Library(book) => {
                return Ok(book);
            }
            OpenDecision::External { book, is_new } => (book, is_new),
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
        if access.mode == BookContentMode::Normal {
            unpack_epub(&source_path, &unpacked_dir)?;
            normalize_unpacked_epub_structure(&unpacked_dir)?;
        }
        if is_new || parsed.metadata != json!({}) {
            write_metadata(storage, &book.id, &parsed.metadata)?;
        }
        storage.mark_external_dirty();
        storage.flush_dirty()?;

        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let book = storage.external_to_library_book(&book)?;
        storage.compose_book(&mut state, &book)
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

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    let Some(book) = state.library.books.iter().find(|book| book.id == id).cloned() else {
        return Ok(None);
    };

    storage.compose_book(&mut state, &book).map(Some)
}
