use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use encoding_rs::{
    Encoding, BIG5, EUC_KR, GB18030, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, Window};
use zip::ZipArchive;

const APP_DATA_DIR_NAME: &str = "Flow Reader";
const BOOKS_DIR: &str = "books";
const LIBRARY_FILE: &str = "library.json";
const SETTINGS_FILE: &str = "settings.json";
const BOOK_FILE: &str = "book.epub";
const SOURCE_TEXT_FILE: &str = "source.txt";
const UNPACKED_DIR: &str = "unpacked";
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
    #[serde(skip_serializing_if = "Option::is_none")]
    configuration: Option<Value>,
    #[serde(default)]
    content_hash: String,
    #[serde(default)]
    content_version: u32,
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

struct ParsedEpubInfo {
    metadata: Value,
    cover: Option<CoverInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportEncodingOption {
    id: String,
    label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportSelection {
    path: String,
    #[serde(default)]
    encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportRulesInput {
    #[serde(default)]
    group_patterns: Vec<String>,
    #[serde(default)]
    chapter_patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextImportStatus {
    Ready,
    NeedsReview,
    Error,
    Skipped,
}

impl TextImportStatus {
    fn as_str(self) -> &'static str {
        match self {
            TextImportStatus::Ready => "ready",
            TextImportStatus::NeedsReview => "needsReview",
            TextImportStatus::Error => "error",
            TextImportStatus::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportPreview {
    path: String,
    filename: String,
    title: String,
    encoding: String,
    encoding_label: String,
    confidence: String,
    status: String,
    selected: bool,
    message: Option<String>,
    sample: String,
    chapters: Vec<TextImportChapterPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportChapterPreview {
    title: String,
    level: u8,
    role: String,
}

#[derive(Debug, Clone)]
struct DecodedText {
    text: String,
    encoding: String,
    encoding_label: String,
    confidence: TextEncodingConfidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextEncodingConfidence {
    High,
    Medium,
    Low,
    Failed,
}

#[derive(Debug, Clone)]
struct TextImportDocument {
    title: String,
    sections: Vec<TextImportSection>,
    chapters: Vec<TextImportChapterPreview>,
}

#[derive(Debug, Clone)]
struct TextImportSection {
    title: String,
    parent: Option<String>,
    paragraphs: Vec<String>,
    prefix_parent_title: bool,
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
    #[serde(default)]
    fullscreen: bool,
}

const MIN_RESTORED_WINDOW_WIDTH: u32 = 900;
const MIN_RESTORED_WINDOW_HEIGHT: u32 = 600;
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
            }),
        })
    }

    fn root(&self) -> &Path {
        &self.inner.root
    }

    fn book_dir(&self, id: &str) -> PathBuf {
        books_root(self.root()).join(id)
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
    }
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
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

fn write_metadata(storage: &AppStorage, id: &str, metadata: &Value) -> Result<(), String> {
    write_json(&storage.book_dir(id).join(METADATA_FILE), metadata)
}

fn write_cover(storage: &AppStorage, id: &str, cover: Option<CoverInput>) -> Result<(), String> {
    remove_cover_files(storage, id)?;

    let Some(cover) = cover else {
        return Ok(());
    };

    let extension = sanitize_cover_extension(&cover.extension, &cover.mime_type);
    if extension.is_empty() || cover.data.is_empty() {
        return Ok(());
    }

    let path = storage
        .book_dir(id)
        .join(format!("{COVER_STEM}.{extension}"));
    fs::write(path, cover.data).map_err(|error| error.to_string())
}

fn read_cover(storage: &AppStorage, id: &str) -> Result<Option<String>, String> {
    let dir = storage.book_dir(id);
    if !dir.exists() {
        return Ok(None);
    }

    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if is_cover_file(&path) {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }

    Ok(None)
}

fn is_generated_text_cover(storage: &AppStorage, id: &str) -> Result<bool, String> {
    let Some(path) = read_cover(storage, id)? else {
        return Ok(true);
    };
    let path = PathBuf::from(path);
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        return Ok(false);
    }

    let svg = fs::read_to_string(path).unwrap_or_default();
    Ok(svg.contains(GENERATED_TEXT_COVER_MARKER)
        || (svg.contains(r##"<rect width="768" height="1024" fill="#ead7b5"/>"##)
            && svg.contains("Noto Serif CJK SC")))
}

fn remove_cover_files(storage: &AppStorage, id: &str) -> Result<(), String> {
    let dir = storage.book_dir(id);
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if is_cover_file(&path) {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

fn is_cover_file(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem == COVER_STEM)
}

fn sanitize_cover_extension(extension: &str, mime_type: &str) -> String {
    let extension = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>();

    if matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg"
    ) {
        return extension;
    }

    match mime_type {
        "image/jpeg" => "jpg".to_string(),
        "image/png" => "png".to_string(),
        "image/gif" => "gif".to_string(),
        "image/webp" => "webp".to_string(),
        "image/svg+xml" => "svg".to_string(),
        _ => String::new(),
    }
}

fn parse_epub_info(path: &Path) -> ParsedEpubInfo {
    parse_epub_info_result(path).unwrap_or_else(|_| ParsedEpubInfo {
        metadata: empty_object(),
        cover: None,
    })
}

fn unpack_epub(path: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;

    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(enclosed_name) = file.enclosed_name() else {
            continue;
        };
        let outpath = dest.join(enclosed_name);

        if file.is_dir() {
            fs::create_dir_all(&outpath).map_err(|error| error.to_string())?;
            continue;
        }

        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let mut outfile = fs::File::create(&outpath).map_err(|error| error.to_string())?;
        std::io::copy(&mut file, &mut outfile).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn find_unpacked_opf_path(unpacked_dir: &Path) -> Result<PathBuf, String> {
    let container_path = unpacked_dir.join("META-INF").join("container.xml");
    let container = fs::read_to_string(&container_path).map_err(|error| error.to_string())?;
    let container_doc =
        roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?;
    let normalized = normalize_zip_path(opf_path.replace('\\', "/"));
    if normalized.is_empty() {
        return Err("EPUB container has invalid rootfile".to_string());
    }

    Ok(unpacked_dir.join(normalized))
}

fn parse_epub_info_result(path: &Path) -> Result<ParsedEpubInfo, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let container = read_zip_text(&mut archive, "META-INF/container.xml")?;
    let container_doc =
        roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?
        .to_string();
    let opf = read_zip_text(&mut archive, &opf_path)?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|error| error.to_string())?;
    let metadata = parse_opf_metadata(&opf_doc);
    let cover = find_cover_path(&opf_doc)
        .and_then(|(href, mime_type)| {
            let cover_path = normalize_zip_path(join_zip_path(parent_zip_path(&opf_path), &href));
            read_zip_bytes(&mut archive, &cover_path).ok().map(|data| {
                let extension = extension_from_path(&cover_path);
                CoverInput {
                    mime_type,
                    extension,
                    data,
                }
            })
        })
        .or_else(|| {
            create_text_cover_input(&metadata, path.file_stem().and_then(|name| name.to_str()))
        });

    Ok(ParsedEpubInfo { metadata, cover })
}

fn read_zip_text<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<String, String> {
    let mut file = archive.by_name(name).map_err(|error| error.to_string())?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    Ok(text)
}

fn read_zip_bytes<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut file = archive.by_name(name).map_err(|error| error.to_string())?;
    let mut data = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    Ok(data)
}

fn parse_opf_metadata(doc: &roxmltree::Document) -> Value {
    let mut metadata = serde_json::Map::new();
    let metadata_node = doc.descendants().find(|node| node.has_tag_name("metadata"));

    let Some(metadata_node) = metadata_node else {
        return Value::Object(metadata);
    };

    let element_mappings = [
        ("title", "title"),
        ("creator", "creator"),
        ("description", "description"),
        ("date", "pubdate"),
        ("publisher", "publisher"),
        ("identifier", "identifier"),
        ("language", "language"),
        ("rights", "rights"),
    ];

    for (tag, key) in element_mappings {
        if let Some(value) = metadata_node
            .children()
            .find(|node| node.is_element() && node.tag_name().name() == tag)
            .and_then(|node| node.text())
            .map(clean_xml_text)
            .filter(|value| !value.is_empty())
        {
            let value = if key == "pubdate" {
                normalize_publication_date(&value)
            } else {
                value
            };
            metadata.insert(key.to_string(), Value::String(value));
        }
    }

    let property_mappings = [
        ("dcterms:modified", "modified_date"),
        ("rendition:layout", "layout"),
        ("rendition:orientation", "orientation"),
        ("rendition:flow", "flow"),
        ("rendition:viewport", "viewport"),
        ("rendition:spread", "spread"),
    ];

    for (property, key) in property_mappings {
        if let Some(value) = metadata_node
            .children()
            .find(|node| {
                node.is_element()
                    && node.has_tag_name("meta")
                    && node.attribute("property") == Some(property)
            })
            .and_then(|node| node.text())
            .map(clean_xml_text)
            .filter(|value| !value.is_empty())
        {
            metadata.insert(key.to_string(), Value::String(value));
        }
    }

    Value::Object(metadata)
}

fn clean_xml_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_publication_date(value: &str) -> String {
    let text = clean_xml_text(value);
    if text.is_empty() {
        return text;
    }

    extract_normalized_publication_date(&text).unwrap_or(text)
}

fn extract_normalized_publication_date(text: &str) -> Option<String> {
    for (index, _) in text.char_indices() {
        if !starts_with_ascii_digits(text, index, 4) {
            continue;
        }
        if previous_char_is_ascii_digit(text, index) {
            continue;
        }

        let digit_count = text[index..]
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .count();

        if let Some(date) = parse_compact_publication_date(text, index, digit_count) {
            return Some(date);
        }

        if digit_count >= 6 {
            continue;
        }

        if let Some(date) = parse_separated_publication_date(text, index) {
            return Some(date);
        }

        if text[index + 4..]
            .chars()
            .next()
            .is_some_and(is_publication_date_separator)
        {
            continue;
        }

        let end = index + 4;
        if !next_char_is_ascii_digit(text, end) {
            return Some(text[index..end].to_string());
        }
    }

    None
}

fn parse_compact_publication_date(text: &str, index: usize, digit_count: usize) -> Option<String> {
    if digit_count >= 8 {
        let year = &text[index..index + 4];
        let month = parse_date_component(&text[index + 4..index + 6], 1, 12)?;
        let day = parse_date_component(&text[index + 6..index + 8], 1, 31)?;
        return Some(format!("{year}-{month:02}-{day:02}"));
    }

    if digit_count == 6 {
        let year = &text[index..index + 4];
        let month = parse_date_component(&text[index + 4..index + 6], 1, 12)?;
        return Some(format!("{year}-{month:02}"));
    }

    None
}

fn parse_separated_publication_date(text: &str, index: usize) -> Option<String> {
    let year = &text[index..index + 4];
    let mut cursor = index + 4;
    let separator = text[cursor..].chars().next()?;

    if !is_publication_date_separator(separator) {
        return None;
    }

    cursor += separator.len_utf8();
    let (month, next_cursor) = read_numeric_component(text, cursor, 2)?;
    let month = parse_date_component(month, 1, 12)?;
    cursor = next_cursor;

    let Some(next) = text[cursor..].chars().next() else {
        return Some(format!("{year}-{month:02}"));
    };

    if next == '月' {
        cursor += next.len_utf8();
    } else if is_publication_date_separator(next) {
        cursor += next.len_utf8();
    } else {
        return Some(format!("{year}-{month:02}"));
    }

    let Some((day, next_cursor)) = read_numeric_component(text, cursor, 2) else {
        return Some(format!("{year}-{month:02}"));
    };
    let day = parse_date_component(day, 1, 31)?;
    cursor = next_cursor;

    if text[cursor..].starts_with('日') {
        cursor += '日'.len_utf8();
    }

    if next_char_is_ascii_digit(text, cursor) {
        return None;
    }

    Some(format!("{year}-{month:02}-{day:02}"))
}

fn starts_with_ascii_digits(text: &str, index: usize, count: usize) -> bool {
    text[index..]
        .chars()
        .take(count)
        .filter(|character| character.is_ascii_digit())
        .count()
        == count
}

fn previous_char_is_ascii_digit(text: &str, index: usize) -> bool {
    text[..index]
        .chars()
        .next_back()
        .is_some_and(|character| character.is_ascii_digit())
}

fn next_char_is_ascii_digit(text: &str, index: usize) -> bool {
    text[index..]
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
}

fn is_publication_date_separator(character: char) -> bool {
    matches!(character, '-' | '/' | '.' | '年')
}

fn read_numeric_component(text: &str, index: usize, max_digits: usize) -> Option<(&str, usize)> {
    let mut end = index;
    let mut digits = 0;

    for (offset, character) in text[index..].char_indices() {
        if !character.is_ascii_digit() || digits >= max_digits {
            break;
        }

        digits += 1;
        end = index + offset + character.len_utf8();
    }

    if digits == 0 {
        None
    } else {
        Some((&text[index..end], end))
    }
}

fn parse_date_component(value: &str, min: u32, max: u32) -> Option<u32> {
    let value = value.parse::<u32>().ok()?;
    (min..=max).contains(&value).then_some(value)
}

fn find_cover_path(doc: &roxmltree::Document) -> Option<(String, String)> {
    let manifest_items = || {
        doc.descendants()
            .filter(|node| node.is_element() && node.has_tag_name("item"))
    };

    if let Some(item) = manifest_items().find(|node| {
        node.attribute("properties")
            .is_some_and(|properties| properties.split_whitespace().any(|p| p == "cover-image"))
    }) {
        return cover_item_to_path(item);
    }

    let cover_id = doc.descendants().find_map(|node| {
        if !node.is_element() || !node.has_tag_name("meta") {
            return None;
        }
        if node.attribute("name") == Some("cover") {
            node.attribute("content").map(str::to_string)
        } else {
            None
        }
    });

    if let Some(cover_id) = cover_id {
        if let Some(item) =
            manifest_items().find(|node| node.attribute("id") == Some(cover_id.as_str()))
        {
            return cover_item_to_path(item);
        }
    }

    manifest_items()
        .find(|node| {
            node.attribute("media-type")
                .is_some_and(|media_type| media_type.starts_with("image/"))
                && node
                    .attribute("href")
                    .is_some_and(|href| href.to_ascii_lowercase().contains("cover"))
        })
        .and_then(cover_item_to_path)
}

fn cover_item_to_path(node: roxmltree::Node) -> Option<(String, String)> {
    let href = node.attribute("href")?.to_string();
    let mime_type = node.attribute("media-type").unwrap_or("").to_string();
    Some((href, mime_type))
}

fn parent_zip_path(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

fn join_zip_path(parent: &str, child: &str) -> String {
    if parent.is_empty() || child.starts_with('/') {
        child.trim_start_matches('/').to_string()
    } else {
        format!("{parent}/{child}")
    }
}

fn normalize_zip_path(path: String) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn extension_from_path(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

fn path_to_client_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn svg_char_width(ch: char) -> f32 {
    if ch.is_ascii_whitespace() {
        0.35
    } else if ch.is_ascii() {
        0.58
    } else {
        1.0
    }
}

fn wrap_svg_text(value: &str, font_size: f32, max_width: f32) -> Vec<String> {
    let max_width = max_width / font_size;
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut width = 0.0;

    for ch in value.chars() {
        if ch == '\n' {
            let text = line.trim();
            if !text.is_empty() {
                lines.push(text.to_string());
            }
            line.clear();
            width = 0.0;
            continue;
        }

        let char_width = svg_char_width(ch);
        if width + char_width > max_width && !line.trim().is_empty() {
            lines.push(line.trim().to_string());
            line.clear();
            width = 0.0;
        }

        if !line.is_empty() || !ch.is_whitespace() {
            line.push(ch);
            width += char_width;
        }
    }

    let text = line.trim();
    if !text.is_empty() {
        lines.push(text.to_string());
    }

    if lines.is_empty() {
        vec![value.to_string()]
    } else {
        lines
    }
}

fn svg_text_block(
    lines: &[String],
    y: f32,
    font_size: f32,
    line_height: f32,
    font_weight: u16,
) -> String {
    let mut output = format!(
        r#"<text x="384" y="{y:.1}" text-anchor="middle" font-size="{font_size:.1}" font-weight="{font_weight}">"#
    );

    for (index, line) in lines.iter().enumerate() {
        if index == 0 {
            output.push_str(&format!(r#"<tspan x="384">{}</tspan>"#, escape_svg(line)));
        } else {
            output.push_str(&format!(
                r#"<tspan x="384" dy="{line_height:.1}">{}</tspan>"#,
                escape_svg(line)
            ));
        }
    }

    output.push_str("</text>");
    output
}

fn create_text_cover_svg(title: &str, creator: &str) -> String {
    let has_creator = !creator.is_empty();
    let max_width = 608.0;
    let mut title_size = 92.0;
    let mut creator_size = 54.0;
    let mut title_lines = wrap_svg_text(title, title_size, max_width);
    let mut creator_lines = if has_creator {
        wrap_svg_text(creator, creator_size, max_width)
    } else {
        Vec::new()
    };

    loop {
        let title_line_height = title_size * 1.18;
        let creator_line_height = creator_size * 1.2;
        let title_height = title_lines.len() as f32 * title_line_height;
        let creator_height = creator_lines.len() as f32 * creator_line_height;
        let gap = if has_creator { 58.0 } else { 0.0 };
        let total_height = title_height + gap + creator_height;

        if total_height <= 620.0 || title_size <= 40.0 {
            let title_y = 512.0 - total_height / 2.0 + title_size;
            let title_block =
                svg_text_block(&title_lines, title_y, title_size, title_line_height, 800);
            let creator_block = if has_creator {
                let creator_y = title_y
                    + title_line_height * (title_lines.len().saturating_sub(1) as f32)
                    + gap
                    + creator_size;
                svg_text_block(
                    &creator_lines,
                    creator_y,
                    creator_size,
                    creator_line_height,
                    700,
                )
            } else {
                String::new()
            };

            return format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 1024" data-flow-generated-cover="true">
  <rect width="768" height="1024" fill="#ead7b5"/>
  <g fill="#3d3122" font-family="Noto Serif CJK SC, Source Han Serif SC, STSong, SimSun, serif" dominant-baseline="alphabetic">
    {title_block}
    {creator_block}
  </g>
</svg>"##
            );
        }

        title_size -= 6.0;
        creator_size = (creator_size - 3.0).max(34.0);
        title_lines = wrap_svg_text(title, title_size, max_width);
        creator_lines = if has_creator {
            wrap_svg_text(creator, creator_size, max_width)
        } else {
            Vec::new()
        };
    }
}

fn create_text_cover_input(metadata: &Value, fallback_title: Option<&str>) -> Option<CoverInput> {
    let title = metadata
        .get("title")
        .and_then(Value::as_str)
        .map(clean_xml_text)
        .filter(|title| !title.is_empty())
        .or_else(|| fallback_title.map(clean_xml_text))
        .unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let creator = metadata
        .get("creator")
        .and_then(Value::as_str)
        .map(clean_xml_text)
        .unwrap_or_default();
    let svg = create_text_cover_svg(&title, &creator);

    Some(CoverInput {
        mime_type: "image/svg+xml".to_string(),
        extension: "svg".to_string(),
        data: svg.into_bytes(),
    })
}

fn text_import_encoding_options() -> Vec<TextImportEncodingOption> {
    [
        ("auto", "Auto"),
        ("utf-8", "UTF-8"),
        ("gb18030", "GB18030"),
        ("big5", "Big5"),
        ("shift_jis", "Shift_JIS"),
        ("euc-kr", "EUC-KR"),
        ("windows-1252", "Windows-1252"),
    ]
    .into_iter()
    .map(|(id, label)| TextImportEncodingOption {
        id: id.to_string(),
        label: label.to_string(),
    })
    .collect()
}

fn text_encoding_by_id(id: &str) -> Option<(&'static str, &'static str, &'static Encoding)> {
    match id {
        "utf-8" => Some(("utf-8", "UTF-8", UTF_8)),
        "gb18030" => Some(("gb18030", "GB18030", GB18030)),
        "big5" => Some(("big5", "Big5", BIG5)),
        "shift_jis" => Some(("shift_jis", "Shift_JIS", SHIFT_JIS)),
        "euc-kr" => Some(("euc-kr", "EUC-KR", EUC_KR)),
        "windows-1252" => Some(("windows-1252", "Windows-1252", WINDOWS_1252)),
        _ => None,
    }
}

fn decode_text_bytes(bytes: &[u8], encoding: Option<&str>) -> DecodedText {
    if let Some(encoding) = encoding.filter(|encoding| *encoding != "auto") {
        if let Some((id, label, encoding)) = text_encoding_by_id(encoding) {
            let (text, had_errors) = decode_with_encoding(bytes, encoding);
            return DecodedText {
                text,
                encoding: id.to_string(),
                encoding_label: label.to_string(),
                confidence: if had_errors {
                    TextEncodingConfidence::Medium
                } else {
                    TextEncodingConfidence::High
                },
            };
        }
    }

    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        let text = String::from_utf8_lossy(&bytes[3..]).to_string();
        return DecodedText {
            text,
            encoding: "utf-8".to_string(),
            encoding_label: "UTF-8".to_string(),
            confidence: TextEncodingConfidence::High,
        };
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (text, had_errors) = decode_with_encoding(&bytes[2..], UTF_16LE);
        return DecodedText {
            text,
            encoding: "utf-16le".to_string(),
            encoding_label: "UTF-16LE".to_string(),
            confidence: if had_errors {
                TextEncodingConfidence::Medium
            } else {
                TextEncodingConfidence::High
            },
        };
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (text, had_errors) = decode_with_encoding(&bytes[2..], UTF_16BE);
        return DecodedText {
            text,
            encoding: "utf-16be".to_string(),
            encoding_label: "UTF-16BE".to_string(),
            confidence: if had_errors {
                TextEncodingConfidence::Medium
            } else {
                TextEncodingConfidence::High
            },
        };
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return DecodedText {
            text: text.to_string(),
            encoding: "utf-8".to_string(),
            encoding_label: "UTF-8".to_string(),
            confidence: TextEncodingConfidence::High,
        };
    }

    let sample = sample_text_bytes(bytes);

    let mut best: Option<(&'static str, &'static str, &'static Encoding, i32, bool)> = None;
    for (id, label, encoding) in [
        ("gb18030", "GB18030", GB18030),
        ("big5", "Big5", BIG5),
        ("shift_jis", "Shift_JIS", SHIFT_JIS),
        ("euc-kr", "EUC-KR", EUC_KR),
        ("windows-1252", "Windows-1252", WINDOWS_1252),
    ] {
        let (text, had_errors) = decode_with_encoding(&sample, encoding);
        let score = score_decoded_text(&text, had_errors);
        if best
            .as_ref()
            .is_none_or(|(_, _, _, best_score, _)| score > *best_score)
        {
            best = Some((id, label, encoding, score, had_errors));
        }
    }

    let Some((id, label, encoding, score, had_errors)) = best else {
        return DecodedText {
            text: String::new(),
            encoding: "gb18030".to_string(),
            encoding_label: "GB18030".to_string(),
            confidence: TextEncodingConfidence::Failed,
        };
    };
    let (text, full_had_errors) = decode_with_encoding(bytes, encoding);
    DecodedText {
        text,
        encoding: id.to_string(),
        encoding_label: label.to_string(),
        confidence: if score < 10 {
            TextEncodingConfidence::Low
        } else if had_errors || full_had_errors {
            TextEncodingConfidence::Medium
        } else {
            TextEncodingConfidence::High
        },
    }
}

fn decode_with_encoding(bytes: &[u8], encoding: &'static Encoding) -> (String, bool) {
    let (text, had_errors) = encoding.decode_without_bom_handling(bytes);
    (text.into_owned(), had_errors)
}

fn sample_text_bytes(bytes: &[u8]) -> Vec<u8> {
    const SAMPLE_SIZE: usize = 64 * 1024;
    if bytes.len() <= SAMPLE_SIZE * 4 {
        return bytes.to_vec();
    }

    let mut sample = Vec::with_capacity(SAMPLE_SIZE * 3);
    sample.extend_from_slice(&bytes[..SAMPLE_SIZE]);

    let middle_start = bytes.len() / 2usize - SAMPLE_SIZE / 2usize;
    sample.extend_from_slice(&bytes[middle_start..middle_start + SAMPLE_SIZE]);
    sample.extend_from_slice(&bytes[bytes.len() - SAMPLE_SIZE..]);
    sample
}

fn score_decoded_text(text: &str, had_errors: bool) -> i32 {
    if text.is_empty() {
        return -1000;
    }

    let mut score = if had_errors { -80 } else { 0 };
    let mut readable = 0;
    let mut suspicious = 0;
    let mut cjk = 0;
    let mut kana = 0;
    let mut hangul = 0;
    let mut latin = 0;

    for ch in text.chars().take(20_000) {
        if ch == '\u{fffd}' {
            suspicious += 8;
            continue;
        }
        if ch.is_control() && !matches!(ch, '\r' | '\n' | '\t') {
            suspicious += 4;
            continue;
        }
        if matches!(ch, 'Ã' | 'Â' | '¤' | '€') {
            suspicious += 2;
        }
        if ch.is_whitespace() || ch.is_ascii_punctuation() {
            readable += 1;
            continue;
        }
        if contains_cjk_char(ch) {
            cjk += 1;
            readable += 3;
        } else if contains_kana_char(ch) {
            kana += 1;
            readable += 3;
        } else if contains_hangul_char(ch) {
            hangul += 1;
            readable += 3;
        } else if ch.is_alphanumeric() {
            latin += 1;
            readable += 2;
        } else {
            readable += 1;
        }
    }

    score += readable;
    score += (cjk + kana + hangul + latin).min(300);
    score -= suspicious * 20;
    score
}

fn contains_cjk_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xf900..=0xfaff
            | 0x20000..=0x2a6df
            | 0x2a700..=0x2b73f
            | 0x2b740..=0x2b81f
            | 0x2b820..=0x2ceaf
    )
}

fn contains_kana_char(ch: char) -> bool {
    matches!(ch as u32, 0x3040..=0x30ff | 0x31f0..=0x31ff)
}

fn contains_hangul_char(ch: char) -> bool {
    matches!(ch as u32, 0xac00..=0xd7af | 0x1100..=0x11ff)
}

#[derive(Debug, Clone, Copy)]
enum TextImportRuleRole {
    Group,
    Chapter,
}

struct TextImportRule {
    role: TextImportRuleRole,
    regex: Regex,
}

fn default_text_import_rules_input() -> TextImportRulesInput {
    TextImportRulesInput {
        group_patterns: vec![
            r"^\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[卷部集篇].*"
                .to_string(),
            r"^\s*(Book|Part|Volume)\s+[0-9IVXLCDM]+.*".to_string(),
        ],
        chapter_patterns: vec![
            r"^\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[章回节].*"
                .to_string(),
            r"^\s*(简介|序言|序|前言|自序|楔子|后记|尾声|番外|附录).*".to_string(),
            r"^\s*Chapter\s+[0-9IVXLCDM]+.*".to_string(),
        ],
    }
}

fn compile_text_import_rules(input: Option<&TextImportRulesInput>) -> Vec<TextImportRule> {
    let defaults;
    let input = match input {
        Some(input) => input,
        None => {
            defaults = default_text_import_rules_input();
            &defaults
        }
    };

    input
        .group_patterns
        .iter()
        .map(|pattern| (TextImportRuleRole::Group, pattern))
        .chain(
            input
                .chapter_patterns
                .iter()
                .map(|pattern| (TextImportRuleRole::Chapter, pattern)),
        )
        .filter_map(|(role, pattern)| {
            let pattern = pattern.trim();
            if pattern.is_empty() {
                return None;
            }

            Regex::new(pattern)
                .ok()
                .map(|regex| TextImportRule { role, regex })
        })
        .collect()
}

fn parse_text_import_document(
    text: &str,
    title: &str,
    rules_input: Option<&TextImportRulesInput>,
) -> TextImportDocument {
    const TARGET_SECTION_CHARS: usize = 12_000;
    const MAX_SECTION_CHARS: usize = 40_000;

    let rules = compile_text_import_rules(rules_input);
    let mut sections = Vec::new();
    let mut current_parent: Option<String> = None;
    let mut current_title: Option<String> = None;
    let mut paragraphs: Vec<String> = Vec::new();
    let mut found_heading = false;

    let flush_section = |sections: &mut Vec<TextImportSection>,
                         current_parent: &Option<String>,
                         current_title: &Option<String>,
                         paragraphs: &mut Vec<String>| {
        if paragraphs.is_empty() {
            return;
        }
        let title = current_title
            .clone()
            .or_else(|| current_parent.clone())
            .unwrap_or_else(|| title.to_string());
        sections.push(TextImportSection {
            title,
            parent: current_parent.clone(),
            paragraphs: std::mem::take(paragraphs),
            prefix_parent_title: false,
        });
    };

    for raw_line in text.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rule) = rules.iter().find(|rule| rule.regex.is_match(line)) {
            found_heading = true;
            flush_section(
                &mut sections,
                &current_parent,
                &current_title,
                &mut paragraphs,
            );
            match rule.role {
                TextImportRuleRole::Group => {
                    current_parent = Some(line.to_string());
                    current_title = None;
                }
                TextImportRuleRole::Chapter => {
                    current_title = Some(line.to_string());
                }
            }
            continue;
        }

        if current_title.is_none() {
            current_title = current_parent.clone().or_else(|| Some(title.to_string()));
        }
        paragraphs.push(line.to_string());
    }

