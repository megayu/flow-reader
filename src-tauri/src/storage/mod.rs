use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

mod book_assets;
mod commands;
mod epub_import;
mod search;
mod text_import;
mod window_state;

pub use commands::*;
pub use search::SearchTextResult;
pub use text_import::{
    is_epub_file, is_txt_file, TextImportEncodingOption, TextImportPreview, TextImportRulesInput,
    TextImportSelection,
};
pub use window_state::{flush_app_storage, restore_window_state, save_window_state};

use book_assets::{is_generated_text_cover, read_cover, write_cover, write_metadata};

#[cfg(test)]
use epub_import::normalize_publication_date;
use epub_import::{
    clean_xml_text, find_unpacked_opf_path, import_epub_path_impl, join_zip_path,
    normalize_zip_path, parent_zip_path, unpack_epub,
};

use search::{
    build_and_write_search_text_cache, load_or_build_search_text_cache, search_text_in_cache,
    SearchTextCache,
};
#[cfg(test)]
use search::{
    read_search_text_sections_from_unpacked, search_text_cache_from_bytes,
    search_text_cache_to_bytes, visible_search_text_from_xhtml, SearchTextSection,
};
use text_import::{
    create_skipped_text_import_preview, create_text_cover_input, create_text_import_preview,
    decode_text_bytes, import_text_path_impl, should_skip_text_import_preview,
    text_import_encoding_options,
};
#[cfg(test)]
use text_import::{
    parse_text_import_document, text_content_opf, text_nav_xhtml, text_section_xhtml,
};

const APP_DATA_DIR_NAME: &str = "Flow Reader";
const APP_DATA_DIR_ENV: &str = "FLOW_READER_DATA_DIR";
const BOOKS_DIR: &str = "books";
const LIBRARY_FILE: &str = "library.json";
const SETTINGS_FILE: &str = "settings.json";
const BOOK_FILE: &str = "book.epub";
const SOURCE_TEXT_FILE: &str = "source.txt";
const UNPACKED_DIR: &str = "unpacked";
const SEARCH_TEXT_CACHE_FILE: &str = "search-text.v1.json.zst";
const SEARCH_TEXT_EXCERPT_RADIUS: usize = 60;
pub const SEARCH_TEXT_CACHE_VERSION: u32 = 1;
pub const SEARCH_TEXT_EXTRACTOR_VERSION: u32 = 1;
const COVER_STEM: &str = "cover";
const GENERATED_TEXT_COVER_MARKER: &str = r#"data-flow-generated-cover="true""#;
const METADATA_FILE: &str = "metadata.json";
const STATE_FILE: &str = "state.json";
const WINDOW_STATE_FILE: &str = "window-state.json";

const READING_POSITION_FLUSH_DELAY: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct AppStorage {
    inner: Arc<StorageInner>,
}

struct StorageInner {
    root: PathBuf,
    state: Mutex<StorageState>,
    dirty: Mutex<DirtyState>,
    search_text_caches: Mutex<HashMap<String, Arc<SearchTextCache>>>,
}

struct StorageState {
    library: Library,
    settings: Value,
    book_states: HashMap<String, BookState>,
}

#[derive(Default)]
struct DirtyState {
    library: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryBook {
    id: String,
    name: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reading_status: Option<ReadingStatus>,
    #[serde(default)]
    content_hash: String,
    #[serde(default)]
    content_version: u32,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    reading_status: Option<ReadingStatus>,
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
        let settings = read_json_value_or_default(&settings_path(&root)?)?;

        Ok(Self {
            inner: Arc::new(StorageInner {
                root,
                state: Mutex::new(StorageState {
                    library,
                    settings,
                    book_states: HashMap::new(),
                }),
                dirty: Mutex::new(DirtyState::default()),
                search_text_caches: Mutex::new(HashMap::new()),
            }),
        })
    }

    fn root(&self) -> &Path {
        &self.inner.root
    }

    fn book_dir(&self, id: &str) -> PathBuf {
        books_root(self.root()).join(id)
    }

    fn search_text_cache_path(&self, id: &str) -> PathBuf {
        self.book_dir(id).join(SEARCH_TEXT_CACHE_FILE)
    }

