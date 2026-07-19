use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    diagnostics,
    tasks::{TaskKey, TaskKind, TaskPriority, TaskService},
};

mod book_assets;
mod commands;
mod epub_import;
mod image_index;
mod search;
mod text_import;
mod window_state;

pub use commands::*;
pub use image_index::ImageIndexCache;
pub use search::SearchTextResult;
pub use text_import::{
    is_epub_file, is_txt_file, TextImportEncodingOption, TextImportPreview, TextImportRulesInput,
    TextImportSelection,
};
pub use window_state::{flush_app_storage, restore_window_state, save_window_state};

use book_assets::{
    is_generated_text_cover, read_cover, remove_cover_files, write_cover, write_metadata,
};

use epub_import::{
    clean_xml_text, find_unpacked_opf_path, import_epub_path_impl, inspect_epub_access,
    join_zip_path, normalize_unpacked_epub_structure, normalize_zip_path,
    open_external_epub_path_impl, parent_zip_path, unpack_epub,
};
#[cfg(test)]
use epub_import::{normalize_non_square_pixel_png, normalize_publication_date};

#[cfg(test)]
use image_index::{
    image_index_cache_from_bytes, image_index_cache_to_bytes, ImageIndexEntry,
    ImageIndexEntryInput, ImageIndexSection, ImageIndexSectionInput,
};
use image_index::{
    read_image_index_cache, write_image_index_cache_if_current, ImageIndexCacheInput,
};
use search::{load_or_build_search_text_cache, search_text_in_cache, SearchTextCache};
#[cfg(test)]
use search::{
    read_search_text_sections_from_unpacked, search_text_cache_from_bytes,
    search_text_cache_to_bytes, visible_search_text_from_xhtml, SearchTextSection,
};
use text_import::{
    consume_or_prepare_text_import, create_skipped_text_import_preview, create_text_cover_input,
    create_text_import_error_preview, create_text_import_preview_from_prepared, decode_text_bytes,
    encode_text_bytes, import_text_path_impl, load_or_prepare_text_import,
    should_skip_prepared_text_import_preview, source_encoding_id_from_metadata,
    text_import_encoding_options, write_text_cover_to_unpacked, PreparedTextImport,
    TextImportPreparedCache, TextImportPreparedKey,
};
#[cfg(test)]
use text_import::{
    parse_text_import_document, text_content_opf, text_nav_xhtml, text_section_xhtml,
};

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

const READING_POSITION_FLUSH_DELAY: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct AppStorage {
    inner: Arc<StorageInner>,
}