    flush_section(
        &mut sections,
        &current_parent,
        &current_title,
        &mut paragraphs,
    );

    if !found_heading || sections.is_empty() {
        let paragraphs = text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut generated_sections = split_paragraphs_into_sections(
            title,
            None,
            paragraphs,
            TARGET_SECTION_CHARS,
            MAX_SECTION_CHARS,
        );
        if generated_sections.is_empty() {
            generated_sections.push(TextImportSection {
                title: title.to_string(),
                parent: None,
                paragraphs: Vec::new(),
                prefix_parent_title: false,
            });
        }
        let generated_chapters = text_sections_to_chapter_previews(&generated_sections);
        return TextImportDocument {
            title: title.to_string(),
            sections: generated_sections,
            chapters: generated_chapters,
        };
    }

    let mut sections = sections
        .into_iter()
        .flat_map(|section| {
            split_paragraphs_into_sections(
                &section.title,
                section.parent,
                section.paragraphs,
                TARGET_SECTION_CHARS,
                MAX_SECTION_CHARS,
            )
        })
        .collect::<Vec<_>>();

    mark_first_group_children(&mut sections);
    let chapters = text_sections_to_chapter_previews(&sections);

    TextImportDocument {
        title: title.to_string(),
        sections,
        chapters,
    }
}

