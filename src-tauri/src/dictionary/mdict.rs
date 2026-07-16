use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use mdict_rs::{MddFile, MdxFile};
use serde::Serialize;

const MAX_HEADER_BYTES: u64 = 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 2 * 1024 * 1024;
const MAX_STYLESHEET_BYTES: usize = 512 * 1024;
const MAX_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SESSION_RESOURCE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdictError {
    pub code: String,
    pub message: String,
}

impl MdictError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for MdictError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for MdictError {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdictEntry {
    pub headword: String,
    pub html: String,
}

#[derive(Debug, Clone)]
pub struct MdictMetadata {
    pub language: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdictLookupResponse {
    pub diagnostics: MdictDiagnostics,
    pub entry: Option<MdictEntry>,
    pub resource_url_prefix: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdictTextResource {
    pub key: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct MdictBinaryResource {
    pub data: Vec<u8>,
    pub key: String,
    pub mime_type: &'static str,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdictDiagnostics {
    pub loaded_resource_keys: Vec<String>,
    pub record_bytes: u64,
    pub resource_bytes: u64,
}

#[derive(Debug, Default)]
struct MutableDiagnostics {
    loaded_resource_keys: BTreeSet<String>,
    record_bytes: u64,
    resource_bytes: u64,
}

#[derive(Debug)]
pub struct MdictReader {
    diagnostics: Mutex<MutableDiagnostics>,
    mdd: Option<MddFile>,
    mdx: MdxFile,
    root: PathBuf,
}

pub fn resource_url_prefix(session_id: u64, dictionary_id: &str) -> String {
    #[cfg(any(windows, target_os = "android"))]
    let origin = "http://dictionary.localhost";
    #[cfg(not(any(windows, target_os = "android")))]
    let origin = "dictionary://localhost";
    format!("{origin}/{session_id}/{dictionary_id}/")
}

pub fn inspect_metadata(master: &Path) -> Result<MdictMetadata, MdictError> {
    preflight_header(master)?;
    let source = mdict_rs::source::FileSource::open(master).map_err(map_parser_error)?;
    let header = mdict_rs::header::parse_header(&source, mdict_rs::ContainerKind::Mdx)
        .map_err(map_parser_error)?
        .header;
    reject_encrypted(header.encrypted)?;
    let title = header.title.filter(|title| {
        let title = title.trim();
        !title.is_empty() && !title.eq_ignore_ascii_case("Title (No HTML code allowed)")
    });
    let language = ["SourceLanguage", "Lang", "Language"]
        .into_iter()
        .find_map(|key| header.attributes.get(key))
        .and_then(|value| infer_language(value));
    Ok(MdictMetadata { language, title })
}

pub fn inspect_resources(path: &Path) -> Result<(), MdictError> {
    preflight_header(path)?;
    let source = mdict_rs::source::FileSource::open(path).map_err(map_parser_error)?;
    let header = mdict_rs::header::parse_header(&source, mdict_rs::ContainerKind::Mdd)
        .map_err(map_parser_error)?
        .header;
    reject_encrypted(header.encrypted)
}

pub fn resource_protocol_response<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;

    let result = (|| {
        let mut parts = request.uri().path().trim_start_matches('/').splitn(3, '/');
        let session_id = parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(invalid_resource_key)?;
        let dictionary_id = percent_decode(parts.next().unwrap_or_default())?;
        let key = parts.next().ok_or_else(invalid_resource_key)?;
        if dictionary_id.is_empty() || key.is_empty() {
            return Err(invalid_resource_key());
        }
        app.state::<super::session::DictionarySessionManager>()
            .load_mdict_resource(session_id, &dictionary_id, key)?
            .ok_or_else(|| {
                MdictError::new(
                    "mdictResourceMissing",
                    "The requested MDict resource is unavailable.",
                )
            })
    })();

    match result {
        Ok(resource) => tauri::http::Response::builder()
            .status(200)
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .header("Content-Type", resource.mime_type)
            .header("X-Content-Type-Options", "nosniff")
            .body(resource.data)
            .unwrap(),
        Err(error) => {
            let status = match error.code.as_str() {
                "invalidResourceKey" | "unsupportedMdictResource" => 400,
                "mdictSessionReleased" => 410,
                _ => 404,
            };
            tauri::http::Response::builder()
                .status(status)
                .header("Cache-Control", "no-store")
                .header("Content-Type", "text/plain; charset=utf-8")
                .header("X-Content-Type-Options", "nosniff")
                .body(error.message.into_bytes())
                .unwrap()
        }
    }
}

impl MdictReader {
    pub fn open(master: &Path) -> Result<Self, MdictError> {
        preflight_header(master)?;
        let master =
            fs::canonicalize(master).map_err(|error| io_error("mdictUnavailable", error))?;
        let root = master
            .parent()
            .ok_or_else(|| MdictError::new("invalidMdict", "The MDict file has no parent folder."))?
            .to_path_buf();
        let mdx = MdxFile::open(&master).map_err(map_parser_error)?;
        reject_encrypted(mdx.header().encrypted)?;

        let mdd_path = master.with_extension("mdd");
        let mdd = if mdd_path.is_file() {
            preflight_header(&mdd_path)?;
            let reader = MddFile::open(&mdd_path).map_err(map_parser_error)?;
            reject_encrypted(reader.header().encrypted)?;
            Some(reader)
        } else {
            None
        };
        Ok(Self {
            diagnostics: Mutex::new(MutableDiagnostics::default()),
            mdd,
            mdx,
            root,
        })
    }

    pub fn lookup(&self, query: &str) -> Result<Option<MdictEntry>, MdictError> {
        let query = query.trim();
        if query.is_empty() || query.len() > 16 * 1024 {
            return Ok(None);
        }
        let Some(record) = self.mdx.lookup(query).map_err(map_parser_error)? else {
            return Ok(None);
        };
        if record.text.len() > MAX_ENTRY_BYTES {
            return Err(MdictError::new(
                "mdictEntryTooLarge",
                "The MDict entry exceeds the supported size limit.",
            ));
        }
        self.with_diagnostics(|diagnostics| {
            diagnostics.record_bytes = diagnostics
                .record_bytes
                .saturating_add(record.text.len() as u64);
        })?;
        Ok(Some(MdictEntry {
            headword: record.key,
            html: record.text,
        }))
    }

    pub fn load_stylesheet(&self, key: &str) -> Result<Option<MdictTextResource>, MdictError> {
        let key = normalize_resource_key(key)?;
        if !key.to_ascii_lowercase().ends_with(".css") {
            return Err(MdictError::new(
                "unsupportedMdictResource",
                "Only referenced CSS files can be loaded as stylesheets.",
            ));
        }
        let Some(data) = self.read_resource_bytes(&key, MAX_STYLESHEET_BYTES)? else {
            return Ok(None);
        };
        let text = String::from_utf8(data).map_err(|_| {
            MdictError::new(
                "invalidMdictResource",
                "The referenced MDict stylesheet is not valid UTF-8.",
            )
        })?;
        self.record_resource(&key, text.len())?;
        Ok(Some(MdictTextResource { key, text }))
    }

    pub fn load_binary_resource(
        &self,
        key: &str,
    ) -> Result<Option<MdictBinaryResource>, MdictError> {
        let key = normalize_resource_key(key)?;
        let Some(expected_mime) = mime_from_extension(&key) else {
            return Err(MdictError::new(
                "unsupportedMdictResource",
                "This MDict resource type is not supported.",
            ));
        };
        if expected_mime == "text/css" {
            return Err(MdictError::new(
                "unsupportedMdictResource",
                "Stylesheets must pass through the CSS sanitizer.",
            ));
        }
        let Some(data) = self.read_resource_bytes(&key, MAX_RESOURCE_BYTES)? else {
            return Ok(None);
        };
        if !valid_magic(expected_mime, &data) {
            return Err(MdictError::new(
                "invalidMdictResource",
                "The referenced MDict resource does not match its declared type.",
            ));
        }
        self.record_resource(&key, data.len())?;
        Ok(Some(MdictBinaryResource {
            data,
            key,
            mime_type: expected_mime,
        }))
    }

    pub fn diagnostics(&self) -> Result<MdictDiagnostics, MdictError> {
        let diagnostics = self.diagnostics.lock().map_err(|_| {
            MdictError::new("mdictLockFailed", "The MDict diagnostics lock failed.")
        })?;
        Ok(MdictDiagnostics {
            loaded_resource_keys: diagnostics.loaded_resource_keys.iter().cloned().collect(),
            record_bytes: diagnostics.record_bytes,
            resource_bytes: diagnostics.resource_bytes,
        })
    }

    pub fn source_file_count(&self) -> usize {
        1 + usize::from(self.mdd.is_some())
    }

    fn read_resource_bytes(&self, key: &str, limit: usize) -> Result<Option<Vec<u8>>, MdictError> {
        if let Some(mdd) = &self.mdd {
            let mdd_key = format!("\\{}", key.replace('/', "\\"));
            if let Some(span) = mdd.lookup_span(&mdd_key).map_err(map_parser_error)? {
                if span.len() as usize > limit {
                    return Err(resource_too_large());
                }
                let resource =
                    mdd.lookup(&mdd_key)
                        .map_err(map_parser_error)?
                        .ok_or_else(|| {
                            MdictError::new(
                                "mdictResourceUnavailable",
                                "The MDict resource disappeared.",
                            )
                        })?;
                return Ok(Some(resource.data));
            }
        }

        let candidate = key
            .split('/')
            .fold(self.root.clone(), |path, segment| path.join(segment));
        if !candidate.is_file() {
            return Ok(None);
        }
        let candidate = fs::canonicalize(&candidate)
            .map_err(|error| io_error("mdictResourceUnavailable", error))?;
        if !candidate.starts_with(&self.root) {
            return Err(MdictError::new(
                "invalidResourceKey",
                "The MDict resource path escapes the dictionary folder.",
            ));
        }
        let size = candidate
            .metadata()
            .map_err(|error| io_error("mdictResourceUnavailable", error))?
            .len();
        if size > limit as u64 {
            return Err(resource_too_large());
        }
        fs::read(candidate)
            .map(Some)
            .map_err(|error| io_error("mdictResourceUnavailable", error))
    }

    fn record_resource(&self, key: &str, bytes: usize) -> Result<(), MdictError> {
        let mut diagnostics = self.diagnostics.lock().map_err(|_| {
            MdictError::new("mdictLockFailed", "The MDict diagnostics lock failed.")
        })?;
        let next_bytes = diagnostics.resource_bytes.saturating_add(bytes as u64);
        if next_bytes > MAX_SESSION_RESOURCE_BYTES {
            return Err(MdictError::new(
                "mdictSessionResourceLimit",
                "The MDict session resource limit was exceeded.",
            ));
        }
        diagnostics.loaded_resource_keys.insert(key.to_string());
        diagnostics.resource_bytes = next_bytes;
        Ok(())
    }

    fn with_diagnostics(
        &self,
        update: impl FnOnce(&mut MutableDiagnostics),
    ) -> Result<(), MdictError> {
        let mut diagnostics = self.diagnostics.lock().map_err(|_| {
            MdictError::new("mdictLockFailed", "The MDict diagnostics lock failed.")
        })?;
        update(&mut diagnostics);
        Ok(())
    }
}

fn preflight_header(path: &Path) -> Result<(), MdictError> {
    let mut file = File::open(path).map_err(|error| io_error("mdictUnavailable", error))?;
    let mut bytes = [0_u8; 4];
    file.read_exact(&mut bytes)
        .map_err(|_| MdictError::new("invalidMdict", "The MDict header is truncated."))?;
    let header_len = u32::from_be_bytes(bytes) as u64;
    if header_len > MAX_HEADER_BYTES {
        return Err(MdictError::new(
            "mdictHeaderTooLarge",
            "The MDict header exceeds the supported size limit.",
        ));
    }
    Ok(())
}

fn reject_encrypted(mode: u8) -> Result<(), MdictError> {
    // MDict flag 2 only obfuscates the keyword index and mdict-rs decodes it
    // without user credentials. Flag 1 encrypts the keyword header and needs a
    // dictionary-specific passcode, which Flow Reader does not collect.
    if mode == 0 || mode == 2 {
        Ok(())
    } else {
        Err(MdictError::new(
            "encryptedMdict",
            "Encrypted MDict dictionaries are not supported.",
        ))
    }
}

fn map_parser_error(error: mdict_rs::Error) -> MdictError {
    let message = error.to_string();
    let code = match error {
        mdict_rs::Error::MissingPasscode => "encryptedMdict",
        mdict_rs::Error::Unsupported(_) => "unsupportedMdict",
        mdict_rs::Error::LimitExceeded { .. } => "mdictLimitExceeded",
        mdict_rs::Error::Decode { .. } => "unsupportedMdictEncoding",
        _ => "invalidMdict",
    };
    MdictError::new(code, message)
}

fn normalize_resource_key(value: &str) -> Result<String, MdictError> {
    let decoded = percent_decode(value)?;
    if decoded.contains('%') && percent_decode(&decoded)? != decoded {
        return Err(invalid_resource_key());
    }
    let normalized = decoded.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains("://")
        || normalized.chars().any(char::is_control)
    {
        return Err(invalid_resource_key());
    }
    let mut segments = Vec::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment.to_string_lossy();
                if segment.is_empty() || segment.contains(':') {
                    return Err(invalid_resource_key());
                }
                segments.push(segment.into_owned());
            }
            _ => return Err(invalid_resource_key()),
        }
    }
    if segments.is_empty() {
        return Err(invalid_resource_key());
    }
    Ok(segments.join("/"))
}