struct StorageInner {
    root: PathBuf,
    state: Mutex<StorageState>,
    dirty: Mutex<DirtyState>,
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

struct StorageState {
    library: Library,
    external: ExternalBookIndex,
    settings: Value,
    book_states: HashMap<String, BookState>,
}

#[derive(Default)]
struct DirtyState {
    library: bool,
    external: bool,
    settings: bool,
    book_states: HashSet<String>,
    delayed_flush_scheduled: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    #[serde(default = "library_version")]
    version: u32,
    #[serde(default)]
    books: Vec<LibraryBook>,
    #[serde(default)]
    tags: Vec<LibraryTagRecord>,
}

fn library_version() -> u32 {
    1
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalBookIndex {
    #[serde(default = "external_book_index_version")]
    version: u32,
    #[serde(default)]
    books: Vec<ExternalBook>,
}

fn external_book_index_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalBook {
    id: String,
    name: String,
    size: u64,
    content_hash: String,
    #[serde(default)]
    content_version: u32,
    #[serde(default, skip_serializing_if = "BookContentMode::is_normal")]
    content_mode: BookContentMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content_flags: Vec<BookContentFlag>,
    created_at: u64,
    last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryBook {
    id: String,
    name: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reading_status: Option<ReadingStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_format: Option<BookSourceFormat>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    exported_versions: HashMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_edited_at: Option<u64>,
    #[serde(default)]
    content_hash: String,
    #[serde(default)]
    content_version: u32,
    #[serde(default, skip_serializing_if = "BookContentMode::is_normal")]
    content_mode: BookContentMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content_flags: Vec<BookContentFlag>,
    #[serde(default = "empty_object")]
    metadata: Value,
    created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_read_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cfi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percentage: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRecord {
    id: String,
    name: String,
    size: u64,
    scope: BookScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    reading_status: Option<ReadingStatus>,
    source_format: BookSourceFormat,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    exported_versions: HashMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_edited_at: Option<u64>,
    #[serde(default = "empty_object")]
    metadata: Value,
    created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_read_at: Option<u64>,
    #[serde(default)]
    definitions: Vec<String>,
    #[serde(default)]
    annotations: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cfi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percentage: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tag_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    configuration: Option<Value>,
    #[serde(default)]
    content_hash: String,
    #[serde(default)]
    content_version: u32,
    #[serde(default, skip_serializing_if = "BookContentMode::is_normal")]
    content_mode: BookContentMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content_flags: Vec<BookContentFlag>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BookScope {
    Library,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTagRecord {
    id: String,
    name: String,
    created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverRecord {
    id: String,
    cover: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverInput {
    #[serde(default)]
    mime_type: String,
    extension: String,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReadingStatus {
    ToRead,
    Reading,
    Read,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookSourceFormat {
    Epub,
    Txt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BookContentMode {
    Normal,
    ArchiveOnly,
}

impl Default for BookContentMode {
    fn default() -> Self {
        Self::Normal
    }
}

impl BookContentMode {
    fn is_normal(value: &Self) -> bool {
        *value == Self::Normal
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BookContentFlag {
    NonPortableArchivePaths,
    DeclaresEncryption,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookExportFormat {
    Epub,
    Txt,
}

impl BookExportFormat {
    fn as_str(self) -> &'static str {
        match self {
            BookExportFormat::Epub => "epub",
            BookExportFormat::Txt => "txt",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTextReplaceTarget {
    section_href: String,
    text_node_index: usize,
    text_node_text: String,
    start_offset: usize,
    end_offset: usize,
    #[serde(default)]
    paragraph_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTextReplaceResult {
    book: BookRecord,
    section_href: String,
    changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookReaderSource {
    mode: BookReaderSourceMode,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    book: Option<BookRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BookReaderSourceMode {
    Opf,
    Epub,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookState {
    #[serde(skip_serializing_if = "Option::is_none")]
    cfi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percentage: Option<f64>,
    #[serde(default)]
    definitions: Vec<String>,
    #[serde(default)]
    annotations: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    configuration: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
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
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        if let Some(book) = state
            .library
            .books
            .iter()
            .find(|book| book.id == id)
            .cloned()
        {
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

    fn unload_search_text_cache(&self, id: &str) {
        if let Ok(mut caches) = self.inner.search_text_caches.lock() {
            caches.remove(id);
        }
        if let Ok(mut order) = self.inner.search_text_cache_order.lock() {
            order.retain(|cache_id| cache_id != id);
        }
    }

    fn get_prepared_text_import(
        &self,
        key: &TextImportPreparedKey,
    ) -> Option<Arc<PreparedTextImport>> {
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

    fn take_prepared_text_import(
        &self,
        key: &TextImportPreparedKey,
    ) -> Option<Arc<PreparedTextImport>> {
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
                match self
                    .inner
                    .text_import_prepared_handoff_max_active
                    .compare_exchange(
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
        self.inner
            .text_import_prepared_cache
            .lock()
            .unwrap()
            .bytes()
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
        self.inner.text_import_prepare_delay_ms.store(
            delay.as_millis() as u64,
            std::sync::atomic::Ordering::SeqCst,
        );
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

    fn ensure_book_state<'a>(
        &self,
        state: &'a mut StorageState,
        id: &str,
    ) -> Result<&'a mut BookState, String> {
        if !state.book_states.contains_key(id) {
            let book_state = self.read_book_state_uncached(id)?;
            state.book_states.insert(id.to_string(), book_state);
        }

        Ok(state
            .book_states
            .get_mut(id)
            .expect("book state should exist"))
    }

    fn compose_book(
        &self,
        state: &mut StorageState,
        book: &LibraryBook,
    ) -> Result<BookRecord, String> {
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
            metadata: read_json_value_or_default(
                &self.external_book_dir(&book.id).join(METADATA_FILE),
            )?,
            created_at: book.created_at,
            updated_at: None,
            last_read_at: Some(book.last_opened_at),
            cfi: None,
            percentage: None,
            tag_ids: Vec::new(),
        })
    }

    fn mark_library_dirty(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.library = true;
        }
    }

    fn mark_external_dirty(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.external = true;
        }
    }

    fn mark_settings_dirty(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.settings = true;
        }
    }

    fn mark_book_state_dirty(&self, id: &str) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.book_states.insert(id.to_string());
        }
    }

    fn schedule_reading_position_flush(&self) {
        let should_schedule = {
            let Ok(mut dirty) = self.inner.dirty.lock() else {
                return;
            };
            if dirty.delayed_flush_scheduled {
                false
            } else {
                dirty.delayed_flush_scheduled = true;
                true
            }
        };

        if !should_schedule {
            return;
        }

        let storage = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(READING_POSITION_FLUSH_DELAY);
            storage.clear_delayed_flush_flag();
            if let Err(error) = storage.flush_dirty() {
                eprintln!("Failed to flush reading position: {error}");
            }
        });
    }

    fn clear_delayed_flush_flag(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.delayed_flush_scheduled = false;
        }
    }

    pub fn flush_dirty(&self) -> Result<(), String> {
        let dirty = {
            let mut dirty = self
                .inner
                .dirty
                .lock()
                .map_err(|_| "storage dirty lock poisoned".to_string())?;
            let snapshot = DirtyState {
                library: dirty.library,
                external: dirty.external,
                settings: dirty.settings,
                book_states: std::mem::take(&mut dirty.book_states),
                delayed_flush_scheduled: dirty.delayed_flush_scheduled,
            };
            dirty.library = false;
            dirty.external = false;
            dirty.settings = false;
            snapshot
        };

        if !dirty.library && !dirty.external && !dirty.settings && dirty.book_states.is_empty() {
            return Ok(());
        }

        let (library, external, settings, book_states) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let library = dirty.library.then(|| clone_library(&state.library));
            let external = dirty
                .external
                .then(|| clone_external_index(&state.external));
            let settings = dirty.settings.then(|| state.settings.clone());
            let book_states = dirty
                .book_states
                .iter()
                .filter_map(|id| state.book_states.get(id).map(|s| (id.clone(), s.clone())))
                .collect::<Vec<_>>();

            (library, external, settings, book_states)
        };

        if let Some(library) = library {
            write_json(&library_path(self.root())?, &library)?;
        }
        if let Some(external) = external {
            write_json(&external_index_path(self.root())?, &external)?;
        }
        if let Some(settings) = settings {
            write_json(&settings_path(self.root())?, &settings)?;
        }
        for (id, book_state) in book_states {
            write_json(&self.book_dir(&id).join(STATE_FILE), &book_state)?;
        }

        Ok(())
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

    let default_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
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
    id.starts_with("ext-")
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

#[cfg(test)]
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

fn ensure_book_package_path_with_unpacker(
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
                diagnostics_storage
                    .search_text_memory_cache_len()
                    .to_string(),
            ),
        ];
        fields.extend(tasks.diagnostic_fields());
        diagnostics::record_timing("epub-unpack", started.elapsed(), &fields);
    }
    result
}

fn ensure_book_package_path(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &LibraryBook,
) -> Result<PathBuf, String> {
    ensure_book_package_path_with_unpacker(storage, tasks, book, unpack_epub)
}

fn set_book_content_access(
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

fn inspect_and_store_book_content_access(
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

fn get_book_reader_source_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &LibraryBook,
) -> Result<BookReaderSource, String> {
    let book_dir = storage.book_dir(&book.id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);
    if let Ok(opf_path) = find_unpacked_opf_path(&unpacked_dir) {
        return Ok(BookReaderSource {
            mode: BookReaderSourceMode::Opf,
            path: path_to_client_string(&opf_path),
            book: None,
        });
    }

    if inspect_and_store_book_content_access(storage, book)? == BookContentMode::ArchiveOnly {
        let book_path = book_dir.join(BOOK_FILE);
        if !book_path.exists() {
            return Err("Book package is unavailable".to_string());
        }
        return Ok(BookReaderSource {
            mode: BookReaderSourceMode::Epub,
            path: path_to_client_string(&book_path),
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
        book: updated_book,
    })
}

fn publish_unpacked_book_package(
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

fn unpack_epub_task_key(book: &LibraryBook) -> TaskKey {
    TaskKey::new(
        TaskKind::EpubUnpack,
        format!("{}:{}:{}", book.id, book.content_hash, book.content_version),
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

fn book_content_still_current(storage: &AppStorage, book: &LibraryBook) -> Result<bool, String> {
    let current = storage.library_book(&book.id)?;
    Ok(
        current.content_hash == book.content_hash
            && current.content_version == book.content_version,
    )
}

fn delete_books_to_tombstones(
    storage: &AppStorage,
    ids: &[String],
) -> Result<Vec<PathBuf>, String> {
    let ids = ids
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect::<HashSet<_>>();

    if ids.is_empty() {
        return Ok(Vec::new());
    }

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.library.books.retain(|book| !ids.contains(&book.id));
        for id in &ids {
            state.book_states.remove(id);
        }
    }
    storage.mark_library_dirty();

    let mut tombstones = Vec::new();
    for id in &ids {
        storage.unload_search_text_cache(id);
        if let Some(tombstone) = move_book_dir_to_tombstone(storage, id) {
            tombstones.push(tombstone);
        }
    }

    Ok(tombstones)
}

fn move_book_dir_to_tombstone(storage: &AppStorage, id: &str) -> Option<PathBuf> {
    let book_dir = storage.book_dir(id);
    if !book_dir.exists() {
        return None;
    }

    let tombstones_root = delete_tombstones_root(storage.root());
    if let Err(error) = fs::create_dir_all(&tombstones_root) {
        eprintln!("Failed to prepare deleted book tombstone directory: {error}");
        remove_book_dir_directly(&book_dir);
        return None;
    }
    let tombstone = next_delete_tombstone_path(&tombstones_root, id);

    match fs::rename(&book_dir, &tombstone) {
        Ok(()) => Some(tombstone),
        Err(error) => {
            eprintln!("Failed to move deleted book directory to tombstone: {error}");
            remove_book_dir_directly(&book_dir);
            None
        }
    }
}

fn remove_book_dir_directly(book_dir: &Path) {
    if let Err(error) = fs::remove_dir_all(book_dir) {
        eprintln!("Failed to delete book directory: {error}");
    }
}

fn next_delete_tombstone_path(root: &Path, id: &str) -> PathBuf {
    let stamp = now_ms();
    let pid = std::process::id();
    let id = sanitize_tombstone_name(id);
    for index in 0.. {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let path = root.join(format!("{id}-{pid}-{stamp}{suffix}"));
        if !path.exists() {
            return path;
        }
    }

    unreachable!("tombstone path loop should return")
}

fn sanitize_tombstone_name(value: &str) -> String {
    let name = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    if name.is_empty() {
        "book".to_string()
    } else {
        name
    }
}

#[cfg(test)]
fn cleanup_delete_tombstones(storage: &AppStorage) -> Result<(), String> {
    let tombstones = list_delete_tombstones(storage)?;
    for tombstone in tombstones {
        cleanup_delete_tombstone_path(&tombstone)?;
    }

    let root = delete_tombstones_root(storage.root());
    if root.exists() {
        let is_empty = fs::read_dir(&root)
            .map_err(|error| error.to_string())?
            .next()
            .is_none();
        if is_empty {
            fs::remove_dir(&root).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn list_delete_tombstones(storage: &AppStorage) -> Result<Vec<PathBuf>, String> {
    let root = delete_tombstones_root(storage.root());
    if !root.exists() {
        return Ok(Vec::new());
    }

    fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn cleanup_delete_tombstone_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn enqueue_delete_tombstone_cleanup(tasks: &TaskService, tombstones: Vec<PathBuf>) {
    if tombstones.is_empty() {
        return;
    }

    let tasks = tasks.clone();
    std::thread::spawn(move || {
        for tombstone in tombstones {
            let key = TaskKey::new(
                TaskKind::TombstoneCleanup,
                tombstone.to_string_lossy().into_owned(),
            );
            let runner = tasks.clone();
            let cleanup_path = tombstone.clone();
            if let Err(error) = tasks.get_or_run(key, TaskPriority::Background, move || {
                runner.run_background(|| cleanup_delete_tombstone_path(&cleanup_path))
            }) {
                eprintln!("Failed to cleanup deleted book tombstone: {error}");
            }
        }
    });
}

fn delete_books_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    ids: Vec<String>,
) -> Result<(), String> {
    let started = Instant::now();
    let source_count = ids.len();
    let tombstones = delete_books_to_tombstones(storage, &ids)?;
    let tombstone_count = tombstones.len();
    storage.flush_dirty()?;
    enqueue_delete_tombstone_cleanup(tasks, tombstones);
    let mut fields = vec![
        ("sources", source_count.to_string()),
        ("tombstones", tombstone_count.to_string()),
        (
            "search_memory_caches",
            storage.search_text_memory_cache_len().to_string(),
        ),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("delete-books", started.elapsed(), &fields);
    Ok(())
}

fn cleanup_external_book_heavy_files(storage: &AppStorage, id: &str) -> Result<(), String> {
    if !is_external_book_id(id) {
        return Ok(());
    }

    storage.unload_search_text_cache(id);
    let dir = storage.external_book_dir(id);
    for path in [
        dir.join(BOOK_FILE),
        dir.join(SEARCH_TEXT_CACHE_FILE),
        dir.join(IMAGE_INDEX_CACHE_FILE),
    ] {
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }

    let unpacked_dir = dir.join(UNPACKED_DIR);
    if unpacked_dir.exists() {
        fs::remove_dir_all(unpacked_dir).map_err(|error| error.to_string())?;
    }
    remove_cover_files(storage, id)?;
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
            .external
            .books
            .iter()
            .map(|book| book.id.clone())
            .collect::<Vec<_>>()
    };

    for id in ids {
        cleanup_external_book_heavy_files(storage, &id)?;
    }
    Ok(())
}

pub fn schedule_existing_delete_tombstone_cleanup(storage: &AppStorage, tasks: &TaskService) {
    match list_delete_tombstones(storage) {
        Ok(tombstones) => enqueue_delete_tombstone_cleanup(tasks, tombstones),
        Err(error) => eprintln!("Failed to list deleted book tombstones: {error}"),
    }
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
        && book
            .exported_versions
            .get(format.as_str())
            .copied()
            .unwrap_or_default()
            < book.content_version
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unescape_xml_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut cursor = 0usize;

    while let Some(relative_start) = value[cursor..].find('&') {
        let start = cursor + relative_start;
        result.push_str(&value[cursor..start]);
        let Some(relative_end) = value[start..].find(';') else {
            result.push_str(&value[start..]);
            return result;
        };
        let end = start + relative_end;
        let entity = &value[start + 1..end];
        match entity {
            "amp" => result.push('&'),
            "lt" => result.push('<'),
            "gt" => result.push('>'),
            "quot" => result.push('"'),
            "apos" => result.push('\''),
            "nbsp" => result.push('\u{00a0}'),
            entity if entity.starts_with("#x") || entity.starts_with("#X") => {
                if let Ok(codepoint) = u32::from_str_radix(&entity[2..], 16) {
                    if let Some(character) = char::from_u32(codepoint) {
                        result.push(character);
                    } else {
                        result.push_str(&value[start..=end]);
                    }
                } else {
                    result.push_str(&value[start..=end]);
                }
            }
            entity if entity.starts_with('#') => {
                if let Ok(codepoint) = entity[1..].parse::<u32>() {
                    if let Some(character) = char::from_u32(codepoint) {
                        result.push(character);
                    } else {
                        result.push_str(&value[start..=end]);
                    }
                } else {
                    result.push_str(&value[start..=end]);
                }
            }
            _ => result.push_str(&value[start..=end]),
        }
        cursor = end + 1;
    }

    result.push_str(&value[cursor..]);
    result
}

fn escape_xml_attr(value: &str) -> String {
    escape_xml_text(value)
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
}

fn normalize_xml_declaration_to_utf8(xml: &str) -> String {
    let Some(end) = xml.find("?>") else {
        return xml.to_string();
    };
    let declaration = &xml[..end + 2];
    if !declaration.trim_start().starts_with("<?xml") {
        return xml.to_string();
    }

    if let Some(updated_declaration) = replace_quoted_attr_value(declaration, "encoding", "UTF-8") {
        format!("{updated_declaration}{}", &xml[end + 2..])
    } else {
        xml.to_string()
    }
}

fn replace_quoted_attr_value(text: &str, attr: &str, value: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let marker = format!("{attr}={quote}");
        if let Some(value_start) = text.find(&marker).map(|start| start + marker.len()) {
            let value_end = text[value_start..].find(quote)? + value_start;
            let mut updated = String::with_capacity(text.len() + value.len());
            updated.push_str(&text[..value_start]);
            updated.push_str(&escape_xml_attr(value));
            updated.push_str(&text[value_end..]);
            return Some(updated);
        }
    }

    None
}

fn copy_until_closing_tag(lines: &[&str], index: &mut usize, closing: &str) -> String {
    let mut block = lines[*index].to_string();
    while !block.contains(closing) && *index + 1 < lines.len() {
        *index += 1;
        block.push_str(lines[*index]);
    }
    block
}

fn compact_open_tag(open_tag: &str) -> String {
    if open_tag.contains('\n') {
        open_tag.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        open_tag.to_string()
    }
}

fn replace_metadata_block(block: &str, value: &str, closing: &str, update_file_as: bool) -> String {
    let Some(open_start) = block.find('<') else {
        return block.to_string();
    };
    let Some(open_end) = block.find('>') else {
        return block.to_string();
    };
    let Some(close_start) = block[open_end + 1..]
        .find(closing)
        .map(|offset| open_end + 1 + offset)
    else {
        return block.to_string();
    };
    let Some(close_end) = block[close_start..]
        .find('>')
        .map(|offset| close_start + offset + 1)
    else {
        return block.to_string();
    };

    let mut open_tag = compact_open_tag(&block[open_start..open_end + 1]);
    if update_file_as {
        open_tag = replace_quoted_attr_value(&open_tag, "opf:file-as", value).unwrap_or(open_tag);
    }

    let mut updated = String::with_capacity(block.len() + value.len());
    updated.push_str(&block[..open_start]);
    updated.push_str(&open_tag);
    updated.push_str(&escape_xml_text(value));
    updated.push_str(&block[close_start..close_end]);
    updated.push_str(&block[close_end..]);
    updated
}

fn remove_block_keep_tail(block: &str, closing: &str) -> String {
    let Some(close_start) = block.find(closing) else {
        return block.to_string();
    };
    let Some(close_end) = block[close_start..]
        .find('>')
        .map(|offset| close_start + offset + 1)
    else {
        return block.to_string();
    };

    block[close_end..].to_string()
}

fn update_opf_metadata_xml(xml: &str, metadata: &Value) -> String {
    let title = metadata_string(metadata, "title");
    let creator = metadata_string(metadata, "creator");
    if title.is_none() && creator.is_none() {
        return xml.to_string();
    }

    let lines = xml.split_inclusive('\n').collect::<Vec<_>>();
    let lines = if lines.is_empty() { vec![xml] } else { lines };
    let mut updated = String::with_capacity(xml.len());
    let mut title_done = title.is_none();
    let mut creator_done = creator.is_none();
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim_start();

        if !title_done && (trimmed.starts_with("<dc:title") || trimmed.starts_with("<title")) {
            let closing = if trimmed.starts_with("<dc:title") {
                "</dc:title"
            } else {
                "</title"
            };
            let block = copy_until_closing_tag(&lines, &mut index, closing);
            updated.push_str(&replace_metadata_block(
                &block,
                title.as_deref().unwrap_or_default(),
                closing,
                false,
            ));
            title_done = true;
            index += 1;
            continue;
        }

        if trimmed.starts_with("<dc:creator") || trimmed.starts_with("<creator") {
            let closing = if trimmed.starts_with("<dc:creator") {
                "</dc:creator"
            } else {
                "</creator"
            };
            let block = copy_until_closing_tag(&lines, &mut index, closing);
            match creator.as_deref() {
                Some("") => updated.push_str(&remove_block_keep_tail(&block, closing)),
                Some(creator) if !creator_done => {
                    updated.push_str(&replace_metadata_block(&block, creator, closing, true));
                    creator_done = true;
                }
                _ => updated.push_str(&block),
            }
            index += 1;
            continue;
        }

        updated.push_str(line);
        index += 1;
    }

    updated
}

fn sync_unpacked_opf_metadata(unpacked_dir: &Path, metadata: &Value) -> Result<(), String> {
    if !unpacked_dir.exists() {
        return Ok(());
    }

    let opf_path = find_unpacked_opf_path(unpacked_dir)?;
    let bytes = fs::read(&opf_path).map_err(|error| error.to_string())?;
    let decoded = decode_text_bytes(&bytes, None);
    let xml = normalize_xml_declaration_to_utf8(&decoded.text);
    let updated = update_opf_metadata_xml(&xml, metadata);
    if updated != xml || decoded.encoding != "utf-8" {
        fs::write(opf_path, updated.as_bytes()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn body_content_range(xhtml: &str) -> Option<(usize, usize)> {
    let lower = xhtml.to_ascii_lowercase();
    let body_tag_start = lower.find("<body")?;
    let body_content_start = lower[body_tag_start..].find('>')? + body_tag_start + 1;
    let body_content_end = lower[body_content_start..]
        .find("</body")
        .map(|index| body_content_start + index)
        .unwrap_or(xhtml.len());

    Some((body_content_start, body_content_end))
}

fn utf16_offset_to_byte_index(text: &str, offset: usize) -> Option<usize> {
    let mut utf16_offset = 0usize;
    for (byte_index, character) in text.char_indices() {
        if utf16_offset == offset {
            return Some(byte_index);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > offset {
            return None;
        }
    }

    if utf16_offset == offset {
        Some(text.len())
    } else {
        None
    }
}

fn replace_text_by_utf16_offsets(
    text: &str,
    start_offset: usize,
    end_offset: usize,
    old_text: &str,
    new_text: &str,
) -> Result<String, String> {
    if start_offset > end_offset {
        return Err(TEXT_REPLACE_TEXT_STALE_ERROR.to_string());
    }
    let start = utf16_offset_to_byte_index(text, start_offset)
        .ok_or_else(|| TEXT_REPLACE_TEXT_STALE_ERROR.to_string())?;
    let end = utf16_offset_to_byte_index(text, end_offset)
        .ok_or_else(|| TEXT_REPLACE_TEXT_STALE_ERROR.to_string())?;
    if &text[start..end] != old_text {
        return Err(TEXT_REPLACE_TEXT_STALE_ERROR.to_string());
    }

    let mut updated = String::with_capacity(text.len() + new_text.len());
    updated.push_str(&text[..start]);
    updated.push_str(new_text);
    updated.push_str(&text[end..]);
    Ok(updated)
}

fn replace_xhtml_text_node(
    xhtml: &str,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
) -> Result<String, String> {
    if old_text.is_empty() {
        return Err(TEXT_REPLACE_EMPTY_ERROR.to_string());
    }
    if old_text == new_text {
        return Ok(xhtml.to_string());
    }

    let (body_start, body_end) =
        body_content_range(xhtml).ok_or_else(|| TEXT_REPLACE_SECTION_BODY_NOT_FOUND.to_string())?;
    let mut text_node_index = 0usize;
    let mut cursor = body_start;

    while cursor < body_end {
        let Some(relative_text_end) = xhtml[cursor..body_end].find('<') else {
            break;
        };
        let text_end = cursor + relative_text_end;
        if text_end > cursor {
            if text_node_index == target.text_node_index {
                let raw_text = &xhtml[cursor..text_end];
                let decoded_text = unescape_xml_text(raw_text);
                if decoded_text != target.text_node_text {
                    return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
                }
                let updated_text = replace_text_by_utf16_offsets(
                    &decoded_text,
                    target.start_offset,
                    target.end_offset,
                    old_text,
                    new_text,
                )?;

                let mut updated = String::with_capacity(xhtml.len() + new_text.len());
                updated.push_str(&xhtml[..cursor]);
                updated.push_str(&escape_xml_text(&updated_text));
                updated.push_str(&xhtml[text_end..]);
                return Ok(updated);
            }
            text_node_index += 1;
        }

        let Some(relative_tag_end) = xhtml[text_end..body_end].find('>') else {
            break;
        };
        cursor = text_end + relative_tag_end + 1;
    }

    Err(TEXT_REPLACE_NODE_NOT_FOUND_ERROR.to_string())
}

struct XhtmlTextReplacement {
    xhtml: String,
    heading_update: Option<(String, String)>,
    paragraph_index: Option<usize>,
}

fn replace_generated_txt_paragraph_xhtml(
    xhtml: &str,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
    paragraph_index: usize,
) -> Result<Option<String>, String> {
    let Some(body_marker) = xhtml.find("data-flow-body-text") else {
        return Ok(None);
    };
    let body = &xhtml[body_marker..];
    let body_end = body
        .find("</div>")
        .map(|index| body_marker + index)
        .unwrap_or(xhtml.len());
    let mut cursor = body_marker;
    let mut current_paragraph_index = 0usize;

    while let Some(relative_start) = xhtml[cursor..body_end].find("<p>") {
        let start = cursor + relative_start + "<p>".len();
        let Some(relative_end) = xhtml[start..body_end].find("</p>") else {
            break;
        };
        let end = start + relative_end;
        if current_paragraph_index == paragraph_index {
            let decoded_text = unescape_xml_text(&xhtml[start..end]);
            if decoded_text != target.text_node_text {
                return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
            }

            let updated_text = replace_text_by_utf16_offsets(
                &decoded_text,
                target.start_offset,
                target.end_offset,
                old_text,
                new_text,
            )?;

            let mut updated = String::with_capacity(xhtml.len() + new_text.len());
            updated.push_str(&xhtml[..start]);
            updated.push_str(&escape_xml_text(&updated_text));
            updated.push_str(&xhtml[end..]);
            return Ok(Some(updated));
        }

        current_paragraph_index += 1;
        cursor = end + "</p>".len();
    }

    Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string())
}

fn replace_first_tag_text(
    xhtml: &str,
    tag_name: &str,
    expected_text: &str,
    updated_text: &str,
) -> Result<Option<String>, String> {
    let open_tag = format!("<{tag_name}");
    let close_tag = format!("</{tag_name}>");
    let Some(tag_start) = xhtml.find(&open_tag) else {
        return Ok(None);
    };
    let content_start = xhtml[tag_start..]
        .find('>')
        .map(|index| tag_start + index + 1)
        .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    let content_end = xhtml[content_start..]
        .find(&close_tag)
        .map(|index| content_start + index)
        .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    let decoded_text = unescape_xml_text(&xhtml[content_start..content_end]);
    if decoded_text != expected_text {
        return Ok(None);
    }

    let mut updated = String::with_capacity(xhtml.len() + updated_text.len());
    updated.push_str(&xhtml[..content_start]);
    updated.push_str(&escape_xml_text(updated_text));
    updated.push_str(&xhtml[content_end..]);
    Ok(Some(updated))
}

fn replace_generated_txt_heading_xhtml(
    xhtml: &str,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
) -> Result<Option<XhtmlTextReplacement>, String> {
    if !xhtml.contains("flow-txt-chapter") {
        return Ok(None);
    }

    let Some(heading) = extract_first_tag_text(xhtml, "h2") else {
        return Ok(None);
    };
    if heading != target.text_node_text {
        return Ok(None);
    }

    let updated_heading = replace_text_by_utf16_offsets(
        &heading,
        target.start_offset,
        target.end_offset,
        old_text,
        new_text,
    )?;
    let Some(mut updated_xhtml) = replace_first_tag_text(xhtml, "h2", &heading, &updated_heading)?
    else {
        return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
    };
    if let Some(with_title) =
        replace_first_tag_text(&updated_xhtml, "title", &heading, &updated_heading)?
    {
        updated_xhtml = with_title;
    }

    Ok(Some(XhtmlTextReplacement {
        xhtml: updated_xhtml,
        heading_update: Some((heading, updated_heading)),
        paragraph_index: None,
    }))
}

fn replace_xhtml_text(
    xhtml: &str,
    source_format: BookSourceFormat,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
) -> Result<XhtmlTextReplacement, String> {
    if old_text.is_empty() {
        return Err(TEXT_REPLACE_EMPTY_ERROR.to_string());
    }
    if old_text == new_text {
        return Ok(XhtmlTextReplacement {
            xhtml: xhtml.to_string(),
            heading_update: None,
            paragraph_index: None,
        });
    }

    if source_format != BookSourceFormat::Txt {
        return replace_xhtml_text_node(xhtml, target, old_text, new_text).map(|xhtml| {
            XhtmlTextReplacement {
                xhtml,
                heading_update: None,
                paragraph_index: None,
            }
        });
    }

    if let Some(paragraph_index) = target.paragraph_index {
        if let Some(xhtml) = replace_generated_txt_paragraph_xhtml(
            xhtml,
            target,
            old_text,
            new_text,
            paragraph_index,
        )? {
            return Ok(XhtmlTextReplacement {
                xhtml,
                heading_update: None,
                paragraph_index: Some(paragraph_index),
            });
        }
    }

    if let Some(replacement) =
        replace_generated_txt_heading_xhtml(xhtml, target, old_text, new_text)?
    {
        return Ok(replacement);
    }

    Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string())
}

const TEXT_REPLACE_EMPTY_ERROR: &str = "TEXT_REPLACE_EMPTY";
const TEXT_REPLACE_SECTION_BODY_NOT_FOUND: &str = "TEXT_REPLACE_SECTION_BODY_NOT_FOUND";
const TEXT_REPLACE_NODE_STALE_ERROR: &str = "TEXT_REPLACE_NODE_STALE";
const TEXT_REPLACE_TEXT_STALE_ERROR: &str = "TEXT_REPLACE_TEXT_STALE";
const TEXT_REPLACE_NODE_NOT_FOUND_ERROR: &str = "TEXT_REPLACE_NODE_NOT_FOUND";

#[derive(Debug, Clone)]
enum SourceTextUpdate {
    Patch {
        offset: u64,
        bytes: Vec<u8>,
    },
    Splice {
        offset: u64,
        old_len: u64,
        bytes: Vec<u8>,
    },
}

fn generated_text_section_index(href: &str) -> Option<usize> {
    let filename = href.rsplit(['/', '\\']).next()?;
    let number = filename
        .strip_prefix("part")?
        .strip_suffix(".xhtml")?
        .parse::<usize>()
        .ok()?;
    number.checked_sub(1)
}

fn extract_first_tag_text(xhtml: &str, tag_name: &str) -> Option<String> {
    let open_tag = format!("<{tag_name}");
    let close_tag = format!("</{tag_name}>");
    let tag_start = xhtml.find(&open_tag)?;
    let content_start = xhtml[tag_start..].find('>')? + tag_start + 1;
    let content_end = xhtml[content_start..].find(&close_tag)? + content_start;
    Some(unescape_xml_text(&xhtml[content_start..content_end]))
}

struct SourceTextLine {
    text: String,
    offset: u64,
    old_len: u64,
}

fn source_bom_len(bytes: &[u8]) -> usize {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        3
    } else if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        2
    } else {
        0
    }
}

fn streaming_source_encoding(metadata: &Value) -> Result<String, String> {
    source_encoding_id_from_metadata(metadata)
        .ok_or_else(|| "TXT_SOURCE_ENCODING_MISSING".to_string())
}

fn encoded_line_delimiter(encoding: &str) -> &'static [u8] {
    match encoding {
        "utf-16le" => &[0x0a, 0x00],
        "utf-16be" => &[0x00, 0x0a],
        _ => b"\n",
    }
}

fn read_until_encoded_newline<R: Read>(
    reader: &mut BufReader<R>,
    encoding: &str,
    buffer: &mut Vec<u8>,
) -> io::Result<usize> {
    let delimiter = encoded_line_delimiter(encoding);
    if delimiter.len() == 1 {
        return reader.read_until(delimiter[0], buffer);
    }

    let mut total = 0usize;
    let mut byte = [0u8; 1];
    while reader.read(&mut byte)? != 0 {
        buffer.push(byte[0]);
        total += 1;
        if buffer.ends_with(delimiter) {
            break;
        }
    }
    Ok(total)
}

fn strip_encoded_line_end<'a>(bytes: &'a [u8], encoding: &str) -> &'a [u8] {
    match encoding {
        "utf-16le" => bytes
            .strip_suffix(&[0x0a, 0x00])
            .unwrap_or(bytes)
            .strip_suffix(&[0x0d, 0x00])
            .unwrap_or_else(|| bytes.strip_suffix(&[0x0a, 0x00]).unwrap_or(bytes)),
        "utf-16be" => bytes
            .strip_suffix(&[0x00, 0x0a])
            .unwrap_or(bytes)
            .strip_suffix(&[0x00, 0x0d])
            .unwrap_or_else(|| bytes.strip_suffix(&[0x00, 0x0a]).unwrap_or(bytes)),
        _ => bytes
            .strip_suffix(b"\n")
            .unwrap_or(bytes)
            .strip_suffix(b"\r")
            .unwrap_or_else(|| bytes.strip_suffix(b"\n").unwrap_or(bytes)),
    }
}

fn decode_source_line(
    bytes: &[u8],
    encoding: &str,
    first_line: bool,
) -> Result<Option<SourceTextLine>, String> {
    let line_end = strip_encoded_line_end(bytes, encoding);
    let bom_len = if first_line {
        source_bom_len(line_end)
    } else {
        0
    };
    let decoded = decode_text_bytes(&line_end[bom_len..], Some(encoding)).text;
    let trimmed_start = decoded.len() - decoded.trim_start().len();
    let trimmed_end = decoded.trim_end().len();
    if trimmed_start >= trimmed_end {
        return Ok(None);
    }

    let prefix_len = encode_text_bytes(&decoded[..trimmed_start], encoding, false)?.len();
    let trimmed_len =
        encode_text_bytes(&decoded[trimmed_start..trimmed_end], encoding, false)?.len();
    Ok(Some(SourceTextLine {
        text: decoded[trimmed_start..trimmed_end].to_string(),
        offset: (bom_len + prefix_len) as u64,
        old_len: trimmed_len as u64,
    }))
}

fn push_unique_text(values: &mut Vec<String>, value: Option<String>) {
    let Some(value) = value else {
        return;
    };
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn generated_txt_section_source_heading_candidates(
    text_dir: &Path,
    section_index: usize,
    section_href: &str,
) -> Result<Vec<String>, String> {
    let mut candidates = Vec::new();
    let path = text_dir.join(format!("part{:04}.xhtml", section_index + 1));
    let xhtml = fs::read_to_string(path).map_err(|_| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    push_unique_text(&mut candidates, extract_first_tag_text(&xhtml, "h2"));

    let nav_path = text_dir
        .parent()
        .map(|oebps| oebps.join("nav.xhtml"))
        .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    if nav_path.exists() {
        let nav_xhtml = fs::read_to_string(nav_path).map_err(|error| error.to_string())?;
        push_unique_text(
            &mut candidates,
            generated_txt_nav_heading(&nav_xhtml, section_href),
        );
    }

    if candidates.is_empty() {
        return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
    }
    Ok(candidates)
}

fn generated_txt_matching_heading_occurrences_before(
    text_dir: &Path,
    target_section_index: usize,
    target_candidates: &[String],
) -> Result<usize, String> {
    let mut occurrences = 0usize;
    for section_index in 0..target_section_index {
        let href = format!("Text/part{:04}.xhtml", section_index + 1);
        let candidates =
            generated_txt_section_source_heading_candidates(text_dir, section_index, &href)?;
        if candidates
            .iter()
            .any(|candidate| target_candidates.iter().any(|target| target == candidate))
        {
            occurrences += 1;
        }
    }
    Ok(occurrences)
}

fn source_update_for_streamed_line(
    line: SourceTextLine,
    old_text: &str,
    new_text: &str,
    encoding: &str,
    target: &BookTextReplaceTarget,
) -> Result<SourceTextUpdate, String> {
    if line.text != target.text_node_text {
        return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
    }
    let updated_line = replace_text_by_utf16_offsets(
        &line.text,
        target.start_offset,
        target.end_offset,
        old_text,
        new_text,
    )?;
    let bytes = encode_text_bytes(&updated_line, encoding, false)?;
    if bytes.len() as u64 == line.old_len {
        Ok(SourceTextUpdate::Patch {
            offset: line.offset,
            bytes,
        })
    } else {
        Ok(SourceTextUpdate::Splice {
            offset: line.offset,
            old_len: line.old_len,
            bytes,
        })
    }
}

fn generated_txt_source_update_streaming(
    source_path: &Path,
    metadata: &Value,
    text_dir: &Path,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
    heading_update: Option<&(String, String)>,
) -> Result<SourceTextUpdate, String> {
    if old_text.is_empty() {
        return Err(TEXT_REPLACE_EMPTY_ERROR.to_string());
    }
    if old_text == new_text {
        return Err(TEXT_REPLACE_TEXT_STALE_ERROR.to_string());
    }

    let encoding = streaming_source_encoding(metadata)?;
    let target_section_index = generated_text_section_index(&target.section_href)
        .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    let target_heading_candidates = generated_txt_section_source_heading_candidates(
        text_dir,
        target_section_index,
        &target.section_href,
    )?;
    let mut matching_heading_occurrences_before =
        generated_txt_matching_heading_occurrences_before(
            text_dir,
            target_section_index,
            &target_heading_candidates,
        )?;
    let target_paragraph_index = target.paragraph_index;
    let mut paragraph_index = 0usize;
    let mut inside_target_section = false;
    let mut first_line = true;
    let mut line_offset = 0u64;
    let mut reader =
        BufReader::new(fs::File::open(source_path).map_err(|error| error.to_string())?);
    let mut bytes = Vec::new();

    loop {
        bytes.clear();
        let read = read_until_encoded_newline(&mut reader, &encoding, &mut bytes)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }

        if let Some(mut line) = decode_source_line(&bytes, &encoding, first_line)? {
            line.offset = line.offset.saturating_add(line_offset);
            if !inside_target_section {
                if target_heading_candidates
                    .iter()
                    .any(|heading| line.text == *heading)
                {
                    if matching_heading_occurrences_before > 0 {
                        matching_heading_occurrences_before -= 1;
                    } else {
                        inside_target_section = true;
                        if heading_update.is_some() {
                            return source_update_for_streamed_line(
                                line, old_text, new_text, &encoding, target,
                            );
                        }
                    }
                }
            } else if target_paragraph_index == Some(paragraph_index) {
                return source_update_for_streamed_line(
                    line, old_text, new_text, &encoding, target,
                );
            } else {
                paragraph_index += 1;
            }
        }

        first_line = false;
        line_offset = line_offset.saturating_add(read as u64);
    }

    Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string())
}

fn quoted_attr_value(text: &str, attr: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let marker = format!("{attr}={quote}");
        if let Some(value_start) = text.find(&marker).map(|start| start + marker.len()) {
            let value_end = text[value_start..].find(quote)? + value_start;
            return Some(unescape_xml_text(&text[value_start..value_end]));
        }
    }

    None
}

fn same_generated_txt_href(left: &str, right: &str) -> bool {
    let left = normalize_zip_path(percent_decode_path(left.split('#').next().unwrap_or("")));
    let right = normalize_zip_path(percent_decode_path(right.split('#').next().unwrap_or("")));
    if left.trim_start_matches('/') == right.trim_start_matches('/') {
        return true;
    }
    generated_text_section_index(&left)
        .zip(generated_text_section_index(&right))
        .is_some_and(|(left_index, right_index)| left_index == right_index)
}

fn generated_txt_nav_heading(nav_xhtml: &str, target_href: &str) -> Option<String> {
    let mut cursor = 0usize;
    while let Some(relative_anchor_start) = nav_xhtml[cursor..].find("<a") {
        let anchor_start = cursor + relative_anchor_start;
        let relative_tag_end = nav_xhtml[anchor_start..].find('>')?;
        let content_start = anchor_start + relative_tag_end + 1;
        let tag = &nav_xhtml[anchor_start..content_start];
        let Some(href) = quoted_attr_value(tag, "href") else {
            cursor = content_start;
            continue;
        };
        let relative_anchor_end = nav_xhtml[content_start..].find("</a>")?;
        let content_end = content_start + relative_anchor_end;
        if same_generated_txt_href(&href, target_href) {
            return Some(unescape_xml_text(&nav_xhtml[content_start..content_end]));
        }

        cursor = content_end + "</a>".len();
    }

    None
}

fn replace_generated_txt_nav_heading(
    nav_xhtml: &str,
    target_href: &str,
    old_heading: &str,
    new_heading: &str,
) -> Result<String, String> {
    let mut cursor = 0usize;
    while let Some(relative_anchor_start) = nav_xhtml[cursor..].find("<a") {
        let anchor_start = cursor + relative_anchor_start;
        let Some(relative_tag_end) = nav_xhtml[anchor_start..].find('>') else {
            break;
        };
        let content_start = anchor_start + relative_tag_end + 1;
        let tag = &nav_xhtml[anchor_start..content_start];
        let Some(href) = quoted_attr_value(tag, "href") else {
            cursor = content_start;
            continue;
        };
        let Some(relative_anchor_end) = nav_xhtml[content_start..].find("</a>") else {
            break;
        };
        let content_end = content_start + relative_anchor_end;
        if same_generated_txt_href(&href, target_href)
            && unescape_xml_text(&nav_xhtml[content_start..content_end]) == old_heading
        {
            let mut updated = String::with_capacity(nav_xhtml.len() + new_heading.len());
            updated.push_str(&nav_xhtml[..content_start]);
            updated.push_str(&escape_xml_text(new_heading));
            updated.push_str(&nav_xhtml[content_end..]);
            return Ok(updated);
        }

        cursor = content_end + "</a>".len();
    }

    Ok(nav_xhtml.to_string())
}

fn source_text_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source.txt");
    path.with_file_name(format!("{file_name}.tmp"))
}

fn write_source_text_splice(
    path: &Path,
    offset: u64,
    old_len: u64,
    bytes: &[u8],
) -> Result<(), String> {
    let tmp = source_text_temp_path(path);
    let mut input = BufReader::new(fs::File::open(path).map_err(|error| error.to_string())?);
    let mut output = BufWriter::new(fs::File::create(&tmp).map_err(|error| error.to_string())?);

    io::copy(&mut input.by_ref().take(offset), &mut output).map_err(|error| error.to_string())?;
    output.write_all(bytes).map_err(|error| error.to_string())?;
    input
        .seek(SeekFrom::Start(offset.saturating_add(old_len)))
        .map_err(|error| error.to_string())?;
    io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    drop(output);
    drop(input);

    fs::remove_file(path).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

fn write_source_text_update(path: &Path, update: &SourceTextUpdate) -> Result<(), String> {
    match update {
        SourceTextUpdate::Patch { offset, bytes } => {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            file.seek(SeekFrom::Start(*offset))
                .map_err(|error| error.to_string())?;
            file.write_all(bytes).map_err(|error| error.to_string())
        }
        SourceTextUpdate::Splice {
            offset,
            old_len,
            bytes,
        } => write_source_text_splice(path, *offset, *old_len, bytes),
    }
}

fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).to_string()
}

fn zip_path_candidates(path: &str) -> Vec<String> {
    let decoded = percent_decode_zip_path(path);
    if decoded == path {
        vec![path.to_string()]
    } else {
        vec![path.to_string(), decoded]
    }
}

fn percent_decode_zip_path(path: &str) -> String {
    path.split('/')
        .map(percent_decode_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_decode_path_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).unwrap_or_else(|_| segment.to_string())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn resolve_unpacked_resource_path(unpacked_dir: &Path, href: &str) -> Result<PathBuf, String> {
    let opf_path = find_unpacked_opf_path(unpacked_dir)?;
    let opf_dir = opf_path.parent().unwrap_or(unpacked_dir);
    let href = href.split('#').next().unwrap_or("").replace('\\', "/");
    let href = percent_decode_path(&href);
    let normalized = normalize_zip_path(href);
    if normalized.is_empty() {
        return Err("Selected section has an invalid href".to_string());
    }

    let candidate = opf_dir.join(normalized.trim_start_matches('/'));
    let canonical_unpacked = fs::canonicalize(unpacked_dir).map_err(|error| error.to_string())?;
    let canonical_candidate = fs::canonicalize(&candidate).map_err(|error| error.to_string())?;
    if !canonical_candidate.starts_with(canonical_unpacked) {
        return Err("Selected section is outside the unpacked book".to_string());
    }

    Ok(canonical_candidate)
}

fn collect_files_sorted(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_files(root, &mut files)?;
    files.sort_by(|a, b| {
        let a = a.strip_prefix(root).unwrap_or(a);
        let b = b.strip_prefix(root).unwrap_or(b);
        a.cmp(b)
    });
    Ok(files)
}

fn collect_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            collect_files(&path, files)?;
        } else if file_type.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn zip_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn epub_entry_compression(relative: &str) -> CompressionMethod {
    let extension = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "mp3" | "mp4" | "m4a" | "ogg"
        | "opus" | "woff" | "woff2" | "ttf" | "otf" => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    }
}

fn write_epub_file(
    writer: &mut ZipWriter<BufWriter<fs::File>>,
    relative: &str,
    path: &Path,
    deflate_level: Option<i64>,
) -> Result<(), String> {
    let content_options = SimpleFileOptions::default()
        .compression_method(epub_entry_compression(relative))
        .compression_level(deflate_level)
        .unix_permissions(0o644);
    writer
        .start_file(relative, content_options)
        .map_err(|error| error.to_string())?;
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    std::io::copy(&mut file, writer).map_err(|error| error.to_string())?;
    Ok(())
}

fn epub_entry_is_editable_text(relative: &str) -> bool {
    let extension = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(extension.as_str(), "htm" | "html" | "xhtml" | "opf" | "ncx")
}

fn unpacked_file_was_modified(path: &Path) -> Result<bool, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    let created = match metadata.created() {
        Ok(created) => created,
        Err(_) => return Ok(true),
    };

    Ok(created != modified)
}

fn should_copy_original_zip_entry(relative: &str, path: &Path) -> Result<bool, String> {
    if !epub_entry_is_editable_text(relative) {
        return Ok(true);
    }

    Ok(!unpacked_file_was_modified(path)?)
}

fn original_epub_file_count<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<usize, String> {
    let mut count = 0usize;
    for index in 0..archive.len() {
        let name = archive
            .name_for_index(index)
            .ok_or_else(|| "Invalid EPUB entry index".to_string())?
            .to_string();
        let relative = normalize_zip_path(name.replace('\\', "/"));
        if relative.is_empty() {
            continue;
        }

        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if !entry.is_dir() {
            count += 1;
        }
    }
    Ok(count)
}

fn write_epub_from_unpacked_dir(
    unpacked_dir: &Path,
    output_path: &Path,
    deflate_level: Option<i64>,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let tmp = output_path.with_extension("tmp");
    let file = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    let mut writer = ZipWriter::new(BufWriter::with_capacity(EPUB_ZIP_WRITER_BUFFER_SIZE, file));
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);

    writer
        .start_file("mimetype", stored)
        .map_err(|error| error.to_string())?;
    let mimetype = fs::read(unpacked_dir.join("mimetype"))
        .unwrap_or_else(|_| b"application/epub+zip".to_vec());
    writer
        .write_all(&mimetype)
        .map_err(|error| error.to_string())?;

    for path in collect_files_sorted(unpacked_dir)? {
        let relative = zip_relative_path(unpacked_dir, &path)?;
        if relative == "mimetype" {
            continue;
        }
        write_epub_file(&mut writer, &relative, &path, deflate_level)?;
    }

    let mut output = writer.finish().map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp, output_path).map_err(|error| error.to_string())
}

fn write_epub_from_original_and_unpacked(
    original_epub: &Path,
    unpacked_dir: &Path,
    output_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let source = fs::File::open(original_epub).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(source).map_err(|error| error.to_string())?;
    if original_epub_file_count(&mut archive)? != collect_files_sorted(unpacked_dir)?.len() {
        return write_epub_from_unpacked_dir(unpacked_dir, output_path, None);
    }

    let tmp = output_path.with_extension("tmp");
    let file = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    let mut writer = ZipWriter::new(BufWriter::with_capacity(EPUB_ZIP_WRITER_BUFFER_SIZE, file));
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);

    writer
        .start_file("mimetype", stored)
        .map_err(|error| error.to_string())?;
    let mimetype = fs::read(unpacked_dir.join("mimetype"))
        .unwrap_or_else(|_| b"application/epub+zip".to_vec());
    writer
        .write_all(&mimetype)
        .map_err(|error| error.to_string())?;

    let mut written = HashSet::from(["mimetype".to_string()]);
    for index in 0..archive.len() {
        let name = archive
            .name_for_index(index)
            .ok_or_else(|| "Invalid EPUB entry index".to_string())?
            .to_string();
        let relative = normalize_zip_path(name.replace('\\', "/"));
        if relative.is_empty() || relative == "mimetype" {
            continue;
        }

        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() {
            continue;
        }
        drop(entry);

        let unpacked_path = unpacked_dir.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !unpacked_path.is_file() {
            continue;
        }

        if should_copy_original_zip_entry(&relative, &unpacked_path)? {
            let raw_entry = archive.by_index(index).map_err(|error| error.to_string())?;
            writer
                .raw_copy_file(raw_entry)
                .map_err(|error| error.to_string())?;
        } else {
            write_epub_file(&mut writer, &relative, &unpacked_path, None)?;
        }
        written.insert(relative);
    }

    for path in collect_files_sorted(unpacked_dir)? {
        let relative = zip_relative_path(unpacked_dir, &path)?;
        if written.contains(&relative) {
            continue;
        }
        write_epub_file(&mut writer, &relative, &path, None)?;
    }

    let mut output = writer.finish().map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp, output_path).map_err(|error| error.to_string())
}

fn edited_book_content_hash(id: &str, content_version: u32, edited_at: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"edited\0");
    hasher.update(id.as_bytes());
    hasher.update(b"\0");
    hasher.update(content_version.to_le_bytes());
    hasher.update(edited_at.to_le_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn mark_library_book_content_updated(
    storage: &AppStorage,
    id: &str,
) -> Result<Option<LibraryBook>, String> {
    let updated = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.library.books.iter_mut().find(|book| book.id == id) else {
            return Ok(None);
        };
        let now = now_ms();
        book.content_version = book.content_version.saturating_add(1).max(1);
        book.content_edited_at = Some(now);
        book.content_hash = edited_book_content_hash(&book.id, book.content_version, now);
        book.updated_at = Some(now);
        book.clone()
    };
    storage.mark_library_dirty();
    Ok(Some(updated))
}

pub(super) fn replace_book_text_impl(
    storage: &AppStorage,
    id: String,
    target: BookTextReplaceTarget,
    old_text: String,
    new_text: String,
) -> Result<BookTextReplaceResult, String> {
    let initial_book = storage.library_book(&id)?;
    let source_format = storage.book_source_format(&initial_book);
    let content_mode = inspect_and_store_book_content_access(storage, &initial_book)?;
    if source_format == BookSourceFormat::Epub && content_mode == BookContentMode::ArchiveOnly {
        return Err("Archive-only EPUB text editing is not supported".to_string());
    }
    let book_dir = storage.book_dir(&id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);
    if !unpacked_dir.exists() {
        let book_path = book_dir.join(BOOK_FILE);
        if book_path.exists() {
            unpack_epub(&book_path, &unpacked_dir)?;
            normalize_unpacked_epub_structure(&unpacked_dir)?;
        }
    }

    let section_path = resolve_unpacked_resource_path(&unpacked_dir, &target.section_href)?;
    let xhtml = fs::read_to_string(&section_path).map_err(|error| error.to_string())?;
    let xhtml_update = replace_xhtml_text(&xhtml, source_format, &target, &old_text, &new_text)?;
    let heading_update = xhtml_update.heading_update.clone();
    let mut source_target = target.clone();
    if source_target.paragraph_index.is_none() {
        source_target.paragraph_index = xhtml_update.paragraph_index;
    }
    let updated_xhtml = xhtml_update.xhtml;
    if updated_xhtml == xhtml {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        return Ok(BookTextReplaceResult {
            book: storage.compose_book(&mut state, &initial_book)?,
            section_href: target.section_href,
            changed: false,
        });
    }

    let source_update = if source_format == BookSourceFormat::Txt {
        let source_path = book_dir.join(SOURCE_TEXT_FILE);
        let text_dir = section_path
            .parent()
            .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
        let source_update = generated_txt_source_update_streaming(
            &source_path,
            &initial_book.metadata,
            text_dir,
            &source_target,
            &old_text,
            &new_text,
            heading_update.as_ref(),
        )?;
        Some((source_path, source_update))
    } else {
        None
    };

    let nav_update = if let Some((old_heading, new_heading)) = &heading_update {
        let nav_path = section_path
            .parent()
            .and_then(Path::parent)
            .map(|oebps| oebps.join("nav.xhtml"))
            .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
        if nav_path.exists() {
            let nav_xhtml = fs::read_to_string(&nav_path).map_err(|error| error.to_string())?;
            let updated_nav = replace_generated_txt_nav_heading(
                &nav_xhtml,
                &target.section_href,
                old_heading,
                new_heading,
            )?;
            (updated_nav != nav_xhtml).then_some((nav_path, updated_nav))
        } else {
            None
        }
    } else {
        None
    };

    if let Some((path, update)) = &source_update {
        write_source_text_update(path, update)?;
    }
    if let Some((path, updated_nav)) = &nav_update {
        fs::write(path, updated_nav).map_err(|error| error.to_string())?;
    }
    fs::write(&section_path, updated_xhtml).map_err(|error| error.to_string())?;

    let mut book = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.library.books.iter_mut().find(|book| book.id == id) else {
            return Err("Book not found".to_string());
        };
        let now = now_ms();
        book.source_format = Some(source_format);
        book.content_version = book.content_version.saturating_add(1).max(1);
        book.content_edited_at = Some(now);
        book.content_hash = edited_book_content_hash(&book.id, book.content_version, now);
        book.updated_at = Some(now);
        book.last_read_at = book.last_read_at.or(Some(now));
        book.clone()
    };

    if source_format == BookSourceFormat::Txt {
        book.size = fs::metadata(book_dir.join(SOURCE_TEXT_FILE))
            .map_err(|error| error.to_string())?
            .len();
    }

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(stored_book) = state
            .library
            .books
            .iter_mut()
            .find(|stored| stored.id == id)
        else {
            return Err("Book not found".to_string());
        };
        stored_book.content_hash = book.content_hash.clone();
        stored_book.size = book.size;
    }

    storage.unload_search_text_cache(&id);
    storage.mark_library_dirty();
    storage.flush_dirty()?;

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(BookTextReplaceResult {
        book: storage.compose_book(&mut state, &book)?,
        section_href: target.section_href,
        changed: true,
    })
}

pub(super) fn export_book_impl(
    storage: &AppStorage,
    id: String,
    format: BookExportFormat,
    output_path: PathBuf,
) -> Result<Option<BookRecord>, String> {
    let initial_book = storage.library_book(&id)?;
    let source_format = storage.book_source_format(&initial_book);
    let content_mode = inspect_and_store_book_content_access(storage, &initial_book)?;
    let book_dir = storage.book_dir(&id);

    match format {
        BookExportFormat::Epub => {
            if source_format == BookSourceFormat::Epub
                && content_mode == BookContentMode::ArchiveOnly
            {
                let book_path = book_dir.join(BOOK_FILE);
                if !book_path.exists() {
                    return Err("Book package is unavailable".to_string());
                }
                if let Some(parent) = output_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::copy(&book_path, &output_path).map_err(|error| error.to_string())?;
            } else {
                let unpacked_dir = book_dir.join(UNPACKED_DIR);
                if !unpacked_dir.exists() {
                    let book_path = book_dir.join(BOOK_FILE);
                    if book_path.exists() {
                        unpack_epub(&book_path, &unpacked_dir)?;
                        normalize_unpacked_epub_structure(&unpacked_dir)?;
                    }
                }
                let book_path = book_dir.join(BOOK_FILE);
                if source_format == BookSourceFormat::Epub && book_path.exists() {
                    write_epub_from_original_and_unpacked(&book_path, &unpacked_dir, &output_path)?;
                } else {
                    let deflate_level = if source_format == BookSourceFormat::Txt {
                        Some(TXT_EPUB_DEFLATE_LEVEL)
                    } else {
                        None
                    };
                    write_epub_from_unpacked_dir(&unpacked_dir, &output_path, deflate_level)?;
                }
            }
        }
        BookExportFormat::Txt => {
            if source_format != BookSourceFormat::Txt {
                return Err("Only TXT imports can be exported as TXT".to_string());
            }
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(book_dir.join(SOURCE_TEXT_FILE), &output_path)
                .map_err(|error| error.to_string())?;
        }
    }

    let book = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.library.books.iter_mut().find(|book| book.id == id) else {
            return Ok(None);
        };
        book.source_format = Some(source_format);
        mark_book_exported(book, format);
        book.clone()
    };