fn mark_first_group_children(sections: &mut [TextImportSection]) {
    let mut seen = HashSet::new();

    for section in sections {
        if let Some(parent) = &section.parent {
            if seen.insert(parent.clone()) {
                section.prefix_parent_title = true;
            }
        }
    }
}

fn text_sections_to_chapter_previews(
    sections: &[TextImportSection],
) -> Vec<TextImportChapterPreview> {
    let mut chapters = Vec::new();
    let mut current_parent: Option<&str> = None;

    for section in sections {
        if section.parent.as_deref() != current_parent {
            current_parent = section.parent.as_deref();
            if let Some(parent) = current_parent {
                chapters.push(TextImportChapterPreview {
                    title: parent.to_string(),
                    level: 1,
                    role: "group".to_string(),
                });
            }
        }

        chapters.push(TextImportChapterPreview {
            title: section.title.clone(),
            level: if section.parent.is_some() { 2 } else { 1 },
            role: "chapter".to_string(),
        });
    }

    chapters
}

fn split_paragraphs_into_sections(
    title: &str,
    parent: Option<String>,
    paragraphs: Vec<String>,
    target_chars: usize,
    max_chars: usize,
) -> Vec<TextImportSection> {
    let total_chars = paragraphs.iter().map(|p| p.chars().count()).sum::<usize>();
    if total_chars <= max_chars {
        return vec![TextImportSection {
            title: title.to_string(),
            parent,
            paragraphs,
            prefix_parent_title: false,
        }];
    }

    let mut sections = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0usize;
    let mut index = 1usize;

    for paragraph in paragraphs {
        let paragraph_chars = paragraph.chars().count();
        if !current.is_empty() && current_chars + paragraph_chars > target_chars {
            sections.push(TextImportSection {
                title: split_section_title(title, index),
                parent: parent.clone(),
                paragraphs: std::mem::take(&mut current),
                prefix_parent_title: false,
            });
            index += 1;
            current_chars = 0;
        }
        current_chars += paragraph_chars;
        current.push(paragraph);
    }

    if !current.is_empty() {
        sections.push(TextImportSection {
            title: split_section_title(title, index),
            parent,
            paragraphs: current,
            prefix_parent_title: false,
        });
    }

    sections
}

