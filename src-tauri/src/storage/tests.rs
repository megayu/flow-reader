use super::book_assets::read_cover;
use super::commands::{
    BookImportResult, ReadingPositionInput, delete_tags_impl, get_book_impl, import_epub_paths_impl, merge_tags_impl,
    preview_text_import_paths_impl, record_reading_position_impl, revealable_book_source_path,
};
use super::epub_import::read_bounded_bytes;
use super::settings::{flush_settings_impl, update_settings_impl};
use super::text_import::text_import_filename_metadata;
use super::{
    AppStorage, BOOK_FILE, BOOK_STATE_VERSION, BOOKS_DIR, BookContentMode, BookExportFormat, BookReaderSourceMode,
    BookRecord, BookScope, BookSourceFormat, BookSourceStatus, BookState, BookTextReplaceTarget, DirtyState,
    ExternalBookIndex, FolderImportTagAssignment, IMAGE_INDEX_CACHE_VERSION, ImageIndexCache, ImageIndexEntry,
    ImageIndexSection, LIBRARY_VERSION, Library, LibraryBook, LibraryPins, LibraryTagRecord, ReadingStatus,
    SEARCH_TEXT_CACHE_VERSION, SOURCE_TEXT_FILE, STATE_FILE, SearchTextCache, SearchTextSection, SourceStorage,
    SourceTextUpdate, StorageInner, StorageState, TextImportRulesInput, TextImportSelection, UNPACKED_DIR,
    apply_folder_import_tags_impl, check_book_source_statuses_impl, cleanup_external_book_heavy_files,
    decode_text_bytes, empty_object, ensure_book_package_path_with_unpacker, export_book_impl, external_books_root,
    external_index_path, get_book_reader_source_impl, hash_file, id_from_hash, library_path,
    load_or_build_search_text_cache, mark_book_exported, mark_library_book_content_updated, materialize_epub_package,
    normalize_non_square_pixel_png, normalize_publication_date, normalize_unpacked_epub_structure,
    open_external_epub_path_impl, parent_zip_path, parse_text_import_document, path_to_client_string,
    read_image_index_cache, read_json_or_default, read_json_value_or_default, read_search_text_sections_from_unpacked,
    relative_zip_path, rename_books_for_deletion, replace_book_text_impl, replace_xhtml_text, replace_xhtml_text_node,
    schedule_existing_pending_delete_cleanup, search_text_cache_from_bytes, search_text_cache_to_bytes,
    search_text_in_cache, settings_path, text_content_opf, text_nav_xhtml, text_section_xhtml,
    visible_search_text_from_xhtml, write_cover, write_epub_from_original_and_unpacked, write_epub_from_unpacked_dir,
    write_image_index_cache_if_current, write_source_text_update,
};
use crate::tasks::TaskService;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read, Write},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

fn imported_books_or_first_error(result: BookImportResult) -> Result<Vec<BookRecord>, String> {
    if let Some(failure) = result.failures.into_iter().next() {
        return Err(failure.error);
    }
    Ok(result.books)
}

