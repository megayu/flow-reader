use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    diagnostics,
    tasks::{TaskKey, TaskKind, TaskPriority, TaskService},
};

mod book_assets;
mod book_source;
mod commands;
mod deletion;
mod editing;
mod epub_import;
mod export;
mod image_index;
mod model;
mod search;
mod state;
mod text_import;
mod window_state;

pub use commands::*;
pub use deletion::{cleanup_all_external_book_heavy_files, schedule_existing_delete_tombstone_cleanup};
pub use image_index::ImageIndexCache;
#[cfg(test)]
use model::ReadingStatus;
use model::{
    BookContentFlag, BookContentMode, BookScope, BookState, ExternalBook, ExternalBookIndex, Library, LibraryBook,
    SourceStorage, WindowState,
};
pub use model::{
    BookExportFormat, BookReaderSource, BookReaderSourceMode, BookRecord, BookSourceFormat, BookSourceStatus,
    BookSourceStatusRecord, BookTextReplaceResult, BookTextReplaceTarget, CoverInput, CoverRecord, LibraryTagRecord,
};
pub use search::SearchTextResult;
pub use text_import::{
    TextImportEncodingOption, TextImportPreview, TextImportRulesInput, TextImportSelection, is_epub_file, is_txt_file,
};
pub use window_state::{flush_app_storage, restore_window_state, save_window_state};

use book_assets::{is_generated_text_cover, read_cover, remove_cover_files, write_cover, write_metadata};
use book_source::*;
#[cfg(test)]
use deletion::{cleanup_delete_tombstones, delete_books_to_tombstones};
use deletion::{cleanup_external_book_heavy_files, delete_books_impl};
use editing::*;
use export::*;

use epub_import::{
    clean_xml_text, deobfuscate_unpacked_idpf_fonts, find_unpacked_opf_path, import_epub_path_impl,
    inspect_epub_access, join_zip_path, normalize_unpacked_epub_structure, normalize_zip_path,
    open_external_epub_path_impl, parent_zip_path, unpack_epub, validate_epub_archive_limits,
};
#[cfg(test)]
use epub_import::{normalize_non_square_pixel_png, normalize_publication_date, relative_zip_path};

use image_index::{ImageIndexCacheInput, read_image_index_cache, write_image_index_cache_if_current};
#[cfg(test)]
use image_index::{ImageIndexEntryInput, ImageIndexSectionInput};
use search::{SearchTextCache, load_or_build_search_text_cache, search_text_in_cache};
#[cfg(test)]
use search::{
    SearchTextSection, read_search_text_sections_from_unpacked, search_text_cache_from_bytes,
    search_text_cache_to_bytes, visible_search_text_from_xhtml,
};
use state::{DirtyState, StorageState};
use text_import::{
    PreparedTextImport, TextImportPreparedCache, TextImportPreparedKey, consume_or_prepare_text_import,
    create_skipped_text_import_preview, create_text_cover_input, create_text_import_error_preview,
    create_text_import_preview_from_prepared, decode_text_bytes, encode_text_bytes, import_text_path_impl,
    load_or_prepare_text_import, should_skip_prepared_text_import_preview, source_encoding_id_from_metadata,
    text_import_encoding_options, write_text_cover_to_unpacked,
};
#[cfg(test)]
use text_import::{parse_text_import_document, text_content_opf, text_nav_xhtml, text_section_xhtml};

const APP_DATA_DIR_NAME: &str = "Flow Reader";
const APP_DATA_DIR_ENV: &str = "FLOW_READER_DATA_DIR";
const BOOKS_DIR: &str = "books";
const EXTERNAL_BOOKS_DIR: &str = "external-books";
const DELETE_TOMBSTONES_DIR: &str = "delete-tombstones";
const LIBRARY_FILE: &str = "library.json";
const EXTERNAL_INDEX_FILE: &str = "index.json";
const SETTINGS_FILE: &str = "settings.json";
const BOOK_FILE: &str = "book.epub";
const SOURCE_TEXT_FILE: &str = "source.txt";
const UNPACKED_DIR: &str = "unpacked";
const SEARCH_TEXT_CACHE_FILE: &str = "search-text.v1.json.zst";
const IMAGE_INDEX_CACHE_FILE: &str = "image-index.v1.json.zst";
const SEARCH_TEXT_EXCERPT_RADIUS: usize = 60;
pub const SEARCH_TEXT_CACHE_VERSION: u32 = 1;
pub const SEARCH_TEXT_EXTRACTOR_VERSION: u32 = 1;
pub const IMAGE_INDEX_CACHE_VERSION: u32 = 1;
pub const IMAGE_INDEX_EXTRACTOR_VERSION: u32 = 1;
const COVER_STEM: &str = "cover";
const GENERATED_TEXT_COVER_MARKER: &str = r#"data-flow-generated-cover="true""#;
const METADATA_FILE: &str = "metadata.json";
const STATE_FILE: &str = "state.json";
const WINDOW_STATE_FILE: &str = "window-state.json";
const EPUB_ZIP_WRITER_BUFFER_SIZE: usize = 256 * 1024;
const TXT_EPUB_DEFLATE_LEVEL: i64 = 2;
const EPUB_MAX_ENTRY_COUNT: usize = 10_000;
const EPUB_MAX_ENTRY_BYTES: u64 = 1024 * 1024 * 1024;
const EPUB_MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const EPUB_MAX_COMPRESSION_RATIO: u64 = 1_000;
const EPUB_COMPRESSION_RATIO_MIN_BYTES: u64 = 1024 * 1024;
const EPUB_XML_READ_LIMIT: u64 = 8 * 1024 * 1024;
const EPUB_COVER_READ_LIMIT: u64 = 64 * 1024 * 1024;
const EPUB_SEARCH_DOCUMENT_READ_LIMIT: u64 = 32 * 1024 * 1024;
const EPUB_MAX_SEARCH_TEXT_BYTES: u64 = 512 * 1024 * 1024;
static IMPORT_WORK_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn read_bounded_bytes(reader: impl Read, limit: u64, description: &str) -> Result<Vec<u8>, String> {
    let capacity = usize::try_from(limit.min(1024 * 1024)).unwrap_or(1024 * 1024);
    let mut data = Vec::with_capacity(capacity);
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    if data.len() as u64 > limit {
        return Err(format!("{description} exceeds the supported size limit"));
    }
    Ok(data)
}

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

struct ImportFileTransaction {
    book_dir: PathBuf,
    book_dir_existed: bool,
    backup_dir: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}

