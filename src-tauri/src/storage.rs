use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

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
const UNPACKED_DIR: &str = "unpacked";
const COVER_STEM: &str = "cover";
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
    let creator_node = if creator.is_empty() {
        String::new()
    } else {
        format!(
            r#"<text x="384" y="594" text-anchor="middle" font-size="72" font-weight="700">{}</text>"#,
            escape_svg(&creator)
        )
    };
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 1024">
  <rect width="768" height="1024" fill="#ead7b5"/>
  <g fill="#3d3122" font-family="Noto Serif CJK SC, Source Han Serif SC, STSong, SimSun, serif" dominant-baseline="alphabetic">
    <text x="384" y="512" text-anchor="middle" font-size="104" font-weight="800">{}</text>
    {}
  </g>
</svg>"##,
        escape_svg(&title),
        creator_node
    );

    Some(CoverInput {
        mime_type: "image/svg+xml".to_string(),
        extension: "svg".to_string(),
        data: svg.into_bytes(),
    })
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
pub fn get_book_package_path(storage: State<'_, AppStorage>, id: String) -> Result<String, String> {
    let dir = storage.book_dir(&id);
    let unpacked_dir = dir.join(UNPACKED_DIR);

    if find_unpacked_opf_path(&unpacked_dir).is_err() {
        unpack_epub(&dir.join(BOOK_FILE), &unpacked_dir)?;
    }

    Ok(path_to_client_string(&find_unpacked_opf_path(
        &unpacked_dir,
    )?))
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
            if let Some(value) = object.get("metadata") {
                book.metadata = value.clone();
                write_metadata(&storage, &id, value)?;
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