#[test]
fn settings_update_honors_explicit_flush_policy() {
    let root = std::env::temp_dir().join(format!(
        "flow-reader-settings-flush-test-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    let storage = test_storage_with_books(&root, Vec::new());
    let path = settings_path(&root).unwrap();
    let settings = json!({"locale": "zh-CN"});

    update_settings_impl(&storage, settings.clone(), false).unwrap();

    assert_eq!(storage.inner.state.lock().unwrap().settings, settings);
    assert!(!path.exists());

    flush_settings_impl(&storage).unwrap();

    assert_eq!(read_json_value_or_default(&path).unwrap(), settings);

    let immediate_settings = json!({"locale": "en"});
    update_settings_impl(&storage, immediate_settings.clone(), true).unwrap();

    assert_eq!(read_json_value_or_default(&path).unwrap(), immediate_settings);
    fs::remove_dir_all(root).unwrap();
}

fn import_single_epub_for_test(storage: &AppStorage, path: &Path) -> Result<BookRecord, String> {
    let result = import_epub_paths_impl(
        storage,
        &TaskService::default(),
        vec![path.to_string_lossy().to_string()],
        None,
    )?;
    imported_books_or_first_error(result)?
        .into_iter()
        .next()
        .ok_or_else(|| "EPUB import produced no book".to_string())
}

fn import_text_paths_strict_for_test(
    storage: &AppStorage,
    tasks: &TaskService,
    imports: Vec<TextImportSelection>,
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<BookRecord>, String> {
    let result = super::commands::import_text_paths_impl(storage, tasks, imports, None, rules, None)?;
    imported_books_or_first_error(result)
}

fn synthetic_non_square_pixel_png() -> Vec<u8> {
    let width = 4u32;
    let height = 2u32;
    let mut pixels = Vec::new();
    for row in 0..height {
        for column in 0..width {
            pixels.extend_from_slice(&[(column * 50) as u8, (row * 100) as u8, 160]);
        }
    }
    let mut output = Vec::new();
    let mut encoder = png::Encoder::new(&mut output, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_pixel_dims(Some(png::PixelDimensions {
        xppu: 2,
        yppu: 1,
        unit: png::Unit::Meter,
    }));
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&pixels).unwrap();
    drop(writer);
    output
}

fn png_dimensions(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    (
        u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
        u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
    )
}

#[test]
fn book_cover_assets_bound_lossy_webp_dimensions_and_preserve_svg() {
    let root = std::env::temp_dir().join(format!(
        "flow-reader-cover-asset-test-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
    fs::create_dir_all(storage.book_dir("book")).unwrap();

    for ((width, height), expected, extension) in [
        ((640, 960), (320, 480), "jpg"),
        ((1200, 1600), (320, 427), "png"),
        ((200, 300), (200, 300), "webp"),
    ] {
        let data = if extension == "webp" {
            let pixels = vec![0; (width * height * 3) as usize];
            webp::Encoder::from_rgb(&pixels, width, height).encode(90.0).to_vec()
        } else {
            let format = if extension == "jpg" {
                image::ImageFormat::Jpeg
            } else {
                image::ImageFormat::Png
            };
            let mut data = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(width, height)
                .write_to(&mut data, format)
                .unwrap();
            data.into_inner()
        };

        write_cover(
            &storage,
            "book",
            Some(super::CoverInput {
                mime_type: format!("image/{extension}"),
                extension: extension.to_string(),
                data,
            }),
        )
        .unwrap();

        let cover = fs::read(storage.book_dir("book").join("cover.webp")).unwrap();
        assert_eq!(&cover[12..16], b"VP8 ");
        let decoded = webp::Decoder::new(&cover).decode().unwrap();
        assert_eq!((decoded.width(), decoded.height()), expected);
        assert!(!storage.book_dir("book").join("cover.jpg").exists());
        assert!(!storage.book_dir("book").join("cover.png").exists());
    }

    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"></svg>"#;
    write_cover(
        &storage,
        "book",
        Some(super::CoverInput {
            mime_type: "image/svg+xml".to_string(),
            extension: "svg".to_string(),
            data: svg.to_vec(),
        }),
    )
    .unwrap();

    assert_eq!(fs::read(storage.book_dir("book").join("cover.svg")).unwrap(), svg);
    assert!(!storage.book_dir("book").join("cover.webp").exists());
    fs::remove_dir_all(root).unwrap();
}

fn wait_until_next_epoch_second() {
    let start = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    while SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() == start {
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn test_storage_with_book(root: &Path, book: LibraryBook) -> AppStorage {
    test_storage_with_books(root, vec![book])
}

fn test_storage_with_books(root: &Path, books: Vec<LibraryBook>) -> AppStorage {
    let initial_states = books
        .iter()
        .filter(|book| book.cfi.is_some() || book.percentage.is_some())
        .map(|book| {
            (
                book.id.clone(),
                BookState {
                    cfi: book.cfi.clone(),
                    percentage: book.percentage,
                    ..Default::default()
                },
            )
        })
        .collect::<Vec<_>>();
    let storage = AppStorage {
        inner: Arc::new(StorageInner {
            root: root.to_path_buf(),
            state: Mutex::new(StorageState::new(
                Library {
                    version: LIBRARY_VERSION,
                    books,
                    tags: Vec::new(),
                    pins: LibraryPins::default(),
                    recent_book_ids: Vec::new(),
                },
                ExternalBookIndex::default(),
                json!({"importSourceStorage": "managed"}),
            )),
            dirty: Mutex::new(DirtyState::default()),
            flush_lock: Mutex::new(()),
            import_lock: Mutex::new(()),
            search_text_caches: Mutex::new(HashMap::new()),
            image_index_caches: Mutex::new(HashMap::new()),
            derived_cache_states: Mutex::new(HashMap::new()),
            derived_cache_flush_lock: Mutex::new(()),
            text_import_prepare_runs: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepare_active: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepare_max_active: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepare_delay_ms: std::sync::atomic::AtomicU64::new(0),
            text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize::new(0),
        }),
    };
    for (id, state) in initial_states {
        storage.write_book_state(&id, &state).unwrap();
    }
    storage
}

fn test_storage_from_disk(root: &Path) -> AppStorage {
    AppStorage {
        inner: Arc::new(StorageInner {
            root: root.to_path_buf(),
            state: Mutex::new(StorageState::new(
                read_json_or_default::<Library>(&library_path(root).unwrap()).unwrap(),
                read_json_or_default::<ExternalBookIndex>(&external_index_path(root).unwrap()).unwrap(),
                json!({"importSourceStorage": "managed"}),
            )),
            dirty: Mutex::new(DirtyState::default()),
            flush_lock: Mutex::new(()),
            import_lock: Mutex::new(()),
            search_text_caches: Mutex::new(HashMap::new()),
            image_index_caches: Mutex::new(HashMap::new()),
            derived_cache_states: Mutex::new(HashMap::new()),
            derived_cache_flush_lock: Mutex::new(()),
            text_import_prepare_runs: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepare_active: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepare_max_active: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepare_delay_ms: std::sync::atomic::AtomicU64::new(0),
            text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize::new(0),
            text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize::new(0),
        }),
    }
}

fn external_promotion_state() -> BookState {
    BookState {
        version: BOOK_STATE_VERSION,
        cfi: Some("epubcfi(/6/4!/4/2)".to_string()),
        percentage: Some(0.42),
        definitions: vec!["term".to_string()],
        annotations: vec![json!({"text": "note"})],
        configuration: Some(json!({"theme": "sepia", "spread": {"page": 2}})),
    }
}

fn assert_external_promoted(storage: &AppStorage, imported: &BookRecord, external_id: &str, source: &Path) {
    assert!(matches!(imported.scope, BookScope::Library));
    assert_eq!(imported.id, external_id);
    assert!(storage.book_dir(&imported.id).join(BOOK_FILE).exists());
    assert_eq!(
        hash_file(source).unwrap(),
        hash_file(&storage.book_dir(&imported.id).join(BOOK_FILE)).unwrap()
    );
    assert_eq!(
        fs::read_to_string(storage.book_dir(&imported.id).join("promotion-marker.txt")).unwrap(),
        "preserved"
    );
    assert!(!storage.external_book_dir(external_id).exists());

    let state = storage.inner.state.lock().unwrap();
    assert!(state.external.books.is_empty());
    assert_eq!(state.library.books.len(), 1);
    drop(state);
    let promoted_state: BookState = read_json_or_default(&storage.book_dir(&imported.id).join(STATE_FILE)).unwrap();
    assert_eq!(promoted_state.version, BOOK_STATE_VERSION);
    assert_eq!(promoted_state.cfi.as_deref(), Some("epubcfi(/6/4!/4/2)"));
    assert_eq!(promoted_state.percentage, Some(0.42));
    assert_eq!(promoted_state.definitions, vec!["term".to_string()]);
    assert_eq!(promoted_state.annotations, vec![json!({"text": "note"})]);
    assert_eq!(
        promoted_state.configuration,
        Some(json!({"theme": "sepia", "spread": {"page": 2}}))
    );
    assert_eq!(
        imported.metadata.get("title").and_then(Value::as_str),
        Some("Edited External")
    );
    assert_eq!(imported.metadata.get("custom").and_then(Value::as_str), Some("kept"));
    let external_index: ExternalBookIndex =
        read_json_or_default(&external_index_path(storage.root()).unwrap()).unwrap();
    assert!(external_index.books.is_empty());
}

fn test_library_book_with_id(id: &str, source_format: BookSourceFormat) -> LibraryBook {
    let mut book = test_library_book(source_format);
    book.id = id.to_string();
    book.name = format!("{id}.epub");
    book
}

#[test]
fn folder_import_tags_reuse_existing_names_and_deduplicate_repeated_directories() {
    let root = std::env::temp_dir().join(format!(
        "flow-reader-folder-tag-test-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let storage = test_storage_with_book(&root, test_library_book_with_id("book-a", BookSourceFormat::Epub));
    storage.inner.state.lock().unwrap().library.tags.push(LibraryTagRecord {
        id: "tag-rust".to_string(),
        name: "rust".to_string(),
        created_at: 1,
        updated_at: None,
    });

    let result = apply_folder_import_tags_impl(
        &storage,
        vec![FolderImportTagAssignment {
            book_id: "book-a".to_string(),
            tag_names: vec!["Rust".to_string(), "a".to_string(), "b".to_string(), "A".to_string()],
        }],
    )
    .unwrap();

    assert_eq!(
        result
            .tags
            .iter()
            .filter(|tag| tag.name.eq_ignore_ascii_case("rust"))
            .count(),
        1
    );
    assert_eq!(
        result
            .tags
            .iter()
            .filter(|tag| tag.name.eq_ignore_ascii_case("a"))
            .count(),
        1
    );
    assert_eq!(
        result
            .tags
            .iter()
            .filter(|tag| tag.name.eq_ignore_ascii_case("b"))
            .count(),
        1
    );
    let book = result.books.iter().find(|book| book.id == "book-a").unwrap();
    assert_eq!(book.tag_ids.len(), 3);
    assert!(book.tag_ids.iter().any(|tag_id| tag_id == "tag-rust"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tag_management_operations_preserve_book_and_pin_references() {
    let root = std::env::temp_dir().join(format!(
        "flow-reader-tag-management-test-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let mut first = test_library_book_with_id("book-a", BookSourceFormat::Epub);
    first.tag_ids = vec!["tag-a".to_string(), "tag-b".to_string()];
    let mut second = test_library_book_with_id("book-b", BookSourceFormat::Epub);
    second.tag_ids = vec!["tag-b".to_string(), "tag-c".to_string()];
    let storage = test_storage_with_books(&root, vec![first, second]);
    {
        let mut state = storage.inner.state.lock().unwrap();
        state.library.tags = [
            ("tag-a", "Alpha"),
            ("tag-b", "Beta"),
            ("tag-c", "Gamma"),
            ("tag-orphan", "Orphan"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (id, name))| LibraryTagRecord {
            id: id.to_string(),
            name: name.to_string(),
            created_at: index as u64 + 1,
            updated_at: None,
        })
        .collect();
        state.library.pins.tag_ids = vec!["tag-b".to_string(), "tag-orphan".to_string()];
    }

    assert_eq!(
        merge_tags_impl(&storage, vec!["tag-a".to_string()], None, Some("Alpha".to_string())).unwrap_err(),
        "at least two tags are required"
    );
    assert_eq!(
        merge_tags_impl(
            &storage,
            vec!["tag-a".to_string(), "tag-missing".to_string()],
            None,
            Some("Combined".to_string()),
        )
        .unwrap_err(),
        "selected tag does not exist"
    );
    assert_eq!(
        merge_tags_impl(
            &storage,
            vec!["tag-a".to_string(), "tag-b".to_string()],
            Some("tag-c".to_string()),
            None,
        )
        .unwrap_err(),
        "merge target must be selected"
    );
    assert_eq!(
        merge_tags_impl(
            &storage,
            vec!["tag-a".to_string(), "tag-b".to_string()],
            None,
            Some(" ".to_string()),
        )
        .unwrap_err(),
        "merge target name is required"
    );
    assert_eq!(
        merge_tags_impl(
            &storage,
            vec!["tag-a".to_string(), "tag-b".to_string()],
            None,
            Some("Gamma".to_string()),
        )
        .unwrap_err(),
        "merge target name already exists"
    );

    let merged = merge_tags_impl(
        &storage,
        vec!["tag-a".to_string(), "tag-b".to_string()],
        Some("tag-a".to_string()),
        None,
    )
    .unwrap();
    assert_eq!(merged.id, "tag-a");
    {
        let state = storage.inner.state.lock().unwrap();
        assert!(!state.library.tags.iter().any(|tag| tag.id == "tag-b"));
        assert_eq!(state.library.books[0].tag_ids, vec!["tag-a"]);
        assert_eq!(state.library.books[1].tag_ids, vec!["tag-c", "tag-a"]);
        assert_eq!(state.library.pins.tag_ids, vec!["tag-a", "tag-orphan"]);
    }

    delete_tags_impl(&storage, vec!["tag-orphan".to_string(), "tag-c".to_string()]).unwrap();
    {
        let state = storage.inner.state.lock().unwrap();
        assert_eq!(
            state.library.tags.iter().map(|tag| tag.id.as_str()).collect::<Vec<_>>(),
            vec!["tag-a"]
        );
        assert_eq!(state.library.books[1].tag_ids, vec!["tag-a"]);
        assert_eq!(state.library.pins.tag_ids, vec!["tag-a"]);
    }

    fs::remove_dir_all(root).unwrap();
}

fn write_book_dir(storage: &AppStorage, id: &str, marker: &str) {
    let dir = storage.book_dir(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("marker.txt"), marker).unwrap();
}

#[test]
fn delete_books_rejects_ids_outside_the_library_without_touching_the_path() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-delete-boundary-test-{}-{nonce}",
        std::process::id()
    ));
    let storage = test_storage_with_book(&root, test_library_book_with_id("book-a", BookSourceFormat::Epub));
    let outside = root.with_extension("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("marker.txt"), "keep").unwrap();

    let result = rename_books_for_deletion(&storage, &[outside.to_string_lossy().into_owned()]);

    assert!(result.is_err());
    assert!(outside.join("marker.txt").exists());
    assert_eq!(storage.inner.state.lock().unwrap().library.books.len(), 1);

    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(outside);
}

#[test]
fn delete_books_renames_all_book_directories_in_place_before_cleanup() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-deferred-delete-test-{}-{nonce}",
        std::process::id()
    ));
    let storage = test_storage_with_books(
        &root,
        vec![
            test_library_book_with_id("book-a", BookSourceFormat::Epub),
            test_library_book_with_id("book-b", BookSourceFormat::Txt),
        ],
    );
    write_book_dir(&storage, "book-a", "A");
    write_book_dir(&storage, "book-b", "B");
    storage.inner.search_text_caches.lock().unwrap().insert(
        "book-a".to_string(),
        Arc::new(SearchTextCache {
            version: SEARCH_TEXT_CACHE_VERSION,
            revision: 1,
            sections: Vec::new(),
        }),
    );

    let pending_deletes = rename_books_for_deletion(&storage, &["book-a".to_string(), "book-b".to_string()]).unwrap();

    {
        let state = storage.inner.state.lock().unwrap();
        assert!(state.library.books.is_empty());
    }
    assert!(!storage.book_dir("book-a").exists());
    assert!(!storage.book_dir("book-b").exists());
    assert_eq!(pending_deletes.len(), 2);
    assert!(pending_deletes.iter().all(|path| {
        path.parent() == Some(root.join(BOOKS_DIR).as_path())
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".del-"))
    }));
    assert!(pending_deletes.iter().any(|path| path.join("marker.txt").exists()));
    assert!(!storage.inner.search_text_caches.lock().unwrap().contains_key("book-a"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn startup_cleanup_removes_leftover_pending_delete_paths() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-startup-cleanup-test-{}-{nonce}",
        std::process::id()
    ));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
    let pending_delete = root.join(BOOKS_DIR).join(".del-book-a-leftover");
    fs::create_dir_all(&pending_delete).unwrap();
    fs::write(pending_delete.join("marker.txt"), "leftover").unwrap();
    let tasks = TaskService::default();

    schedule_existing_pending_delete_cleanup(&storage, &tasks);
    for _ in 0..100 {
        if !pending_delete.exists() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    assert!(!pending_delete.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn text_preview_does_not_retain_full_document_for_later_import() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-prepare-reuse-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("novel.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, "第1章 开始\n第一段。\n第二段。\n").unwrap();
    let storage = test_storage_with_books(&root, Vec::new());
    let tasks = TaskService::default();

    let previews = preview_text_import_paths_impl(
        &storage,
        &tasks,
        vec![source.to_string_lossy().to_string()],
        HashMap::new(),
        None,
    )
    .unwrap();
    assert_eq!(previews.len(), 1);
    assert_eq!(storage.text_import_prepare_run_count(), 1);

    let books = import_text_paths_strict_for_test(
        &storage,
        &tasks,
        vec![TextImportSelection {
            path: source.to_string_lossy().to_string(),
            encoding: Some(previews[0].encoding.clone()),
            title: Some(previews[0].title.clone()),
            creator: Some("作者".to_string()),
        }],
        None,
    )
    .unwrap();

    assert_eq!(books.len(), 1);
    assert_eq!(storage.text_import_prepare_run_count(), 2);
    assert_eq!(
        fs::read_to_string(storage.book_dir(&books[0].id).join(SOURCE_TEXT_FILE)).unwrap(),
        "第1章 开始\n第一段。\n第二段。\n"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_text_import_does_not_mutate_existing_library_record() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-import-rollback-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("novel.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, "Chapter 1\nSynthetic paragraph.\n").unwrap();
    let mut existing = test_library_book_with_id("book", BookSourceFormat::Txt);
    existing.name = "novel.txt".to_string();
    existing.source_path = source.clone();
    existing.content_hash = "before-import".to_string();
    existing.metadata = json!({"title": "Before import"});
    let storage = test_storage_with_book(&root, existing);
    fs::create_dir_all(root.join(BOOKS_DIR)).unwrap();
    fs::write(storage.book_dir("book"), "blocks the book directory").unwrap();
    let before = serde_json::to_value(&storage.inner.state.lock().unwrap().library.books[0]).unwrap();

    let result = import_text_paths_strict_for_test(
        &storage,
        &TaskService::default(),
        vec![TextImportSelection {
            path: source.to_string_lossy().to_string(),
            encoding: None,
            title: None,
            creator: None,
        }],
        None,
    );

    assert!(result.is_err());
    let after = serde_json::to_value(&storage.inner.state.lock().unwrap().library.books[0]).unwrap();
    assert_eq!(after, before);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn referenced_text_import_materializes_on_epub_export() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-reference-import-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("referenced.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, "第1章 开始\n第一段。\n第二段。\n").unwrap();
    let storage = test_storage_with_books(&root, Vec::new());
    use_referenced_import_sources(&storage);
    let tasks = TaskService::default();

    let books = import_text_paths_strict_for_test(
        &storage,
        &tasks,
        vec![TextImportSelection {
            path: source.to_string_lossy().to_string(),
            encoding: None,
            title: None,
            creator: None,
        }],
        None,
    )
    .unwrap();
    let book = &books[0];
    let book_dir = storage.book_dir(&book.id);

    assert!(!book_dir.join(SOURCE_TEXT_FILE).exists());
    assert!(!book_dir.join(UNPACKED_DIR).exists());
    let persisted = serde_json::to_value(book).unwrap();
    assert!(persisted.get("managed").is_none());
    assert!(persisted.get("sourceStorage").is_none());
    assert_eq!(
        persisted.get("sourcePath").and_then(Value::as_str),
        Some(path_to_client_string(&source).as_str())
    );

    let txt_error = export_book_impl(
        &storage,
        book.id.clone(),
        BookExportFormat::Txt,
        root.join("blocked.txt"),
    )
    .unwrap_err();
    assert!(txt_error.contains("referenced TXT"));

    let output = root.join("referenced.epub");
    export_book_impl(&storage, book.id.clone(), BookExportFormat::Epub, output.clone()).unwrap();
    assert!(output.exists());
    assert!(book_dir.join(UNPACKED_DIR).join("OEBPS/content.opf").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn text_import_reprepares_when_prepared_file_metadata_changes() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-prepare-stale-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("novel.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, "第1章 旧内容\n旧段落。\n").unwrap();
    let storage = test_storage_with_books(&root, Vec::new());
    let tasks = TaskService::default();

    let previews = preview_text_import_paths_impl(
        &storage,
        &tasks,
        vec![source.to_string_lossy().to_string()],
        HashMap::new(),
        None,
    )
    .unwrap();
    assert_eq!(storage.text_import_prepare_run_count(), 1);

    fs::write(&source, "第1章 新内容\n新段落。\n新增段落。\n").unwrap();

    let books = import_text_paths_strict_for_test(
        &storage,
        &tasks,
        vec![TextImportSelection {
            path: source.to_string_lossy().to_string(),
            encoding: Some(previews[0].encoding.clone()),
            title: Some(previews[0].title.clone()),
            creator: None,
        }],
        None,
    )
    .unwrap();

    assert_eq!(books.len(), 1);
    assert_eq!(storage.text_import_prepare_run_count(), 2);
    assert_eq!(
        fs::read_to_string(storage.book_dir(&books[0].id).join(SOURCE_TEXT_FILE)).unwrap(),
        "第1章 新内容\n新段落。\n新增段落。\n"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn text_preview_prepares_files_concurrently() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-prepare-concurrent-test-{}-{nonce}",
        std::process::id()
    ));
    let first = root.join("first.txt");
    let second = root.join("second.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&first, "第1章 第一\n第一段。\n").unwrap();
    fs::write(&second, "第1章 第二\n第二段。\n").unwrap();
    let storage = test_storage_with_books(&root, Vec::new());
    storage.set_text_import_prepare_delay(Duration::from_millis(80));
    let tasks = TaskService::default();

    let previews = preview_text_import_paths_impl(
        &storage,
        &tasks,
        vec![
            first.to_string_lossy().to_string(),
            second.to_string_lossy().to_string(),
        ],
        HashMap::new(),
        None,
    )
    .unwrap();

    assert_eq!(previews.len(), 2);
    assert!(storage.text_import_prepare_max_active() > 1);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn text_import_prepares_files_concurrently_before_ordered_commit() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-import-concurrent-test-{}-{nonce}",
        std::process::id()
    ));
    let first = root.join("first.txt");
    let second = root.join("second.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&first, "第1章 第一\n第一段。\n").unwrap();
    fs::write(&second, "第1章 第二\n第二段。\n").unwrap();
    let storage = test_storage_with_books(&root, Vec::new());
    storage.set_text_import_prepare_delay(Duration::from_millis(80));
    let tasks = TaskService::default();

    let books = import_text_paths_strict_for_test(
        &storage,
        &tasks,
        vec![
            TextImportSelection {
                path: first.to_string_lossy().to_string(),
                encoding: None,
                title: None,
                creator: None,
            },
            TextImportSelection {
                path: second.to_string_lossy().to_string(),
                encoding: None,
                title: None,
                creator: None,
            },
        ],
        None,
    )
    .unwrap();

    assert_eq!(books.len(), 2);
    assert_eq!(books[0].name, "first.txt");
    assert_eq!(books[1].name, "second.txt");
    assert!(storage.text_import_prepare_max_active() > 1);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn text_import_materializes_prepared_files_with_bounded_handoff() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-import-bounded-handoff-test-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let worker_limit = std::thread::available_parallelism()
        .map(|cpus| cpus.get())
        .unwrap_or(1)
        .saturating_mul(2)
        .max(1);
    let file_count = worker_limit + 4;
    let imports = (0..file_count)
        .map(|index| {
            let path = root.join(format!("book-{index:03}.txt"));
            fs::write(&path, format!("第1章 标题{index}\n正文{index}。\n")).unwrap();
            TextImportSelection {
                path: path.to_string_lossy().to_string(),
                encoding: None,
                title: None,
                creator: None,
            }
        })
        .collect::<Vec<_>>();
    let storage = test_storage_with_books(&root, Vec::new());
    let tasks = TaskService::default();

    let books = import_text_paths_strict_for_test(&storage, &tasks, imports, None).unwrap();

    assert_eq!(books.len(), file_count);
    assert_eq!(books[0].name, "book-000.txt");
    assert_eq!(books[file_count - 1].name, format!("book-{:03}.txt", file_count - 1));
    let max_handoff = storage.text_import_prepared_handoff_max_active();
    assert!(max_handoff > 0);
    assert!(max_handoff <= worker_limit + 1);
    assert!(max_handoff < file_count);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn text_import_does_not_build_search_cache_in_visible_path() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-text-import-no-search-cache-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("novel.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, "第1章 开始\n第一段。\n第二段。\n").unwrap();
    let storage = test_storage_with_books(&root, Vec::new());
    let tasks = TaskService::default();

    let books = import_text_paths_strict_for_test(
        &storage,
        &tasks,
        vec![TextImportSelection {
            path: source.to_string_lossy().to_string(),
            encoding: None,
            title: None,
            creator: None,
        }],
        None,
    )
    .unwrap();

    assert_eq!(books.len(), 1);
    assert!(!storage.search_text_cache_path(&books[0].id, books[0].revision).exists());

    let _ = fs::remove_dir_all(root);
}

fn reading_position_input(
    cfi: &str,
    percentage: f64,
    spread: serde_json::Value,
    last_read_at: u64,
) -> ReadingPositionInput {
    ReadingPositionInput {
        book_id: "book".to_string(),
        cfi: Some(cfi.to_string()),
        percentage: Some(percentage),
        spread: Some(spread),
        last_read_at,
    }
}

fn write_minimal_unpacked_package(root: &Path, marker: &str) {
    let meta_inf = root.join("META-INF");
    let oebps = root.join("OEBPS");
    fs::create_dir_all(&meta_inf).unwrap();
    fs::create_dir_all(&oebps).unwrap();
    fs::write(
            meta_inf.join("container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
    fs::write(
        oebps.join("content.opf"),
        format!(r#"<?xml version="1.0" encoding="UTF-8"?><package>{marker}</package>"#),
    )
    .unwrap();
}

#[test]
fn unchanged_unpacked_package_is_not_reported_as_normalized() {
    let root = std::env::temp_dir().join(format!("flow-reader-normalize-noop-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    write_minimal_unpacked_package(&root, "unchanged");

    assert!(!normalize_unpacked_epub_structure(&root).unwrap());

    fs::remove_dir_all(root).unwrap();
}

fn write_minimal_epub_file(path: &Path, title: &str, body: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let file = fs::File::create(path).unwrap();
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file("mimetype", stored).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer.start_file("META-INF/container.xml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/content.opf", deflated).unwrap();
    writer
        .write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
  <metadata>
    <dc:title>{title}</dc:title>
    <dc:creator>Author</dc:creator>
  </metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>"#
            )
            .as_bytes(),
        )
        .unwrap();
    writer.start_file("OEBPS/chapter.xhtml", deflated).unwrap();
    writer
        .write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>{body}</p></body></html>"#
            )
            .as_bytes(),
        )
        .unwrap();
    writer.finish().unwrap();
}

fn use_referenced_import_sources(storage: &AppStorage) {
    storage.inner.state.lock().unwrap().settings = json!({
        "importSourceStorage": "referenced",
    });
}

fn write_minimal_epub_with_invalid_windows_entry(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let file = fs::File::create(path).unwrap();
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file("mimetype", stored).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer.start_file("META-INF/container.xml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/content.opf", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>Archive Only</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chap1" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="chap2" href="Text/invalid:path.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chap1"/>
    <itemref idref="chap2"/>
  </spine>
</package>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/nav.xhtml", deflated).unwrap();
    writer
        .write_all(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol>
  <li><a href="Text/chapter.xhtml">正常章节</a></li>
  <li><a href="Text/invalid:path.xhtml">兼容章节</a></li>
</ol></nav></body></html>"#
                .as_bytes(),
        )
        .unwrap();
    writer.start_file("OEBPS/Text/chapter.xhtml", deflated).unwrap();
    writer
        .write_all(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>正常章节</h1><p>普通正文 keyword。</p></body></html>"#
                .as_bytes(),
        )
        .unwrap();
    writer.start_file("OEBPS/Text/invalid:path.xhtml", deflated).unwrap();
    writer
        .write_all(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>兼容章节</h1><p>非法路径章节 keyword。</p></body></html>"#
                .as_bytes(),
        )
        .unwrap();
    writer.finish().unwrap();
}

fn write_minimal_epub_with_percent_encoded_cover(path: &Path, cover_bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let file = fs::File::create(path).unwrap();
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file("mimetype", stored).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer.start_file("META-INF/container.xml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/content.opf", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>Encoded Cover</dc:title>
    <meta name="cover" content="cover.jpg"/>
  </metadata>
  <manifest>
    <item id="cover.jpg" href="Images/%2Acover.jpg" media-type="image/jpeg"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/Images/*cover.jpg", deflated).unwrap();
    writer.write_all(cover_bytes).unwrap();
    writer.start_file("OEBPS/chapter.xhtml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>body</p></body></html>"#,
        )
        .unwrap();
    writer.finish().unwrap();
}

fn write_minimal_epub_with_xhtml_cover_image(
    path: &Path,
    cover_page_body: &str,
    cover_path: &str,
    cover_media_type: &str,
    cover_bytes: &[u8],
) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let file = fs::File::create(path).unwrap();
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file("mimetype", stored).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer.start_file("META-INF/container.xml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/content.opf", deflated).unwrap();
    writer
        .write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>XHTML Cover</dc:title>
  </metadata>
  <manifest>
    <item id="x_coverpage" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="image-cover" href="Images/{cover_path}" media-type="{cover_media_type}"/>
  </manifest>
  <spine>
    <itemref idref="x_coverpage" linear="yes"/>
    <itemref idref="chapter"/>
  </spine>
</package>"#
            )
            .as_bytes(),
        )
        .unwrap();
    writer.start_file("OEBPS/Text/cover.xhtml", deflated).unwrap();
    writer
        .write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>{cover_page_body}</body></html>"#
            )
            .as_bytes(),
        )
        .unwrap();
    writer.start_file("OEBPS/Text/chapter.xhtml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>body</p></body></html>"#,
        )
        .unwrap();
    writer
        .start_file(format!("OEBPS/Images/{cover_path}"), deflated)
        .unwrap();
    writer.write_all(cover_bytes).unwrap();
    writer.finish().unwrap();
}

fn write_minimal_epub_with_first_image_spine_page(path: &Path, cover_bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let file = fs::File::create(path).unwrap();
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file("mimetype", stored).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer.start_file("META-INF/container.xml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/content.opf", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>First Image Page</dc:title>
  </metadata>
  <manifest>
    <item id="preface" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="item27" href="Images/image00220.jpeg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    <itemref idref="preface" linear="yes"/>
    <itemref idref="chapter"/>
  </spine>
</package>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/Text/part0000.xhtml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p><img src="../Images/image00220.jpeg" alt=""/></p></body></html>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/Text/chapter.xhtml", deflated).unwrap();
    writer
        .write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>body</p></body></html>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/Images/image00220.jpeg", deflated).unwrap();
    writer.write_all(cover_bytes).unwrap();
    writer.finish().unwrap();
}

#[test]
fn epub_import_copies_source_without_unpacking_or_indexing() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-stream-import-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("streamed.epub");
    write_minimal_epub_file(&source, "Streamed Book", "streamed body");
    let storage = test_storage_with_books(&root, Vec::new());

    let book = import_single_epub_for_test(&storage, &source).unwrap();

    let book_dir = storage.book_dir(&book.id);
    assert_eq!(
        hash_file(&source).unwrap(),
        hash_file(&book_dir.join(BOOK_FILE)).unwrap()
    );
    assert_eq!(
        book.metadata.get("title").and_then(Value::as_str),
        Some("Streamed Book")
    );
    assert!(!book_dir.join(UNPACKED_DIR).exists());
    assert!(!storage.search_text_cache_path(&book.id, book.revision).exists());
    let persisted = serde_json::to_value(&book).unwrap();
    assert_eq!(
        persisted.get("sourcePath").and_then(Value::as_str),
        Some(path_to_client_string(&source).as_str())
    );
    assert_eq!(persisted.get("managed").and_then(Value::as_bool), Some(true));
    assert!(persisted.get("sourceStorage").is_none());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn referenced_epub_import_materializes_on_first_open() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-reference-import-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("referenced.epub");
    write_minimal_epub_file(&source, "Referenced Book", "referenced body");
    let storage = test_storage_with_books(&root, Vec::new());
    use_referenced_import_sources(&storage);

    let book = import_single_epub_for_test(&storage, &source).unwrap();
    let book_dir = storage.book_dir(&book.id);

    assert!(!book_dir.join(BOOK_FILE).exists());
    assert!(!book_dir.join(UNPACKED_DIR).exists());
    let persisted = serde_json::to_value(&book).unwrap();
    assert!(persisted.get("managed").is_none());
    assert!(persisted.get("sourceStorage").is_none());
    assert_eq!(
        persisted.get("sourcePath").and_then(Value::as_str),
        Some(path_to_client_string(&source).as_str())
    );

    let tasks = TaskService::default();
    let reader_book = storage.library_book(&book.id).unwrap();
    let reader_source = get_book_reader_source_impl(&storage, &tasks, &reader_book).unwrap();
    assert_eq!(reader_source.mode, BookReaderSourceMode::Opf);
    assert!(reader_source.path.ends_with("/unpacked/OEBPS/content.opf"));
    assert!(book_dir.join(UNPACKED_DIR).join("OEBPS/content.opf").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn external_epub_open_creates_external_record_without_library_entry() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-external-open-test-{}-{nonce}", std::process::id()));
    let source = root.join("external.epub");
    write_minimal_epub_file(&source, "External Book", "external body");
    let storage = test_storage_with_books(&root, Vec::new());

    let book = open_external_epub_path_impl(&storage, &source).unwrap();

    assert_eq!(book.id, id_from_hash(&hash_file(&source).unwrap()));
    assert!(matches!(book.scope, BookScope::External));
    assert_eq!(
        book.metadata.get("title").and_then(Value::as_str),
        Some("External Book")
    );
    let state = storage.inner.state.lock().unwrap();
    assert!(state.library.books.is_empty());
    assert_eq!(state.external.books.len(), 1);
    drop(state);

    let external_dir = external_books_root(storage.root()).join(&book.id);
    assert!(!external_dir.join(BOOK_FILE).exists());
    assert!(external_dir.join(UNPACKED_DIR).join("OEBPS/content.opf").exists());

    let loaded = get_book_impl(&storage, book.id.clone())
        .unwrap()
        .expect("external book should load by id");
    assert_eq!(loaded.id, book.id);
    assert!(matches!(loaded.scope, BookScope::External));

    let tasks = TaskService::default();
    let reader_book = storage.library_book(&book.id).unwrap();
    let source = get_book_reader_source_impl(&storage, &tasks, &reader_book).unwrap();
    assert_eq!(source.mode, BookReaderSourceMode::Opf);
    assert!(source.path.contains("/external-books/"));
    assert!(source.path.ends_with("/unpacked/OEBPS/content.opf"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn referenced_archive_only_epub_fails_after_source_disappears() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-archive-reference-missing-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("archive-only.epub");
    write_minimal_epub_with_invalid_windows_entry(&source);
    let storage = test_storage_with_books(&root, Vec::new());
    use_referenced_import_sources(&storage);

    let imported = import_single_epub_for_test(&storage, &source).unwrap();
    assert!(!storage.book_dir(&imported.id).join(BOOK_FILE).exists());
    let available = check_book_source_statuses_impl(&storage, vec![imported.id.clone()]).unwrap();
    assert_eq!(available.len(), 1);
    assert_eq!(available[0].status, BookSourceStatus::Available);
    fs::remove_file(&source).unwrap();

    let missing = check_book_source_statuses_impl(&storage, vec![imported.id.clone()]).unwrap();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].status, BookSourceStatus::Missing);

    let tasks = TaskService::default();
    let book = storage.library_book(&imported.id).unwrap();
    let error = get_book_reader_source_impl(&storage, &tasks, &book).unwrap_err();

    assert_eq!(error, "BOOK_SOURCE_MISSING");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn referenced_archive_only_epub_reports_changed_source() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-archive-reference-changed-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("archive-only.epub");
    write_minimal_epub_with_invalid_windows_entry(&source);
    let storage = test_storage_with_books(&root, Vec::new());
    use_referenced_import_sources(&storage);

    let imported = import_single_epub_for_test(&storage, &source).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"changed")
        .unwrap();

    let statuses = check_book_source_statuses_impl(&storage, vec![imported.id.clone()]).unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].status, BookSourceStatus::Changed);

    let tasks = TaskService::default();
    let book = storage.library_book(&imported.id).unwrap();
    let error = get_book_reader_source_impl(&storage, &tasks, &book).unwrap_err();
    assert_eq!(error, "BOOK_SOURCE_CHANGED");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn external_epub_cleanup_keeps_metadata_and_state_for_later_promotion() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-external-cleanup-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("external-cleanup.epub");
    write_minimal_epub_file(&source, "External Cleanup", "external body");
    let storage = test_storage_with_books(&root, Vec::new());
    let book = open_external_epub_path_impl(&storage, &source).unwrap();
    let external_dir = external_books_root(storage.root()).join(&book.id);

    fs::create_dir_all(external_dir.join(UNPACKED_DIR)).unwrap();
    fs::write(external_dir.join(UNPACKED_DIR).join("stale"), "stale").unwrap();
    storage
        .write_book_state(
            &book.id,
            &BookState {
                cfi: Some("epubcfi(/6/2)".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

    cleanup_external_book_heavy_files(&storage, &book.id).unwrap();

    assert!(!external_dir.join(BOOK_FILE).exists());
    assert!(!external_dir.join(UNPACKED_DIR).exists());
    assert!(external_dir.join(STATE_FILE).exists());
    let external_index = read_json_value_or_default(&external_index_path(storage.root()).unwrap()).unwrap();
    assert_eq!(
        external_index
            .pointer("/books/0/metadata/title")
            .and_then(Value::as_str),
        Some("External Cleanup")
    );

    let imported = import_single_epub_for_test(&storage, &source).unwrap();
    assert!(read_cover(&storage, &imported.id).unwrap().is_some());
    assert!(storage.book_dir(&imported.id).join(BOOK_FILE).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn external_epub_open_prefers_existing_library_book_by_hash() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-external-existing-library-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("existing.epub");
    write_minimal_epub_file(&source, "Existing Library", "existing body");
    let storage = test_storage_with_books(&root, Vec::new());
    let imported = import_single_epub_for_test(&storage, &source).unwrap();

    let opened = open_external_epub_path_impl(&storage, &source).unwrap();

    assert_eq!(opened.id, imported.id);
    assert!(matches!(opened.scope, BookScope::Library));
    let state = storage.inner.state.lock().unwrap();
    assert_eq!(state.library.books.len(), 1);
    assert!(state.external.books.is_empty());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn opening_managed_book_epub_uses_existing_book_without_hash_matching() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-managed-open-test-{}-{nonce}", std::process::id()));
    let source = root.join("source.epub");
    write_minimal_epub_file(&source, "Managed Original", "original body");
    let storage = test_storage_with_books(&root, Vec::new());
    let imported = import_single_epub_for_test(&storage, &source).unwrap();
    let managed_epub = storage.book_dir(&imported.id).join(BOOK_FILE);
    write_minimal_epub_file(&managed_epub, "Managed Edited", "edited body");
    {
        let mut state = storage.inner.state.lock().unwrap();
        state
            .library
            .books
            .iter_mut()
            .find(|book| book.id == imported.id)
            .unwrap()
            .metadata = json!({"title": "Edited Metadata", "custom": "kept"});
    }

    let opened = open_external_epub_path_impl(&storage, &managed_epub).unwrap();

    assert_eq!(opened.id, imported.id);
    assert!(matches!(opened.scope, BookScope::Library));
    assert_eq!(
        opened.metadata.get("title").and_then(Value::as_str),
        Some("Edited Metadata")
    );
    assert_eq!(opened.metadata.get("custom").and_then(Value::as_str), Some("kept"));
    let state = storage.inner.state.lock().unwrap();
    assert_eq!(state.library.books.len(), 1);
    assert!(state.external.books.is_empty());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn importing_open_external_epub_promotes_metadata_state_and_removes_external_record() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-external-promote-open-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("promote-open.epub");
    write_minimal_epub_file(&source, "Promote Open", "promote body");
    let storage = test_storage_with_books(&root, Vec::new());
    let external = open_external_epub_path_impl(&storage, &source).unwrap();
    assert_eq!(external.id, id_from_hash(&hash_file(&source).unwrap()));
    {
        let state = storage.inner.state.lock().unwrap();
        let persisted = serde_json::to_value(&state.external.books[0]).unwrap();
        assert_eq!(persisted["sourceFormat"], "epub");
        assert!(persisted.get("lastReadAt").is_some());
        assert!(persisted.get("lastOpenedAt").is_none());
    }
    {
        let mut state = storage.inner.state.lock().unwrap();
        state
            .external
            .books
            .iter_mut()
            .find(|book| book.id == external.id)
            .unwrap()
            .metadata = json!({"title": "Edited External", "custom": "kept"});
    }
    storage
        .write_book_state(&external.id, &external_promotion_state())
        .unwrap();
    fs::write(
        storage.external_book_dir(&external.id).join("promotion-marker.txt"),
        "preserved",
    )
    .unwrap();
    let moved_source = root.join("moved/promoted.epub");
    fs::create_dir_all(moved_source.parent().unwrap()).unwrap();
    fs::rename(&source, &moved_source).unwrap();

    let imported = import_single_epub_for_test(&storage, &moved_source).unwrap();

    assert_eq!(imported.id, external.id);
    assert_eq!(imported.name, "promoted.epub");
    assert_eq!(imported.source_path, path_to_client_string(&moved_source));
    assert_external_promoted(&storage, &imported, &external.id, &moved_source);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn importing_persisted_external_epub_promotes_disk_metadata_and_state() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-external-promote-disk-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("promote-disk.epub");
    write_minimal_epub_file(&source, "Promote Disk", "promote body");
    let storage = test_storage_with_books(&root, Vec::new());
    let external = open_external_epub_path_impl(&storage, &source).unwrap();
    {
        let mut state = storage.inner.state.lock().unwrap();
        state
            .external
            .books
            .iter_mut()
            .find(|book| book.id == external.id)
            .unwrap()
            .metadata = json!({"title": "Edited External", "custom": "kept"});
    }
    storage
        .write_book_state(&external.id, &external_promotion_state())
        .unwrap();
    fs::write(
        storage.external_book_dir(&external.id).join("promotion-marker.txt"),
        "preserved",
    )
    .unwrap();
    storage.mark_external_dirty();
    storage.flush_content_dirty().unwrap();

    let reloaded = test_storage_from_disk(&root);
    let imported = import_single_epub_for_test(&reloaded, &source).unwrap();

    assert_external_promoted(&reloaded, &imported, &external.id, &source);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn epub_import_extracts_cover_from_percent_encoded_zip_path() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-encoded-cover-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("encoded-cover.epub");
    let cover_bytes = b"encoded-cover-bytes";
    write_minimal_epub_with_percent_encoded_cover(&source, cover_bytes);
    let storage = test_storage_with_books(&root, Vec::new());

    let book = import_single_epub_for_test(&storage, &source).unwrap();

    let book_dir = storage.book_dir(&book.id);
    assert_eq!(fs::read(book_dir.join("cover.jpg")).unwrap(), cover_bytes);
    assert!(!book_dir.join("cover.svg").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn normalizes_non_square_pixel_png_dimensions() {
    let source_cover = synthetic_non_square_pixel_png();
    let normalized = normalize_non_square_pixel_png(&source_cover).unwrap();
    assert_eq!(png_dimensions(&normalized), (2, 2));
}

#[test]
fn epub_materialization_repairs_plain_png_cover_when_another_resource_is_encrypted() {
    let root = std::env::temp_dir().join(format!(
        "flow-reader-encrypted-resource-cover-test-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    let source = root.join("source.epub");
    let unpacked = root.join("unpacked");
    write_minimal_epub_with_xhtml_cover_image(
        &source,
        r#"<img src="../Images/real-cover.png"/>"#,
        "real-cover.png",
        "image/png",
        &synthetic_non_square_pixel_png(),
    );
    let file = fs::OpenOptions::new().read(true).write(true).open(&source).unwrap();
    let mut writer = ZipWriter::new_append(file).unwrap();
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer.start_file("META-INF/encryption.xml", deflated).unwrap();
    writer
        .write_all(
            br#"<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="urn:example:unrelated-resource"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/protected.bin"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>"#,
        )
        .unwrap();
    writer.start_file("OEBPS/protected.bin", deflated).unwrap();
    writer.write_all(b"encrypted resource").unwrap();
    writer.finish().unwrap();

    assert!(materialize_epub_package(&source, &unpacked).unwrap());
    assert_eq!(
        png_dimensions(&fs::read(unpacked.join("OEBPS/Images/real-cover.png")).unwrap()),
        (2, 2)
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn epub_import_extracts_cover_from_xhtml_img_cover_page() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-xhtml-img-cover-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("xhtml-img-cover.epub");
    let cover_bytes = b"xhtml-img-cover-bytes";
    write_minimal_epub_with_xhtml_cover_image(
        &source,
        r#"<div><img src="../Images/real-cover.jpeg" alt=""/></div>"#,
        "real-cover.jpeg",
        "image/jpeg",
        cover_bytes,
    );
    let storage = test_storage_with_books(&root, Vec::new());

    let book = import_single_epub_for_test(&storage, &source).unwrap();

    let book_dir = storage.book_dir(&book.id);
    assert_eq!(fs::read(book_dir.join("cover.jpeg")).unwrap(), cover_bytes);
    assert!(!book_dir.join("cover.svg").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn epub_import_extracts_cover_from_xhtml_svg_image_cover_page() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-xhtml-svg-cover-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("xhtml-svg-cover.epub");
    let cover_bytes = b"xhtml-svg-cover-bytes";
    write_minimal_epub_with_xhtml_cover_image(
        &source,
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../Images/real-cover.jpeg"/></svg>"#,
        "real-cover.jpeg",
        "image/jpeg",
        cover_bytes,
    );
    let storage = test_storage_with_books(&root, Vec::new());

    let book = import_single_epub_for_test(&storage, &source).unwrap();

    let book_dir = storage.book_dir(&book.id);
    assert_eq!(fs::read(book_dir.join("cover.jpeg")).unwrap(), cover_bytes);
    assert!(!book_dir.join("cover.svg").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn epub_import_uses_first_image_spine_page_when_cover_metadata_is_missing() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-first-image-cover-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("first-image-page.epub");
    let cover_bytes = b"first-image-cover-bytes";
    write_minimal_epub_with_first_image_spine_page(&source, cover_bytes);
    let storage = test_storage_with_books(&root, Vec::new());

    let book = import_single_epub_for_test(&storage, &source).unwrap();

    let book_dir = storage.book_dir(&book.id);
    assert_eq!(fs::read(book_dir.join("cover.jpeg")).unwrap(), cover_bytes);
    assert!(!book_dir.join("cover.svg").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn epub_import_command_returns_successes_when_later_source_fails() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-partial-import-test-{}-{nonce}",
        std::process::id()
    ));
    let source = root.join("valid.epub");
    let broken = root.join("broken.epub");
    write_minimal_epub_file(&source, "Valid Book", "valid body");
    fs::write(&broken, b"not an epub").unwrap();
    let storage = test_storage_with_books(&root, Vec::new());
    let tasks = TaskService::default();

    let result = import_epub_paths_impl(
        &storage,
        &tasks,
        vec![
            source.to_string_lossy().to_string(),
            broken.to_string_lossy().to_string(),
        ],
        None,
    )
    .unwrap();

    assert_eq!(result.books.len(), 1);
    assert_eq!(result.failures.len(), 1);
    assert_eq!(result.failures[0].filename, "broken.epub");
    assert_eq!(
        result.books[0].metadata.get("title").and_then(Value::as_str),
        Some("Valid Book")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn epub_import_resolves_content_and_path_identity_without_losing_local_changes() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-replace-cleanup-test-{}-{nonce}",
        std::process::id()
    ));
    let source_dir = root.join("first");
    let source = source_dir.join("replace.epub");
    write_minimal_epub_file(&source, "Old Book", "old body");
    let storage = test_storage_with_books(&root, Vec::new());
    let old_book = import_single_epub_for_test(&storage, &source).unwrap();
    {
        let mut state = storage.inner.state.lock().unwrap();
        state.library.books[0].metadata = json!({"title": "Custom title", "creator": "Custom author"});
    }
    let book_dir = storage.book_dir(&old_book.id);
    fs::create_dir_all(book_dir.join(UNPACKED_DIR)).unwrap();
    fs::write(book_dir.join(UNPACKED_DIR).join("stale.txt"), "stale").unwrap();
    let stale_cache_path = storage.search_text_cache_path(&old_book.id, old_book.revision);
    fs::write(&stale_cache_path, "stale").unwrap();

    let moved_source = root.join("moved/renamed.epub");
    fs::create_dir_all(moved_source.parent().unwrap()).unwrap();
    fs::rename(&source, &moved_source).unwrap();
    let renamed_book = import_single_epub_for_test(&storage, &moved_source).unwrap();
    assert_eq!(old_book.id, renamed_book.id);
    assert_eq!(renamed_book.name, "renamed.epub");
    assert_eq!(
        storage.library_book(&old_book.id).unwrap().source_path,
        moved_source.clone()
    );
    assert!(book_dir.join(UNPACKED_DIR).exists());
    assert!(stale_cache_path.exists());

    write_minimal_epub_file(&moved_source, "New Book", "new body");
    let new_book = import_single_epub_for_test(&storage, &moved_source).unwrap();

    assert_eq!(old_book.id, new_book.id);
    assert_eq!(
        new_book.metadata.get("title").and_then(Value::as_str),
        Some("Custom title")
    );
    assert_eq!(
        new_book.metadata.get("creator").and_then(Value::as_str),
        Some("Custom author")
    );
    assert!(!book_dir.join(UNPACKED_DIR).exists());
    assert!(!stale_cache_path.exists());

    let other_source = root.join("second/renamed.epub");
    write_minimal_epub_file(&other_source, "Another Book", "another body");
    let other_book = import_single_epub_for_test(&storage, &other_source).unwrap();
    assert_ne!(old_book.id, other_book.id);
    assert_eq!(storage.inner.state.lock().unwrap().library.books.len(), 2);

    mark_library_book_content_updated(&storage, &old_book.id).unwrap();
    write_minimal_epub_file(&moved_source, "Conflicting Book", "conflicting body");
    let result = import_epub_paths_impl(
        &storage,
        &TaskService::default(),
        vec![moved_source.to_string_lossy().to_string()],
        None,
    )
    .unwrap();
    assert!(result.books.is_empty());
    assert!(result.failures.is_empty());
    assert_eq!(result.skipped, vec!["renamed.epub"]);
    let preserved = storage.library_book(&old_book.id).unwrap();
    assert!(preserved.content_edited_at.is_some());
    assert_eq!(
        preserved.metadata.get("title").and_then(Value::as_str),
        Some("Custom title")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn unpack_package_reuses_in_flight_task_for_same_book_revision() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-unpack-idempotent-test-{}-{nonce}",
        std::process::id()
    ));
    let storage = Arc::new(test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub)));
    fs::create_dir_all(storage.book_dir("book")).unwrap();
    fs::write(storage.book_dir("book").join(BOOK_FILE), b"placeholder").unwrap();
    let tasks = Arc::new(TaskService::default());
    let runs = Arc::new(AtomicUsize::new(0));
    let book = storage.library_book("book").unwrap();

    let first = {
        let storage = Arc::clone(&storage);
        let tasks = Arc::clone(&tasks);
        let runs = Arc::clone(&runs);
        let book = book.clone();
        thread::spawn(move || {
            ensure_book_package_path_with_unpacker(&storage, &tasks, &book, |_, dest| {
                runs.fetch_add(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(100));
                write_minimal_unpacked_package(dest, "first");
                Ok(())
            })
        })
    };

    thread::sleep(Duration::from_millis(20));

    let second = {
        let storage = Arc::clone(&storage);
        let tasks = Arc::clone(&tasks);
        let runs = Arc::clone(&runs);
        thread::spawn(move || {
            ensure_book_package_path_with_unpacker(&storage, &tasks, &book, |_, dest| {
                runs.fetch_add(1, Ordering::SeqCst);
                write_minimal_unpacked_package(dest, "second");
                Ok(())
            })
        })
    };

    let first_path = first.join().unwrap().unwrap();
    let second_path = second.join().unwrap().unwrap();

    assert_eq!(first_path, second_path);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    let published = fs::read_to_string(first_path).unwrap();
    assert!(published.contains("first") || published.contains("second"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn stale_unpack_result_is_not_published() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-unpack-stale-test-{}-{nonce}", std::process::id()));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
    fs::create_dir_all(storage.book_dir("book")).unwrap();
    fs::write(storage.book_dir("book").join(BOOK_FILE), b"placeholder").unwrap();
    let tasks = TaskService::default();
    let book = storage.library_book("book").unwrap();

    let result = ensure_book_package_path_with_unpacker(&storage, &tasks, &book, |_, dest| {
        write_minimal_unpacked_package(dest, "stale");
        let mut state = storage.inner.state.lock().unwrap();
        let book = state.library.books.iter_mut().find(|book| book.id == "book").unwrap();
        book.content_hash = "changed".to_string();
        book.revision = book.revision.saturating_add(1);
        Ok(())
    });

    assert!(result.is_err());
    assert!(!storage.book_dir("book").join(UNPACKED_DIR).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_unpack_does_not_expose_partial_directory() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-unpack-atomic-test-{}-{nonce}", std::process::id()));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
    fs::create_dir_all(storage.book_dir("book")).unwrap();
    fs::write(storage.book_dir("book").join(BOOK_FILE), b"placeholder").unwrap();
    let tasks = TaskService::default();
    let book = storage.library_book("book").unwrap();

    let result = ensure_book_package_path_with_unpacker(&storage, &tasks, &book, |_, dest| {
        fs::create_dir_all(dest.join("OEBPS")).unwrap();
        fs::write(dest.join("OEBPS").join("partial.xhtml"), "partial").unwrap();
        Err("unpack failed".to_string())
    });

    assert!(result.is_err());
    assert!(!storage.book_dir("book").join(UNPACKED_DIR).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_only_epub_reader_source_returns_original_package_without_unpacking() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-archive-reader-source-test-{}-{nonce}",
        std::process::id()
    ));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
    let book_dir = storage.book_dir("book");
    let book_path = book_dir.join(BOOK_FILE);
    write_minimal_epub_with_invalid_windows_entry(&book_path);
    let tasks = TaskService::default();
    let book = storage.library_book("book").unwrap();

    let source = get_book_reader_source_impl(&storage, &tasks, &book).unwrap();

    assert_eq!(source.mode, BookReaderSourceMode::Epub);
    assert_eq!(source.path, path_to_client_string(&book_path));
    assert!(!book_dir.join(UNPACKED_DIR).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_only_epub_search_reads_sections_from_package() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-archive-search-test-{}-{nonce}",
        std::process::id()
    ));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
    let book_dir = storage.book_dir("book");
    write_minimal_epub_with_invalid_windows_entry(&book_dir.join(BOOK_FILE));
    let tasks = TaskService::default();
    let book = storage.library_book("book").unwrap();

    let cache = load_or_build_search_text_cache(&storage, &tasks, &book).unwrap();
    let hits = search_text_in_cache(&cache, "非法路径章节", None);

    assert_eq!(cache.sections.len(), 2);
    assert!(
        cache
            .sections
            .iter()
            .any(|section| section.href == "Text/invalid:path.xhtml" && section.text.contains("非法路径章节 keyword"))
    );
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "Text/invalid:path.xhtml");
    let cache_path = storage.search_text_cache_path(&book.id, book.revision);
    assert_eq!(cache_path.file_name().unwrap(), "search-text.v1.r1.json.zst");
    assert!(!cache_path.exists());
    storage.set_derived_cache_active(&book.id, false).unwrap();
    assert!(cache_path.exists());
    assert!(!book_dir.join(UNPACKED_DIR).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_only_epub_text_replacement_is_not_supported() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-archive-replace-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Epub);
    book.content_mode = BookContentMode::ArchiveOnly;
    let storage = test_storage_with_book(&root, book);
    let book_dir = storage.book_dir("book");
    write_minimal_epub_with_invalid_windows_entry(&book_dir.join(BOOK_FILE));
    let target = BookTextReplaceTarget {
        section_href: "Text/invalid:path.xhtml".to_string(),
        text_node_index: 0,
        text_node_text: "非法路径章节 keyword。".to_string(),
        start_offset: 0,
        end_offset: 2,
        paragraph_index: None,
    };

    let error = replace_book_text_impl(
        &storage,
        "book".to_string(),
        target,
        "非法".to_string(),
        "替换".to_string(),
    )
    .unwrap_err();

    assert!(error.contains("Archive-only EPUB"));
    assert!(!book_dir.join(UNPACKED_DIR).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_only_epub_export_copies_original_package_without_unpacking() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-archive-export-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Epub);
    book.content_mode = BookContentMode::ArchiveOnly;
    let storage = test_storage_with_book(&root, book);
    let book_dir = storage.book_dir("book");
    let book_path = book_dir.join(BOOK_FILE);
    write_minimal_epub_with_invalid_windows_entry(&book_path);
    let original = fs::read(&book_path).unwrap();
    let output = root.join("exported.epub");

    export_book_impl(&storage, "book".to_string(), BookExportFormat::Epub, output.clone())
        .unwrap()
        .unwrap();

    assert_eq!(fs::read(output).unwrap(), original);
    assert!(!book_dir.join(UNPACKED_DIR).exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn record_reading_position_persists_state_before_library_flush() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-position-flush-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Txt);
    book.metadata = json!({ "sourceEncodingId": "utf-8" });
    book.updated_at = Some(100);
    let storage = test_storage_with_book(&root, book);

    let accepted = record_reading_position_impl(
        &storage,
        reading_position_input("epubcfi(/6/8)", 0.8, json!({"version": 1}), 300),
    )
    .expect("position update should not error");
    assert!(accepted);

    {
        let state = storage.inner.state.lock().unwrap();
        let stored = &state.library.books[0];
        assert_eq!(stored.updated_at, Some(100));
        assert_eq!(stored.last_read_at, Some(300));
    }

    assert!(!library_path(&root).unwrap().exists());
    let state = fs::read_to_string(root.join("books").join("book").join(STATE_FILE)).unwrap();
    assert!(state.contains(r#""cfi": "epubcfi(/6/8)""#));
    assert!(state.contains(r#""percentage": 0.8"#));

    storage.flush_content_dirty().expect("dirty position should flush");

    let library = fs::read_to_string(library_path(&root).unwrap()).unwrap();
    assert!(library.contains(r#""cfi": "epubcfi(/6/8)""#));
    assert!(library.contains(r#""percentage": 0.8"#));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_flush_keeps_library_dirty_for_retry() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-flush-retry-test-{}-{nonce}", std::process::id()));
    let storage = test_storage_with_books(&root, vec![test_library_book(BookSourceFormat::Epub)]);
    let path = library_path(&root).unwrap();
    fs::create_dir_all(&path).unwrap();
    storage.mark_library_dirty();

    assert!(storage.flush_content_dirty().is_err());
    assert!(storage.inner.dirty.lock().unwrap().library);

    fs::remove_dir(&path).unwrap();
    storage
        .flush_content_dirty()
        .expect("dirty library should be retryable");
    assert!(!storage.inner.dirty.lock().unwrap().library);
    assert!(path.is_file());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn bounded_epub_read_rejects_content_past_the_limit() {
    let result = read_bounded_bytes(Cursor::new(b"123456789"), 8, "Synthetic EPUB entry");

    assert!(result.is_err());
}

#[test]
fn normalizes_common_publication_date_formats() {
    let cases = [
        ("2020/1/1", "2020-01-01"),
        ("2020-1-1 12:34:56", "2020-01-01"),
        ("2020.1.1T12:34:56Z", "2020-01-01"),
        ("2020年1月1日", "2020-01-01"),
        ("20200101", "2020-01-01"),
        ("202001", "2020-01"),
        ("2020-01", "2020-01"),
        ("2020", "2020"),
    ];

    for (input, expected) in cases {
        assert_eq!(normalize_publication_date(input), expected);
    }
}

#[test]
fn leaves_unrecognized_publication_dates_unchanged() {
    let cases = ["2020/13/1", "not a date"];

    for input in cases {
        assert_eq!(normalize_publication_date(input), input);
    }
}

#[test]
fn parses_text_import_chapter_hierarchy() {
    let text = "第一卷 起始\n第001章 开端\n第一段正文。\n第二段正文。\n第002章 继续\n第三段正文。";
    let document = parse_text_import_document(text, "测试书", None);

    assert_eq!(document.sections.len(), 3);
    assert_eq!(document.sections[0].title, "第一卷 起始");
    assert_eq!(document.sections[1].parent.as_deref(), Some("第一卷 起始"));
    assert_eq!(document.sections[1].title, "第001章 开端");
    assert_eq!(document.sections[2].title, "第002章 继续");
    assert_eq!(document.chapters[0].role, "group");
    assert_eq!(document.chapters[1].role, "chapter");
}

#[test]
fn generates_valid_text_import_opf_metadata() {
    let mut document = parse_text_import_document("第1章 开始\n正文。", "测试书", None);
    document.creator = "作者".to_string();
    let opf = text_content_opf(&document, "GB18030");

    assert!(opf.contains(r#"<dc:title>测试书</dc:title>"#));
    assert!(opf.contains(r#"<dc:creator>作者</dc:creator>"#));
    assert!(opf.contains(r#"<meta name="cover" content="cover-image"/>"#));
    assert!(opf.contains(r#"<meta property="source-format">txt</meta>"#));
    assert!(opf.contains(r#"<meta property="source-encoding">GB18030</meta>"#));
    assert!(opf.contains(
        r#"<item id="cover-image" href="Images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>"#
    ));
    assert!(!opf.contains("cover.xhtml"));
    assert!(!opf.contains("flow:source"));
}

#[test]
fn detects_large_utf8_text_before_legacy_candidates() {
    let text = "第一章 UTF-8 文本\n这是合法的 UTF-8 中文内容。\n".repeat(20_000);
    let decoded = decode_text_bytes(text.as_bytes(), None);

    assert_eq!(decoded.encoding, "utf-8");
}

#[test]
fn marks_generated_text_body_on_container_only() {
    let document = parse_text_import_document("第1章 开始\n第一段。\n第二段。", "测试书", None);
    let xhtml = text_section_xhtml(&document.sections[0]);

    assert!(xhtml.contains(r#"<div class="flow-txt-body" data-flow-body-text="true">"#));
    assert!(xhtml.contains("<p>第一段。</p>"));
    assert!(!xhtml.contains(r#"<p class="flow-txt-body""#));
}

#[test]
fn creates_standalone_centered_group_section_before_its_first_chapter() {
    let text = "第一卷 分组甲\n\n第一章 章节甲\n示例正文。";
    let document = parse_text_import_document(text, "测试书", None);

    assert_eq!(document.sections.len(), 2);

    let group = text_section_xhtml(&document.sections[0]);
    let chapter = text_section_xhtml(&document.sections[1]);
    let css = super::text_import::text_import_css();
    let nav = text_nav_xhtml(&document);
    let opf = text_content_opf(&document, "UTF-8");

    assert!(document.sections[0].paragraphs.is_empty());
    assert_eq!(document.sections[1].paragraphs, vec!["示例正文。".to_string()]);
    assert!(group.contains(r#"<body class="flow-txt-volume-page">"#));
    assert!(group.contains(r#"<h1 class="flow-txt-volume">第一卷 分组甲</h1>"#));
    assert!(chapter.contains(r#"<h2 class="flow-txt-chapter">第一章 章节甲</h2>"#));
    assert!(!chapter.contains("第一卷 分组甲 第一章 章节甲"));
    assert!(css.contains("align-items: center;"));
    assert!(css.contains("justify-content: center;"));
    assert!(css.contains(".flow-txt-volume {\n  font-size: 1.45em;"));
    assert!(css.contains(".flow-txt-chapter {\n  font-size: 1.25em;"));
    assert!(nav.contains(
            r#"<li id="txt-group-0001"><a href="Text/part0001.xhtml">第一卷 分组甲</a><ol><li><a href="Text/part0002.xhtml">第一章 章节甲</a></li>"#
        ));
    assert!(opf.contains(r#"<itemref idref="part0001"/>"#));
    assert!(opf.contains(r#"<itemref idref="part0002"/>"#));
}

#[test]
fn accepts_custom_text_import_heading_rules() {
    let rules = TextImportRulesInput {
        group_patterns: vec![r"^\s*幕\s+\d+".to_string()],
        chapter_patterns: vec![r"^\s*场\s+\d+".to_string()],
        filename_patterns: Vec::new(),
    };
    let text = "幕 1\n场 1\n第一段正文。\n场 2\n第二段正文。";
    let document = parse_text_import_document(text, "测试书", Some(&rules));

    assert_eq!(document.sections.len(), 3);
    assert_eq!(document.sections[0].title, "幕 1");
    assert_eq!(document.sections[1].parent.as_deref(), Some("幕 1"));
    assert_eq!(document.sections[1].title, "场 1");
    assert_eq!(document.sections[2].title, "场 2");
}

#[test]
fn resolves_text_import_filename_templates_as_ordered_full_matches() {
    let default_metadata = text_import_filename_metadata(Path::new("《示例书》.txt"), None);
    assert_eq!(default_metadata.title, "示例书");
    assert_eq!(default_metadata.creator, "");

    let author_metadata = text_import_filename_metadata(Path::new("《示例书》 - 作者：示例作者.txt"), None);
    assert_eq!(author_metadata.title, "示例书");
    assert_eq!(author_metadata.creator, "示例作者");

    let rules = TextImportRulesInput {
        filename_patterns: vec![
            "《$title》".to_string(),
            "《$title》作者：$author".to_string(),
            "$title".to_string(),
        ],
        group_patterns: Vec::new(),
        chapter_patterns: Vec::new(),
    };
    let parsed_metadata = text_import_filename_metadata(Path::new("《示例书》作者：示例作者.txt"), Some(&rules));
    assert_eq!(parsed_metadata.title, "示例书");
    assert_eq!(parsed_metadata.creator, "示例作者");
}

#[test]
fn generated_text_nav_groups_have_stable_ids() {
    let text = "第一卷 起始\n第001章 开端\n第一段正文。";
    let document = parse_text_import_document(text, "测试书", None);
    let nav = text_nav_xhtml(&document);

    assert!(nav.contains(r#"<li id="txt-group-0001"><a href="Text/part0001.xhtml">第一卷 起始</a><ol>"#));
}

#[test]
fn extracts_visible_text_for_search_cache() {
    let xhtml = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>不应进入搜索</title>
  <style>.hidden { display: none; }</style>
  <script>window.hidden = "不应进入搜索";</script>
</head>
<body>
  <h1>第一章</h1>
  <p>Alpha target &amp; beta platform</p>
  <p>Second <span>paragraph</span>.</p>
</body>
</html>"#;

    let text = visible_search_text_from_xhtml(xhtml);

    assert_eq!(text, "第一章\nAlpha target & beta platform\nSecond paragraph.");
    assert!(!text.contains("不应进入搜索"));
}

#[test]
fn persists_search_text_cache_as_zstd_payload() {
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 2,
        sections: vec![SearchTextSection {
            section_index: 0,
            href: "Text/chapter.xhtml".to_string(),
            title: Some("Chapter One".to_string()),
            nav_path: Vec::new(),
            text: "The target phrase appears once.".to_string(),
        }],
    };

    let bytes = search_text_cache_to_bytes(&cache).expect("cache should encode");
    let restored = search_text_cache_from_bytes(&bytes).expect("cache should decode");

    assert_eq!(restored, cache);
    let json = zstd::stream::decode_all(bytes.as_slice()).unwrap();
    let json: Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(json["version"], SEARCH_TEXT_CACHE_VERSION);
    assert_eq!(json["revision"], 2);
    assert!(json.get("contentVersion").is_none());
}

#[test]
fn writes_image_index_cache_only_for_current_book_revision() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-image-index-cache-test-{}-{nonce}",
        std::process::id()
    ));
    let book = test_library_book_with_id("book", BookSourceFormat::Epub);
    let storage = test_storage_with_book(&root, book.clone());
    fs::create_dir_all(storage.book_dir(&book.id)).unwrap();

    let input = ImageIndexCache {
        version: IMAGE_INDEX_CACHE_VERSION,
        revision: book.revision,
        sections: vec![ImageIndexSection {
            index: 0,
            href: "Text/chapter.xhtml".to_string(),
            images: vec![ImageIndexEntry {
                src: "../Images/p001.jpg".to_string(),
                index: 0,
                hidden_by_default: false,
                reason: None,
            }],
        }],
    };

    assert!(write_image_index_cache_if_current(&storage, &book.id, &input).unwrap());
    assert_eq!(
        storage
            .image_index_cache_path(&book.id, book.revision)
            .file_name()
            .unwrap(),
        "image-index.v1.r1.json.zst"
    );
    let cache = read_image_index_cache(&storage, &book).unwrap();
    assert_eq!(cache.sections.len(), 1);
    assert_eq!(cache.sections[0].images[0].src, "../Images/p001.jpg");

    let stale = ImageIndexCache {
        version: IMAGE_INDEX_CACHE_VERSION,
        revision: book.revision + 1,
        sections: Vec::new(),
    };
    assert!(!write_image_index_cache_if_current(&storage, &book.id, &stale).unwrap());
    let cache = read_image_index_cache(&storage, &book).unwrap();
    assert_eq!(cache.sections.len(), 1);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn searches_in_cached_section_text_with_occurrences() {
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 1,
        sections: vec![
            SearchTextSection {
                section_index: 0,
                href: "Text/one.xhtml".to_string(),
                title: Some("Chapter One".to_string()),
                nav_path: Vec::new(),
                text: "This section has no match.".to_string(),
            },
            SearchTextSection {
                section_index: 1,
                href: "Text/two.xhtml".to_string(),
                title: Some("Chapter Two".to_string()),
                nav_path: Vec::new(),
                text: "The target phrase appears here. Later the target phrase appears again.".to_string(),
            },
        ],
    };

    let results = search_text_in_cache(&cache, "target phrase", Some(20));

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "Text/two.xhtml");
    assert_eq!(results[0].excerpt, "Chapter Two");
    assert_eq!(results[0].subitems.len(), 2);
    assert_eq!(results[0].section_index, 1);
    assert_eq!(results[0].subitems[0].occurrence, 0);
    assert!(results[0].subitems[0].id.ends_with(":0:4"));
    assert!(results[0].subitems[0].excerpt.contains("target phrase appears"));
    assert_eq!(results[0].subitems[1].occurrence, 1);
}

#[test]
fn search_results_serialize_section_context_once_per_group() {
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 1,
        sections: vec![SearchTextSection {
            section_index: 7,
            href: "Text/chapter.xhtml".to_string(),
            title: Some("Chapter".to_string()),
            nav_path: Vec::new(),
            text: "target phrase".to_string(),
        }],
    };

    let value = serde_json::to_value(search_text_in_cache(&cache, "target", None)).unwrap();
    let group = &value[0];
    let hit = &group["subitems"][0];

    assert_eq!(group["sectionIndex"], 7);
    assert!(hit.get("sectionIndex").is_none());
    assert!(hit.get("href").is_none());
    assert!(hit.get("offset").is_none());
}

#[test]
fn search_offsets_reference_original_text_when_lowercase_expands() {
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 1,
        sections: vec![SearchTextSection {
            section_index: 0,
            href: "Text/chapter.xhtml".to_string(),
            title: Some("Chapter".to_string()),
            nav_path: Vec::new(),
            text: "İx target phrase".to_string(),
        }],
    };

    let results = search_text_in_cache(&cache, "TARGET", None);

    assert!(results[0].subitems[0].id.ends_with(":0:3"));
    assert!(results[0].subitems[0].excerpt.contains("target phrase"));
}

#[test]
fn searches_cached_text_without_default_result_limit() {
    let sections = (0..1001)
        .map(|index| SearchTextSection {
            section_index: index,
            href: format!("Text/{index:04}.xhtml"),
            title: Some(format!("Chapter {index}")),
            nav_path: Vec::new(),
            text: "target phrase".to_string(),
        })
        .collect();
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 1,
        sections,
    };

    let results = search_text_in_cache(&cache, "target phrase", None);
    let result_count = results.iter().map(|result| result.subitems.len()).sum::<usize>();

    assert_eq!(result_count, 1001);
}

#[test]
fn search_excerpt_stays_within_matching_paragraph() {
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 1,
        sections: vec![SearchTextSection {
            section_index: 0,
            href: "Text/chapter.xhtml".to_string(),
            title: Some("Chapter".to_string()),
            nav_path: Vec::new(),
            text: [
                "First paragraph should not be included.",
                "Second paragraph has the target phrase and only this paragraph should be shown.",
                "Third paragraph should not be included.",
            ]
            .join("\n"),
        }],
    };

    let results = search_text_in_cache(&cache, "target phrase", Some(20));
    let excerpt = &results[0].subitems[0].excerpt;

    assert!(excerpt.contains("Second paragraph has the target phrase"));
    assert!(!excerpt.contains("First paragraph"));
    assert!(!excerpt.contains("Third paragraph"));
}

#[test]
fn search_excerpt_trims_long_matching_paragraph_only() {
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 1,
        sections: vec![SearchTextSection {
            section_index: 0,
            href: "Text/chapter.xhtml".to_string(),
            title: Some("Chapter".to_string()),
            nav_path: Vec::new(),
            text: [
                "Previous paragraph should not leak into the excerpt.",
                &format!("{} target phrase {}", "before ".repeat(40), "after ".repeat(40)),
                "Next paragraph should not leak into the excerpt.",
            ]
            .join("\n"),
        }],
    };

    let results = search_text_in_cache(&cache, "target phrase", Some(20));
    let excerpt = &results[0].subitems[0].excerpt;

    assert!(excerpt.starts_with('…'));
    assert!(excerpt.ends_with('…'));
    assert!(excerpt.contains("target phrase"));
    assert!(!excerpt.contains("Previous paragraph"));
    assert!(!excerpt.contains("Next paragraph"));
}

#[test]
fn uses_cached_nav_path_for_search_result_group() {
    let cache = SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        revision: 1,
        sections: vec![SearchTextSection {
            section_index: 0,
            href: "Text/chapter0002.xhtml".to_string(),
            title: Some("Chapter Two".to_string()),
            nav_path: vec!["Part One".to_string()],
            text: "The target phrase appears here.".to_string(),
        }],
    };

    let results = search_text_in_cache(&cache, "target phrase", Some(20));

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].excerpt, "Chapter Two");
    assert_eq!(results[0].description.as_deref(), Some("Part One"));
}

#[test]
fn reads_search_text_sections_from_unpacked_spine_order() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-search-cache-test-{}-{nonce}", std::process::id()));
    let meta_inf = root.join("META-INF");
    let oebps = root.join("OEBPS");
    let text_dir = oebps.join("Text");
    fs::create_dir_all(&meta_inf).unwrap();
    fs::create_dir_all(&text_dir).unwrap();

    fs::write(
        meta_inf.join("container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .unwrap();
    fs::write(
        oebps.join("content.opf"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="two" href="Text/two.xhtml" media-type="application/xhtml+xml"/>
    <item id="one" href="Text/one.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="one"/>
    <itemref idref="two"/>
  </spine>
</package>"#,
    )
    .unwrap();
    fs::write(
        text_dir.join("one.xhtml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>The target phrase appears.</p></body></html>"#,
    )
    .unwrap();
    fs::write(
        text_dir.join("two.xhtml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter Two</h1><p>Another paragraph.</p></body></html>"#,
    )
    .unwrap();

    let sections = read_search_text_sections_from_unpacked(&root).unwrap();

    assert_eq!(sections.len(), 2);
    assert_eq!(sections[0].section_index, 0);
    assert_eq!(sections[0].href, "Text/one.xhtml");
    assert_eq!(sections[0].title.as_deref(), Some("Chapter One"));
    assert_eq!(sections[0].text, "Chapter One\nThe target phrase appears.");
    assert_eq!(sections[1].section_index, 1);
    assert_eq!(sections[1].href, "Text/two.xhtml");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reads_epub3_nav_titles_and_parent_paths_for_search_sections() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-search-nav-test-{}-{nonce}", std::process::id()));
    let meta_inf = root.join("META-INF");
    let oebps = root.join("OEBPS");
    let text_dir = oebps.join("Text");
    let nav_dir = oebps.join("nav");
    fs::create_dir_all(&meta_inf).unwrap();
    fs::create_dir_all(&text_dir).unwrap();
    fs::create_dir_all(&nav_dir).unwrap();

    fs::write(
        meta_inf.join("container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .unwrap();
    fs::write(
        oebps.join("content.opf"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="nav" href="nav/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="Text/chapter0002.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>"#,
    )
    .unwrap();
    fs::write(
        nav_dir.join("nav.xhtml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><span>Part One</span>
        <ol>
          <li><a href="../Text/chapter0002.xhtml">Chapter Two</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>"#,
    )
    .unwrap();
    fs::write(
            text_dir.join("chapter0002.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Inline Heading</h1><p>The target phrase appears.</p></body></html>"#,
        )
        .unwrap();

    let sections = read_search_text_sections_from_unpacked(&root).unwrap();

    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].href, "Text/chapter0002.xhtml");
    assert_eq!(sections[0].title.as_deref(), Some("Chapter Two"));
    assert_eq!(sections[0].nav_path, vec!["Part One"]);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reads_ncx_titles_for_search_sections() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-search-ncx-test-{}-{nonce}", std::process::id()));
    let meta_inf = root.join("META-INF");
    let oebps = root.join("OEBPS");
    let text_dir = oebps.join("Text");
    fs::create_dir_all(&meta_inf).unwrap();
    fs::create_dir_all(&text_dir).unwrap();

    fs::write(
        meta_inf.join("container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .unwrap();
    fs::write(
        oebps.join("content.opf"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter" href="Text/chapter318.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter"/>
  </spine>
</package>"#,
    )
    .unwrap();
    fs::write(
        oebps.join("toc.ncx"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN"
   "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>Chapter Three Hundred Eighteen</text></navLabel>
      <content src="Text/chapter318.html"/>
    </navPoint>
  </navMap>
</ncx>"#,
    )
    .unwrap();
    fs::write(
            text_dir.join("chapter318.html"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"
  "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><body><h2>Inline Heading</h2><p>The target phrase appears.</p></body></html>"#,
        )
        .unwrap();

    let sections = read_search_text_sections_from_unpacked(&root).unwrap();

    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].href, "Text/chapter318.html");
    assert_eq!(sections[0].title.as_deref(), Some("Chapter Three Hundred Eighteen"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replaces_selected_xhtml_text_node_by_dom_index() {
    let xhtml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>alpha</p><p>\r\nbeta target gamma\r\n</p></body></html>";
    let target = BookTextReplaceTarget {
        section_href: "Text/chapter.xhtml".to_string(),
        text_node_index: 1,
        text_node_text: "\nbeta target gamma\n".to_string(),
        start_offset: 6,
        end_offset: 12,
        paragraph_index: None,
    };

    let updated = replace_xhtml_text_node(xhtml, &target, "target", "fixed").expect("replace succeeds");

    assert!(updated.contains("<p>alpha</p>"));
    assert!(updated.contains("<p>\r\nbeta fixed gamma\r\n</p>"));
}

#[test]
fn epub_replacement_updates_unique_xhtml_heading_without_updating_navigation() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-heading-replace-test-{}-{nonce}",
        std::process::id()
    ));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
    let book_dir = storage.book_dir("book");
    let unpacked = book_dir.join(UNPACKED_DIR);
    let oebps = unpacked.join("OEBPS");
    let text_dir = oebps.join("Text");
    fs::create_dir_all(&text_dir).unwrap();
    fs::create_dir_all(unpacked.join("META-INF")).unwrap();
    fs::write(
        unpacked.join("META-INF").join("container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
    )
    .unwrap();
    fs::write(oebps.join("content.opf"), "<package/>").unwrap();
    let original_nav = r#"<?xml version="1.0" encoding="UTF-8"?><html><body><nav><ol><li><a href="Text/volume.xhtml">Volume One</a></li></ol></nav></body></html>"#;
    fs::write(oebps.join("nav.xhtml"), original_nav).unwrap();
    fs::write(
        text_dir.join("volume.xhtml"),
        r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Volume One</h1><p>Body text.</p></body></html>"#,
    )
    .unwrap();

    replace_book_text_impl(
        &storage,
        "book".to_string(),
        BookTextReplaceTarget {
            section_href: "Text/volume.xhtml".to_string(),
            text_node_index: 99,
            text_node_text: "Volume One".to_string(),
            start_offset: 7,
            end_offset: 10,
            paragraph_index: None,
        },
        "One".to_string(),
        "Two".to_string(),
    )
    .expect("unique EPUB heading replacement succeeds when the rendered text node index differs");

    assert!(
        fs::read_to_string(text_dir.join("volume.xhtml"))
            .unwrap()
            .contains("<h1>Volume Two</h1>")
    );
    assert_eq!(fs::read_to_string(oebps.join("nav.xhtml")).unwrap(), original_nav);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn escapes_replacement_when_rewriting_xhtml_text_node() {
    let xhtml = r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>A &amp; B target</p></body></html>"#;
    let target = BookTextReplaceTarget {
        section_href: "Text/chapter.xhtml".to_string(),
        text_node_index: 0,
        text_node_text: "A & B target".to_string(),
        start_offset: 6,
        end_offset: 12,
        paragraph_index: None,
    };

    let updated = replace_xhtml_text_node(xhtml, &target, "target", "C < D & E").expect("replace succeeds");

    assert!(updated.contains("<p>A &amp; B C &lt; D &amp; E</p>"));
}

#[test]
fn txt_xhtml_replacement_does_not_fall_back_to_rendered_text_node_index() {
    let xhtml = r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h2 class="flow-txt-chapter">第001章 测试</h2><div class="flow-txt-body" data-flow-body-text="true"><p>重复错字。</p><p>重复错字。</p></div></body></html>"#;
    let target = BookTextReplaceTarget {
        section_href: "Text/part0001.xhtml".to_string(),
        text_node_index: 2,
        text_node_text: "重复错字。".to_string(),
        start_offset: 2,
        end_offset: 4,
        paragraph_index: None,
    };

    let result = replace_xhtml_text(xhtml, BookSourceFormat::Txt, &target, "错字", "正字");

    assert!(matches!(
        result,
        Err(error) if error == "TEXT_REPLACE_NODE_STALE"
    ));
}

#[test]
fn txt_replacement_uses_paragraph_index_when_rendered_text_node_index_is_stale() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-txt-paragraph-replace-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Txt);
    book.metadata = json!({ "sourceEncodingId": "utf-8" });
    let storage = test_storage_with_book(&root, book);
    let book_dir = storage.book_dir("book");
    let unpacked = book_dir.join(UNPACKED_DIR);
    let text_dir = unpacked.join("OEBPS").join("Text");
    fs::create_dir_all(&text_dir).unwrap();
    fs::create_dir_all(unpacked.join("META-INF")).unwrap();
    fs::write(
            unpacked.join("META-INF").join("container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
    fs::write(unpacked.join("OEBPS").join("content.opf"), "<package/>").unwrap();
    fs::write(unpacked.join("OEBPS").join("nav.xhtml"), "<nav/>").unwrap();
    fs::write(
            text_dir.join("part0001.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第001章 测试</title></head><body>
<h2 class="flow-txt-chapter">第001章 测试</h2><div class="flow-txt-body" data-flow-body-text="true"><p>第一段原文。</p><p>第二段错字。</p></div></body></html>"#,
        )
        .unwrap();
    fs::write(
        book_dir.join(SOURCE_TEXT_FILE),
        "第001章 测试\n第一段原文。\n第二段错字。\n",
    )
    .unwrap();

    let target = BookTextReplaceTarget {
        section_href: "Text/part0001.xhtml".to_string(),
        text_node_index: 99,
        text_node_text: "第二段错字。".to_string(),
        start_offset: 3,
        end_offset: 5,
        paragraph_index: Some(1),
    };

    let result = replace_book_text_impl(
        &storage,
        "book".to_string(),
        target,
        "错字".to_string(),
        "正字".to_string(),
    )
    .expect("paragraph replacement succeeds without rendered node index");

    assert!(result.changed);
    assert!(
        fs::read_to_string(text_dir.join("part0001.xhtml"))
            .unwrap()
            .contains("<p>第二段正字。</p>")
    );
    assert_eq!(
        fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
        "第001章 测试\n第一段原文。\n第二段正字。\n"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn txt_replacement_fails_fast_without_paragraph_index() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-txt-missing-paragraph-index-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Txt);
    book.metadata = json!({ "sourceEncodingId": "utf-8" });
    let storage = test_storage_with_book(&root, book);
    let book_dir = storage.book_dir("book");
    let unpacked = book_dir.join(UNPACKED_DIR);
    let oebps = unpacked.join("OEBPS");
    let text_dir = oebps.join("Text");
    fs::create_dir_all(&text_dir).unwrap();
    fs::create_dir_all(unpacked.join("META-INF")).unwrap();
    fs::write(
            unpacked.join("META-INF").join("container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
    fs::write(oebps.join("content.opf"), "<package/>").unwrap();
    fs::write(
            oebps.join("nav.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html><body><nav><ol><li><a href="Text/part0001.xhtml">第001章 测试</a></li></ol></nav></body></html>"#,
        )
        .unwrap();
    fs::write(
            text_dir.join("part0001.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第001章 测试</title></head><body>
<h2 class="flow-txt-chapter">第001章 测试</h2><div class="flow-txt-body" data-flow-body-text="true"><p>第一段原文。</p><p>第二段错字。</p></div></body></html>"#,
        )
        .unwrap();
    fs::write(
        book_dir.join(SOURCE_TEXT_FILE),
        "第001章 测试\n第一段原文。\n第二段错字。\n",
    )
    .unwrap();

    let target = BookTextReplaceTarget {
        section_href: "Text/part0001.xhtml".to_string(),
        text_node_index: 99,
        text_node_text: "第二段错字。".to_string(),
        start_offset: 3,
        end_offset: 5,
        paragraph_index: None,
    };

    let error = match replace_book_text_impl(
        &storage,
        "book".to_string(),
        target,
        "错字".to_string(),
        "正字".to_string(),
    ) {
        Ok(_) => panic!("paragraph replacement requires a structural paragraph index"),
        Err(error) => error,
    };

    assert_eq!(error, "TEXT_REPLACE_NODE_STALE");
    assert!(
        fs::read_to_string(text_dir.join("part0001.xhtml"))
            .unwrap()
            .contains("<p>第二段错字。</p>")
    );
    assert_eq!(
        fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
        "第001章 测试\n第一段原文。\n第二段错字。\n"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn txt_replacement_streams_to_target_heading_when_previous_generated_heading_has_parent() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-txt-stream-heading-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Txt);
    book.metadata = json!({ "sourceEncodingId": "utf-8" });
    let storage = test_storage_with_book(&root, book);
    let book_dir = storage.book_dir("book");
    let unpacked = book_dir.join(UNPACKED_DIR);
    let oebps = unpacked.join("OEBPS");
    let text_dir = oebps.join("Text");
    fs::create_dir_all(&text_dir).unwrap();
    fs::create_dir_all(unpacked.join("META-INF")).unwrap();
    fs::write(
            unpacked.join("META-INF").join("container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
    fs::write(oebps.join("content.opf"), "<package/>").unwrap();
    fs::write(
            oebps.join("nav.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html><body><nav><ol><li><a href="Text/part0001.xhtml">第001章 开始</a></li><li><a href="Text/part0002.xhtml">第002章 目标</a></li></ol></nav></body></html>"#,
        )
        .unwrap();
    fs::write(
            text_dir.join("part0001.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html><head><title>第一卷 第001章 开始</title></head><body><h2 class="flow-txt-chapter">第一卷 第001章 开始</h2><div class="flow-txt-body" data-flow-body-text="true"><p>前文。</p></div></body></html>"#,
        )
        .unwrap();
    fs::write(
            text_dir.join("part0002.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html><head><title>第002章 目标</title></head><body><h2 class="flow-txt-chapter">第002章 目标</h2><div class="flow-txt-body" data-flow-body-text="true"><p>目标段错字。</p></div></body></html>"#,
        )
        .unwrap();
    fs::write(
        book_dir.join(SOURCE_TEXT_FILE),
        "第一卷\n第001章 开始\n前文。\n第002章 目标\n目标段错字。\n",
    )
    .unwrap();

    let target = BookTextReplaceTarget {
        section_href: "Text/part0002.xhtml".to_string(),
        text_node_index: 99,
        text_node_text: "目标段错字。".to_string(),
        start_offset: 3,
        end_offset: 5,
        paragraph_index: Some(0),
    };

    replace_book_text_impl(
        &storage,
        "book".to_string(),
        target,
        "错字".to_string(),
        "正字".to_string(),
    )
    .expect("streaming source replacement skips parent-prefixed generated heading");

    assert_eq!(
        fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
        "第一卷\n第001章 开始\n前文。\n第002章 目标\n目标段正字。\n"
    );
    assert!(
        fs::read_to_string(text_dir.join("part0002.xhtml"))
            .unwrap()
            .contains("<p>目标段正字。</p>")
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn txt_replacement_updates_generated_heading_and_source_title_line() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-txt-heading-replace-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Txt);
    book.metadata = json!({ "sourceEncodingId": "utf-8" });
    let storage = test_storage_with_book(&root, book);
    let book_dir = storage.book_dir("book");
    let unpacked = book_dir.join(UNPACKED_DIR);
    let oebps = unpacked.join("OEBPS");
    let text_dir = oebps.join("Text");
    fs::create_dir_all(&text_dir).unwrap();
    fs::create_dir_all(unpacked.join("META-INF")).unwrap();
    fs::write(
            unpacked.join("META-INF").join("container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
    fs::write(oebps.join("content.opf"), "<package/>").unwrap();
    fs::write(
            oebps.join("nav.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html><body><nav><ol><li><a href="Text/part0001.xhtml">第001章测试</a></li></ol></nav></body></html>"#,
        )
        .unwrap();
    fs::write(
            text_dir.join("part0001.xhtml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第001章测试</title></head><body>
<h2 class="flow-txt-chapter">第001章测试</h2><div class="flow-txt-body" data-flow-body-text="true"><p>正文。</p></div></body></html>"#,
        )
        .unwrap();
    fs::write(book_dir.join(SOURCE_TEXT_FILE), "第001章测试\n正文。\n").unwrap();

    let target = BookTextReplaceTarget {
        section_href: "Text/part0001.xhtml".to_string(),
        text_node_index: 99,
        text_node_text: "第001章测试".to_string(),
        start_offset: 5,
        end_offset: 7,
        paragraph_index: None,
    };

    replace_book_text_impl(
        &storage,
        "book".to_string(),
        target,
        "测试".to_string(),
        " 测试".to_string(),
    )
    .expect("heading replacement succeeds without rendered node index");

    let updated_xhtml = fs::read_to_string(text_dir.join("part0001.xhtml")).unwrap();
    assert!(updated_xhtml.contains("<title>第001章 测试</title>"));
    assert!(updated_xhtml.contains(r#"<h2 class="flow-txt-chapter">第001章 测试</h2>"#));
    assert!(
        fs::read_to_string(oebps.join("nav.xhtml"))
            .unwrap()
            .contains(r#"<a href="Text/part0001.xhtml">第001章 测试</a>"#)
    );
    assert_eq!(
        fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
        "第001章 测试\n正文。\n"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn txt_replacement_updates_generated_volume_heading_and_source_title_line() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-txt-volume-heading-replace-test-{}-{nonce}",
        std::process::id()
    ));
    let mut book = test_library_book(BookSourceFormat::Txt);
    book.metadata = json!({ "sourceEncodingId": "utf-8" });
    let storage = test_storage_with_book(&root, book);
    let book_dir = storage.book_dir("book");
    let unpacked = book_dir.join(UNPACKED_DIR);
    let oebps = unpacked.join("OEBPS");
    let text_dir = oebps.join("Text");
    fs::create_dir_all(&text_dir).unwrap();
    fs::create_dir_all(unpacked.join("META-INF")).unwrap();
    fs::write(
        unpacked.join("META-INF").join("container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
    )
    .unwrap();
    fs::write(oebps.join("content.opf"), "<package/>").unwrap();
    fs::write(
        oebps.join("nav.xhtml"),
        r#"<?xml version="1.0" encoding="UTF-8"?><html><body><nav><ol><li><a href="Text/part0001.xhtml">第一卷测试</a></li></ol></nav></body></html>"#,
    )
    .unwrap();
    fs::write(
        text_dir.join("part0001.xhtml"),
        r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一卷测试</title></head><body>
<h1 class="flow-txt-volume">第一卷测试</h1><div class="flow-txt-body" data-flow-body-text="true"><p>正文。</p></div></body></html>"#,
    )
    .unwrap();
    fs::write(book_dir.join(SOURCE_TEXT_FILE), "第一卷测试\n正文。\n").unwrap();

    let target = BookTextReplaceTarget {
        section_href: "Text/part0001.xhtml".to_string(),
        text_node_index: 99,
        text_node_text: "第一卷测试".to_string(),
        start_offset: 3,
        end_offset: 5,
        paragraph_index: None,
    };

    replace_book_text_impl(
        &storage,
        "book".to_string(),
        target,
        "测试".to_string(),
        " 测试".to_string(),
    )
    .expect("volume heading replacement succeeds without rendered node index");

    let updated_xhtml = fs::read_to_string(text_dir.join("part0001.xhtml")).unwrap();
    assert!(updated_xhtml.contains("<title>第一卷 测试</title>"));
    assert!(updated_xhtml.contains(r#"<h1 class="flow-txt-volume">第一卷 测试</h1>"#));
    assert!(
        fs::read_to_string(oebps.join("nav.xhtml"))
            .unwrap()
            .contains(r#"<a href="Text/part0001.xhtml">第一卷 测试</a>"#)
    );
    assert_eq!(
        fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
        "第一卷 测试\n正文。\n"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn writes_splice_txt_source_update_without_losing_tail() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!(
        "flow-reader-source-splice-test-{}-{nonce}.txt",
        std::process::id()
    ));
    fs::write(&path, "第一段 MD4_A_RED\n第二段。\n").unwrap();

    write_source_text_update(
        &path,
        &SourceTextUpdate::Splice {
            offset: 0,
            old_len: "第一段 MD4_A_RED".len() as u64,
            bytes: "第一段 MD55_A_RED".as_bytes().to_vec(),
        },
    )
    .expect("splice write succeeds");

    assert_eq!(fs::read_to_string(&path).unwrap(), "第一段 MD55_A_RED\n第二段。\n");

    fs::remove_file(path).unwrap();
}

#[test]
fn exports_epub_with_required_mimetype_entry() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("flow-reader-export-test-{}-{nonce}", std::process::id()));
    let output = root.with_extension("epub");
    fs::create_dir_all(root.join("META-INF")).unwrap();
    fs::create_dir_all(root.join("OEBPS")).unwrap();
    fs::write(root.join("mimetype"), "application/epub+zip").unwrap();
    fs::write(
        root.join("META-INF/container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?><container version="1.0"></container>"#,
    )
    .unwrap();
    fs::write(root.join("OEBPS/content.opf"), "<package/>").unwrap();

    write_epub_from_unpacked_dir(&root, &output, None).expect("export succeeds");

    let file = fs::File::open(&output).unwrap();
    let mut archive = ZipArchive::new(file).unwrap();
    let (mimetype_name, mimetype_compression) = {
        let mimetype = archive.by_index(0).unwrap();
        (mimetype.name().to_string(), mimetype.compression())
    };
    assert_eq!(mimetype_name, "mimetype");
    assert_eq!(mimetype_compression, CompressionMethod::Stored);

    fs::remove_dir_all(&root).unwrap();
    fs::remove_file(output).unwrap();
}

#[test]
fn exports_epub_compresses_text_and_stores_already_compressed_assets() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-export-compression-test-{}-{nonce}",
        std::process::id()
    ));
    let output = root.with_extension("epub");
    fs::create_dir_all(root.join("OEBPS")).unwrap();
    fs::create_dir_all(root.join("OEBPS/images")).unwrap();
    fs::write(root.join("mimetype"), "application/epub+zip").unwrap();
    fs::write(root.join("OEBPS/content.opf"), "<package/>").unwrap();
    fs::write(root.join("OEBPS/images/page.jpg"), [1u8, 2, 3, 4]).unwrap();

    write_epub_from_unpacked_dir(&root, &output, None).expect("export succeeds");

    let file = fs::File::open(&output).unwrap();
    let mut archive = ZipArchive::new(file).unwrap();
    let content_compression = archive.by_name("OEBPS/content.opf").unwrap().compression();
    let image_compression = archive.by_name("OEBPS/images/page.jpg").unwrap().compression();
    assert_eq!(content_compression, CompressionMethod::Deflated);
    assert_eq!(image_compression, CompressionMethod::Stored);

    fs::remove_dir_all(&root).unwrap();
    fs::remove_file(output).unwrap();
}

#[test]
fn exports_epub_reuses_original_entries_and_rewrites_changed_files() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-export-raw-copy-test-{}-{nonce}",
        std::process::id()
    ));
    let original = root.join("original.epub");
    let unpacked = root.join("unpacked");
    let output = root.join("exported.epub");
    fs::create_dir_all(unpacked.join("OEBPS/images")).unwrap();
    fs::create_dir_all(unpacked.join("OEBPS/styles")).unwrap();
    fs::write(unpacked.join("mimetype"), "application/epub+zip").unwrap();
    fs::write(unpacked.join("OEBPS/content.opf"), "<package>original</package>").unwrap();
    fs::write(unpacked.join("OEBPS/toc.ncx"), "<ncx>same</ncx>").unwrap();
    fs::write(unpacked.join("OEBPS/chapter.xhtml"), "<p>same</p>").unwrap();
    fs::write(unpacked.join("OEBPS/styles/book.css"), "p{color:red}").unwrap();
    fs::write(unpacked.join("OEBPS/images/page.jpg"), [9u8; 128]).unwrap();

    let file = fs::File::create(&original).unwrap();
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer.start_file("mimetype", stored).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer.start_file("OEBPS/content.opf", stored).unwrap();
    writer.write_all(b"<package>original</package>").unwrap();
    writer.start_file("OEBPS/toc.ncx", stored).unwrap();
    writer.write_all(b"<ncx>same</ncx>").unwrap();
    writer.start_file("OEBPS/chapter.xhtml", stored).unwrap();
    writer.write_all(b"<p>same</p>").unwrap();
    writer.start_file("OEBPS/styles/book.css", stored).unwrap();
    writer.write_all(b"p{color:red}").unwrap();
    writer.start_file("OEBPS/images/page.jpg", deflated).unwrap();
    writer.write_all(&[9u8; 128]).unwrap();
    writer.finish().unwrap();

    wait_until_next_epoch_second();
    fs::write(unpacked.join("OEBPS/content.opf"), "<package>changed</package>").unwrap();
    fs::write(unpacked.join("OEBPS/toc.ncx"), "<ncx>changed</ncx>").unwrap();
    fs::write(unpacked.join("OEBPS/chapter.xhtml"), "<p>tame</p>").unwrap();
    fs::write(unpacked.join("OEBPS/styles/book.css"), "p{color:blue}").unwrap();
    fs::write(unpacked.join("OEBPS/images/page.jpg"), [8u8; 128]).unwrap();

    write_epub_from_original_and_unpacked(&original, &unpacked, &output).expect("export succeeds");

    let file = fs::File::open(&output).unwrap();
    let mut archive = ZipArchive::new(file).unwrap();
    let (mimetype_name, mimetype_compression) = {
        let mimetype = archive.by_index(0).unwrap();
        (mimetype.name().to_string(), mimetype.compression())
    };
    assert_eq!(mimetype_name, "mimetype");
    assert_eq!(mimetype_compression, CompressionMethod::Stored);
    assert_eq!(
        archive.by_name("OEBPS/content.opf").unwrap().compression(),
        CompressionMethod::Deflated
    );
    assert_eq!(
        archive.by_name("OEBPS/chapter.xhtml").unwrap().compression(),
        CompressionMethod::Deflated
    );
    assert_eq!(
        archive.by_name("OEBPS/toc.ncx").unwrap().compression(),
        CompressionMethod::Deflated
    );
    assert_eq!(
        archive.by_name("OEBPS/styles/book.css").unwrap().compression(),
        CompressionMethod::Stored
    );
    assert_eq!(
        archive.by_name("OEBPS/images/page.jpg").unwrap().compression(),
        CompressionMethod::Deflated
    );
    let mut content = String::new();
    archive
        .by_name("OEBPS/content.opf")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "<package>changed</package>");
    content.clear();
    archive
        .by_name("OEBPS/chapter.xhtml")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "<p>tame</p>");
    content.clear();
    archive
        .by_name("OEBPS/toc.ncx")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "<ncx>changed</ncx>");
    content.clear();
    archive
        .by_name("OEBPS/styles/book.css")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "p{color:red}");
    let mut image = Vec::new();
    archive
        .by_name("OEBPS/images/page.jpg")
        .unwrap()
        .read_to_end(&mut image)
        .unwrap();
    assert_eq!(image, vec![9u8; 128]);

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn exports_epub_from_unpacked_when_file_count_changes() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-export-unpacked-count-test-{}-{nonce}",
        std::process::id()
    ));
    let original = root.join("original.epub");
    let unpacked = root.join("unpacked");
    let output = root.join("exported.epub");
    fs::create_dir_all(unpacked.join("OEBPS")).unwrap();
    fs::write(unpacked.join("mimetype"), "application/epub+zip").unwrap();
    fs::write(unpacked.join("OEBPS/content.opf"), "<package>unpacked</package>").unwrap();
    fs::write(unpacked.join("OEBPS/toc.ncx"), "<ncx>unpacked</ncx>").unwrap();

    let file = fs::File::create(&original).unwrap();
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    writer.start_file("mimetype", stored).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer.start_file("OEBPS/content.opf", stored).unwrap();
    writer.write_all(b"<package>original</package>").unwrap();
    writer.finish().unwrap();

    write_epub_from_original_and_unpacked(&original, &unpacked, &output).expect("export succeeds");

    let file = fs::File::open(&output).unwrap();
    let mut archive = ZipArchive::new(file).unwrap();
    let mut content = String::new();
    archive
        .by_name("OEBPS/content.opf")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "<package>unpacked</package>");
    content.clear();
    archive
        .by_name("OEBPS/toc.ncx")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "<ncx>unpacked</ncx>");

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn normalizes_large_ncx_anchored_spine_section() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-normalize-test-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("META-INF")).unwrap();
    fs::create_dir_all(root.join("OEBPS")).unwrap();
    fs::write(root.join("mimetype"), "application/epub+zip").unwrap();
    fs::write(
        root.join("META-INF/container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf"/>
  </rootfiles>
</container>"#,
    )
    .unwrap();
    fs::write(
        root.join("OEBPS/content.opf"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata/>
  <manifest>
    <item id="big" href="text00000.html" media-type="application/xhtml+xml"/>
    <item id="tocpage" href="text00001.html" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="big"/>
    <itemref idref="tocpage"/>
  </spine>
</package>"#,
    )
    .unwrap();

    let mut ncx = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?><ncx><navMap>
"#,
    );
    let mut toc_page = String::from(
        r#"<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body>
"#,
    );
    let mut body = String::from("<p>preface</p>\n");
    for index in 1..=9 {
        ncx.push_str(&format!(
                r#"<navPoint id="nav{index}"><navLabel><text>Chapter {index}</text></navLabel><content src="text00000.html#c{index:03}"/></navPoint>
"#
            ));
        toc_page.push_str(&format!(
            r#"<p><a href="text00000.html#c{index:03}">Chapter {index}</a></p>
"#
        ));
        body.push_str(&format!(
            r#"<span id="c{index:03}"></span><p>Chapter {index}</p><p>{}</p>
"#,
            "正文".repeat(40_000)
        ));
    }
    ncx.push_str("</navMap></ncx>");
    toc_page.push_str("</body></html>");
    let xhtml = format!(
        r#"<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Big</title></head><body>{body}</body></html>"#
    );
    fs::write(root.join("OEBPS/toc.ncx"), ncx).unwrap();
    fs::write(root.join("OEBPS/text00001.html"), toc_page).unwrap();
    fs::write(root.join("OEBPS/text00000.html"), xhtml).unwrap();

    normalize_unpacked_epub_structure(&root).expect("normalization succeeds");

    let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
    assert!(opf.contains(r#"id="big_flow_split_0001""#));
    assert!(opf.contains(r#"href="text00000-flow-split-0001.html""#));
    assert!(opf.contains(r#"<itemref idref="big_flow_split_0001"/>"#));
    assert!(!opf.contains(r#"<itemref idref="big"/>"#));

    let ncx = fs::read_to_string(root.join("OEBPS/toc.ncx")).unwrap();
    assert!(ncx.contains(r#"src="text00000-flow-split-0001.html#c001""#));
    assert!(ncx.contains(r#"src="text00000-flow-split-0009.html#c009""#));
    let toc_page = fs::read_to_string(root.join("OEBPS/text00001.html")).unwrap();
    assert!(toc_page.contains(r#"href="text00000-flow-split-0001.html#c001""#));
    assert!(toc_page.contains(r#"href="text00000-flow-split-0009.html#c009""#));
    assert!(!root.join("OEBPS/text00000.html").exists());
    assert!(root.join("OEBPS/text00000-flow-split-0001.html").exists());
    assert!(root.join("OEBPS/text00000-flow-split-0009.html").exists());

    let output = root.with_extension("epub");
    write_epub_from_unpacked_dir(&root, &output, None).expect("export succeeds");
    let file = fs::File::open(&output).unwrap();
    let mut archive = ZipArchive::new(file).unwrap();
    assert!(archive.by_name("OEBPS/text00000.html").is_err());
    assert!(archive.by_name("OEBPS/text00000-flow-split-0001.html").is_ok());
    assert!(archive.by_name("OEBPS/text00000-flow-split-0009.html").is_ok());

    fs::remove_dir_all(&root).unwrap();
    fs::remove_file(output).unwrap();
}

#[test]
fn normalizes_minified_large_ncx_anchored_spine_section() {
    assert_minified_large_ncx_anchored_spine_section_normalizes(
        &["OEBPS"],
        "content.opf",
        "toc.ncx",
        "intro.html",
        "text00000.html",
        "text00001.html",
        "text00000-flow-split-0001.html#c001",
        "text00000-flow-split-0009.html#c009",
        "OEBPS/text00000-flow-split-0001.html",
    );
}

#[test]
fn normalizes_minified_large_ncx_anchored_spine_section_in_nested_directories() {
    assert_minified_large_ncx_anchored_spine_section_normalizes(
        &["OPS", "Books"],
        "content.opf",
        "toc/toc.ncx",
        "front/intro.html",
        "chapters/text00000.html",
        "chapters/text00001.html",
        "../chapters/text00000-flow-split-0001.html#c001",
        "../chapters/text00000-flow-split-0009.html#c009",
        "OPS/Books/chapters/text00000-flow-split-0001.html",
    );
}

// The parameters describe one synthetic EPUB layout and remain explicit at each call site.
#[allow(clippy::too_many_arguments)]
fn assert_minified_large_ncx_anchored_spine_section_normalizes(
    opf_dir_segments: &[&str],
    opf_file: &str,
    ncx_href: &str,
    intro_href: &str,
    big_href: &str,
    toc_page_href: &str,
    first_ncx_src: &str,
    last_ncx_src: &str,
    first_split_path: &str,
) {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flow-reader-epub-minified-normalize-test-{}-{nonce}",
        std::process::id()
    ));
    let opf_dir = opf_dir_segments
        .iter()
        .fold(root.clone(), |path, segment| path.join(segment));
    let full_opf_path = opf_dir.join(opf_file);
    let full_opf_zip_path = opf_dir_segments
        .iter()
        .copied()
        .chain(std::iter::once(opf_file))
        .collect::<Vec<_>>()
        .join("/");
    fs::create_dir_all(root.join("META-INF")).unwrap();
    fs::create_dir_all(&opf_dir).unwrap();
    fs::write(root.join("mimetype"), "application/epub+zip").unwrap();
    fs::write(
            root.join("META-INF/container.xml"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="{full_opf_zip_path}"/></rootfiles></container>"#
            ),
        )
        .unwrap();
    fs::write(
            &full_opf_path,
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest><item id="intro" href="{intro_href}" media-type="application/xhtml+xml"/><item id="big" href="{big_href}" media-type="application/xhtml+xml"/><item id="tocpage" href="{toc_page_href}" media-type="application/xhtml+xml"/><item id="ncx" href="{ncx_href}" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="intro"/><itemref idref="big"/><itemref idref="tocpage"/></spine></package>"#
            ),
        )
        .unwrap();

    let ncx_big_href = relative_zip_path(parent_zip_path(ncx_href), big_href);
    let toc_big_href = relative_zip_path(parent_zip_path(toc_page_href), big_href);
    let mut ncx = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><ncx><navMap>"#);
    let mut toc_page = String::from(r#"<!DOCTYPE html><html><body>"#);
    let mut body = String::from("<p>preface</p>");
    for index in 1..=9 {
        ncx.push_str(&format!(
                r#"<navPoint id="nav{index}"><navLabel><text>Chapter {index}</text></navLabel><content src="{ncx_big_href}#c{index:03}"/></navPoint>"#
            ));
        toc_page.push_str(&format!(
            r#"<p><a href="{toc_big_href}#c{index:03}">Chapter {index}</a></p>"#
        ));
        body.push_str(&format!(
            r#"<span id="c{index:03}"></span><p>Chapter {index}</p><p>{}</p>"#,
            "正文".repeat(40_000)
        ));
    }
    ncx.push_str("</navMap></ncx>");
    toc_page.push_str("</body></html>");
    let xhtml = format!(r#"<!DOCTYPE html><html><head><title>Big</title></head><body>{body}</body></html>"#);
    let ncx_path = opf_dir.join(ncx_href.replace('/', std::path::MAIN_SEPARATOR_STR));
    let intro_path = opf_dir.join(intro_href.replace('/', std::path::MAIN_SEPARATOR_STR));
    let toc_page_path = opf_dir.join(toc_page_href.replace('/', std::path::MAIN_SEPARATOR_STR));
    let big_path = opf_dir.join(big_href.replace('/', std::path::MAIN_SEPARATOR_STR));
    for path in [&ncx_path, &intro_path, &toc_page_path, &big_path] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
    }
    fs::write(ncx_path, ncx).unwrap();
    fs::write(intro_path, "<html><body>Intro</body></html>").unwrap();
    fs::write(toc_page_path, toc_page).unwrap();
    fs::write(big_path, xhtml).unwrap();

    normalize_unpacked_epub_structure(&root).expect("normalization succeeds");

    let opf = fs::read_to_string(&full_opf_path).unwrap();
    roxmltree::Document::parse(&opf).expect("normalized OPF parses");
    assert_eq!(opf.matches("<package").count(), 1);
    assert_eq!(opf.matches("<manifest").count(), 1);
    assert_eq!(opf.matches("<spine").count(), 1);
    assert!(opf.contains(r#"id="big_flow_split_0001""#));
    assert!(opf.contains(&format!(
        r#"href="{}""#,
        big_href.replace(".html", "-flow-split-0001.html")
    )));
    assert!(opf.contains(r#"<itemref idref="big_flow_split_0009"/>"#));
    assert!(!opf.contains(r#"<itemref idref="big"/>"#));
    let ncx = fs::read_to_string(opf_dir.join(ncx_href.replace('/', std::path::MAIN_SEPARATOR_STR))).unwrap();
    assert!(ncx.contains(&format!(r#"src="{first_ncx_src}""#)));
    assert!(ncx.contains(&format!(r#"src="{last_ncx_src}""#)));
    assert!(
        root.join(first_split_path.replace('/', std::path::MAIN_SEPARATOR_STR))
            .exists()
    );

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn exporting_clears_content_edited_at() {
    let mut book = test_library_book(BookSourceFormat::Txt);
    book.revision = 3;
    book.content_edited_at = Some(123);

    mark_book_exported(&mut book);

    assert!(book.content_edited_at.is_none());
}

#[test]
fn imported_content_repair_marks_epub_export_dirty() {
    let root = std::env::temp_dir().join(format!("flow-reader-import-repair-dirty-test-{}", std::process::id()));
    let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));

    let updated = mark_library_book_content_updated(&storage, "book")
        .unwrap()
        .expect("library book should be updated");

    assert_eq!(updated.revision, 2);
    assert!(updated.content_edited_at.is_some());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn only_existing_referenced_sources_can_be_revealed() {
    let root = std::env::temp_dir().join(format!("flow-reader-reveal-source-test-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.epub");
    fs::write(&source, b"source").unwrap();

    let mut book = test_library_book(BookSourceFormat::Epub);
    book.source_path = source.clone();
    assert!(revealable_book_source_path(&book).is_none());

    book.source_storage = SourceStorage::Referenced;
    assert_eq!(revealable_book_source_path(&book), Some(source.as_path()));

    fs::remove_file(&source).unwrap();
    assert!(revealable_book_source_path(&book).is_none());
    fs::remove_dir_all(&root).unwrap();
}

fn test_library_book(source_format: BookSourceFormat) -> LibraryBook {
    LibraryBook {
        id: "book".to_string(),
        name: "book.txt".to_string(),
        size: 1,
        reading_status: None::<ReadingStatus>,
        source_format,
        generated_cover: source_format == BookSourceFormat::Txt,
        content_edited_at: None,
        content_hash: "hash".to_string(),
        revision: 1,
        content_mode: BookContentMode::Normal,
        source_storage: SourceStorage::Managed,
        source_path: "book.txt".into(),
        metadata: empty_object(),
        created_at: 1,
        updated_at: None,
        last_read_at: None,
        cfi: None,
        percentage: None,
        tag_ids: Vec::new(),
    }
}