    storage.mark_library_dirty();
    storage.flush_dirty()?;

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    storage.compose_book(&mut state, &book).map(Some)
}

#[cfg(test)]
mod tests {
    use super::commands::{
        get_book_impl, import_epub_paths_impl, import_text_paths_impl,
        preview_text_import_paths_impl, record_reading_position_impl, ReadingPositionInput,
    };
    use super::{
        book_is_export_dirty, cleanup_delete_tombstones, cleanup_external_book_heavy_files,
        decode_text_bytes, delete_books_to_tombstones, delete_tombstones_root, empty_object,
        ensure_book_package_path_with_unpacker, export_book_impl, external_books_root,
        external_index_path, get_book_reader_source_impl, hash_file, image_index_cache_from_bytes,
        image_index_cache_to_bytes, import_epub_path_impl, library_path,
        load_or_build_search_text_cache, mark_book_exported, mark_library_book_content_updated,
        normalize_non_square_pixel_png, normalize_publication_date,
        normalize_unpacked_epub_structure, open_external_epub_path_impl,
        parse_text_import_document, path_to_client_string, read_image_index_cache,
        read_json_or_default, read_json_value_or_default, read_search_text_sections_from_unpacked,
        replace_book_text_impl, replace_xhtml_text, replace_xhtml_text_node,
        schedule_existing_delete_tombstone_cleanup, search_text_cache_from_bytes,
        search_text_cache_to_bytes, search_text_in_cache, settings_path,
        sync_unpacked_opf_metadata, text_content_opf, text_nav_xhtml, text_section_xhtml,
        visible_search_text_from_xhtml, write_epub_from_original_and_unpacked,
        write_epub_from_unpacked_dir, write_image_index_cache_if_current, write_metadata,
        write_source_text_update, AppStorage, BookContentMode, BookExportFormat,
        BookReaderSourceMode, BookRecord, BookScope, BookSourceFormat, BookState,
        BookTextReplaceTarget, DirtyState, ExternalBookIndex, ImageIndexCache,
        ImageIndexCacheInput, ImageIndexEntry, ImageIndexEntryInput, ImageIndexSection,
        ImageIndexSectionInput, Library, LibraryBook, ReadingStatus, SearchTextCache,
        SearchTextSection, SourceTextUpdate, StorageInner, StorageState, TextImportPreparedCache,
        TextImportRulesInput, TextImportSelection, BOOK_FILE, IMAGE_INDEX_CACHE_FILE,
        IMAGE_INDEX_CACHE_VERSION, IMAGE_INDEX_EXTRACTOR_VERSION, METADATA_FILE,
        SEARCH_TEXT_CACHE_FILE, SEARCH_TEXT_CACHE_VERSION, SEARCH_TEXT_EXTRACTOR_VERSION,
        SOURCE_TEXT_FILE, STATE_FILE, UNPACKED_DIR,
    };
    use crate::tasks::TaskService;
    use serde_json::{json, Value};
    use std::{
        collections::{HashMap, VecDeque},
        fs,
        io::{Read, Write},
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

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
        let start = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        while SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            == start
        {
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
                    external: read_json_or_default::<ExternalBookIndex>(
                        &external_index_path(root).unwrap(),
                    )
                    .unwrap(),
                    settings: read_json_value_or_default(&settings_path(root).unwrap()).unwrap(),
                    book_states: HashMap::new(),
                }),
                dirty: Mutex::new(DirtyState::default()),
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