fn split_section_title(title: &str, index: usize) -> String {
    if index <= 1 {
        title.to_string()
    } else {
        format!("{title}（{index}）")
    }
}

fn text_import_file_title(path: &Path, filename: &str) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| filename.trim_end_matches(".txt").to_string())
}

fn create_skipped_text_import_preview(path: &Path) -> TextImportPreview {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let title = text_import_file_title(path, &filename);

    TextImportPreview {
        path: path_to_client_string(path),
        filename,
        title,
        encoding: "auto".to_string(),
        encoding_label: "Auto".to_string(),
        confidence: "high".to_string(),
        status: TextImportStatus::Skipped.as_str().to_string(),
        selected: false,
        message: None,
        sample: String::new(),
        chapters: Vec::new(),
    }
}

fn should_skip_text_import_preview(storage: &AppStorage, path: &Path) -> Result<bool, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let hash = hash_file(path)?;
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;

    Ok(state.library.books.iter().any(|book| {
        book.name == name && !book.content_hash.is_empty() && book.content_hash == hash
    }))
}

fn create_text_import_preview(
    path: &Path,
    encoding: Option<&str>,
    rules: Option<&TextImportRulesInput>,
) -> TextImportPreview {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let title = text_import_file_title(path, &filename);

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return TextImportPreview {
                path: path_to_client_string(path),
                filename,
                title,
                encoding: "auto".to_string(),
                encoding_label: "Auto".to_string(),
                confidence: "failed".to_string(),
                status: TextImportStatus::Error.as_str().to_string(),
                selected: false,
                message: Some(error.to_string()),
                sample: String::new(),
                chapters: Vec::new(),
            };
        }
    };

    let decoded = decode_text_bytes(&bytes, encoding);
    let sample = decoded
        .text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    let document = parse_text_import_document(&decoded.text, &title, rules);
    let has_text = decoded.text.chars().any(|ch| !ch.is_whitespace());
    let status = if !has_text || decoded.confidence == TextEncodingConfidence::Failed {
        TextImportStatus::Error
    } else if decoded.confidence == TextEncodingConfidence::Low {
        TextImportStatus::NeedsReview
    } else {
        TextImportStatus::Ready
    };

    TextImportPreview {
        path: path_to_client_string(path),
        filename,
        title,
        encoding: decoded.encoding,
        encoding_label: decoded.encoding_label,
        confidence: match decoded.confidence {
            TextEncodingConfidence::High => "high",
            TextEncodingConfidence::Medium => "medium",
            TextEncodingConfidence::Low => "low",
            TextEncodingConfidence::Failed => "failed",
        }
        .to_string(),
        status: status.as_str().to_string(),
        selected: status == TextImportStatus::Ready,
        message: if status == TextImportStatus::Error {
            Some("Unable to decode text file".to_string())
        } else if document.chapters.is_empty() {
            Some("No chapters detected; sections will be generated by length".to_string())
        } else {
            None
        },
        sample,
        chapters: document.chapters,
    }
}

