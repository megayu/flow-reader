use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    diagnostics,
    tasks::{TaskKey, TaskKind, TaskPriority, TaskService},
};

mod archive_resource;
mod book_assets;
mod book_source;
pub(crate) mod checkpoint;
mod commands;
mod deletion;
mod editing;
mod epub_import;
mod export;
mod folder_import;
pub(crate) mod image_download;
mod image_index;
mod import_support;
mod model;
mod publication;
mod reading_metrics;
mod search;
pub(crate) mod settings;
mod state;
mod text_import;
mod window_state;

pub use archive_resource::archive_resource_protocol_response;
pub use commands::*;
pub use deletion::{cleanup_all_external_book_heavy_files, schedule_existing_pending_delete_cleanup};
pub use folder_import::*;
pub use image_index::ImageIndexCache;
#[cfg(test)]
use image_index::ImageIndexEntry;
use image_index::{
    ImageIndexSection, finalize_image_index, image_index_cache_from_bytes, image_index_cache_to_bytes,
    image_index_section_from_document,
};
#[cfg(test)]
use model::ReadingStatus;
use model::{
    BOOK_STATE_VERSION, BookContentMode, BookScope, BookState, LIBRARY_VERSION, Library, SourceStorage, StoredBook,
    WindowPaneState, WindowState, is_valid_book_storage_id,
};
pub use model::{
    BookExportFormat, BookModeSwitchConflict, BookModeSwitchResolution, BookModeSwitchResult, BookReaderSource,
    BookReaderSourceMode, BookRecord, BookSourceFormat, BookSourceStatus, BookSourceStatusRecord,
    BookTextReplaceResult, BookTextReplaceTarget, CoverInput, CoverRecord, LibraryPins, LibraryTagRecord,
};
pub use search::SearchTextResult;
pub use text_import::{
    TextImportEncodingOption, TextImportPreview, TextImportRulesInput, TextImportSelection, is_epub_file, is_txt_file,
};
pub use window_state::{
    AppCloseInput, WindowUiState, persist_app_close_state, restore_window_state, runtime_window_ui_state,
};
pub(crate) use window_state::{RuntimeWindowState, record_window_state};

use book_assets::{read_cover_record, write_cover};
use book_source::*;
#[cfg(test)]
use deletion::rename_books_for_deletion;
use deletion::{
    cleanup_external_book_heavy_files, clear_book_caches_impl, delete_books_impl, remove_book_derived_cache_files,
};
use editing::*;
use export::*;

use epub_import::{
    clean_xml_text, commit_prepared_epub_import, deobfuscate_unpacked_idpf_fonts, find_unpacked_opf_path,
    inspect_epub_access, join_zip_path, materialize_epub_package, normalize_unpacked_epub_structure,
    normalize_zip_path, open_external_epub_path_unflushed_impl, parent_zip_path, prepare_epub_import,
    read_epub_xml_file, unpack_epub, validate_epub_archive_limits,
};
#[cfg(test)]
use epub_import::{
    normalize_epub_creator, normalize_non_square_pixel_png, normalize_publication_date, open_external_epub_path_impl,
    relative_zip_path,
};

use import_support::{
    BookImportLookupIndex, ExistingBookImport, ImportFileTransaction, ImportFinalizer,
    eager_import_materialization_enabled, existing_book_import, import_work_path, same_source_path,
};
use search::{
    DerivedCacheState, SearchTextCache, get_or_compute_book_word_count, load_or_build_image_index_cache,
    load_or_build_search_text_cache, search_text_in_cache,
};
#[cfg(test)]
use search::{
    SearchTextSection, read_image_index_cache, read_search_text_sections_from_unpacked, search_text_cache_from_bytes,
    search_text_cache_to_bytes, visible_search_text_from_xhtml, write_image_index_cache_if_current,
};
use state::{DirtyState, StorageState};
use text_import::{
    PreparedTextImport, create_skipped_text_import_preview, create_text_cover_input, create_text_import_error_preview,
    create_text_import_preview_from_prepared, decode_text_bytes, encode_text_bytes, import_text_path_impl,
    materialize_library_text_publication, prepare_text_import, should_skip_prepared_text_import_preview,
    source_encoding_id_from_metadata, text_import_encoding_options, write_text_cover_to_unpacked,
};
#[cfg(test)]
use text_import::{parse_text_import_document, text_content_opf, text_nav_xhtml, text_section_xhtml};

