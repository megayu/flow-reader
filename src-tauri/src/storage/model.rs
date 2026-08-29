use super::*;

pub(super) const LIBRARY_VERSION: u32 = 1;
pub(super) const BOOK_STATE_VERSION: u32 = 1;

pub(super) fn is_valid_book_storage_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Library {
    pub(super) version: u32,
    #[serde(default)]
    pub(super) books: Vec<StoredBook>,
    #[serde(default)]
    pub(super) tags: Vec<LibraryTagRecord>,
    #[serde(default)]
    pub(super) pins: LibraryPins,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) recent_book_ids: Vec<String>,
}

impl Default for Library {
    fn default() -> Self {
        Self {
            version: LIBRARY_VERSION,
            books: Vec::new(),
            tags: Vec::new(),
            pins: LibraryPins::default(),
            recent_book_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryPins {
    pub(super) authors: Vec<String>,
    pub(super) tag_ids: Vec<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredBook {
    pub(super) id: String,
    pub(super) scope: BookScope,
    pub(super) name: String,
    pub(super) size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reading_status: Option<ReadingStatus>,
    #[serde(default)]
    pub(super) source_format: BookSourceFormat,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(super) generated_cover: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content_edited_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) word_count: Option<u64>,
    pub(super) source_hash: String,
    /// Monotonic event number for the last accepted source file.
    pub(super) source_revision: u32,
    /// Monotonic event number for the last App edit to unpacked content.
    pub(super) revision: u32,
    /// Content event number captured by the last successful export.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) latest_export_revision: Option<u32>,
    /// Hash captured for export comparison: the EPUB output, or managed TXT's internal `book.txt` snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) latest_export_hash: Option<String>,
    #[serde(default, rename = "archive", skip_serializing_if = "BookContentMode::is_normal")]
    pub(super) content_mode: BookContentMode,
    pub(super) editable: bool,
    #[serde(default, rename = "managed", skip_serializing_if = "SourceStorage::is_referenced")]
    pub(super) source_storage: SourceStorage,
    pub(super) source_path: PathBuf,
    #[serde(default = "empty_object")]
    pub(super) metadata: Value,
    pub(super) created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_read_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cfi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) percentage: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRecord {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) size: u64,
    pub(super) scope: BookScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reading_status: Option<ReadingStatus>,
    pub(super) source_format: BookSourceFormat,
    #[serde(default)]
    pub(super) generated_cover: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content_edited_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) word_count: Option<u64>,
    #[serde(default = "empty_object")]
    pub(super) metadata: Value,
    pub(super) created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_read_at: Option<u64>,
    #[serde(default)]
    pub(super) definitions: Vec<String>,
    #[serde(default)]
    pub(super) annotations: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cfi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) percentage: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) tag_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) configuration: Option<Value>,
    pub(super) source_hash: String,
    pub(super) source_revision: u32,
    pub(super) revision: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) latest_export_revision: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) latest_export_hash: Option<String>,
    #[serde(default, rename = "archive", skip_serializing_if = "BookContentMode::is_normal")]
    pub(super) content_mode: BookContentMode,
    pub(super) editable: bool,
    #[serde(default, rename = "managed", skip_serializing_if = "SourceStorage::is_referenced")]
    pub(super) source_storage: SourceStorage,
    pub(super) source_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum BookScope {
    Library,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTagRecord {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverRecord {
    pub(super) id: String,
    pub(super) cover: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverInput {
    #[serde(default)]
    pub(super) mime_type: String,
    pub(super) extension: String,
    pub(super) data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReadingStatus {
    ToRead,
    Reading,
    Read,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookSourceFormat {
    #[default]
    Epub,
    Txt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BookSourceStatus {
    Available,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceStatusRecord {
    pub(super) id: String,
    pub(super) status: BookSourceStatus,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "bool", into = "bool")]
pub(super) enum SourceStorage {
    Managed,
    #[default]
    Referenced,
}

impl From<bool> for SourceStorage {
    fn from(managed: bool) -> Self {
        if managed { Self::Managed } else { Self::Referenced }
    }
}

impl From<SourceStorage> for bool {
    fn from(value: SourceStorage) -> Self {
        value == SourceStorage::Managed
    }
}

impl SourceStorage {
    pub(super) fn is_referenced(value: &Self) -> bool {
        *value == Self::Referenced
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "bool", into = "bool")]
pub(super) enum BookContentMode {
    #[default]
    Normal,
    ArchiveOnly,
}

impl From<bool> for BookContentMode {
    fn from(archive: bool) -> Self {
        if archive { Self::ArchiveOnly } else { Self::Normal }
    }
}

impl From<BookContentMode> for bool {
    fn from(value: BookContentMode) -> Self {
        value == BookContentMode::ArchiveOnly
    }
}

impl BookContentMode {
    pub(super) fn is_normal(value: &Self) -> bool {
        *value == Self::Normal
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookExportFormat {
    Epub,
    Txt,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BookModeSwitchResolution {
    Overwrite,
    Adopt,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BookModeSwitchConflict {
    Changed,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookModeSwitchResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) book: Option<BookRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) conflict: Option<BookModeSwitchConflict>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTextReplaceTarget {
    pub(super) section_href: String,
    pub(super) text_node_index: usize,
    pub(super) text_node_text: String,
    pub(super) start_offset: usize,
    pub(super) end_offset: usize,
    #[serde(default)]
    pub(super) paragraph_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTextReplaceResult {
    pub(super) book: BookRecord,
    pub(super) section_href: String,
    pub(super) changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookReaderSource {
    pub(super) mode: BookReaderSourceMode,
    pub(super) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) updated_book: Option<BookRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reading_metrics: Option<ReadingMetrics>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMetrics {
    pub(super) version: u32,
    pub(super) total_length: u64,
    pub(super) sections: Vec<ReadingMetricsSection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMetricsSection {
    pub(super) href: String,
    pub(super) start: u64,
    pub(super) end: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BookReaderSourceMode {
    Opf,
    Epub,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BookState {
    pub(super) version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cfi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) percentage: Option<f64>,
    #[serde(default)]
    pub(super) definitions: Vec<String>,
    #[serde(default)]
    pub(super) annotations: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) configuration: Option<Value>,
}

impl Default for BookState {
    fn default() -> Self {
        Self {
            version: BOOK_STATE_VERSION,
            cfi: None,
            percentage: None,
            definitions: Vec::new(),
            annotations: Vec::new(),
            configuration: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowState {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) maximized: bool,
    pub(super) maximized_x: i32,
    pub(super) maximized_y: i32,
    pub(super) reader_sidebar_open: bool,
    pub(super) reader_sidebar_width: u32,
    pub(super) library_sidebar_open: bool,
    pub(super) library_sidebar_width: u32,
    pub(super) panes: HashMap<String, WindowPaneState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowPaneState {
    pub(super) expanded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) size: Option<f64>,
}