fn write_text_publication(
    storage: &AppStorage,
    id: &str,
    document: &TextImportDocument,
    encoding_label: &str,
) -> Result<(), String> {
    let unpacked_dir = storage.book_dir(id).join(UNPACKED_DIR);
    if unpacked_dir.exists() {
        fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
    }

    let meta_inf = unpacked_dir.join("META-INF");
    let oebps = unpacked_dir.join("OEBPS");
    let text_dir = oebps.join("Text");
    let styles_dir = oebps.join("Styles");
    fs::create_dir_all(&meta_inf).map_err(|error| error.to_string())?;
    fs::create_dir_all(&text_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&styles_dir).map_err(|error| error.to_string())?;

    fs::write(
        meta_inf.join("container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .map_err(|error| error.to_string())?;

    fs::write(styles_dir.join("txt.css"), text_import_css()).map_err(|error| error.to_string())?;

    for (index, section) in document.sections.iter().enumerate() {
        fs::write(
            text_dir.join(format!("part{:04}.xhtml", index + 1)),
            text_section_xhtml(section),
        )
        .map_err(|error| error.to_string())?;
    }

    fs::write(oebps.join("nav.xhtml"), text_nav_xhtml(document))
        .map_err(|error| error.to_string())?;
    fs::write(
        oebps.join("content.opf"),
        text_content_opf(document, encoding_label),
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

fn text_import_css() -> &'static str {
    r#"html, body {
  margin: 0;
  padding: 0;
}

.flow-txt-volume,
.flow-txt-chapter {
  text-align: center;
  text-indent: 0;
  font-weight: 700;
  line-height: 1.5;
}

.flow-txt-volume {
  font-size: 1.45em;
  margin: 2.2em 0 1.6em;
}

.flow-txt-chapter {
  font-size: 1.25em;
  margin: 2em 0 1.4em;
}

.flow-txt-body,
.flow-txt-body p {
  text-align: justify;
  text-indent: 2em;
}

.flow-txt-body p {
  margin: 0 0 0.75em;
}
"#
}

fn text_section_xhtml(section: &TextImportSection) -> String {
    let mut body = String::new();
    let heading = if section.prefix_parent_title {
        section
            .parent
            .as_ref()
            .map(|parent| format!("{parent} {}", section.title))
            .unwrap_or_else(|| section.title.clone())
    } else {
        section.title.clone()
    };
    body.push_str(&format!(
        r#"<h2 class="flow-txt-chapter">{}</h2>"#,
        escape_xml(&heading)
    ));

    if !section.paragraphs.is_empty() {
        body.push_str(r#"<div class="flow-txt-body" data-flow-body-text="true">"#);
        for paragraph in &section.paragraphs {
            body.push_str(&format!(r#"<p>{}</p>"#, escape_xml(paragraph)));
        }
        body.push_str("</div>");
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head>
  <title>{}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/txt.css"/>
</head>
<body>
{}
</body>
</html>"#,
        escape_xml(&heading),
        body
    )
}

fn text_nav_xhtml(document: &TextImportDocument) -> String {
    let mut nav = String::new();
    let mut open_group: Option<String> = None;
    let mut group_index = 0usize;

    for (index, section) in document.sections.iter().enumerate() {
        if section.parent != open_group {
            if open_group.is_some() {
                nav.push_str("</ol></li>");
            }
            open_group = section.parent.clone();
            if let Some(parent) = &open_group {
                group_index += 1;
                nav.push_str(&format!(
                    r#"<li id="txt-group-{group_index:04}"><span>{}</span><ol>"#,
                    escape_xml(parent)
                ));
            }
        }

        nav.push_str(&format!(
            r#"<li><a href="Text/part{:04}.xhtml">{}</a></li>"#,
            index + 1,
            escape_xml(&section.title)
        ));
    }

    if open_group.is_some() {
        nav.push_str("</ol></li>");
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head>
  <title>{}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>{}</h1>
    <ol>{}</ol>
  </nav>
</body>
</html>"#,
        escape_xml(&document.title),
        escape_xml(&document.title),
        nav
    )
}

fn text_content_opf(document: &TextImportDocument, encoding_label: &str) -> String {
    let manifest_items = document
        .sections
        .iter()
        .enumerate()
        .map(|(index, _)| {
            format!(
                r#"<item id="part{0:04}" href="Text/part{0:04}.xhtml" media-type="application/xhtml+xml"/>"#,
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");
    let spine_items = document
        .sections
        .iter()
        .enumerate()
        .map(|(index, _)| format!(r#"<itemref idref="part{:04}"/>"#, index + 1))
        .collect::<Vec<_>>()
        .join("\n    ");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">{}</dc:identifier>
    <dc:title>{}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="source-format">txt</meta>
    <meta property="source-encoding">{}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="Styles/txt.css" media-type="text/css"/>
    {}
  </manifest>
  <spine>
    {}
  </spine>
</package>"#,
        escape_xml(&document.title),
        escape_xml(&document.title),
        escape_xml(encoding_label),
        manifest_items,
        spine_items
    )
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_svg(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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

fn import_epub_path_impl(
    storage: &AppStorage,
    path: &Path,
    replace_existing: bool,
) -> Result<BookRecord, String> {
    fs::create_dir_all(books_root(storage.root())).map_err(|error| error.to_string())?;

    let hash = hash_file(path)?;
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.epub".to_string());

    let (mut book, id, should_copy) = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let filename_index = state
            .library
            .books
            .iter()
            .position(|book| book.name == name);
        let hash_index = state
            .library
            .books
            .iter()
            .position(|book| !book.content_hash.is_empty() && book.content_hash == hash);

        let (index, should_copy) = if let Some(index) = filename_index {
            if !replace_existing || state.library.books[index].content_hash == hash {
                let book = state.library.books[index].clone();
                return storage.compose_book(&mut state, &book);
            }

            let book = &mut state.library.books[index];
            book.size = size;
            book.content_hash = hash;
            book.content_version = book.content_version.saturating_add(1).max(1);
            book.updated_at = Some(now_ms());
            book.last_read_at = book.updated_at;
            (index, true)
        } else if let Some(index) = hash_index {
            let book = &mut state.library.books[index];
            book.name = name;
            book.size = size;
            book.updated_at = Some(now_ms());
            (index, false)
        } else {
            let created_at = now_ms();
            let id = id_from_hash(&hash);
            state.library.books.push(LibraryBook {
                id,
                name,
                size,
                reading_status: None,
                content_hash: hash,
                content_version: 1,
                metadata: empty_object(),
                created_at,
                updated_at: None,
                last_read_at: None,
                cfi: None,
                percentage: None,
            });
            (state.library.books.len() - 1, true)
        };

        let book = state.library.books[index].clone();
        let id = book.id.clone();
        (book, id, should_copy)
    };

    if should_copy {
        let dir = storage.book_dir(&id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        fs::copy(path, dir.join(BOOK_FILE)).map_err(|error| error.to_string())?;
        unpack_epub(path, &dir.join(UNPACKED_DIR))?;
        let parsed = parse_epub_info(path);
        if parsed.metadata != json!({}) {
            book.metadata = parsed.metadata;
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            if let Some(stored_book) = state.library.books.iter_mut().find(|book| book.id == id) {
                stored_book.metadata = book.metadata.clone();
            }
        }
        write_metadata(storage, &id, &book.metadata)?;
        write_cover(storage, &id, parsed.cover)?;
    }

    storage.mark_library_dirty();
    storage.flush_dirty()?;

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    storage.compose_book(&mut state, &book)
}

fn import_text_path_impl(
    storage: &AppStorage,
    path: &Path,
    encoding: Option<&str>,
    replace_existing: bool,
    rules: Option<&TextImportRulesInput>,
) -> Result<BookRecord, String> {
    fs::create_dir_all(books_root(storage.root())).map_err(|error| error.to_string())?;

    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let decoded = decode_text_bytes(&bytes, encoding);
    if decoded.confidence == TextEncodingConfidence::Failed {
        return Err("Unable to decode text file".to_string());
    }

    let hash = hash_file(path)?;
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let title = path
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| name.trim_end_matches(".txt").to_string());

    let document = parse_text_import_document(&decoded.text, &title, rules);
    let metadata = json!({
        "title": title,
        "sourceFormat": "txt",
        "sourceEncoding": decoded.encoding_label,
    });

    let (mut book, id, should_copy) = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let filename_index = state
            .library
            .books
            .iter()
            .position(|book| book.name == name);
        let hash_index = state
            .library
            .books
            .iter()
            .position(|book| !book.content_hash.is_empty() && book.content_hash == hash);

        let (index, should_copy) = if let Some(index) = filename_index {
            if !replace_existing || state.library.books[index].content_hash == hash {
                let book = state.library.books[index].clone();
                return storage.compose_book(&mut state, &book);
            }

            let book = &mut state.library.books[index];
            book.size = size;
            book.content_hash = hash;
            book.content_version = book.content_version.saturating_add(1).max(1);
            book.updated_at = Some(now_ms());
            book.last_read_at = book.updated_at;
            book.metadata = metadata.clone();
            (index, true)
        } else if let Some(index) = hash_index {
            let book = &mut state.library.books[index];
            book.name = name;
            book.size = size;
            book.updated_at = Some(now_ms());
            book.metadata = metadata.clone();
            (index, false)
        } else {
            let created_at = now_ms();
            let id = id_from_hash(&hash);
            state.library.books.push(LibraryBook {
                id,
                name,
                size,
                reading_status: None,
                content_hash: hash,
                content_version: 1,
                metadata: metadata.clone(),
                created_at,
                updated_at: None,
                last_read_at: None,
                cfi: None,
                percentage: None,
            });
            (state.library.books.len() - 1, true)
        };

        let book = state.library.books[index].clone();
        let id = book.id.clone();
        (book, id, should_copy)
    };

    if should_copy {
        let dir = storage.book_dir(&id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        if dir.join(BOOK_FILE).exists() {
            let _ = fs::remove_file(dir.join(BOOK_FILE));
        }
        fs::copy(path, dir.join(SOURCE_TEXT_FILE)).map_err(|error| error.to_string())?;
        write_text_publication(storage, &id, &document, &decoded.encoding_label)?;
        book.metadata = metadata;
        {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            if let Some(stored_book) = state.library.books.iter_mut().find(|book| book.id == id) {
                stored_book.metadata = book.metadata.clone();
            }
        }
        write_metadata(storage, &id, &book.metadata)?;
        write_cover(
            storage,
            &id,
            create_text_cover_input(
                &book.metadata,
                path.file_stem().and_then(|name| name.to_str()),
            ),
        )?;
    }

    storage.mark_library_dirty();
    storage.flush_dirty()?;

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    storage.compose_book(&mut state, &book)
}

#[tauri::command]
pub fn list_books(storage: State<'_, AppStorage>) -> Result<Vec<BookRecord>, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(state
        .library
        .books
        .iter()
        .map(|book| storage.compose_book_summary(book))
        .collect())
}

#[tauri::command]
pub fn get_book(storage: State<'_, AppStorage>, id: String) -> Result<Option<BookRecord>, String> {
    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    let book = state
        .library
        .books
        .iter()
        .find(|book| book.id == id)
        .cloned();

    book.map(|book| storage.compose_book(&mut state, &book))
        .transpose()
}

#[tauri::command]
pub fn list_covers(storage: State<'_, AppStorage>) -> Result<Vec<CoverRecord>, String> {
    let ids = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state
            .library
            .books
            .iter()
            .map(|book| book.id.clone())
            .collect::<Vec<_>>()
    };

    ids.into_iter()
        .map(|id| {
            Ok(CoverRecord {
                cover: read_cover(&storage, &id)?,
                id,
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_cover(
    storage: State<'_, AppStorage>,
    id: String,
) -> Result<Option<CoverRecord>, String> {
    Ok(Some(CoverRecord {
        id: id.clone(),
        cover: read_cover(&storage, &id)?,
    }))
}

#[tauri::command]
pub fn update_cover(
    storage: State<'_, AppStorage>,
    id: String,
    cover: Option<CoverInput>,
) -> Result<(), String> {
    write_cover(&storage, &id, cover)
}

#[tauri::command]
pub fn import_epub_paths(
    storage: State<'_, AppStorage>,
    paths: Vec<String>,
    replace_existing: bool,
) -> Result<Vec<BookRecord>, String> {
    let mut books = Vec::new();

    for path in paths {
        let path = PathBuf::from(path);
        if !is_epub_file(&path) {
            continue;
        }

        books.push(import_epub_path_impl(&storage, &path, replace_existing)?);
    }

    Ok(books)
}

#[tauri::command]
pub fn get_text_import_encodings() -> Vec<TextImportEncodingOption> {
    text_import_encoding_options()
}

#[tauri::command]
pub fn preview_text_import_paths(
    storage: State<'_, AppStorage>,
    paths: Vec<String>,
    encodings: HashMap<String, String>,
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<TextImportPreview>, String> {
    let rules = rules.as_ref();
    Ok(paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| is_txt_file(path))
        .map(|path| {
            let key = path_to_client_string(&path);
            if should_skip_text_import_preview(&storage, &path).unwrap_or(false) {
                return create_skipped_text_import_preview(&path);
            }

            create_text_import_preview(&path, encodings.get(&key).map(String::as_str), rules)
        })
        .collect())
}

#[tauri::command]
pub fn import_text_paths(
    storage: State<'_, AppStorage>,
    imports: Vec<TextImportSelection>,
    replace_existing: bool,
    rules: Option<TextImportRulesInput>,
) -> Result<Vec<BookRecord>, String> {
    let mut books = Vec::new();
    let rules = rules.as_ref();

    for import in imports {
        let path = PathBuf::from(&import.path);
        if !is_txt_file(&path) {
            continue;
        }

        books.push(import_text_path_impl(
            &storage,
            &path,
            import.encoding.as_deref(),
            replace_existing,
            rules,
        )?);
    }

    Ok(books)
}

#[tauri::command]
pub fn get_book_package_path(storage: State<'_, AppStorage>, id: String) -> Result<String, String> {
    let dir = storage.book_dir(&id);
    let unpacked_dir = dir.join(UNPACKED_DIR);

    if let Ok(opf_path) = find_unpacked_opf_path(&unpacked_dir) {
        return Ok(path_to_client_string(&opf_path));
    }

    let book_path = dir.join(BOOK_FILE);
    if book_path.exists() {
        unpack_epub(&dir.join(BOOK_FILE), &unpacked_dir)?;
        return Ok(path_to_client_string(&find_unpacked_opf_path(
            &unpacked_dir,
        )?));
    }

    Err("Book package is unavailable".to_string())
}

#[tauri::command]
pub fn update_book(
    storage: State<'_, AppStorage>,
    id: String,
    changes: Value,
) -> Result<Option<BookRecord>, String> {
    let mut library_changed = false;
    let mut state_changed = false;
    let mut immediate_flush = false;
    let mut reading_position_only = false;
    let book = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book_index) = state.library.books.iter().position(|book| book.id == id) else {
            return Ok(None);
        };
        let mut book = state.library.books[book_index].clone();

        if let Some(object) = changes.as_object() {
            let updates_reading_position =
                object.contains_key("cfi") || object.contains_key("percentage");
            let explicit_state_update = object.contains_key("definitions")
                || object.contains_key("annotations")
                || object.contains_key("configuration");
            reading_position_only = updates_reading_position
                && !explicit_state_update
                && object
                    .keys()
                    .all(|key| matches!(key.as_str(), "cfi" | "percentage" | "updatedAt"));

            if let Some(value) = object.get("name").and_then(Value::as_str) {
                book.name = value.to_string();
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("size").and_then(Value::as_u64) {
                book.size = value;
                library_changed = true;
                immediate_flush = true;
            }
            if object.contains_key("readingStatus") {
                book.reading_status = object
                    .get("readingStatus")
                    .and_then(|value| serde_json::from_value(value.clone()).ok());
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("metadata") {
                book.metadata = value.clone();
                write_metadata(&storage, &id, value)?;
                if is_generated_text_cover(&storage, &id)? {
                    write_cover(
                        &storage,
                        &id,
                        create_text_cover_input(
                            value,
                            Path::new(&book.name)
                                .file_stem()
                                .and_then(|name| name.to_str()),
                        ),
                    )?;
                }
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("createdAt").and_then(Value::as_u64) {
                book.created_at = value;
                library_changed = true;
                immediate_flush = true;
            }
            if let Some(value) = object.get("updatedAt").and_then(Value::as_u64) {
                book.updated_at = Some(value);
                if updates_reading_position {
                    book.last_read_at = Some(value);
                }
                library_changed = true;
            }
            if let Some(value) = object.get("lastReadAt").and_then(Value::as_u64) {
                book.last_read_at = Some(value);
                library_changed = true;
            }

            {
                let book_state = storage.ensure_book_state(&mut state, &id)?;
                if let Some(value) = object.get("cfi") {
                    let cfi = value.as_str().map(str::to_string);
                    book_state.cfi = cfi.clone();
                    book.cfi = cfi;
                    library_changed = true;
                    state_changed = true;
                }
                if let Some(value) = object.get("percentage") {
                    let percentage = value.as_f64();
                    book_state.percentage = percentage;
                    book.percentage = percentage;
                    library_changed = true;
                    state_changed = true;
                }
                if let Some(value) = object.get("definitions") {
                    book_state.definitions =
                        serde_json::from_value(value.clone()).unwrap_or_default();
                    state_changed = true;
                    immediate_flush = true;
                }
                if let Some(value) = object.get("annotations") {
                    book_state.annotations =
                        serde_json::from_value(value.clone()).unwrap_or_default();
                    state_changed = true;
                    immediate_flush = true;
                }
                if let Some(value) = object.get("configuration") {
                    book_state.configuration = Some(value.clone());
                    state_changed = true;
                    immediate_flush = true;
                }
            }
        }

        state.library.books[book_index] = book.clone();
        book
    };

    if library_changed {
        storage.mark_library_dirty();
    }
    if state_changed {
        storage.mark_book_state_dirty(&id);
    }

    if immediate_flush {
        storage.flush_dirty()?;
    } else if reading_position_only {
        storage.schedule_reading_position_flush();
    }

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    storage.compose_book(&mut state, &book).map(Some)
}

#[tauri::command]
pub fn delete_books(storage: State<'_, AppStorage>, ids: Vec<String>) -> Result<(), String> {
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

    for id in ids {
        let _ = fs::remove_dir_all(storage.book_dir(&id));
    }

    storage.mark_library_dirty();
    storage.flush_dirty()
}

#[tauri::command]
pub fn get_settings(storage: State<'_, AppStorage>) -> Result<Value, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(state.settings.clone())
}

#[tauri::command]
pub fn update_settings(storage: State<'_, AppStorage>, settings: Value) -> Result<(), String> {
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.settings = settings;
    }

    storage.mark_settings_dirty();
    storage.flush_dirty()
}

pub fn is_epub_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
}

pub fn is_txt_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
}

pub fn flush_app_storage(window: &Window) {
    if let Some(storage) = window.try_state::<AppStorage>() {
        if let Err(error) = storage.flush_dirty() {
            eprintln!("Failed to flush app storage: {error}");
        }
    }
}

#[tauri::command]
pub fn flush_storage(storage: State<'_, AppStorage>) -> Result<(), String> {
    storage.flush_dirty()
}

pub fn restore_window_state(window: &WebviewWindow) {
    let app = window.app_handle();
    let Ok(path) = window_state_path(app) else {
        let _ = window.show();
        return;
    };
    let Ok(state) = read_json_or_default::<Option<WindowState>>(&path) else {
        let _ = window.show();
        return;
    };

    if let Some(state) = state {
        if !is_restorable_window_state(&state) {
            let _ = window.show();
            return;
        }

        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));

        if state.fullscreen {
            let _ = window.set_fullscreen(true);
        } else if state.maximized {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
}

pub fn save_window_state(window: &Window) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }

    let app = window.app_handle();
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);

    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
        fullscreen,
    };

    if !is_restorable_window_state(&state) {
        return;
    }

    if let Ok(path) = window_state_path(app) {
        let _ = write_json(&path, &state);
    }
}

fn is_restorable_window_state(state: &WindowState) -> bool {
    state.x > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.y > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.width >= MIN_RESTORED_WINDOW_WIDTH
        && state.height >= MIN_RESTORED_WINDOW_HEIGHT
}

#[cfg(test)]
mod tests {
    use super::{
        decode_text_bytes, normalize_publication_date, parse_text_import_document,
        text_content_opf, text_nav_xhtml, text_section_xhtml, TextImportRulesInput,
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
}