impl ImportFileTransaction {
    fn begin(storage: &AppStorage, id: &str) -> Result<Self, String> {
        let book_dir = storage.book_dir(id);
        let book_dir_existed = book_dir.exists();
        fs::create_dir_all(&book_dir).map_err(|error| error.to_string())?;
        let backup_dir = import_work_path(&books_root(storage.root()), "import-backup", id);
        fs::create_dir(&backup_dir).map_err(|error| error.to_string())?;

        let mut targets = [
            BOOK_FILE,
            SOURCE_TEXT_FILE,
            UNPACKED_DIR,
            SEARCH_TEXT_CACHE_FILE,
            IMAGE_INDEX_CACHE_FILE,
            METADATA_FILE,
        ]
        .into_iter()
        .map(|name| book_dir.join(name))
        .collect::<Vec<_>>();
        let entries = fs::read_dir(&book_dir).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&format!("{COVER_STEM}.")))
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

    fn restore_preserved(&mut self, name: &str) -> Result<(), String> {
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

    fn commit(self) -> Result<(), String> {
        fs::remove_dir_all(self.backup_dir).map_err(|error| error.to_string())
    }

    fn rollback(self) -> Result<(), String> {
        let mut first_error = None;
        let mut current_targets = [
            BOOK_FILE,
            SOURCE_TEXT_FILE,
            UNPACKED_DIR,
            SEARCH_TEXT_CACHE_FILE,
            IMAGE_INDEX_CACHE_FILE,
            METADATA_FILE,
        ]
        .into_iter()
        .map(|name| self.book_dir.join(name))
        .collect::<Vec<_>>();
        if let Ok(entries) = fs::read_dir(&self.book_dir) {
            for entry in entries.flatten() {
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&format!("{COVER_STEM}.")))
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

#[derive(Clone)]
pub struct AppStorage {
    inner: Arc<StorageInner>,
}

struct StorageInner {
    root: PathBuf,
    state: Mutex<StorageState>,
    dirty: Mutex<DirtyState>,
    flush_lock: Mutex<()>,
    import_lock: Mutex<()>,
    reading_position_sequences: Mutex<HashMap<String, u64>>,
    search_text_caches: Mutex<HashMap<String, Arc<SearchTextCache>>>,
    search_text_cache_order: Mutex<VecDeque<String>>,
    text_import_prepared_cache: Mutex<TextImportPreparedCache>,
    #[cfg(test)]
    text_import_prepare_runs: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    text_import_prepare_active: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    text_import_prepare_max_active: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    text_import_prepare_delay_ms: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize,
}

const MIN_RESTORED_WINDOW_WIDTH: u32 = 900;
const MIN_RESTORED_WINDOW_HEIGHT: u32 = 600;
const DEFAULT_RESTORED_WINDOW_WIDTH: u32 = 1280;
const DEFAULT_RESTORED_WINDOW_HEIGHT: u32 = 800;
const MAXIMIZED_BOUNDS_TOLERANCE: u32 = 16;
const WINDOWS_MINIMIZED_POSITION_SENTINEL: i32 = -30_000;

fn empty_object() -> Value {
    json!({})
}

impl AppStorage {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let root = data_root(app)?;
        let library = read_json_or_default::<Library>(&library_path(&root)?)?;
        let external = read_json_or_default::<ExternalBookIndex>(&external_index_path(&root)?)?;
        let settings = read_json_value_or_default(&settings_path(&root)?)?;
        if library.books.iter().any(|book| !is_valid_book_storage_id(&book.id))
            || external.books.iter().any(|book| !is_external_book_id(&book.id))
        {
            return Err("Storage contains an invalid book id".to_string());
        }

        Ok(Self {
            inner: Arc::new(StorageInner {
                root,
                state: Mutex::new(StorageState {
                    library,
                    external,
                    settings,
                    book_states: HashMap::new(),
                }),
                dirty: Mutex::new(DirtyState::default()),
                flush_lock: Mutex::new(()),
                import_lock: Mutex::new(()),
                reading_position_sequences: Mutex::new(HashMap::new()),
                search_text_caches: Mutex::new(HashMap::new()),
                search_text_cache_order: Mutex::new(VecDeque::new()),
                text_import_prepared_cache: Mutex::new(TextImportPreparedCache::new()),
                #[cfg(test)]
                text_import_prepare_runs: std::sync::atomic::AtomicUsize::new(0),
                #[cfg(test)]
                text_import_prepare_active: std::sync::atomic::AtomicUsize::new(0),
                #[cfg(test)]
                text_import_prepare_max_active: std::sync::atomic::AtomicUsize::new(0),
                #[cfg(test)]
                text_import_prepare_delay_ms: std::sync::atomic::AtomicU64::new(0),
                #[cfg(test)]
                text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize::new(0),
                #[cfg(test)]
                text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize::new(0),
            }),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.inner.root
    }

    fn book_dir(&self, id: &str) -> PathBuf {
        if is_external_book_id(id) {
            self.external_book_dir(id)
        } else {
            books_root(self.root()).join(id)
        }
    }

    fn external_book_dir(&self, id: &str) -> PathBuf {
        external_books_root(self.root()).join(id)
    }

    fn search_text_cache_path(&self, id: &str) -> PathBuf {
        self.book_dir(id).join(SEARCH_TEXT_CACHE_FILE)
    }

    fn image_index_cache_path(&self, id: &str) -> PathBuf {
        self.book_dir(id).join(IMAGE_INDEX_CACHE_FILE)
    }

    fn library_book(&self, id: &str) -> Result<LibraryBook, String> {
        if !is_valid_book_storage_id(id) {
            return Err("Invalid book id".to_string());
        }
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        if let Some(book) = state.library.books.iter().find(|book| book.id == id).cloned() {
            return Ok(book);
        }

        state
            .external
            .books
            .iter()
            .find(|book| book.id == id)
            .cloned()
            .map(|book| self.external_to_library_book(&book))
            .transpose()?
            .ok_or_else(|| "Book not found".to_string())
    }

    fn ensure_external_book(&self, id: &str) -> Result<(), String> {
        if !is_external_book_id(id) {
            return Err("Invalid external book id".to_string());
        }
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state
            .external
            .books
            .iter()
            .any(|book| book.id == id)
            .then_some(())
            .ok_or_else(|| "External book not found".to_string())
    }

    fn unload_search_text_cache(&self, id: &str) {
        if let Ok(mut caches) = self.inner.search_text_caches.lock() {
            caches.remove(id);
        }
        if let Ok(mut order) = self.inner.search_text_cache_order.lock() {
            order.retain(|cache_id| cache_id != id);
        }
    }

    fn get_prepared_text_import(&self, key: &TextImportPreparedKey) -> Option<Arc<PreparedTextImport>> {
        self.inner
            .text_import_prepared_cache
            .lock()
            .ok()
            .and_then(|mut cache| cache.get(key))
    }

    fn insert_prepared_text_import(&self, prepared: Arc<PreparedTextImport>) {
        if let Ok(mut cache) = self.inner.text_import_prepared_cache.lock() {
            cache.insert(prepared);
        }
    }

    fn take_prepared_text_import(&self, key: &TextImportPreparedKey) -> Option<Arc<PreparedTextImport>> {
        self.inner
            .text_import_prepared_cache
            .lock()
            .ok()
            .and_then(|mut cache| cache.take(key))
    }

    fn note_text_import_prepare_run(&self) {
        #[cfg(test)]
        self.inner
            .text_import_prepare_runs
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn begin_text_import_prepare(&self) {
        #[cfg(test)]
        {
            let active = self
                .inner
                .text_import_prepare_active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            let mut current = self
                .inner
                .text_import_prepare_max_active
                .load(std::sync::atomic::Ordering::SeqCst);
            while active > current {
                match self.inner.text_import_prepare_max_active.compare_exchange(
                    current,
                    active,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(next) => current = next,
                }
            }
            let delay_ms = self
                .inner
                .text_import_prepare_delay_ms
                .load(std::sync::atomic::Ordering::SeqCst);
            if delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }

    fn end_text_import_prepare(&self) {
        #[cfg(test)]
        self.inner
            .text_import_prepare_active
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn begin_text_import_prepared_handoff(&self) {
        #[cfg(test)]
        {
            let active = self
                .inner
                .text_import_prepared_handoff_active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            let mut current = self
                .inner
                .text_import_prepared_handoff_max_active
                .load(std::sync::atomic::Ordering::SeqCst);
            while active > current {
                match self.inner.text_import_prepared_handoff_max_active.compare_exchange(
                    current,
                    active,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(next) => current = next,
                }
            }
        }
    }

    fn end_text_import_prepared_handoff(&self) {
        #[cfg(test)]
        self.inner
            .text_import_prepared_handoff_active
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(test)]
    fn text_import_prepare_run_count(&self) -> usize {
        self.inner
            .text_import_prepare_runs
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    fn set_text_import_prepared_cache_limit(&self, max_bytes: usize) {
        self.inner
            .text_import_prepared_cache
            .lock()
            .unwrap()
            .set_max_bytes(max_bytes);
    }

    #[cfg(test)]
    fn text_import_prepared_cache_len(&self) -> usize {
        self.inner.text_import_prepared_cache.lock().unwrap().len()
    }

    #[cfg(test)]
    fn text_import_prepared_cache_bytes(&self) -> usize {
        self.inner.text_import_prepared_cache.lock().unwrap().bytes()
    }

    fn text_import_prepared_cache_stats(&self) -> (usize, usize) {
        self.inner
            .text_import_prepared_cache
            .lock()
            .map(|mut cache| (cache.len(), cache.bytes()))
            .unwrap_or_default()
    }

    fn search_text_memory_cache_len(&self) -> usize {
        self.inner
            .search_text_caches
            .lock()
            .map(|cache| cache.len())
            .unwrap_or_default()
    }

    #[cfg(test)]
    fn set_text_import_prepare_delay(&self, delay: Duration) {
        self.inner
            .text_import_prepare_delay_ms
            .store(delay.as_millis() as u64, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(test)]
    fn text_import_prepare_max_active(&self) -> usize {
        self.inner
            .text_import_prepare_max_active
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    fn text_import_prepared_handoff_max_active(&self) -> usize {
        self.inner
            .text_import_prepared_handoff_max_active
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn read_book_state_uncached(&self, id: &str) -> Result<BookState, String> {
        read_json_or_default(&self.book_dir(id).join(STATE_FILE))
    }

    fn ensure_book_state<'a>(&self, state: &'a mut StorageState, id: &str) -> Result<&'a mut BookState, String> {
        if !state.book_states.contains_key(id) {
            let book_state = self.read_book_state_uncached(id)?;
            state.book_states.insert(id.to_string(), book_state);
        }

        Ok(state.book_states.get_mut(id).expect("book state should exist"))
    }

    fn compose_book(&self, state: &mut StorageState, book: &LibraryBook) -> Result<BookRecord, String> {
        let book_state = self.ensure_book_state(state, &book.id)?.clone();

        Ok(BookRecord {
            id: book.id.clone(),
            name: book.name.clone(),
            size: book.size,
            scope: if is_external_book_id(&book.id) {
                BookScope::External
            } else {
                BookScope::Library
            },
            reading_status: book.reading_status.clone(),
            source_format: self.book_source_format(book),
            exported_versions: book.exported_versions.clone(),
            content_edited_at: book.content_edited_at,
            metadata: book.metadata.clone(),
            created_at: book.created_at,
            updated_at: book.updated_at,
            last_read_at: book.last_read_at,
            definitions: book_state.definitions,
            annotations: book_state.annotations,
            cfi: book_state.cfi,
            percentage: book_state.percentage,
            tag_ids: book.tag_ids.clone(),
            configuration: book_state.configuration,
            content_hash: book.content_hash.clone(),
            content_version: book.content_version,
            content_mode: book.content_mode,
            content_flags: book.content_flags.clone(),
            source_storage: book.source_storage,
            source_path: book.source_path.as_deref().map(path_to_client_string),
        })
    }

    fn compose_book_summary(&self, book: &LibraryBook) -> BookRecord {
        BookRecord {
            id: book.id.clone(),
            name: book.name.clone(),
            size: book.size,
            scope: BookScope::Library,
            reading_status: book.reading_status.clone(),
            source_format: self.book_source_format(book),
            exported_versions: book.exported_versions.clone(),
            content_edited_at: book.content_edited_at,
            metadata: book.metadata.clone(),
            created_at: book.created_at,
            updated_at: book.updated_at,
            last_read_at: book.last_read_at,
            definitions: Vec::new(),
            annotations: Vec::new(),
            cfi: book.cfi.clone(),
            percentage: book.percentage,
            tag_ids: book.tag_ids.clone(),
            configuration: None,
            content_hash: book.content_hash.clone(),
            content_version: book.content_version,
            content_mode: book.content_mode,
            content_flags: book.content_flags.clone(),
            source_storage: book.source_storage,
            source_path: book.source_path.as_deref().map(path_to_client_string),
        }
    }

    fn book_source_format(&self, book: &LibraryBook) -> BookSourceFormat {
        if let Some(source_format) = book.source_format {
            return source_format;
        }

        if book
            .metadata
            .get("sourceFormat")
            .and_then(Value::as_str)
            .is_some_and(|format| format.eq_ignore_ascii_case("txt"))
            || self.book_dir(&book.id).join(SOURCE_TEXT_FILE).exists()
        {
            BookSourceFormat::Txt
        } else {
            BookSourceFormat::Epub
        }
    }

    fn external_to_library_book(&self, book: &ExternalBook) -> Result<LibraryBook, String> {
        Ok(LibraryBook {
            id: book.id.clone(),
            name: book.name.clone(),
            size: book.size,
            reading_status: None,
            source_format: Some(BookSourceFormat::Epub),
            exported_versions: Default::default(),
            content_edited_at: None,
            content_hash: book.content_hash.clone(),
            content_version: book.content_version.max(1),
            content_mode: book.content_mode,
            content_flags: book.content_flags.clone(),
            source_storage: book.source_storage,
            source_path: book.source_path.clone(),
            metadata: read_json_value_or_default(&self.external_book_dir(&book.id).join(METADATA_FILE))?,
            created_at: book.created_at,
            updated_at: None,
            last_read_at: Some(book.last_opened_at),
            cfi: None,
            percentage: None,
            tag_ids: Vec::new(),
        })
    }

    fn import_source_storage(&self) -> SourceStorage {
        self.inner
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .settings
                    .get("importSourceStorage")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|value| value == "referenced")
            .map(|_| SourceStorage::Referenced)
            .unwrap_or_default()
    }
}

fn clone_library(library: &Library) -> Library {
    Library {
        version: library.version,
        books: library.books.clone(),
        tags: library.tags.clone(),
    }
}

fn clone_external_index(index: &ExternalBookIndex) -> ExternalBookIndex {
    ExternalBookIndex {
        version: index.version,
        books: index.books.clone(),
    }
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os(APP_DATA_DIR_ENV) {
        let root = PathBuf::from(root);
        if !root.as_os_str().is_empty() {
            return Ok(root);
        }
    }

    let default_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let base_dir = default_dir
        .parent()
        .map(|parent| parent.join(APP_DATA_DIR_NAME))
        .unwrap_or(default_dir);

    Ok(base_dir)
}

fn books_root(root: &Path) -> PathBuf {
    root.join(BOOKS_DIR)
}

fn external_books_root(root: &Path) -> PathBuf {
    root.join(EXTERNAL_BOOKS_DIR)
}

fn delete_tombstones_root(root: &Path) -> PathBuf {
    root.join(DELETE_TOMBSTONES_DIR)
}

fn library_path(root: &Path) -> Result<PathBuf, String> {
    Ok(root.join(LIBRARY_FILE))
}

fn external_index_path(root: &Path) -> Result<PathBuf, String> {
    Ok(external_books_root(root).join(EXTERNAL_INDEX_FILE))
}

fn settings_path(root: &Path) -> Result<PathBuf, String> {
    Ok(root.join(SETTINGS_FILE))
}

fn is_external_book_id(id: &str) -> bool {
    id.starts_with("ext-") && is_valid_book_storage_id(id)
}

fn is_valid_book_storage_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn window_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join(WINDOW_STATE_FILE))
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }

    let data = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&data).map_err(|error| error.to_string())
}

fn read_json_value_or_default(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }

    let data = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&data).map_err(|error| error.to_string())
}

fn write_json<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let data = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

fn path_to_client_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn id_from_hash(hash: &str) -> String {
    hash.chars().take(16).collect()
}

fn book_export_key(format: BookExportFormat) -> String {
    format.as_str().to_string()
}

fn mark_book_exported(book: &mut LibraryBook, format: BookExportFormat) {
    book.exported_versions
        .insert(book_export_key(format), book.content_version);
}

#[cfg(test)]
fn book_is_export_dirty(book: &LibraryBook, format: BookExportFormat) -> bool {
    book.content_edited_at.is_some()
        && book.exported_versions.get(format.as_str()).copied().unwrap_or_default() < book.content_version
}

#[cfg(test)]
mod tests {
    use super::commands::{
        ReadingPositionInput, get_book_impl, import_epub_paths_impl, import_text_paths_impl,
        preview_text_import_paths_impl, record_reading_position_impl, revealable_book_source_path,
    };
    use super::{
        AppStorage, BOOK_FILE, BOOKS_DIR, BookContentMode, BookExportFormat, BookReaderSourceMode, BookRecord,
        BookScope, BookSourceFormat, BookSourceStatus, BookState, BookTextReplaceTarget, DirtyState, ExternalBookIndex,
        IMAGE_INDEX_CACHE_FILE, ImageIndexCacheInput, ImageIndexEntryInput, ImageIndexSectionInput, Library,
        LibraryBook, METADATA_FILE, ReadingStatus, SEARCH_TEXT_CACHE_FILE, SEARCH_TEXT_CACHE_VERSION,
        SEARCH_TEXT_EXTRACTOR_VERSION, SOURCE_TEXT_FILE, STATE_FILE, SearchTextCache, SearchTextSection, SourceStorage,
        SourceTextUpdate, StorageInner, StorageState, TextImportPreparedCache, TextImportRulesInput,
        TextImportSelection, UNPACKED_DIR, book_is_export_dirty, check_book_source_statuses_impl,
        cleanup_delete_tombstones, cleanup_external_book_heavy_files, decode_text_bytes, delete_books_to_tombstones,
        delete_tombstones_root, empty_object, ensure_book_package_path_with_unpacker, export_book_impl,
        external_books_root, external_index_path, get_book_reader_source_impl, hash_file, import_epub_path_impl,
        library_path, load_or_build_search_text_cache, mark_book_exported, mark_library_book_content_updated,
        normalize_non_square_pixel_png, normalize_publication_date, normalize_unpacked_epub_structure,
        open_external_epub_path_impl, parent_zip_path, parse_text_import_document, path_to_client_string,
        read_bounded_bytes, read_image_index_cache, read_json_or_default, read_json_value_or_default,
        read_search_text_sections_from_unpacked, relative_zip_path, replace_book_text_impl, replace_xhtml_text,
        replace_xhtml_text_node, schedule_existing_delete_tombstone_cleanup, search_text_cache_from_bytes,
        search_text_cache_to_bytes, search_text_in_cache, settings_path, sync_unpacked_opf_metadata, text_content_opf,
        text_nav_xhtml, text_section_xhtml, visible_search_text_from_xhtml, write_epub_from_original_and_unpacked,
        write_epub_from_unpacked_dir, write_image_index_cache_if_current, write_metadata, write_source_text_update,
    };
    use crate::tasks::TaskService;
    use serde_json::{Value, json};
    use std::{
        collections::{HashMap, VecDeque},
        fs,
        io::{Cursor, Read, Write},
        path::{Path, PathBuf},
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

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
        let mut book_states = HashMap::new();
        for book in &books {
            book_states.insert(
                book.id.clone(),
                BookState {
                    cfi: book.cfi.clone(),
                    percentage: book.percentage,
                    ..Default::default()
                },
            );
        }

        AppStorage {
            inner: Arc::new(StorageInner {
                root: root.to_path_buf(),
                state: Mutex::new(StorageState {
                    library: Library {
                        version: 1,
                        books,
                        tags: Vec::new(),
                    },
                    external: ExternalBookIndex::default(),
                    settings: json!({}),
                    book_states,
                }),
                dirty: Mutex::new(DirtyState::default()),
                flush_lock: Mutex::new(()),
                import_lock: Mutex::new(()),
                reading_position_sequences: Mutex::new(HashMap::new()),
                search_text_caches: Mutex::new(HashMap::new()),
                search_text_cache_order: Mutex::new(VecDeque::new()),
                text_import_prepared_cache: Mutex::new(TextImportPreparedCache::new()),
                text_import_prepare_runs: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_max_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_delay_ms: std::sync::atomic::AtomicU64::new(0),
                text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    fn test_storage_from_disk(root: &Path) -> AppStorage {
        AppStorage {
            inner: Arc::new(StorageInner {
                root: root.to_path_buf(),
                state: Mutex::new(StorageState {
                    library: read_json_or_default::<Library>(&library_path(root).unwrap()).unwrap(),
                    external: read_json_or_default::<ExternalBookIndex>(&external_index_path(root).unwrap()).unwrap(),
                    settings: read_json_value_or_default(&settings_path(root).unwrap()).unwrap(),
                    book_states: HashMap::new(),
                }),
                dirty: Mutex::new(DirtyState::default()),
                flush_lock: Mutex::new(()),
                import_lock: Mutex::new(()),
                reading_position_sequences: Mutex::new(HashMap::new()),
                search_text_caches: Mutex::new(HashMap::new()),
                search_text_cache_order: Mutex::new(VecDeque::new()),
                text_import_prepared_cache: Mutex::new(TextImportPreparedCache::new()),
                text_import_prepare_runs: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_max_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_delay_ms: std::sync::atomic::AtomicU64::new(0),
                text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    fn external_promotion_state(book_id: &str) -> BookState {
        BookState {
            cfi: Some("epubcfi(/6/4!/4/2)".to_string()),
            percentage: Some(0.42),
            definitions: vec!["term".to_string()],
            annotations: vec![json!({
                "id": "annotation-1",
                "bookId": book_id,
                "text": "note"
            })],
            configuration: Some(json!({"theme": "sepia", "spread": {"page": 2}})),
        }
    }

    fn assert_external_promoted(storage: &AppStorage, imported: &BookRecord, external_id: &str, source: &Path) {
        assert!(matches!(imported.scope, BookScope::Library));
        assert_ne!(imported.id, external_id);
        assert!(storage.book_dir(&imported.id).join(BOOK_FILE).exists());
        assert_eq!(
            hash_file(source).unwrap(),
            hash_file(&storage.book_dir(&imported.id).join(BOOK_FILE)).unwrap()
        );
        assert!(!storage.external_book_dir(external_id).exists());

        let state = storage.inner.state.lock().unwrap();
        assert!(state.external.books.is_empty());
        assert_eq!(state.library.books.len(), 1);
        assert!(!state.book_states.contains_key(external_id));
        let promoted_state = state.book_states.get(&imported.id).unwrap();
        assert_eq!(promoted_state.cfi.as_deref(), Some("epubcfi(/6/4!/4/2)"));
        assert_eq!(promoted_state.percentage, Some(0.42));
        assert_eq!(promoted_state.definitions, vec!["term".to_string()]);
        assert_eq!(
            promoted_state.annotations,
            vec![json!({
                "id": "annotation-1",
                "bookId": imported.id,
                "text": "note"
            })]
        );
        assert_eq!(
            promoted_state.configuration,
            Some(json!({"theme": "sepia", "spread": {"page": 2}}))
        );
        drop(state);

        let metadata: Value = read_json_value_or_default(&storage.book_dir(&imported.id).join(METADATA_FILE)).unwrap();
        assert_eq!(metadata.get("title").and_then(Value::as_str), Some("Edited External"));
        assert_eq!(metadata.get("custom").and_then(Value::as_str), Some("kept"));
        let state_file: BookState = read_json_or_default(&storage.book_dir(&imported.id).join(STATE_FILE)).unwrap();
        assert_eq!(state_file.cfi.as_deref(), Some("epubcfi(/6/4!/4/2)"));
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

    fn write_book_dir(storage: &AppStorage, id: &str, marker: &str) {
        let dir = storage.book_dir(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("marker.txt"), marker).unwrap();
    }

    fn tombstone_entries(root: &Path) -> Vec<PathBuf> {
        let tombstones = delete_tombstones_root(root);
        if !tombstones.exists() {
            return Vec::new();
        }
        fs::read_dir(tombstones)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect()
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

        let result = delete_books_to_tombstones(&storage, &[outside.to_string_lossy().into_owned()]);

        assert!(result.is_err());
        assert!(outside.join("marker.txt").exists());
        assert_eq!(storage.inner.state.lock().unwrap().library.books.len(), 1);

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn delete_books_moves_book_directories_to_tombstones_before_cleanup() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-delete-tombstone-test-{}-{nonce}",
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
                extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
                book_hash: "hash".to_string(),
                content_version: 1,
                sections: Vec::new(),
            }),
        );

        let tombstones = delete_books_to_tombstones(&storage, &["book-a".to_string(), "book-b".to_string()]).unwrap();

        {
            let state = storage.inner.state.lock().unwrap();
            assert!(state.library.books.is_empty());
            assert!(state.book_states.is_empty());
        }
        assert!(!storage.book_dir("book-a").exists());
        assert!(!storage.book_dir("book-b").exists());
        assert_eq!(tombstones.len(), 2);
        assert_eq!(tombstone_entries(&root).len(), 2);
        assert!(tombstones.iter().any(|path| path.join("marker.txt").exists()));
        assert!(!storage.inner.search_text_caches.lock().unwrap().contains_key("book-a"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_books_falls_back_when_tombstone_root_is_unavailable() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-delete-tombstone-fallback-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = test_storage_with_books(&root, vec![test_library_book_with_id("book-a", BookSourceFormat::Epub)]);
        write_book_dir(&storage, "book-a", "A");
        fs::create_dir_all(&root).unwrap();
        fs::write(delete_tombstones_root(&root), "blocked").unwrap();

        let tombstones = delete_books_to_tombstones(&storage, &["book-a".to_string()]).unwrap();

        {
            let state = storage.inner.state.lock().unwrap();
            assert!(state.library.books.is_empty());
            assert!(state.book_states.is_empty());
        }
        assert!(storage.inner.dirty.lock().unwrap().library);
        assert!(!storage.book_dir("book-a").exists());
        assert!(tombstones.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_tombstone_cleanup_removes_existing_tombstones() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-delete-cleanup-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
        let tombstone = delete_tombstones_root(&root).join("book-a-deleted");
        fs::create_dir_all(&tombstone).unwrap();
        fs::write(tombstone.join("marker.txt"), "deleted").unwrap();

        cleanup_delete_tombstones(&storage).unwrap();

        assert!(!tombstone.exists());
        assert!(tombstone_entries(&root).is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_tombstone_cleanup_removes_leftover_tombstones() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-startup-cleanup-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
        let tombstone = delete_tombstones_root(&root).join("book-a-leftover");
        fs::create_dir_all(&tombstone).unwrap();
        fs::write(tombstone.join("marker.txt"), "leftover").unwrap();
        let tasks = TaskService::default();

        schedule_existing_delete_tombstone_cleanup(&storage, &tasks);
        for _ in 0..100 {
            if !tombstone.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        assert!(!tombstone.exists());
        assert!(tombstone_entries(&root).is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn text_preview_then_import_consumes_prepared_entry_without_repreparing() {
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
        assert_eq!(storage.text_import_prepared_cache_len(), 1);

        let books = import_text_paths_impl(
            &storage,
            &tasks,
            vec![TextImportSelection {
                path: source.to_string_lossy().to_string(),
                encoding: Some(previews[0].encoding.clone()),
                title: Some(previews[0].title.clone()),
                creator: Some("作者".to_string()),
            }],
            true,
            None,
        )
        .unwrap();

        assert_eq!(books.len(), 1);
        assert_eq!(storage.text_import_prepare_run_count(), 1);
        assert_eq!(storage.text_import_prepared_cache_len(), 0);
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
        existing.content_hash = "before-import".to_string();
        existing.metadata = json!({"title": "Before import"});
        let storage = test_storage_with_book(&root, existing);
        fs::create_dir_all(root.join(BOOKS_DIR)).unwrap();
        fs::write(storage.book_dir("book"), "blocks the book directory").unwrap();
        let before = serde_json::to_value(&storage.inner.state.lock().unwrap().library.books[0]).unwrap();

        let result = import_text_paths_impl(
            &storage,
            &TaskService::default(),
            vec![TextImportSelection {
                path: source.to_string_lossy().to_string(),
                encoding: None,
                title: None,
                creator: None,
            }],
            true,
            None,
        );

        assert!(result.is_err());
        let after = serde_json::to_value(&storage.inner.state.lock().unwrap().library.books[0]).unwrap();
        assert_eq!(after, before);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn referenced_text_import_uses_only_unpacked_and_exports_only_epub() {
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

        let books = import_text_paths_impl(
            &storage,
            &tasks,
            vec![TextImportSelection {
                path: source.to_string_lossy().to_string(),
                encoding: None,
                title: None,
                creator: None,
            }],
            true,
            None,
        )
        .unwrap();
        let book = &books[0];
        let book_dir = storage.book_dir(&book.id);

        assert!(!book_dir.join(SOURCE_TEXT_FILE).exists());
        assert!(book_dir.join(UNPACKED_DIR).join("OEBPS/content.opf").exists());
        let persisted = serde_json::to_value(book).unwrap();
        assert_eq!(
            persisted.get("sourceStorage").and_then(Value::as_str),
            Some("referenced")
        );
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

        let books = import_text_paths_impl(
            &storage,
            &tasks,
            vec![TextImportSelection {
                path: source.to_string_lossy().to_string(),
                encoding: Some(previews[0].encoding.clone()),
                title: Some(previews[0].title.clone()),
                creator: None,
            }],
            true,
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
    fn text_prepare_cache_enforces_configured_byte_limit() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-text-prepare-limit-test-{}-{nonce}",
            std::process::id()
        ));
        let first = root.join("first.txt");
        let second = root.join("second.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&first, "第1章 第一\n第一段。\n").unwrap();
        fs::write(&second, "第1章 第二\n第二段。\n").unwrap();
        let storage = test_storage_with_books(&root, Vec::new());
        storage.set_text_import_prepared_cache_limit(32);
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
        assert_eq!(storage.text_import_prepare_run_count(), 2);
        assert!(storage.text_import_prepared_cache_bytes() <= 32);
        assert!(storage.text_import_prepared_cache_len() <= 1);

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

        let books = import_text_paths_impl(
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
            true,
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

        let books = import_text_paths_impl(&storage, &tasks, imports, true, None).unwrap();

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

        let books = import_text_paths_impl(
            &storage,
            &tasks,
            vec![TextImportSelection {
                path: source.to_string_lossy().to_string(),
                encoding: None,
                title: None,
                creator: None,
            }],
            true,
            None,
        )
        .unwrap();

        assert_eq!(books.len(), 1);
        assert!(!storage.book_dir(&books[0].id).join(SEARCH_TEXT_CACHE_FILE).exists());

        let _ = fs::remove_dir_all(root);
    }

    fn reading_position_input(
        sequence: u64,
        cfi: &str,
        percentage: f64,
        spread: serde_json::Value,
        updated_at: u64,
    ) -> ReadingPositionInput {
        ReadingPositionInput {
            book_id: "book".to_string(),
            cfi: Some(cfi.to_string()),
            percentage: Some(percentage),
            spread: Some(spread),
            updated_at,
            sequence,
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

    fn write_minimal_epub_with_xhtml_cover_image(path: &Path, cover_page_body: &str, cover_bytes: &[u8]) {
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
    <dc:title>XHTML Cover</dc:title>
  </metadata>
  <manifest>
    <item id="x_coverpage" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="image-cover" href="Images/real-cover.jpeg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    <itemref idref="x_coverpage" linear="yes"/>
    <itemref idref="chapter"/>
  </spine>
</package>"#,
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
        writer.start_file("OEBPS/Images/real-cover.jpeg", deflated).unwrap();
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

        let book = import_epub_path_impl(&storage, &source, true).unwrap();

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
        assert!(!book_dir.join(SEARCH_TEXT_CACHE_FILE).exists());
        let persisted = serde_json::to_value(&book).unwrap();
        assert_eq!(
            persisted.get("sourcePath").and_then(Value::as_str),
            Some(path_to_client_string(&source).as_str())
        );
        assert!(persisted.get("sourceStorage").is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn referenced_epub_import_keeps_source_in_place_and_publishes_unpacked_package() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-epub-reference-import-test-{}-{nonce}",
            std::process::id()
        ));
        let source = root.join("referenced.epub");
        write_minimal_epub_file(&source, "Referenced Book", "referenced body");
        let storage = test_storage_with_books(&root, Vec::new());
        use_referenced_import_sources(&storage);

        let book = import_epub_path_impl(&storage, &source, true).unwrap();
        let book_dir = storage.book_dir(&book.id);

        assert!(!book_dir.join(BOOK_FILE).exists());
        assert!(book_dir.join(UNPACKED_DIR).join("OEBPS/content.opf").exists());
        let persisted = serde_json::to_value(&book).unwrap();
        assert_eq!(
            persisted.get("sourceStorage").and_then(Value::as_str),
            Some("referenced")
        );
        assert_eq!(
            persisted.get("sourcePath").and_then(Value::as_str),
            Some(path_to_client_string(&source).as_str())
        );

        let tasks = TaskService::default();
        let reader_book = storage.library_book(&book.id).unwrap();
        let reader_source = get_book_reader_source_impl(&storage, &tasks, &reader_book).unwrap();
        assert_eq!(reader_source.mode, BookReaderSourceMode::Opf);
        assert!(reader_source.path.ends_with("/unpacked/OEBPS/content.opf"));

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

        assert!(book.id.starts_with("ext-"));
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
        assert!(external_dir.join(METADATA_FILE).exists());
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

        let imported = import_epub_path_impl(&storage, &source, true).unwrap();
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

        let imported = import_epub_path_impl(&storage, &source, true).unwrap();
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
    fn external_epub_cleanup_keeps_metadata_and_state() {
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
        fs::write(external_dir.join(SEARCH_TEXT_CACHE_FILE), "search").unwrap();
        fs::write(external_dir.join(IMAGE_INDEX_CACHE_FILE), "image").unwrap();
        {
            let mut state = storage.inner.state.lock().unwrap();
            let book_state = storage.ensure_book_state(&mut state, &book.id).unwrap();
            book_state.cfi = Some("epubcfi(/6/2)".to_string());
        }
        storage.mark_book_state_dirty(&book.id);
        storage.flush_dirty().unwrap();

        cleanup_external_book_heavy_files(&storage, &book.id).unwrap();

        assert!(!external_dir.join(BOOK_FILE).exists());
        assert!(!external_dir.join(UNPACKED_DIR).exists());
        assert!(!external_dir.join(SEARCH_TEXT_CACHE_FILE).exists());
        assert!(!external_dir.join(IMAGE_INDEX_CACHE_FILE).exists());
        assert!(external_dir.join(METADATA_FILE).exists());
        assert!(external_dir.join(STATE_FILE).exists());

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
        let imported = import_epub_path_impl(&storage, &source, true).unwrap();

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
        let imported = import_epub_path_impl(&storage, &source, true).unwrap();
        let managed_epub = storage.book_dir(&imported.id).join(BOOK_FILE);
        write_minimal_epub_file(&managed_epub, "Managed Edited", "edited body");
        write_metadata(
            &storage,
            &imported.id,
            &json!({"title": "Edited Metadata", "custom": "kept"}),
        )
        .unwrap();
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
        write_metadata(
            &storage,
            &external.id,
            &json!({"title": "Edited External", "custom": "kept"}),
        )
        .unwrap();
        {
            let mut state = storage.inner.state.lock().unwrap();
            state
                .book_states
                .insert(external.id.clone(), external_promotion_state(&external.id));
        }

        let imported = import_epub_path_impl(&storage, &source, true).unwrap();

        assert_external_promoted(&storage, &imported, &external.id, &source);

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
        write_metadata(
            &storage,
            &external.id,
            &json!({"title": "Edited External", "custom": "kept"}),
        )
        .unwrap();
        {
            let mut state = storage.inner.state.lock().unwrap();
            state
                .book_states
                .insert(external.id.clone(), external_promotion_state(&external.id));
        }
        storage.mark_book_state_dirty(&external.id);
        storage.flush_dirty().unwrap();

        let reloaded = test_storage_from_disk(&root);
        let imported = import_epub_path_impl(&reloaded, &source, true).unwrap();

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

        let book = import_epub_path_impl(&storage, &source, true).unwrap();

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
            cover_bytes,
        );
        let storage = test_storage_with_books(&root, Vec::new());

        let book = import_epub_path_impl(&storage, &source, true).unwrap();

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
            cover_bytes,
        );
        let storage = test_storage_with_books(&root, Vec::new());

        let book = import_epub_path_impl(&storage, &source, true).unwrap();

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

        let book = import_epub_path_impl(&storage, &source, true).unwrap();

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
            true,
            None,
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
    fn epub_replace_import_removes_stale_unpacked_and_search_artifacts() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-epub-replace-cleanup-test-{}-{nonce}",
            std::process::id()
        ));
        let source = root.join("replace.epub");
        write_minimal_epub_file(&source, "Old Book", "old body");
        let storage = test_storage_with_books(&root, Vec::new());
        let old_book = import_epub_path_impl(&storage, &source, true).unwrap();
        let book_dir = storage.book_dir(&old_book.id);
        fs::create_dir_all(book_dir.join(UNPACKED_DIR)).unwrap();
        fs::write(book_dir.join(UNPACKED_DIR).join("stale.txt"), "stale").unwrap();
        fs::write(book_dir.join(SEARCH_TEXT_CACHE_FILE), "stale").unwrap();

        write_minimal_epub_file(&source, "New Book", "new body");
        let new_book = import_epub_path_impl(&storage, &source, true).unwrap();

        assert_eq!(old_book.id, new_book.id);
        assert_eq!(new_book.metadata.get("title").and_then(Value::as_str), Some("New Book"));
        assert!(!book_dir.join(UNPACKED_DIR).exists());
        assert!(!book_dir.join(SEARCH_TEXT_CACHE_FILE).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unpack_package_reuses_in_flight_task_for_same_book_version() {
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
            book.content_version = book.content_version.saturating_add(1);
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
                .any(|section| section.href == "Text/invalid:path.xhtml"
                    && section.text.contains("非法路径章节 keyword"))
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "Text/invalid:path.xhtml");
        assert!(book_dir.join(SEARCH_TEXT_CACHE_FILE).exists());
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

        let exported = export_book_impl(&storage, "book".to_string(), BookExportFormat::Epub, output.clone())
            .unwrap()
            .unwrap();

        assert_eq!(fs::read(output).unwrap(), original);
        assert_eq!(exported.exported_versions.get("epub"), Some(&1));
        assert!(!book_dir.join(UNPACKED_DIR).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn record_reading_position_keeps_latest_sequence_in_memory() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-position-memory-test-{}-{nonce}",
            std::process::id()
        ));
        let mut book = test_library_book(BookSourceFormat::Txt);
        book.metadata = json!({ "sourceEncodingId": "utf-8" });
        let storage = test_storage_with_book(&root, book);

        let accepted = record_reading_position_impl(
            &storage,
            reading_position_input(2, "epubcfi(/6/4)", 0.4, json!({"version": 1}), 200),
        )
        .expect("new sequence should not error");
        assert!(accepted);

        let stale = record_reading_position_impl(
            &storage,
            reading_position_input(1, "epubcfi(/6/2)", 0.2, json!({"version": 1}), 100),
        )
        .expect("stale sequence should not error");
        assert!(!stale);

        let mut state = storage.inner.state.lock().unwrap();
        let book = state
            .library
            .books
            .iter()
            .find(|book| book.id == "book")
            .unwrap()
            .clone();
        let book_state = storage.ensure_book_state(&mut state, "book").unwrap().clone();

        assert_eq!(book.cfi.as_deref(), Some("epubcfi(/6/4)"));
        assert_eq!(book_state.cfi.as_deref(), Some("epubcfi(/6/4)"));
        assert_eq!(book.percentage, Some(0.4));
        assert_eq!(book_state.percentage, Some(0.4));
        assert_eq!(book.updated_at, Some(200));
        assert_eq!(book.last_read_at, Some(200));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn record_reading_position_marks_dirty_without_disk_write_until_flush() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-position-flush-test-{}-{nonce}",
            std::process::id()
        ));
        let mut book = test_library_book(BookSourceFormat::Txt);
        book.metadata = json!({ "sourceEncodingId": "utf-8" });
        let storage = test_storage_with_book(&root, book);

        let accepted = record_reading_position_impl(
            &storage,
            reading_position_input(1, "epubcfi(/6/8)", 0.8, json!({"version": 1}), 300),
        )
        .expect("position update should not error");
        assert!(accepted);

        assert!(!library_path(&root).unwrap().exists());
        assert!(!root.join("books").join("book").join(STATE_FILE).exists());

        storage.flush_dirty().expect("dirty position should flush");

        let library = fs::read_to_string(library_path(&root).unwrap()).unwrap();
        assert!(library.contains(r#""cfi": "epubcfi(/6/8)""#));
        assert!(library.contains(r#""percentage": 0.8"#));

        let state = fs::read_to_string(root.join("books").join("book").join(STATE_FILE)).unwrap();
        assert!(state.contains(r#""cfi": "epubcfi(/6/8)""#));
        assert!(state.contains(r#""percentage": 0.8"#));

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

        assert!(storage.flush_dirty().is_err());
        assert!(storage.inner.dirty.lock().unwrap().library);

        fs::remove_dir(&path).unwrap();
        storage.flush_dirty().expect("dirty library should be retryable");
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
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 2,
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
    }

    #[test]
    fn writes_image_index_cache_only_for_current_book_version() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-image-index-cache-test-{}-{nonce}",
            std::process::id()
        ));
        let book = test_library_book_with_id("book", BookSourceFormat::Epub);
        let storage = test_storage_with_book(&root, book.clone());
        fs::create_dir_all(storage.book_dir(&book.id)).unwrap();

        let input = ImageIndexCacheInput {
            book_hash: book.content_hash.clone(),
            content_version: book.content_version,
            sections: vec![ImageIndexSectionInput {
                section_index: 0,
                href: "Text/chapter.xhtml".to_string(),
                title: Some("Chapter One".to_string()),
                nav_path: Vec::new(),
                images: vec![ImageIndexEntryInput {
                    src: "../Images/p001.jpg".to_string(),
                    index: 0,
                    hidden_by_default: false,
                    reason: None,
                }],
            }],
        };

        assert!(write_image_index_cache_if_current(&storage, &book.id, input).unwrap());
        let cache = read_image_index_cache(&storage, &book).unwrap();
        assert_eq!(cache.sections.len(), 1);
        assert_eq!(cache.sections[0].images[0].src, "../Images/p001.jpg");

        let stale = ImageIndexCacheInput {
            book_hash: "old-hash".to_string(),
            content_version: book.content_version,
            sections: Vec::new(),
        };
        assert!(!write_image_index_cache_if_current(&storage, &book.id, stale).unwrap());
        let cache = read_image_index_cache(&storage, &book).unwrap();
        assert_eq!(cache.sections.len(), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn searches_in_cached_section_text_with_occurrences() {
        let cache = SearchTextCache {
            version: SEARCH_TEXT_CACHE_VERSION,
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 1,
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
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 1,
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
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 1,
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
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 1,
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
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 1,
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
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 1,
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
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 1,
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
        let xhtml = r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>target one</p><p>target two</p></body></html>"#;
        let target = BookTextReplaceTarget {
            section_href: "Text/chapter.xhtml".to_string(),
            text_node_index: 1,
            text_node_text: "target two".to_string(),
            start_offset: 0,
            end_offset: 6,
            paragraph_index: None,
        };

        let updated = replace_xhtml_text_node(xhtml, &target, "target", "fixed").expect("replace succeeds");

        assert!(updated.contains("<p>target one</p>"));
        assert!(updated.contains("<p>fixed two</p>"));
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
    fn syncs_unpacked_opf_title_and_first_creator_metadata() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("flow-reader-opf-metadata-test-{}-{nonce}", std::process::id()));
        fs::create_dir_all(root.join("META-INF")).unwrap();
        fs::create_dir_all(root.join("OEBPS")).unwrap();
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
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <metadata>
    <dc:title>旧标题</dc:title>
    <dc:creator opf:role="aut" opf:file-as="旧作者">旧作者</dc:creator>
    <dc:creator opf:role="trl" opf:file-as="译者">译者</dc:creator>
  </metadata>
</package>"#,
        )
        .unwrap();

        sync_unpacked_opf_metadata(
            &root,
            &json!({
                "title": "新标题 & 续",
                "creator": "新作者"
            }),
        )
        .expect("metadata sync succeeds");

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains("<dc:title>新标题 &amp; 续</dc:title>"));
        assert!(opf.contains(r#"<dc:creator opf:role="aut" opf:file-as="新作者">新作者</dc:creator>"#));
        assert!(opf.contains(r#"<dc:creator opf:role="trl" opf:file-as="译者">译者</dc:creator>"#));
        assert!(!opf.contains("旧标题"));
        assert!(!opf.contains("旧作者"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn syncs_unpacked_opf_multiline_creator_and_preserves_tail() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-opf-metadata-multiline-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("META-INF")).unwrap();
        fs::create_dir_all(root.join("OEBPS")).unwrap();
        fs::write(
            root.join("META-INF/container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <metadata>
    <dc:title>旧标题</dc:title>
    <dc:creator
      opf:role="aut"
      opf:file-as="旧作者">旧作者
    </dc:creator><meta property="keep">tail</meta>
  </metadata>
</package>"#,
        )
        .unwrap();

        sync_unpacked_opf_metadata(
            &root,
            &json!({
                "title": "新标题",
                "creator": "新作者"
            }),
        )
        .expect("metadata sync succeeds");

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains("<dc:title>新标题</dc:title>"));
        assert!(opf.contains(
            r#"    <dc:creator opf:role="aut" opf:file-as="新作者">新作者</dc:creator><meta property="keep">tail</meta>"#
        ));
        assert!(!opf.contains("<dc:creator\n"));
        assert!(!opf.contains("旧作者"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn syncs_unpacked_opf_metadata_removes_creators_when_author_is_empty() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-opf-metadata-empty-author-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("META-INF")).unwrap();
        fs::create_dir_all(root.join("OEBPS")).unwrap();
        fs::write(
            root.join("META-INF/container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>旧标题</dc:title>
    <dc:creator>作者一</dc:creator>
    <dc:creator>作者二</dc:creator>
  </metadata>
</package>"#,
        )
        .unwrap();

        sync_unpacked_opf_metadata(
            &root,
            &json!({
                "title": "保留标题",
                "creator": ""
            }),
        )
        .expect("metadata sync succeeds");

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains("<dc:title>保留标题</dc:title>"));
        assert!(!opf.contains("dc:creator"));
        assert!(!opf.contains("作者一"));
        assert!(!opf.contains("作者二"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn syncs_unpacked_opf_metadata_rewrites_utf16_opf_as_utf8() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-opf-metadata-utf16-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("META-INF")).unwrap();
        fs::create_dir_all(root.join("OEBPS")).unwrap();
        fs::write(
            root.join("META-INF/container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        let opf = r#"<?xml version="1.0" encoding="UTF-16LE"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>旧标题</dc:title>
    <dc:creator>旧作者</dc:creator>
  </metadata>
</package>"#;
        let mut bytes = vec![0xff, 0xfe];
        for unit in opf.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(root.join("OEBPS/content.opf"), bytes).unwrap();

        sync_unpacked_opf_metadata(
            &root,
            &json!({
                "title": "新标题",
                "creator": "新作者"
            }),
        )
        .expect("metadata sync succeeds");

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains(r#"encoding="UTF-8""#));
        assert!(opf.contains("<dc:title>新标题</dc:title>"));
        assert!(opf.contains("<dc:creator>新作者</dc:creator>"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn exported_versions_are_tracked_per_format() {
        let mut book = test_library_book(BookSourceFormat::Txt);
        book.content_version = 3;
        book.content_edited_at = Some(123);

        mark_book_exported(&mut book, BookExportFormat::Txt);

        assert_eq!(book.exported_versions.get("txt"), Some(&3));
        assert!(book_is_export_dirty(&book, BookExportFormat::Epub));
        assert!(!book_is_export_dirty(&book, BookExportFormat::Txt));
    }

    #[test]
    fn imported_content_repair_marks_epub_export_dirty() {
        let root = std::env::temp_dir().join(format!("flow-reader-import-repair-dirty-test-{}", std::process::id()));
        let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));

        let updated = mark_library_book_content_updated(&storage, "book")
            .unwrap()
            .expect("library book should be updated");

        assert_eq!(updated.content_version, 2);
        assert!(updated.content_edited_at.is_some());
        assert!(book_is_export_dirty(&updated, BookExportFormat::Epub));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn only_existing_referenced_sources_can_be_revealed() {
        let root = std::env::temp_dir().join(format!("flow-reader-reveal-source-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.epub");
        fs::write(&source, b"source").unwrap();

        let mut book = test_library_book(BookSourceFormat::Epub);
        book.source_path = Some(source.clone());
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
            source_format: Some(source_format),
            exported_versions: Default::default(),
            content_edited_at: None,
            content_hash: "hash".to_string(),
            content_version: 1,
            content_mode: BookContentMode::Normal,
            content_flags: Vec::new(),
            source_storage: SourceStorage::Managed,
            source_path: None,
            metadata: empty_object(),
            created_at: 1,
            updated_at: None,
            last_read_at: None,
            cfi: None,
            percentage: None,
            tag_ids: Vec::new(),
        }
    }
}
