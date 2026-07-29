use super::*;

pub(super) fn is_external_book_id(id: &str) -> bool {
    id.starts_with("ext-") && is_valid_book_storage_id(id)
}

pub(super) fn is_valid_book_storage_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Library {
    #[serde(default = "library_version")]
    pub(super) version: u32,
    #[serde(default)]
    pub(super) books: Vec<LibraryBook>,
    #[serde(default)]
    pub(super) tags: Vec<LibraryTagRecord>,
}

fn library_version() -> u32 {
    1
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExternalBookIndex {
    #[serde(default = "external_book_index_version")]
    pub(super) version: u32,
    #[serde(default)]
    pub(super) books: Vec<ExternalBook>,
}

fn external_book_index_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExternalBook {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) size: u64,
    pub(super) content_hash: String,
    #[serde(default)]
    pub(super) content_version: u32,
    #[serde(default, skip_serializing_if = "BookContentMode::is_normal")]
    pub(super) content_mode: BookContentMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) content_flags: Vec<BookContentFlag>,
    #[serde(default, skip_serializing_if = "SourceStorage::is_managed")]
    pub(super) source_storage: SourceStorage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_path: Option<PathBuf>,
    pub(super) created_at: u64,
    pub(super) last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibraryBook {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reading_status: Option<ReadingStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source_format: Option<BookSourceFormat>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(super) exported_versions: HashMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content_edited_at: Option<u64>,
    #[serde(default)]
    pub(super) content_hash: String,
    #[serde(default)]
    pub(super) content_version: u32,
    #[serde(default, skip_serializing_if = "BookContentMode::is_normal")]
    pub(super) content_mode: BookContentMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) content_flags: Vec<BookContentFlag>,
    #[serde(default, skip_serializing_if = "SourceStorage::is_managed")]
    pub(super) source_storage: SourceStorage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_path: Option<PathBuf>,
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
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(super) exported_versions: HashMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content_edited_at: Option<u64>,
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
    #[serde(default)]
    pub(super) content_hash: String,
    #[serde(default)]
    pub(super) content_version: u32,
    #[serde(default, skip_serializing_if = "BookContentMode::is_normal")]
    pub(super) content_mode: BookContentMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) content_flags: Vec<BookContentFlag>,
    #[serde(default, skip_serializing_if = "SourceStorage::is_managed")]
    pub(super) source_storage: SourceStorage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source_path: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ReadingStatus {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BookSourceStatus {
    Available,
    Changed,
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
#[serde(rename_all = "camelCase")]
pub(super) enum SourceStorage {
    #[default]
    Managed,
    Referenced,
}

impl SourceStorage {
    pub(super) fn is_managed(value: &Self) -> bool {
        *value == Self::Managed
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BookContentMode {
    #[default]
    Normal,
    ArchiveOnly,
}

impl BookContentMode {
    pub(super) fn is_normal(value: &Self) -> bool {
        *value == Self::Normal
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BookContentFlag {
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
    pub(super) fn as_str(self) -> &'static str {
        match self {
            BookExportFormat::Epub => "epub",
            BookExportFormat::Txt => "txt",
        }
    }
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
    pub(super) book: Option<BookRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BookReaderSourceMode {
    Opf,
    Epub,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BookState {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowState {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: u32,
    pub(super) height: u32,
    #[serde(default)]
    pub(super) maximized: bool,
}