    fn library_book(&self, id: &str) -> Result<LibraryBook, String> {
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

    fn unload_search_text_cache(&self, id: &str) {
        if let Ok(mut caches) = self.inner.search_text_caches.lock() {
            caches.remove(id);
        }
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
            reading_status: book.reading_status.clone(),
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
        })
    }

    fn compose_book_summary(&self, book: &LibraryBook) -> BookRecord {
        BookRecord {
            id: book.id.clone(),
            name: book.name.clone(),
            size: book.size,
            reading_status: book.reading_status.clone(),
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
        }
    }

    fn mark_library_dirty(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.library = true;
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
                settings: dirty.settings,
                book_states: std::mem::take(&mut dirty.book_states),
                delayed_flush_scheduled: dirty.delayed_flush_scheduled,
            };
            dirty.library = false;
            dirty.settings = false;
            snapshot
        };

        if !dirty.library && !dirty.settings && dirty.book_states.is_empty() {
            return Ok(());
        }

        let (library, settings, book_states) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let library = dirty.library.then(|| clone_library(&state.library));
            let settings = dirty.settings.then(|| state.settings.clone());
            let book_states = dirty
                .book_states
                .iter()
                .filter_map(|id| state.book_states.get(id).map(|s| (id.clone(), s.clone())))
                .collect::<Vec<_>>();

            (library, settings, book_states)
        };

        if let Some(library) = library {
            write_json(&library_path(self.root())?, &library)?;
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

#[cfg(test)]
mod tests {
    use super::{
        decode_text_bytes, normalize_publication_date, parse_text_import_document,
        read_search_text_sections_from_unpacked, search_text_cache_from_bytes,
        search_text_cache_to_bytes, search_text_in_cache, text_content_opf, text_nav_xhtml,
        text_section_xhtml, visible_search_text_from_xhtml, SearchTextCache, SearchTextSection,
        TextImportRulesInput, SEARCH_TEXT_CACHE_VERSION, SEARCH_TEXT_EXTRACTOR_VERSION,
    };
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

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

        assert_eq!(document.sections.len(), 2);
        assert_eq!(document.sections[0].parent.as_deref(), Some("第一卷 起始"));
        assert_eq!(document.sections[0].title, "第001章 开端");
        assert_eq!(document.sections[1].title, "第002章 继续");
        assert_eq!(document.chapters[0].role, "group");
        assert_eq!(document.chapters[1].role, "chapter");
    }

    #[test]
    fn generates_valid_text_import_opf_metadata() {
        let document = parse_text_import_document("第1章 开始\n正文。", "测试书", None);
        let opf = text_content_opf(&document, "GB18030");

        assert!(opf.contains(r#"<meta property="source-format">txt</meta>"#));
        assert!(opf.contains(r#"<meta property="source-encoding">GB18030</meta>"#));
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
    fn only_prefixes_group_name_on_first_child_section() {
        let text = "第一卷 起始\n第001章 开端\n第一段正文。\n第002章 继续\n第二段正文。";
        let document = parse_text_import_document(text, "测试书", None);
        let first = text_section_xhtml(&document.sections[0]);
        let second = text_section_xhtml(&document.sections[1]);

        assert!(first.contains(r#"<h2 class="flow-txt-chapter">第一卷 起始 第001章 开端</h2>"#));
        assert!(!first.contains(r#"<h1 class="flow-txt-volume">"#));
        assert!(second.contains(r#"<h2 class="flow-txt-chapter">第002章 继续</h2>"#));
        assert!(!second.contains("第一卷 起始"));
    }

    #[test]
    fn accepts_custom_text_import_heading_rules() {
        let rules = TextImportRulesInput {
            group_patterns: vec![r"^\s*幕\s+\d+".to_string()],
            chapter_patterns: vec![r"^\s*场\s+\d+".to_string()],
        };
        let text = "幕 1\n场 1\n第一段正文。\n场 2\n第二段正文。";
        let document = parse_text_import_document(text, "测试书", Some(&rules));

        assert_eq!(document.sections.len(), 2);
        assert_eq!(document.sections[0].parent.as_deref(), Some("幕 1"));
        assert_eq!(document.sections[0].title, "场 1");
        assert_eq!(document.sections[1].title, "场 2");
    }

    #[test]
    fn generated_text_nav_groups_have_stable_ids() {
        let text = "第一卷 起始\n第001章 开端\n第一段正文。";
        let document = parse_text_import_document(text, "测试书", None);
        let nav = text_nav_xhtml(&document);

        assert!(nav.contains(r#"<li id="txt-group-0001"><span>第一卷 起始</span><ol>"#));
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
}
