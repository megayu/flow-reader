//! EPUB import and external-open workflow orchestration.

use super::*;

pub(super) fn epub_import_temp_path(root: &Path, name: &str) -> PathBuf {
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
    root.join(format!(".import-{}-{}-{}", std::process::id(), now_ms(), name))
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

pub(super) fn reassign_book_state_annotations(state: &mut BookState, from_id: &str, to_id: &str) {
    for annotation in &mut state.annotations {
        let Some(object) = annotation.as_object_mut() else {
            continue;
        };
        if object
            .get("bookId")
            .and_then(Value::as_str)
            .is_some_and(|book_id| book_id == from_id)
        {
            object.insert("bookId".to_string(), json!(to_id));
        }
    }
}

pub(in crate::storage) fn import_epub_path_impl(
    storage: &AppStorage,
    path: &Path,
    replace_existing: bool,
) -> Result<BookRecord, String> {
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

    // These values move once through import control flow; boxing would add avoidable allocations.
    #[allow(clippy::large_enum_variant)]
    enum ImportDecision {
        Existing(BookRecord),
        Commit {
            book: LibraryBook,
            id: String,
            should_copy: bool,
            external_promotion: Option<ExternalPromotion>,
        },
    }

    struct ExternalPromotion {
        book: ExternalBook,
        state: Option<BookState>,
    }

    let result = (|| -> Result<BookRecord, String> {
        let decision = {
            let mut state = storage
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
                if !replace_existing || (state.library.books[index].content_hash == hash && !storage_changed) {
                    state.library.books[index].source_path = Some(source_path.clone());
                    let book = state.library.books[index].clone();
                    if external_promotion.is_none() {
                        ImportDecision::Existing(storage.compose_book(&mut state, &book)?)
                    } else {
                        let id = book.id.clone();
                        ImportDecision::Commit {
                            book,
                            id,
                            should_copy: false,
                            external_promotion,
                        }
                    }
                } else {
                    let book = &mut state.library.books[index];
                    book.size = size;
                    book.content_hash = hash.clone();
                    book.content_version = book.content_version.saturating_add(1).max(1);
                    book.content_mode = access.mode;
                    book.content_flags = access.flags.clone();
                    book.source_storage = source_storage;
                    book.source_path = Some(source_path.clone());
                    book.updated_at = Some(now_ms());
                    book.last_read_at = book.updated_at;
                    let book = state.library.books[index].clone();
                    let id = book.id.clone();
                    ImportDecision::Commit {
                        book,
                        id,
                        should_copy: true,
                        external_promotion,
                    }
                }
            } else if let Some(index) = hash_index {
                let book = &mut state.library.books[index];
                book.name = name.clone();
                book.size = size;
                book.content_mode = access.mode;
                book.content_flags = access.flags.clone();
                let storage_changed = book.source_storage != source_storage;
                book.source_storage = source_storage;
                book.source_path = Some(source_path.clone());
                book.updated_at = Some(now_ms());
                let book = state.library.books[index].clone();
                let id = book.id.clone();
                ImportDecision::Commit {
                    book,
                    id,
                    should_copy: storage_changed,
                    external_promotion,
                }
            } else {
                let created_at = now_ms();
                let id = id_from_hash(&hash);
                state.library.books.push(LibraryBook {
                    id,
                    name: name.clone(),
                    size,
                    reading_status: None,
                    source_format: Some(BookSourceFormat::Epub),
                    exported_versions: Default::default(),
                    content_edited_at: None,
                    content_hash: hash.clone(),
                    content_version: 1,
                    content_mode: access.mode,
                    content_flags: access.flags.clone(),
                    source_storage,
                    source_path: Some(source_path.clone()),
                    metadata: empty_object(),
                    created_at,
                    updated_at: None,
                    last_read_at: None,
                    cfi: None,
                    percentage: None,
                    tag_ids: Vec::new(),
                });
                let book = state
                    .library
                    .books
                    .last()
                    .expect("newly pushed book should exist")
                    .clone();
                let id = book.id.clone();
                ImportDecision::Commit {
                    book,
                    id,
                    should_copy: true,
                    external_promotion,
                }
            }
        };

        let (mut book, id, should_copy, external_promotion) = match decision {
            ImportDecision::Existing(record) => {
                remove_epub_import_temp(&temp_path);
                storage.mark_library_dirty();
                storage.flush_dirty()?;
                return Ok(record);
            }
            ImportDecision::Commit {
                book,
                id,
                should_copy,
                external_promotion,
            } => (book, id, should_copy, external_promotion),
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
            let dir = storage.book_dir(&id);
            storage.unload_search_text_cache(&id);
            fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            let book_path = dir.join(BOOK_FILE);
            let unpacked_dir = dir.join(UNPACKED_DIR);
            if unpacked_dir.exists() {
                fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
            }
            let search_cache_path = dir.join(SEARCH_TEXT_CACHE_FILE);
            if search_cache_path.exists() {
                fs::remove_file(&search_cache_path).map_err(|error| error.to_string())?;
            }
            if book_path.exists() {
                fs::remove_file(&book_path).map_err(|error| error.to_string())?;
            }
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
                && !access.flags.contains(&BookContentFlag::DeclaresEncryption)
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
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            if let Some(stored_book) = state.library.books.iter_mut().find(|book| book.id == id) {
                stored_book.metadata = book.metadata.clone();
            }
            drop(state);
            write_metadata(storage, &id, &book.metadata)?;
        }

        if let Some((external_book, _, mut external_state)) = promotion {
            let external_id = external_book.id.clone();
            let last_opened_at = external_book.last_opened_at;
            reassign_book_state_annotations(&mut external_state, &external_id, &id);
            {
                let mut state = storage
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "storage state lock poisoned".to_string())?;
                state.external.books.retain(|book| book.id != external_id);
                state.book_states.remove(&external_id);
                state.book_states.insert(id.clone(), external_state.clone());
                if let Some(stored_book) = state.library.books.iter_mut().find(|book| book.id == id) {
                    stored_book.cfi = external_state.cfi.clone();
                    stored_book.percentage = external_state.percentage;
                    stored_book.last_read_at = Some(last_opened_at);
                    stored_book.updated_at = Some(now_ms());
                    book.cfi = stored_book.cfi.clone();
                    book.percentage = stored_book.percentage;
                    book.last_read_at = stored_book.last_read_at;
                    book.updated_at = stored_book.updated_at;
                }
            }
            storage.unload_search_text_cache(&external_id);
            storage.mark_external_dirty();
            storage.mark_book_state_dirty(&id);
            let external_dir = storage.external_book_dir(&external_id);
            if external_dir.exists() {
                fs::remove_dir_all(&external_dir).map_err(|error| error.to_string())?;
            }
        }

        if publication_changed {
            book = mark_library_book_content_updated(storage, &id)?.ok_or_else(|| "Book not found".to_string())?;
        }

        storage.mark_library_dirty();
        storage.flush_dirty()?;

        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        storage.compose_book(&mut state, &book)
    })();

    if result.is_err() {
        remove_epub_import_temp(&temp_path);
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
                book.content_flags = access.flags.clone();
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
                    content_flags: access.flags.clone(),
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
        storage.unload_search_text_cache(&book.id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let book_path = dir.join(BOOK_FILE);
        let unpacked_dir = dir.join(UNPACKED_DIR);
        if unpacked_dir.exists() {
            fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
        }
        let search_cache_path = dir.join(SEARCH_TEXT_CACHE_FILE);
        if search_cache_path.exists() {
            fs::remove_file(&search_cache_path).map_err(|error| error.to_string())?;
        }
        let image_cache_path = dir.join(IMAGE_INDEX_CACHE_FILE);
        if image_cache_path.exists() {
            fs::remove_file(&image_cache_path).map_err(|error| error.to_string())?;
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