    fn assert_external_promoted(
        storage: &AppStorage,
        imported: &BookRecord,
        external_id: &str,
        source: &Path,
    ) {
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

        let metadata: Value =
            read_json_value_or_default(&storage.book_dir(&imported.id).join(METADATA_FILE))
                .unwrap();
        assert_eq!(
            metadata.get("title").and_then(Value::as_str),
            Some("Edited External")
        );
        assert_eq!(metadata.get("custom").and_then(Value::as_str), Some("kept"));
        let state_file: BookState =
            read_json_or_default(&storage.book_dir(&imported.id).join(STATE_FILE)).unwrap();
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
    fn delete_books_moves_book_directories_to_tombstones_before_cleanup() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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

        let tombstones =
            delete_books_to_tombstones(&storage, &["book-a".to_string(), "book-b".to_string()])
                .unwrap();

        {
            let state = storage.inner.state.lock().unwrap();
            assert!(state.library.books.is_empty());
            assert!(state.book_states.is_empty());
        }
        assert!(!storage.book_dir("book-a").exists());
        assert!(!storage.book_dir("book-b").exists());
        assert_eq!(tombstones.len(), 2);
        assert_eq!(tombstone_entries(&root).len(), 2);
        assert!(tombstones
            .iter()
            .any(|path| path.join("marker.txt").exists()));
        assert!(!storage
            .inner
            .search_text_caches
            .lock()
            .unwrap()
            .contains_key("book-a"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_books_falls_back_when_tombstone_root_is_unavailable() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-delete-tombstone-fallback-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = test_storage_with_books(
            &root,
            vec![test_library_book_with_id("book-a", BookSourceFormat::Epub)],
        );
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
    fn text_import_reprepares_when_prepared_file_metadata_changes() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        assert_eq!(
            books[file_count - 1].name,
            format!("book-{:03}.txt", file_count - 1)
        );
        let max_handoff = storage.text_import_prepared_handoff_max_active();
        assert!(max_handoff > 0);
        assert!(max_handoff <= worker_limit + 1);
        assert!(max_handoff < file_count);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn text_import_does_not_build_search_cache_in_visible_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        assert!(!storage
            .book_dir(&books[0].id)
            .join(SEARCH_TEXT_CACHE_FILE)
            .exists());

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
        let root = std::env::temp_dir().join(format!(
            "flow-reader-normalize-noop-test-{}",
            std::process::id()
        ));
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
        writer
            .start_file("META-INF/container.xml", deflated)
            .unwrap();
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
        writer
            .start_file("META-INF/container.xml", deflated)
            .unwrap();
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
        writer
            .start_file("OEBPS/Text/chapter.xhtml", deflated)
            .unwrap();
        writer
            .write_all(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>正常章节</h1><p>普通正文 keyword。</p></body></html>"#
                    .as_bytes(),
            )
            .unwrap();
        writer
            .start_file("OEBPS/Text/invalid:path.xhtml", deflated)
            .unwrap();
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
        writer
            .start_file("META-INF/container.xml", deflated)
            .unwrap();
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
        writer
            .start_file("OEBPS/Images/*cover.jpg", deflated)
            .unwrap();
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
        writer
            .start_file("META-INF/container.xml", deflated)
            .unwrap();
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
        writer
            .start_file("OEBPS/Text/cover.xhtml", deflated)
            .unwrap();
        writer
            .write_all(
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>{cover_page_body}</body></html>"#
                )
                .as_bytes(),
            )
            .unwrap();
        writer
            .start_file("OEBPS/Text/chapter.xhtml", deflated)
            .unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>body</p></body></html>"#,
            )
            .unwrap();
        writer
            .start_file("OEBPS/Images/real-cover.jpeg", deflated)
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
        writer
            .start_file("META-INF/container.xml", deflated)
            .unwrap();
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
        writer
            .start_file("OEBPS/Text/part0000.xhtml", deflated)
            .unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p><img src="../Images/image00220.jpeg" alt=""/></p></body></html>"#,
            )
            .unwrap();
        writer
            .start_file("OEBPS/Text/chapter.xhtml", deflated)
            .unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>body</p></body></html>"#,
            )
            .unwrap();
        writer
            .start_file("OEBPS/Images/image00220.jpeg", deflated)
            .unwrap();
        writer.write_all(cover_bytes).unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn epub_import_copies_source_without_unpacking_or_indexing() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_epub_open_creates_external_record_without_library_entry() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-external-open-test-{}-{nonce}",
            std::process::id()
        ));
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
        assert!(external_dir.join(BOOK_FILE).exists());
        assert!(external_dir.join(METADATA_FILE).exists());
        assert!(!external_dir.join(UNPACKED_DIR).exists());

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
        assert!(source.path.ends_with("/unpacked/content.opf"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_epub_cleanup_keeps_metadata_and_state() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-managed-open-test-{}-{nonce}",
            std::process::id()
        ));
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

        let opened = open_external_epub_path_impl(&storage, &managed_epub).unwrap();

        assert_eq!(opened.id, imported.id);
        assert!(matches!(opened.scope, BookScope::Library));
        assert_eq!(
            opened.metadata.get("title").and_then(Value::as_str),
            Some("Edited Metadata")
        );
        assert_eq!(
            opened.metadata.get("custom").and_then(Value::as_str),
            Some("kept")
        );
        let state = storage.inner.state.lock().unwrap();
        assert_eq!(state.library.books.len(), 1);
        assert!(state.external.books.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn importing_open_external_epub_promotes_metadata_state_and_removes_external_record() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
    fn epub_import_command_records_timing_for_generated_fixture() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-epub-command-import-test-{}-{nonce}",
            std::process::id()
        ));
        let source = root.join("command.epub");
        write_minimal_epub_file(&source, "Command Book", "command body");
        let storage = test_storage_with_books(&root, Vec::new());
        let tasks = TaskService::default();

        let result = import_epub_paths_impl(
            &storage,
            &tasks,
            vec![source.to_string_lossy().to_string()],
            true,
            None,
            None,
        )
        .unwrap();

        assert_eq!(result.books.len(), 1);
        assert!(result.failures.is_empty());
        assert_eq!(
            result.books[0]
                .metadata
                .get("title")
                .and_then(Value::as_str),
            Some("Command Book")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn epub_import_command_returns_successes_when_later_source_fails() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
            result.books[0]
                .metadata
                .get("title")
                .and_then(Value::as_str),
            Some("Valid Book")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn epub_replace_import_removes_stale_unpacked_and_search_artifacts() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        assert_eq!(
            new_book.metadata.get("title").and_then(Value::as_str),
            Some("New Book")
        );
        assert!(!book_dir.join(UNPACKED_DIR).exists());
        assert!(!book_dir.join(SEARCH_TEXT_CACHE_FILE).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unpack_package_reuses_in_flight_task_for_same_book_version() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-unpack-idempotent-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = Arc::new(test_storage_with_book(
            &root,
            test_library_book(BookSourceFormat::Epub),
        ));
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
        assert!(fs::read_to_string(first_path).unwrap().contains("first"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_unpack_result_is_not_published() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-unpack-stale-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));
        fs::create_dir_all(storage.book_dir("book")).unwrap();
        fs::write(storage.book_dir("book").join(BOOK_FILE), b"placeholder").unwrap();
        let tasks = TaskService::default();
        let book = storage.library_book("book").unwrap();

        let result = ensure_book_package_path_with_unpacker(&storage, &tasks, &book, |_, dest| {
            write_minimal_unpacked_package(dest, "stale");
            let mut state = storage.inner.state.lock().unwrap();
            let book = state
                .library
                .books
                .iter_mut()
                .find(|book| book.id == "book")
                .unwrap();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-unpack-atomic-test-{}-{nonce}",
            std::process::id()
        ));
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        assert!(cache
            .sections
            .iter()
            .any(|section| section.href == "Text/invalid:path.xhtml"
                && section.text.contains("非法路径章节 keyword")));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].subitems[0].href, "Text/invalid:path.xhtml");
        assert!(book_dir.join(SEARCH_TEXT_CACHE_FILE).exists());
        assert!(!book_dir.join(UNPACKED_DIR).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_only_epub_text_replacement_is_not_supported() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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

        let exported = export_book_impl(
            &storage,
            "book".to_string(),
            BookExportFormat::Epub,
            output.clone(),
        )
        .unwrap()
        .unwrap();

        assert_eq!(fs::read(output).unwrap(), original);
        assert_eq!(exported.exported_versions.get("epub"), Some(&1));
        assert!(!book_dir.join(UNPACKED_DIR).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn record_reading_position_keeps_latest_sequence_in_memory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let book_state = storage
            .ensure_book_state(&mut state, "book")
            .unwrap()
            .clone();

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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let text =
            "第一卷 起始\n第001章 开端\n第一段正文。\n第二段正文。\n第002章 继续\n第三段正文。";
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
        assert_eq!(
            document.sections[1].paragraphs,
            vec!["示例正文。".to_string()]
        );
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

        assert!(nav.contains(
            r#"<li id="txt-group-0001"><a href="Text/part0001.xhtml">第一卷 起始</a><ol>"#
        ));
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

        assert_eq!(
            text,
            "第一章\nAlpha target & beta platform\nSecond paragraph."
        );
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
    fn persists_image_index_cache_as_zstd_payload() {
        let cache = ImageIndexCache {
            version: IMAGE_INDEX_CACHE_VERSION,
            extractor_version: IMAGE_INDEX_EXTRACTOR_VERSION,
            book_hash: "abc123".to_string(),
            content_version: 2,
            sections: vec![ImageIndexSection {
                section_index: 0,
                href: "Text/chapter.xhtml".to_string(),
                title: Some("Chapter One".to_string()),
                nav_path: vec!["Part One".to_string()],
                images: vec![ImageIndexEntry {
                    src: "../Images/p001.jpg".to_string(),
                    index: 0,
                    hidden_by_default: false,
                    reason: None,
                }],
            }],
        };

        let bytes = image_index_cache_to_bytes(&cache).expect("cache should encode");
        let restored = image_index_cache_from_bytes(&bytes).expect("cache should decode");

        assert_eq!(restored, cache);
    }

    #[test]
    fn writes_image_index_cache_only_for_current_book_version() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
                    text: "The target phrase appears here. Later the target phrase appears again."
                        .to_string(),
                },
            ],
        };

        let results = search_text_in_cache(&cache, "target phrase", Some(20));

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "Text/two.xhtml");
        assert_eq!(results[0].excerpt, "Chapter Two");
        assert_eq!(results[0].subitems.len(), 2);
        assert_eq!(results[0].subitems[0].section_index, 1);
        assert_eq!(results[0].subitems[0].href, "Text/two.xhtml");
        assert_eq!(results[0].subitems[0].occurrence, 0);
        assert_eq!(results[0].subitems[0].offset, 4);
        assert!(results[0].subitems[0]
            .excerpt
            .contains("target phrase appears"));
        assert_eq!(results[0].subitems[1].occurrence, 1);
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
        let result_count = results
            .iter()
            .map(|result| result.subitems.len())
            .sum::<usize>();

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
                    &format!(
                        "{} target phrase {}",
                        "before ".repeat(40),
                        "after ".repeat(40)
                    ),
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-search-cache-test-{}-{nonce}",
            std::process::id()
        ));
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-search-nav-test-{}-{nonce}",
            std::process::id()
        ));
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-search-ncx-test-{}-{nonce}",
            std::process::id()
        ));
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
        assert_eq!(
            sections[0].title.as_deref(),
            Some("Chapter Three Hundred Eighteen")
        );

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

        let updated =
            replace_xhtml_text_node(xhtml, &target, "target", "fixed").expect("replace succeeds");

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

        let updated = replace_xhtml_text_node(xhtml, &target, "target", "C < D & E")
            .expect("replace succeeds");

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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-txt-paragraph-replace-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Txt));
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
        assert!(fs::read_to_string(text_dir.join("part0001.xhtml"))
            .unwrap()
            .contains("<p>第二段正字。</p>"));
        assert_eq!(
            fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
            "第001章 测试\n第一段原文。\n第二段正字。\n"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn txt_replacement_fails_fast_without_paragraph_index() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        assert!(fs::read_to_string(text_dir.join("part0001.xhtml"))
            .unwrap()
            .contains("<p>第二段错字。</p>"));
        assert_eq!(
            fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
            "第001章 测试\n第一段原文。\n第二段错字。\n"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn txt_replacement_streams_to_target_heading_when_previous_generated_heading_has_parent() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        assert!(fs::read_to_string(text_dir.join("part0002.xhtml"))
            .unwrap()
            .contains("<p>目标段正字。</p>"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn txt_replacement_updates_generated_heading_and_source_title_line() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-txt-heading-replace-test-{}-{nonce}",
            std::process::id()
        ));
        let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Txt));
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
        assert!(fs::read_to_string(oebps.join("nav.xhtml"))
            .unwrap()
            .contains(r#"<a href="Text/part0001.xhtml">第001章 测试</a>"#));
        assert_eq!(
            fs::read_to_string(book_dir.join(SOURCE_TEXT_FILE)).unwrap(),
            "第001章 测试\n正文。\n"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_splice_txt_source_update_without_losing_tail() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "第一段 MD55_A_RED\n第二段。\n"
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn exports_epub_with_required_mimetype_entry() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-export-test-{}-{nonce}",
            std::process::id()
        ));
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let image_compression = archive
            .by_name("OEBPS/images/page.jpg")
            .unwrap()
            .compression();
        assert_eq!(content_compression, CompressionMethod::Deflated);
        assert_eq!(image_compression, CompressionMethod::Stored);

        fs::remove_dir_all(&root).unwrap();
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn exports_epub_reuses_original_entries_and_rewrites_changed_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        fs::write(
            unpacked.join("OEBPS/content.opf"),
            "<package>original</package>",
        )
        .unwrap();
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
        writer
            .start_file("OEBPS/images/page.jpg", deflated)
            .unwrap();
        writer.write_all(&[9u8; 128]).unwrap();
        writer.finish().unwrap();

        wait_until_next_epoch_second();
        fs::write(
            unpacked.join("OEBPS/content.opf"),
            "<package>changed</package>",
        )
        .unwrap();
        fs::write(unpacked.join("OEBPS/toc.ncx"), "<ncx>changed</ncx>").unwrap();
        fs::write(unpacked.join("OEBPS/chapter.xhtml"), "<p>tame</p>").unwrap();
        fs::write(unpacked.join("OEBPS/styles/book.css"), "p{color:blue}").unwrap();
        fs::write(unpacked.join("OEBPS/images/page.jpg"), [8u8; 128]).unwrap();

        write_epub_from_original_and_unpacked(&original, &unpacked, &output)
            .expect("export succeeds");

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
            archive
                .by_name("OEBPS/chapter.xhtml")
                .unwrap()
                .compression(),
            CompressionMethod::Deflated
        );
        assert_eq!(
            archive.by_name("OEBPS/toc.ncx").unwrap().compression(),
            CompressionMethod::Deflated
        );
        assert_eq!(
            archive
                .by_name("OEBPS/styles/book.css")
                .unwrap()
                .compression(),
            CompressionMethod::Stored
        );
        assert_eq!(
            archive
                .by_name("OEBPS/images/page.jpg")
                .unwrap()
                .compression(),
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-export-unpacked-count-test-{}-{nonce}",
            std::process::id()
        ));
        let original = root.join("original.epub");
        let unpacked = root.join("unpacked");
        let output = root.join("exported.epub");
        fs::create_dir_all(unpacked.join("OEBPS")).unwrap();
        fs::write(unpacked.join("mimetype"), "application/epub+zip").unwrap();
        fs::write(
            unpacked.join("OEBPS/content.opf"),
            "<package>unpacked</package>",
        )
        .unwrap();
        fs::write(unpacked.join("OEBPS/toc.ncx"), "<ncx>unpacked</ncx>").unwrap();

        let file = fs::File::create(&original).unwrap();
        let mut writer = ZipWriter::new(file);
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("mimetype", stored).unwrap();
        writer.write_all(b"application/epub+zip").unwrap();
        writer.start_file("OEBPS/content.opf", stored).unwrap();
        writer.write_all(b"<package>original</package>").unwrap();
        writer.finish().unwrap();

        write_epub_from_original_and_unpacked(&original, &unpacked, &output)
            .expect("export succeeds");

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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        assert!(archive
            .by_name("OEBPS/text00000-flow-split-0001.html")
            .is_ok());
        assert!(archive
            .by_name("OEBPS/text00000-flow-split-0009.html")
            .is_ok());

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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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

        let mut ncx = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><ncx><navMap>"#);
        let mut toc_page = String::from(r#"<!DOCTYPE html><html><body>"#);
        let mut body = String::from("<p>preface</p>");
        for index in 1..=9 {
            ncx.push_str(&format!(
                r#"<navPoint id="nav{index}"><navLabel><text>Chapter {index}</text></navLabel><content src="{big_href}#c{index:03}"/></navPoint>"#
            ));
            toc_page.push_str(&format!(
                r#"<p><a href="{big_href}#c{index:03}">Chapter {index}</a></p>"#
            ));
            body.push_str(&format!(
                r#"<span id="c{index:03}"></span><p>Chapter {index}</p><p>{}</p>"#,
                "正文".repeat(40_000)
            ));
        }
        ncx.push_str("</navMap></ncx>");
        toc_page.push_str("</body></html>");
        let xhtml = format!(
            r#"<!DOCTYPE html><html><head><title>Big</title></head><body>{body}</body></html>"#
        );
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
        let ncx =
            fs::read_to_string(opf_dir.join(ncx_href.replace('/', std::path::MAIN_SEPARATOR_STR)))
                .unwrap();
        assert!(ncx.contains(&format!(r#"src="{first_ncx_src}""#)));
        assert!(ncx.contains(&format!(r#"src="{last_ncx_src}""#)));
        assert!(root
            .join(first_split_path.replace('/', std::path::MAIN_SEPARATOR_STR))
            .exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn syncs_unpacked_opf_title_and_first_creator_metadata() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flow-reader-opf-metadata-test-{}-{nonce}",
            std::process::id()
        ));
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
        assert!(
            opf.contains(r#"<dc:creator opf:role="aut" opf:file-as="新作者">新作者</dc:creator>"#)
        );
        assert!(opf.contains(r#"<dc:creator opf:role="trl" opf:file-as="译者">译者</dc:creator>"#));
        assert!(!opf.contains("旧标题"));
        assert!(!opf.contains("旧作者"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn syncs_unpacked_opf_multiline_creator_and_preserves_tail() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
        let root = std::env::temp_dir().join(format!(
            "flow-reader-import-repair-dirty-test-{}",
            std::process::id()
        ));
        let storage = test_storage_with_book(&root, test_library_book(BookSourceFormat::Epub));

        let updated = mark_library_book_content_updated(&storage, "book")
            .unwrap()
            .expect("library book should be updated");

        assert_eq!(updated.content_version, 2);
        assert!(updated.content_edited_at.is_some());
        assert!(book_is_export_dirty(&updated, BookExportFormat::Epub));

        let _ = fs::remove_dir_all(root);
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