fn percent_decode(value: &str) -> Result<String, MdictError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err(invalid_resource_key());
        }
        let high = hex(bytes[index + 1]).ok_or_else(invalid_resource_key)?;
        let low = hex(bytes[index + 2]).ok_or_else(invalid_resource_key)?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).map_err(|_| invalid_resource_key())
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn mime_from_extension(key: &str) -> Option<&'static str> {
    match key.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "css" => Some("text/css"),
        "gif" => Some("image/gif"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "otf" => Some("font/otf"),
        "png" => Some("image/png"),
        "ttf" => Some("font/ttf"),
        "webp" => Some("image/webp"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        _ => None,
    }
}

fn infer_language(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if matches!(
        value.as_str(),
        "zh" | "zho" | "chi" | "chinese" | "zh-cn" | "zh-tw"
    ) {
        Some("zh".to_string())
    } else if matches!(value.as_str(), "en" | "eng" | "english" | "en-us" | "en-gb") {
        Some("en".to_string())
    } else {
        None
    }
}

fn valid_magic(mime: &str, data: &[u8]) -> bool {
    match mime {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "image/webp" => data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP",
        "font/ttf" => data.starts_with(&[0, 1, 0, 0]) || data.starts_with(b"true"),
        "font/otf" => data.starts_with(b"OTTO"),
        "font/woff" => data.starts_with(b"wOFF"),
        "font/woff2" => data.starts_with(b"wOF2"),
        _ => false,
    }
}