const APP_DATA_DIR_NAME: &str = "Flow Reader";
const APP_DATA_DIR_ENV: &str = "FLOW_READER_DATA_DIR";
const BOOKS_DIR: &str = "books";
const PENDING_DELETE_PREFIX: &str = ".del-";
const LIBRARY_FILE: &str = "library.json";
const RECENT_BOOK_LIMIT: usize = 10;
const SETTINGS_FILE: &str = "settings.json";
const BOOK_FILE: &str = "book.epub";
const SOURCE_TEXT_FILE: &str = "source.txt";
const UNPACKED_DIR: &str = "unpacked";

fn encode_compressed_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    zstd::stream::encode_all(json.as_slice(), 8).map_err(|error| error.to_string())
}

fn decode_compressed_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    let json = zstd::stream::decode_all(bytes).map_err(|error| error.to_string())?;
    serde_json::from_slice(&json).map_err(|error| error.to_string())
}

fn is_derived_cache_file_name(name: &str) -> bool {
    (name.starts_with("search-text.v") || name.starts_with("image-index.v") || name.starts_with("reading-metrics.v"))
        && name.ends_with(".json.zst")
}
const SEARCH_TEXT_EXCERPT_RADIUS: usize = 60;
pub const SEARCH_TEXT_CACHE_VERSION: u32 = 1;
pub const IMAGE_INDEX_CACHE_VERSION: u32 = 1;
const COVER_STEM: &str = "cover";
const STATE_FILE: &str = "state.json";
const WINDOW_STATE_FILE: &str = "window-state.json";
const EPUB_ZIP_WRITER_BUFFER_SIZE: usize = 256 * 1024;
const TXT_EPUB_DEFLATE_LEVEL: i64 = 2;

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
    search_text_caches: Mutex<HashMap<String, Arc<SearchTextCache>>>,
    image_index_caches: Mutex<HashMap<String, Arc<ImageIndexCache>>>,
    derived_cache_states: Mutex<HashMap<String, DerivedCacheState>>,
    derived_cache_flush_lock: Mutex<()>,
    archive_resources: Mutex<HashMap<String, archive_resource::ArchiveResourceSession>>,
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
const WINDOWS_MINIMIZED_POSITION_SENTINEL: i32 = -30_000;

fn empty_object() -> Value {
    json!({})
}

fn current_book_revision(book: &StoredBook) -> u32 {
    book.source_revision.max(book.revision)
}

fn next_book_revision(book: &StoredBook) -> Result<u32, String> {
    current_book_revision(book)
        .checked_add(1)
        .ok_or_else(|| "Book revision overflow".to_string())
}

fn has_unexported_book_changes(book: &StoredBook) -> bool {
    book.revision > book.source_revision && book.latest_export_revision != Some(book.revision)
}

fn adopt_book_source_fields(book: &mut StoredBook, source_hash: String, size: u64) -> Result<(), String> {
    book.source_revision = next_book_revision(book)?;
    book.source_hash = source_hash;
    book.size = size;
    book.word_count = None;
    Ok(())
}

fn mark_book_content_updated_fields(book: &mut StoredBook, edited_at: u64) -> Result<(), String> {
    book.revision = next_book_revision(book)?;
    book.content_edited_at = Some(edited_at);
    Ok(())
}

fn source_storage_from_settings(settings: &Value) -> SourceStorage {
    match settings.get("importSourceStorage").and_then(Value::as_str) {
        Some("referenced") | None => SourceStorage::Referenced,
        Some(_) => SourceStorage::Managed,
    }
}

fn epub_editable_from_settings(settings: &Value) -> bool {
    settings.get("defaultEpubMode").and_then(Value::as_str) == Some("unpacked")
}

