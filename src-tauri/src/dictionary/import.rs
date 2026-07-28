use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::language::infer_language;

const FINGERPRINT_SAMPLE_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DictionaryFormat {
    #[serde(rename = "stardict")]
    StarDict,
    #[serde(rename = "mdict")]
    MDict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DictionaryFileKind {
    Index,
    Data,
    CompressedData,
    Synonyms,
    Resources,
    Cover,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryFileReference {
    pub kind: DictionaryFileKind,
    pub path: PathBuf,
    pub used: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFingerprint {
    pub size: u64,
    pub modified_ms: u64,
    pub sample_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedDictionary {
    pub format: DictionaryFormat,
    pub name: String,
    pub source_path: PathBuf,
    pub fingerprint: SourceFingerprint,
    pub files: Vec<DictionaryFileReference>,
    pub metadata_languages: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryImportError {
    pub code: String,
    pub message: String,
}

impl DictionaryImportError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DictionaryImportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for DictionaryImportError {}

pub fn inspect_dictionary_file(path: &Path) -> Result<InspectedDictionary, DictionaryImportError> {
    if path.as_os_str().is_empty() {
        return Err(DictionaryImportError::new(
            "invalidMasterFile",
            "Choose a StarDict .ifo or MDict .mdx master file.",
        ));
    }
    if path.is_dir() || path.parent().is_none() {
        return Err(DictionaryImportError::new(
            "directoryNotAllowed",
            "Dictionary import accepts one master file, not a directory.",
        ));
    }
    if !path.is_file() {
        return Err(DictionaryImportError::new(
            "sourceMissing",
            "The selected dictionary master file is unavailable.",
        ));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "ifo" => inspect_stardict(path),
        "mdx" => inspect_mdict(path),
        _ => Err(DictionaryImportError::new(
            "unsupportedMasterFile",
            "Choose a StarDict .ifo or MDict .mdx master file.",
        )),
    }
}

fn inspect_stardict(path: &Path) -> Result<InspectedDictionary, DictionaryImportError> {
    let source_path = canonical_file(path)?;
    let metadata = fs::read_to_string(&source_path)
        .map_err(|error| DictionaryImportError::new("sourceUnreadable", format!("Cannot read .ifo file: {error}")))?;
    if !metadata.contains("StarDict") {
        return Err(DictionaryImportError::new(
            "invalidStarDict",
            "The selected .ifo file is not a readable StarDict dictionary.",
        ));
    }

    let index = companion_path(&source_path, "idx")?;
    if !index.is_file() {
        return Err(DictionaryImportError::new(
            "missingStarDictIndex",
            "The matching .idx file is required.",
        ));
    }
    let data = companion_path(&source_path, "dict")?;
    let compressed_data = companion_path(&source_path, "dict.dz")?;
    if !data.is_file() && !compressed_data.is_file() {
        return Err(DictionaryImportError::new(
            "missingStarDictData",
            "A matching .dict or .dict.dz file is required.",
        ));
    }

    let mut files = vec![file_reference(DictionaryFileKind::Index, index, true)?];
    if data.is_file() {
        files.push(file_reference(DictionaryFileKind::Data, data, true)?);
    }
    if compressed_data.is_file() {
        files.push(file_reference(
            DictionaryFileKind::CompressedData,
            compressed_data,
            !files.iter().any(|file| file.kind == DictionaryFileKind::Data),
        )?);
    }
    let synonyms = companion_path(&source_path, "syn")?;
    if synonyms.is_file() {
        files.push(file_reference(DictionaryFileKind::Synonyms, synonyms, true)?);
    }

    let fingerprint = fingerprint_group(
        std::iter::once(&source_path).chain(files.iter().filter(|file| file.used).map(|file| &file.path)),
    )?;

    Ok(InspectedDictionary {
        format: DictionaryFormat::StarDict,
        name: metadata_value(&metadata, "bookname").unwrap_or_else(|| source_stem(&source_path)),
        fingerprint,
        metadata_languages: infer_stardict_languages(&metadata),
        source_path,
        files,
    })
}

fn inspect_mdict(path: &Path) -> Result<InspectedDictionary, DictionaryImportError> {
    let source_path = canonical_file(path)?;
    let metadata = super::mdict::inspect_metadata(&source_path)
        .map_err(|error| DictionaryImportError::new(&error.code, error.message))?;

    let mut files = Vec::new();
    for resources in super::mdict::resource_paths(&source_path) {
        super::mdict::inspect_resources(&resources)
            .map_err(|error| DictionaryImportError::new(&error.code, error.message))?;
        files.push(file_reference(DictionaryFileKind::Resources, resources, true)?);
    }
    for extension in ["jpg", "png"] {
        let cover = companion_path(&source_path, extension)?;
        if cover.is_file() {
            files.push(file_reference(DictionaryFileKind::Cover, cover, true)?);
            break;
        }
    }

    Ok(InspectedDictionary {
        format: DictionaryFormat::MDict,
        name: metadata.title.unwrap_or_else(|| source_stem(&source_path)),
        fingerprint: fingerprint_group(
            std::iter::once(&source_path).chain(files.iter().filter(|file| file.used).map(|file| &file.path)),
        )?,
        metadata_languages: metadata.language.into_iter().collect(),
        source_path,
        files,
    })
}

fn canonical_file(path: &Path) -> Result<PathBuf, DictionaryImportError> {
    fs::canonicalize(path).map_err(|error| {
        DictionaryImportError::new("sourceUnreadable", format!("Cannot resolve dictionary file: {error}"))
    })
}

fn companion_path(path: &Path, extension: &str) -> Result<PathBuf, DictionaryImportError> {
    let parent = path
        .parent()
        .ok_or_else(|| DictionaryImportError::new("invalidMasterFile", "The master file has no parent folder."))?;
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| DictionaryImportError::new("invalidMasterFile", "The master file name is invalid."))?;
    Ok(parent.join(format!("{stem}.{extension}")))
}

fn file_reference(
    kind: DictionaryFileKind,
    path: PathBuf,
    used: bool,
) -> Result<DictionaryFileReference, DictionaryImportError> {
    Ok(DictionaryFileReference {
        kind,
        path: canonical_file(&path)?,
        used,
    })
}

fn fingerprint(path: &Path) -> Result<SourceFingerprint, DictionaryImportError> {
    let metadata = fs::metadata(path)
        .map_err(|error| DictionaryImportError::new("sourceUnreadable", format!("Cannot inspect file: {error}")))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let mut file = File::open(path)
        .map_err(|error| DictionaryImportError::new("sourceUnreadable", format!("Cannot read file: {error}")))?;
    let mut hasher = Sha256::new();
    hasher.update(metadata.len().to_le_bytes());
    let mut buffer = vec![0; FINGERPRINT_SAMPLE_BYTES.min(metadata.len() as usize)];
    if !buffer.is_empty() {
        file.read_exact(&mut buffer)
            .map_err(|error| DictionaryImportError::new("sourceUnreadable", format!("Cannot read file: {error}")))?;
        hasher.update(&buffer);
        if metadata.len() > FINGERPRINT_SAMPLE_BYTES as u64 {
            file.seek(SeekFrom::End(-(FINGERPRINT_SAMPLE_BYTES as i64)))
                .map_err(|error| {
                    DictionaryImportError::new("sourceUnreadable", format!("Cannot seek file: {error}"))
                })?;
            buffer.resize(FINGERPRINT_SAMPLE_BYTES, 0);
            file.read_exact(&mut buffer).map_err(|error| {
                DictionaryImportError::new("sourceUnreadable", format!("Cannot read file: {error}"))
            })?;
            hasher.update(&buffer);
        }
    }

    Ok(SourceFingerprint {
        size: metadata.len(),
        modified_ms,
        sample_hash: format!("{:x}", hasher.finalize()),
    })
}

fn fingerprint_group<'a>(paths: impl Iterator<Item = &'a PathBuf>) -> Result<SourceFingerprint, DictionaryImportError> {
    let mut size = 0_u64;
    let mut modified_ms = 0_u64;
    let mut hasher = Sha256::new();
    for path in paths {
        let current = fingerprint(path)?;
        size = size.saturating_add(current.size);
        modified_ms = modified_ms.max(current.modified_ms);
        hasher.update(path.file_name().unwrap_or_default().to_string_lossy().as_bytes());
        hasher.update(current.size.to_le_bytes());
        hasher.update(current.modified_ms.to_le_bytes());
        hasher.update(current.sample_hash.as_bytes());
    }
    Ok(SourceFingerprint {
        size,
        modified_ms,
        sample_hash: format!("{:x}", hasher.finalize()),
    })
}

fn metadata_value(metadata: &str, key: &str) -> Option<String> {
    metadata.lines().find_map(|line| {
        let (name, value) = line.split_once('=')?;
        (name.eq_ignore_ascii_case(key) && !value.trim().is_empty()).then(|| value.trim().to_string())
    })
}

fn infer_stardict_languages(metadata: &str) -> Vec<String> {
    let mut languages = Vec::new();
    for language in ["lang", "lang_from", "lang_to"]
        .into_iter()
        .filter_map(|key| metadata_value(metadata, key))
        .filter_map(|value| infer_language(&value))
    {
        if !languages.contains(&language) {
            languages.push(language);
        }
    }
    languages
}

fn source_stem(path: &Path) -> String {
    path.file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Dictionary".to_string())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{DictionaryFileKind, DictionaryFormat, infer_stardict_languages, inspect_dictionary_file};

    #[test]
    fn recognizes_explicit_dictionary_language_metadata() {
        assert_eq!(
            infer_stardict_languages("lang_from=English\nlang_to=中文\n"),
            vec!["en".to_string(), "zh".to_string()]
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "flow-reader-dictionary-import-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_stardict(root: &std::path::Path, stem: &str) -> PathBuf {
        let ifo = root.join(format!("{stem}.ifo"));
        fs::write(
            &ifo,
            "StarDict's dict ifo file\nversion=2.4.2\nbookname=Test Dictionary\nlang_from=English\n",
        )
        .unwrap();
        fs::write(root.join(format!("{stem}.idx")), b"index").unwrap();
        fs::write(root.join(format!("{stem}.dict")), b"data").unwrap();
        ifo
    }

    fn write_mdict_header(path: &std::path::Path, tag: &str) {
        let header = format!(
            r#"<{tag} GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" Encoding="UTF-8" Encrypted="No"/>"#
        );
        let header = header.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
        let mut a = 1_u32;
        let mut b = 0_u32;
        for byte in &header {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(&((b << 16) | a).to_le_bytes());
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn accepts_only_master_files_and_requires_stardict_companions() {
        let root = temp_dir("master");
        let ifo = write_stardict(&root, "alpha");
        assert_eq!(
            inspect_dictionary_file(&ifo).unwrap().format,
            DictionaryFormat::StarDict
        );
        assert_eq!(
            inspect_dictionary_file(&root.join("alpha.idx")).unwrap_err().code,
            "unsupportedMasterFile"
        );
        assert_eq!(inspect_dictionary_file(&root).unwrap_err().code, "directoryNotAllowed");
        fs::remove_file(root.join("alpha.idx")).unwrap();
        assert_eq!(inspect_dictionary_file(&ifo).unwrap_err().code, "missingStarDictIndex");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_only_same_stem_known_stardict_companions() {
        let root = temp_dir("stardict-group");
        let ifo = write_stardict(&root, "alpha");
        let _other = write_stardict(&root, "beta");
        fs::write(root.join("alpha.dict.dz"), b"compressed").unwrap();
        fs::write(root.join("alpha.syn"), b"synonyms").unwrap();
        fs::write(root.join("alpha.ttf"), b"not a companion").unwrap();

        let inspected = inspect_dictionary_file(&ifo).unwrap();
        assert_eq!(inspected.files.len(), 4);
        assert!(
            inspected
                .files
                .iter()
                .any(|file| file.kind == DictionaryFileKind::Data && file.used)
        );
        assert!(
            inspected
                .files
                .iter()
                .any(|file| { file.kind == DictionaryFileKind::CompressedData && !file.used })
        );
        assert!(
            inspected
                .files
                .iter()
                .all(|file| !file.path.to_string_lossy().contains("beta"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mdict_associates_same_stem_numbered_mdd_volumes_and_cover() {
        let root = temp_dir("mdict-group");
        let mdx = root.join("source.mdx");
        write_mdict_header(&mdx, "Dictionary");
        write_mdict_header(&root.join("source.mdd"), "Library_Data");
        write_mdict_header(&root.join("source.1.mdd"), "Library_Data");
        write_mdict_header(&root.join("source.2.mdd"), "Library_Data");
        fs::write(root.join("source.jpg"), b"cover").unwrap();
        fs::write(root.join("source.css"), b"ignored").unwrap();
        fs::write(root.join("source.ttf"), b"ignored").unwrap();
        fs::write(root.join("other.mdd"), b"ignored").unwrap();

        let inspected = inspect_dictionary_file(&mdx).unwrap();
        assert_eq!(inspected.format, DictionaryFormat::MDict);
        assert_eq!(inspected.files.len(), 4);
        assert_eq!(
            inspected
                .files
                .iter()
                .filter(|file| file.kind == DictionaryFileKind::Resources)
                .count(),
            3
        );
        assert!(
            inspected
                .files
                .iter()
                .any(|file| file.kind == DictionaryFileKind::Cover)
        );
        let _ = fs::remove_dir_all(root);
    }
}