fn io_error(code: &str, error: std::io::Error) -> MdictError {
    MdictError::new(code, error.to_string())
}

fn invalid_resource_key() -> MdictError {
    MdictError::new(
        "invalidResourceKey",
        "The MDict resource key is not a safe relative path.",
    )
}

fn resource_too_large() -> MdictError {
    MdictError::new(
        "mdictResourceTooLarge",
        "The referenced MDict resource exceeds the supported size limit.",
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
    };

    use flate2::{write::ZlibEncoder, Compression};

    use super::MdictReader;
    use crate::dictionary::session::DictionarySessionManager;

    #[derive(Clone, Copy)]
    enum FixtureKind {
        Mdd,
        Mdx,
    }

    fn temp_dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "flow-reader-mdict-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_fixture(path: &Path, kind: FixtureKind, entries: &[(&str, &[u8])], encrypted: bool) {
        let tag = match kind {
            FixtureKind::Mdd => "Library_Data",
            FixtureKind::Mdx => "Dictionary",
        };
        let header = format!(
            r#"<{tag} GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" Encoding="UTF-8" Encrypted="{}" KeyCaseSensitive="No" StripKey="No"/>"#,
            if encrypted { "1" } else { "No" }
        );
        let header_bytes = header
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        let mut file = Vec::new();
        file.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
        file.extend_from_slice(&header_bytes);
        file.extend_from_slice(&adler32(&header_bytes).to_le_bytes());

        let mut key_payload = Vec::new();
        let mut record_offset = 0_u64;
        for (key, record) in entries {
            key_payload.extend_from_slice(&record_offset.to_be_bytes());
            key_payload.extend_from_slice(&fixture_key_bytes(kind, key));
            key_payload.extend(std::iter::repeat_n(0, fixture_key_unit_size(kind)));
            record_offset += record.len() as u64;
        }
        let key_block = compressed_block(&key_payload);
        let first_key = entries.first().unwrap().0;
        let last_key = entries.last().unwrap().0;
        let first_key_bytes = fixture_key_bytes(kind, first_key);
        let last_key_bytes = fixture_key_bytes(kind, last_key);
        let mut key_index_payload = Vec::new();
        key_index_payload.extend_from_slice(&(entries.len() as u64).to_be_bytes());
        key_index_payload
            .extend_from_slice(&(fixture_key_units(kind, first_key) as u16).to_be_bytes());
        key_index_payload.extend_from_slice(&first_key_bytes);
        key_index_payload.extend(std::iter::repeat_n(0, fixture_key_unit_size(kind)));
        key_index_payload
            .extend_from_slice(&(fixture_key_units(kind, last_key) as u16).to_be_bytes());
        key_index_payload.extend_from_slice(&last_key_bytes);
        key_index_payload.extend(std::iter::repeat_n(0, fixture_key_unit_size(kind)));
        key_index_payload.extend_from_slice(&(key_block.len() as u64).to_be_bytes());
        key_index_payload.extend_from_slice(&(key_payload.len() as u64).to_be_bytes());
        let key_index = plain_block(&key_index_payload);

        let mut keyword_header = Vec::new();
        keyword_header.extend_from_slice(&1_u64.to_be_bytes());
        keyword_header.extend_from_slice(&(entries.len() as u64).to_be_bytes());
        keyword_header.extend_from_slice(&(key_index_payload.len() as u64).to_be_bytes());
        keyword_header.extend_from_slice(&(key_index.len() as u64).to_be_bytes());
        keyword_header.extend_from_slice(&(key_block.len() as u64).to_be_bytes());
        file.extend_from_slice(&keyword_header);
        file.extend_from_slice(&adler32(&keyword_header).to_be_bytes());
        file.extend_from_slice(&key_index);
        file.extend_from_slice(&key_block);

        let record_blocks = entries
            .iter()
            .map(|(_, record)| compressed_block(record))
            .collect::<Vec<_>>();
        let record_index_len = record_blocks.len() * 16;
        let record_blocks_len = record_blocks.iter().map(Vec::len).sum::<usize>();
        file.extend_from_slice(&(record_blocks.len() as u64).to_be_bytes());
        file.extend_from_slice(&(entries.len() as u64).to_be_bytes());
        file.extend_from_slice(&(record_index_len as u64).to_be_bytes());
        file.extend_from_slice(&(record_blocks_len as u64).to_be_bytes());
        for ((_, record), block) in entries.iter().zip(&record_blocks) {
            file.extend_from_slice(&(block.len() as u64).to_be_bytes());
            file.extend_from_slice(&(record.len() as u64).to_be_bytes());
        }
        for block in record_blocks {
            file.extend_from_slice(&block);
        }
        fs::write(path, file).unwrap();
    }

    fn fixture_key_bytes(kind: FixtureKind, key: &str) -> Vec<u8> {
        match kind {
            FixtureKind::Mdd => key
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
            FixtureKind::Mdx => key.as_bytes().to_vec(),
        }
    }

    fn fixture_key_unit_size(kind: FixtureKind) -> usize {
        match kind {
            FixtureKind::Mdd => 2,
            FixtureKind::Mdx => 1,
        }
    }

    fn fixture_key_units(kind: FixtureKind, key: &str) -> usize {
        match kind {
            FixtureKind::Mdd => key.encode_utf16().count(),
            FixtureKind::Mdx => key.len(),
        }
    }

    fn write_header_only(path: &Path, encoding: &str, valid_checksum: bool) {
        let header = format!(
            r#"<Dictionary GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" Encoding="{encoding}" Encrypted="No"/>"#
        );
        let header = header
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let mut file = Vec::new();
        file.extend_from_slice(&(header.len() as u32).to_be_bytes());
        file.extend_from_slice(&header);
        let checksum = adler32(&header) ^ u32::from(!valid_checksum);
        file.extend_from_slice(&checksum.to_le_bytes());
        fs::write(path, file).unwrap();
    }

    fn plain_block(payload: &[u8]) -> Vec<u8> {
        let mut block = vec![0, 0, 0, 0];
        block.extend_from_slice(&adler32(payload).to_be_bytes());
        block.extend_from_slice(payload);
        block
    }

    fn compressed_block(payload: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(payload).unwrap();
        let mut block = vec![2, 0, 0, 0];
        block.extend_from_slice(&adler32(payload).to_be_bytes());
        block.extend_from_slice(&encoder.finish().unwrap());
        block
    }

    fn adler32(bytes: &[u8]) -> u32 {
        const MOD_ADLER: u32 = 65_521;
        let mut a = 1_u32;
        let mut b = 0_u32;
        for byte in bytes {
            a = (a + u32::from(*byte)) % MOD_ADLER;
            b = (b + a) % MOD_ADLER;
        }
        (b << 16) | a
    }

    #[test]
    fn looks_up_an_exact_unicode_entry_from_compressed_blocks() {
        let root = temp_dir("lookup");
        let mdx = root.join("fixture.mdx");
        write_fixture(
            &mdx,
            FixtureKind::Mdx,
            &[
                ("alpha", b"<p>first</p>"),
                (
                    "天",
                    r#"<link rel="stylesheet" href="cy3.css"><main><p>天空</p></main>"#.as_bytes(),
                ),
            ],
            false,
        );

        let reader = MdictReader::open(&mdx).unwrap();
        let entry = reader.lookup("\u{5929}").unwrap().unwrap();
        assert_eq!(entry.headword, "\u{5929}");
        assert!(entry.html.contains("cy3.css"));
        assert!(entry.html.contains("\u{5929}\u{7a7a}"));
        assert!(reader.lookup("\u{5929}\u{5730}").unwrap().is_none());
        let diagnostics = reader.diagnostics().unwrap();
        assert_eq!(diagnostics.record_bytes, entry.html.len() as u64);
        assert_eq!(diagnostics.resource_bytes, 0);
        assert!(diagnostics.loaded_resource_keys.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_only_supported_mdd_or_exact_loose_resources() {
        let root = temp_dir("resources");
        let mdx = root.join("fixture.mdx");
        let mdd = root.join("fixture.mdd");
        write_fixture(
            &mdx,
            FixtureKind::Mdx,
            &[("entry", b"<img src=\"image.png\">")],
            false,
        );
        write_fixture(
            &mdd,
            FixtureKind::Mdd,
            &[
                ("\\cy3.css", b"p{color:green}"),
                ("\\image.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRfixture"),
            ],
            false,
        );
        fs::write(root.join("cy3.css"), "p{color:red}").unwrap();
        fs::write(root.join("loose.css"), "p{font-weight:600}").unwrap();
        fs::write(root.join("invalid.ttf"), b"not a font").unwrap();
        fs::write(root.join("sound.mp3"), b"audio").unwrap();
        fs::write(root.join("secret.png"), b"outside").unwrap();

        let reader = MdictReader::open(&mdx).unwrap();
        assert_eq!(
            reader.load_stylesheet("cy3.css").unwrap().unwrap().text,
            "p{color:green}"
        );
        assert_eq!(
            reader.load_stylesheet("loose.css").unwrap().unwrap().text,
            "p{font-weight:600}"
        );
        let image = reader.load_binary_resource("image.png").unwrap().unwrap();
        assert_eq!(image.mime_type, "image/png");
        assert!(image.data.starts_with(b"\x89PNG"));
        assert!(reader
            .load_binary_resource("missing.png")
            .unwrap()
            .is_none());
        assert_eq!(
            reader
                .load_binary_resource("../secret.png")
                .unwrap_err()
                .code,
            "invalidResourceKey"
        );
        assert_eq!(
            reader.load_binary_resource("invalid.ttf").unwrap_err().code,
            "invalidMdictResource"
        );
        assert_eq!(
            reader.load_binary_resource("sound.mp3").unwrap_err().code,
            "unsupportedMdictResource"
        );
        let diagnostics = reader.diagnostics().unwrap();
        assert_eq!(
            diagnostics.loaded_resource_keys,
            ["cy3.css", "image.png", "loose.css"]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_malformed_oversized_and_unsupported_headers() {
        let root = temp_dir("invalid-headers");
        let truncated = root.join("truncated.mdx");
        fs::write(&truncated, [0_u8, 1]).unwrap();
        assert_eq!(
            MdictReader::open(&truncated).unwrap_err().code,
            "invalidMdict"
        );

        let oversized = root.join("oversized.mdx");
        fs::write(&oversized, (1_048_577_u32).to_be_bytes()).unwrap();
        assert_eq!(
            MdictReader::open(&oversized).unwrap_err().code,
            "mdictHeaderTooLarge"
        );

        let corrupted = root.join("corrupted.mdx");
        write_header_only(&corrupted, "UTF-8", false);
        assert_eq!(
            MdictReader::open(&corrupted).unwrap_err().code,
            "invalidMdict"
        );

        let unsupported = root.join("unsupported.mdx");
        write_header_only(&unsupported, "UTF-32", true);
        assert_eq!(
            MdictReader::open(&unsupported).unwrap_err().code,
            "unsupportedMdict"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_encrypted_files_and_releases_session_readers() {
        let root = temp_dir("lifecycle");
        let encrypted = root.join("encrypted.mdx");
        write_fixture(&encrypted, FixtureKind::Mdx, &[("entry", b"hidden")], true);
        assert_eq!(
            MdictReader::open(&encrypted).unwrap_err().code,
            "encryptedMdict"
        );

        let mdx = root.join("fixture.mdx");
        write_fixture(&mdx, FixtureKind::Mdx, &[("entry", b"visible")], false);
        let sessions = DictionarySessionManager::default();
        let reader = sessions
            .get_or_open_mdict(7, "fixture", || MdictReader::open(&mdx))
            .unwrap();
        assert_eq!(reader.lookup("entry").unwrap().unwrap().html, "visible");
        assert_eq!(sessions.diagnostics().unwrap().resource_count, 1);
        assert_eq!(sessions.release(7).unwrap(), 1);
        assert_eq!(sessions.diagnostics().unwrap().resource_count, 0);
        assert_eq!(
            sessions
                .load_mdict_resource(7, "fixture", "missing.png")
                .unwrap_err()
                .code,
            "mdictSessionReleased"
        );
        let _ = fs::remove_dir_all(root);
    }
}