impl AppStorage {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let root = data_root(app)?;
        let library = read_json_or_default::<Library>(&library_path(&root)?)?;
        if library.version != LIBRARY_VERSION {
            return Err(format!(
                "Unsupported library version {}; current version is {LIBRARY_VERSION}",
                library.version
            ));
        }
        let settings_path = settings_path(&root)?;
        let initialize_settings = !settings_path.exists();
        let mut settings = read_json_value_or_default(&settings_path)?;
        if initialize_settings {
            settings::initialize_first_launch_settings(&mut settings)?;
        }
        if library.books.iter().any(|book| !is_valid_book_storage_id(&book.id)) {
            return Err("Storage contains an invalid book id".to_string());
        }
        if library.books.iter().any(|book| book.source_path.as_os_str().is_empty()) {
            return Err("Storage contains an empty book source path".to_string());
        }
        let mut book_ids = HashSet::with_capacity(library.books.len());
        if library.books.iter().any(|book| !book_ids.insert(book.id.as_str())) {
            return Err("Storage contains duplicate book ids".to_string());
        }
        if library
            .books
            .iter()
            .any(|book| book.source_revision == 0 || book.revision == 0)
        {
            return Err("Storage contains an invalid book revision".to_string());
        }
        let storage = Self {
            inner: Arc::new(StorageInner {
                root,
                state: Mutex::new(StorageState::new(library, settings)),
                dirty: Mutex::new(DirtyState::default()),
                flush_lock: Mutex::new(()),
                import_lock: Mutex::new(()),
                search_text_caches: Mutex::new(HashMap::new()),
                image_index_caches: Mutex::new(HashMap::new()),
                derived_cache_states: Mutex::new(HashMap::new()),
                derived_cache_flush_lock: Mutex::new(()),
                archive_resources: Mutex::new(HashMap::new()),
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
        };
        if initialize_settings {
            storage.mark_settings_dirty();
        }
        Ok(storage)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.inner.root
    }

    fn book_dir(&self, id: &str) -> PathBuf {
        books_root(self.root()).join(id)
    }

    fn search_text_cache_path(&self, id: &str, source_revision: u32, revision: u32) -> PathBuf {
        self.book_dir(id).join(format!(
            "search-text.v{SEARCH_TEXT_CACHE_VERSION}.s{source_revision}.r{revision}.json.zst"
        ))
    }

    fn image_index_cache_path(&self, id: &str, source_revision: u32, revision: u32) -> PathBuf {
        self.book_dir(id).join(format!(
            "image-index.v{IMAGE_INDEX_CACHE_VERSION}.s{source_revision}.r{revision}.json.zst"
        ))
    }

    // source_revision changes must rebuild reading metrics; revision changes must reuse them.
    fn reading_metrics_cache_path(&self, id: &str, source_revision: u32) -> PathBuf {
        self.book_dir(id).join(format!(
            "reading-metrics.v{}.s{source_revision}.json.zst",
            reading_metrics::READING_METRICS_VERSION,
        ))
    }

    fn stored_book(&self, id: &str) -> Result<StoredBook, String> {
        if !is_valid_book_storage_id(id) {
            return Err("Invalid book id".to_string());
        }
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        state
            .library
            .books
            .iter()
            .find(|book| book.id == id)
            .cloned()
            .ok_or_else(|| "Book not found".to_string())
    }

    fn library_book(&self, id: &str) -> Result<StoredBook, String> {
        let book = self.stored_book(id)?;
        (book.scope == BookScope::Library)
            .then_some(book)
            .ok_or_else(|| "Book not found".to_string())
    }

    fn ensure_external_book(&self, id: &str) -> Result<(), String> {
        if !is_valid_book_storage_id(id) {
            return Err("Invalid external book id".to_string());
        }
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state
            .library
            .books
            .iter()
            .any(|book| book.id == id && book.scope == BookScope::External)
            .then_some(())
            .ok_or_else(|| "External book not found".to_string())
    }

    fn remove_derived_memory_caches(&self, id: &str) {
        if let Ok(mut caches) = self.inner.search_text_caches.lock() {
            caches.remove(id);
        }
        if let Ok(mut caches) = self.inner.image_index_caches.lock() {
            caches.remove(id);
        }
        if let Ok(mut states) = self.inner.derived_cache_states.lock() {
            states.remove(id);
        }
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

    fn read_book_state(&self, id: &str) -> Result<BookState, String> {
        let state = read_json_or_default::<BookState>(&self.book_dir(id).join(STATE_FILE))?;
        if state.version != BOOK_STATE_VERSION {
            return Err(format!(
                "Unsupported book state version {}; current version is {BOOK_STATE_VERSION}",
                state.version
            ));
        }
        Ok(state)
    }

    fn write_book_state(&self, id: &str, state: &BookState) -> Result<(), String> {
        write_json_durable(&self.book_dir(id).join(STATE_FILE), state)
    }

    fn compose_book(&self, book: &StoredBook) -> Result<BookRecord, String> {
        let book_state = self.read_book_state(&book.id)?;
        let mut record = self.compose_book_summary(book);
        record.definitions = book_state.definitions;
        record.annotations = book_state.annotations;
        record.cfi = book_state.cfi;
        record.percentage = book_state.percentage;
        record.configuration = book_state.configuration;
        Ok(record)
    }

    fn compose_book_summary(&self, book: &StoredBook) -> BookRecord {
        BookRecord {
            id: book.id.clone(),
            name: book.name.clone(),
            size: book.size,
            scope: book.scope,
            reading_status: book.reading_status.clone(),
            source_format: book.source_format,
            generated_cover: book.generated_cover,
            content_edited_at: book.content_edited_at,
            word_count: book.word_count,
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
            source_hash: book.source_hash.clone(),
            source_revision: book.source_revision,
            revision: book.revision,
            latest_export_revision: book.latest_export_revision,
            latest_export_hash: book.latest_export_hash.clone(),
            content_mode: book.content_mode,
            editable: book.editable,
            source_storage: book.source_storage,
            source_path: path_to_client_string(&book.source_path),
        }
    }

    fn import_source_storage(&self) -> SourceStorage {
        self.inner.state.lock().ok().map_or(SourceStorage::Referenced, |state| {
            source_storage_from_settings(&state.settings)
        })
    }

    fn default_epub_editable(&self) -> bool {
        self.inner
            .state
            .lock()
            .ok()
            .is_some_and(|state| epub_editable_from_settings(&state.settings))
    }

    fn should_copy_text_import(&self, copy_source_files: Option<bool>) -> bool {
        let Ok(state) = self.inner.state.lock() else {
            return copy_source_files.unwrap_or(false);
        };
        if source_storage_from_settings(&state.settings) == SourceStorage::Managed {
            return true;
        }

        copy_source_files
            .or_else(|| state.settings.get("copyTextImports").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn text_import_rules(&self) -> Result<TextImportRulesInput, String> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        Ok(state.text_import_rules.clone())
    }
}

fn clone_library(library: &Library) -> Library {
    Library {
        version: library.version,
        books: library.books.clone(),
        tags: library.tags.clone(),
        pins: library.pins.clone(),
        recent_book_ids: library.recent_book_ids.clone(),
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

fn library_path(root: &Path) -> Result<PathBuf, String> {
    Ok(root.join(LIBRARY_FILE))
}

fn settings_path(root: &Path) -> Result<PathBuf, String> {
    Ok(root.join(SETTINGS_FILE))
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

fn library_book_author(book: &StoredBook) -> Option<String> {
    let author = book
        .metadata
        .get("creator")
        .and_then(Value::as_str)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!author.is_empty()).then_some(author)
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

fn write_json_durable<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let data = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("tmp");
    let mut file = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    file.write_all(&data).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&tmp, path).map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
    }

    Ok(())
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

fn mark_book_exported(book: &mut StoredBook, revision: u32, hash: Option<String>) {
    book.latest_export_revision = Some(revision);
    if let Some(hash) = hash {
        book.latest_export_hash = Some(hash);
    }
}

#[cfg(test)]
mod tests;
