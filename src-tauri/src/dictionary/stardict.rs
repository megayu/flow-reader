use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use flate2::read::DeflateDecoder;
use memmap2::{Mmap, MmapOptions};
use serde::{Deserialize, Serialize};

use super::import::{
    inspect_dictionary_file, DictionaryFileKind, DictionaryFormat, InspectedDictionary,
    SourceFingerprint,
};

const INDEX_VERSION: u32 = 1;
const HEADER_LENGTH_BYTES: usize = 4;
const MAX_ENTRIES: usize = 10_000_000;
const MAX_WORD_BYTES: usize = 16 * 1024;
const MAX_DEFINITION_BYTES: usize = 1024 * 1024;
const MAX_MATCHES: usize = 64;
const MAX_DICTZIP_BLOCKS: usize = 4_096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarDictError {
    pub code: String,
    pub message: String,
}

impl StarDictError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for StarDictError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for StarDictError {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarDictEntry {
    pub headword: String,
    pub definitions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarDictLookupResult {
    pub entries: Vec<StarDictEntry>,
}

#[derive(Debug, Clone)]
struct SourceEntry {
    key: String,
    headword: String,
    offset: u64,
    length: u32,
    index_offset: u32,
}

#[derive(Debug, Clone)]
struct SynonymEntry {
    key: String,
    synonym_offset: u32,
    target_index_offset: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DerivedMetadata {
    version: u32,
    fingerprint: SourceFingerprint,
    entry_count: u32,
    synonym_count: u32,
}

pub fn prepare_index(master: &Path, cache: &Path) -> Result<(), StarDictError> {
    let inspected = inspect_stardict(master)?;
    let metadata = read_ifo(&inspected.source_path)?;
    if metadata
        .get("sametypesequence")
        .is_some_and(|value| value != "m")
    {
        return Err(StarDictError::new(
            "unsupportedStarDictType",
            "This StarDict uses definition fields that are not supported yet.",
        ));
    }
    let offset_bytes = index_data_offset_bytes(&metadata)?;
    let index_path = used_file(&inspected, DictionaryFileKind::Index)?;
    let data_size = dictionary_uncompressed_size(&inspected)?;
    let mut entries = parse_index(&index_path, offset_bytes, data_size)?;
    let mut synonyms = optional_used_file(&inspected, DictionaryFileKind::Synonyms)
        .map(|path| parse_synonyms(&path, &entries))
        .transpose()?
        .unwrap_or_default();
    entries.sort_by(|left, right| {
        left.key
            .cmp(&right.key)
            .then_with(|| left.index_offset.cmp(&right.index_offset))
            .then_with(|| left.headword.cmp(&right.headword))
    });
    synonyms.sort_by(|left, right| {
        left.key
            .cmp(&right.key)
            .then_with(|| left.target_index_offset.cmp(&right.target_index_offset))
            .then_with(|| left.synonym_offset.cmp(&right.synonym_offset))
    });

    fs::create_dir_all(cache).map_err(|error| io_error("cacheCreateFailed", error))?;
    let metadata = DerivedMetadata {
        version: INDEX_VERSION,
        fingerprint: inspected.fingerprint,
        entry_count: entries.len() as u32,
        synonym_count: synonyms.len() as u32,
    };
    let encoded = serde_json::to_vec(&metadata)
        .map_err(|error| StarDictError::new("indexWriteFailed", error.to_string()))?;
    let header_length = u32::try_from(encoded.len())
        .map_err(|_| invalid_derived("The derived StarDict header is too large."))?;
    let mut offset_bytes = Vec::with_capacity(
        HEADER_LENGTH_BYTES + encoded.len() + entries.len() * 4 + synonyms.len() * 8,
    );
    offset_bytes.extend_from_slice(&header_length.to_le_bytes());
    offset_bytes.extend_from_slice(&encoded);
    for entry in &entries {
        offset_bytes.extend_from_slice(&entry.index_offset.to_le_bytes());
    }
    for synonym in &synonyms {
        offset_bytes.extend_from_slice(&synonym.synonym_offset.to_le_bytes());
        offset_bytes.extend_from_slice(&synonym.target_index_offset.to_le_bytes());
    }
    atomic_write(&cache.join("offsets.bin"), &offset_bytes)
}

#[derive(Debug)]
pub struct StarDictReader {
    index: Mmap,
    offsets: Mmap,
    synonyms: Option<Mmap>,
    entry_count: usize,
    synonym_count: usize,
    entry_table_start: usize,
    synonym_table_start: usize,
    data_offset_bytes: usize,
    data: DictionaryData,
}

impl StarDictReader {
    pub fn open(master: &Path, cache: &Path) -> Result<Self, StarDictError> {
        let inspected = inspect_stardict(master)?;
        let metadata = read_ifo(&inspected.source_path)?;
        let data_offset_bytes = index_data_offset_bytes(&metadata)?;
        let offsets_file = File::open(cache.join("offsets.bin"))
            .map_err(|error| io_error("indexUnavailable", error))?;
        // App-generated cache files and registered source files remain immutable
        // for the lifetime of a dictionary lookup session.
        let offsets = unsafe { MmapOptions::new().map(&offsets_file) }
            .map_err(|error| io_error("indexUnavailable", error))?;
        let (header, entry_table_start) = read_index_header(&offsets)?;
        if header.fingerprint != inspected.fingerprint {
            return Err(StarDictError::new(
                "staleIndex",
                "The StarDict source changed after its index was prepared.",
            ));
        }
        let entry_count = header.entry_count as usize;
        let synonym_count = header.synonym_count as usize;
        if entry_count == 0 || entry_count > MAX_ENTRIES || synonym_count > MAX_ENTRIES {
            return Err(StarDictError::new(
                "invalidDerivedIndex",
                "The derived StarDict index has an invalid entry count.",
            ));
        }
        let synonym_table_start = table_offset(entry_table_start, entry_count, 4)?;
        let expected_len = table_offset(synonym_table_start, synonym_count, 8)?;
        if offsets.len() != expected_len {
            return Err(invalid_derived(
                "The derived StarDict offset table has an invalid size.",
            ));
        }
        let index_path = used_file(&inspected, DictionaryFileKind::Index)?;
        let index_file =
            File::open(index_path).map_err(|error| io_error("indexUnavailable", error))?;
        let index = unsafe { MmapOptions::new().map(&index_file) }
            .map_err(|error| io_error("indexUnavailable", error))?;
        let synonyms = if synonym_count == 0 {
            None
        } else {
            optional_used_file(&inspected, DictionaryFileKind::Synonyms)
                .map(|path| {
                    let file =
                        File::open(path).map_err(|error| io_error("invalidSynonym", error))?;
                    unsafe { MmapOptions::new().map(&file) }
                        .map_err(|error| io_error("invalidSynonym", error))
                })
                .transpose()?
        };
        if synonym_count > 0 && synonyms.is_none() {
            return Err(invalid_derived(
                "The derived StarDict synonym table has no source file.",
            ));
        }
        let data = DictionaryData::open(&inspected)?;
        Ok(Self {
            index,
            offsets,
            synonyms,
            entry_count,
            synonym_count,
            entry_table_start,
            synonym_table_start,
            data_offset_bytes,
            data,
        })
    }

    pub fn lookup(&self, query: &str) -> Result<StarDictLookupResult, StarDictError> {
        let query = normalize_key(query);
        if query.is_empty() || query.len() > MAX_WORD_BYTES {
            return Ok(StarDictLookupResult {
                entries: Vec::new(),
            });
        }
        let mut source_matches = self.regular_matches(&query)?;
        source_matches.extend(self.synonym_matches(&query)?);
        source_matches.sort_by(|left, right| {
            left.index_offset
                .cmp(&right.index_offset)
                .then_with(|| left.headword.cmp(&right.headword))
        });
        source_matches.truncate(MAX_MATCHES);

        let mut matches: Vec<StarDictEntry> = Vec::new();
        for entry in source_matches {
            let bytes = self.data.read(entry.offset, entry.length)?;
            let definition = controlled_text(&bytes)?;
            if definition.is_empty() {
                continue;
            }
            if let Some(existing) = matches
                .iter_mut()
                .find(|current: &&mut StarDictEntry| current.headword == entry.headword)
            {
                existing.definitions.push(definition);
            } else {
                matches.push(StarDictEntry {
                    headword: entry.headword,
                    definitions: vec![definition],
                });
            }
        }
        Ok(StarDictLookupResult { entries: matches })
    }

    fn regular_matches(&self, query: &str) -> Result<Vec<SourceEntry>, StarDictError> {
        let low = lower_bound(self.entry_count, query, |index| {
            Ok(self.regular_entry_at(index)?.key)
        })?;
        let mut matches = Vec::new();
        for index in low..self.entry_count.min(low + MAX_MATCHES) {
            let entry = self.regular_entry_at(index)?;
            if entry.key != query {
                break;
            }
            matches.push(entry);
        }
        Ok(matches)
    }

    fn synonym_matches(&self, query: &str) -> Result<Vec<SourceEntry>, StarDictError> {
        let Some(synonyms) = &self.synonyms else {
            return Ok(Vec::new());
        };
        let low = lower_bound(self.synonym_count, query, |index| {
            Ok(self.synonym_entry_at(synonyms, index)?.0)
        })?;
        let mut matches = Vec::new();
        for index in low..self.synonym_count.min(low + MAX_MATCHES) {
            let (key, target_offset) = self.synonym_entry_at(synonyms, index)?;
            if key != query {
                break;
            }
            matches.push(parse_index_entry(&self.index, target_offset, self.data_offset_bytes)?.0);
        }
        Ok(matches)
    }

    fn regular_entry_at(&self, index: usize) -> Result<SourceEntry, StarDictError> {
        let offset_position = table_offset(self.entry_table_start, index, 4)?;
        let source_offset = read_u32_le(&self.offsets, offset_position)?;
        Ok(parse_index_entry(&self.index, source_offset, self.data_offset_bytes)?.0)
    }

    fn synonym_entry_at(
        &self,
        synonyms: &[u8],
        index: usize,
    ) -> Result<(String, u32), StarDictError> {
        let record_start = table_offset(self.synonym_table_start, index, 8)?;
        let synonym_offset = read_u32_le(&self.offsets, record_start)?;
        let target_offset = read_u32_le(&self.offsets, record_start + 4)?;
        let key = parse_synonym_key(synonyms, synonym_offset)?;
        Ok((normalize_key(&key), target_offset))
    }
}

fn lower_bound(
    length: usize,
    query: &str,
    mut key_at: impl FnMut(usize) -> Result<String, StarDictError>,
) -> Result<usize, StarDictError> {
    let (mut low, mut high) = (0, length);
    while low < high {
        let middle = low + (high - low) / 2;
        if key_at(middle)?.as_str() < query {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    Ok(low)
}

#[derive(Debug)]
enum DictionaryData {
    Plain {
        file: Mutex<File>,
        size: u64,
    },
    DictZip {
        file: Mutex<File>,
        table: DictZipTable,
    },
}

impl DictionaryData {
    fn open(inspected: &InspectedDictionary) -> Result<Self, StarDictError> {
        if let Some(path) = optional_used_file(inspected, DictionaryFileKind::Data) {
            let file = File::open(&path).map_err(|error| io_error("dataUnavailable", error))?;
            let size = file
                .metadata()
                .map_err(|error| io_error("dataUnavailable", error))?
                .len();
            return Ok(Self::Plain {
                file: Mutex::new(file),
                size,
            });
        }
        let path = used_file(inspected, DictionaryFileKind::CompressedData)?;
        let mut file = File::open(&path).map_err(|error| io_error("dataUnavailable", error))?;
        let table = DictZipTable::parse(&mut file)?;
        Ok(Self::DictZip {
            file: Mutex::new(file),
            table,
        })
    }

    fn read(&self, offset: u64, length: u32) -> Result<Vec<u8>, StarDictError> {
        if length as usize > MAX_DEFINITION_BYTES {
            return Err(StarDictError::new(
                "definitionTooLarge",
                "The StarDict definition exceeds the size limit.",
            ));
        }
        match self {
            Self::Plain { file, size } => {
                validate_range(offset, length, *size)?;
                let mut buffer = vec![0; length as usize];
                let mut file = file.lock().map_err(|_| {
                    StarDictError::new("dataLockFailed", "Dictionary data lock failed.")
                })?;
                file.seek(SeekFrom::Start(offset))
                    .and_then(|_| file.read_exact(&mut buffer))
                    .map_err(|error| io_error("dataReadFailed", error))?;
                Ok(buffer)
            }
            Self::DictZip { file, table } => table.read_range(file, offset, length),
        }
    }
}

#[derive(Debug)]
struct DictZipTable {
    chunk_length: u64,
    chunk_sizes: Vec<u16>,
    compressed_offsets: Vec<u64>,
    uncompressed_size: u64,
}

impl DictZipTable {
    fn parse(file: &mut File) -> Result<Self, StarDictError> {
        let file_size = file
            .metadata()
            .map_err(|error| io_error("invalidDictzip", error))?
            .len();
        if file_size < 18 {
            return Err(invalid_dictzip("The dictzip file is truncated."));
        }
        let mut header = [0_u8; 12];
        file.read_exact(&mut header)
            .map_err(|error| io_error("invalidDictzip", error))?;
        if header[0..3] != [0x1f, 0x8b, 0x08] || header[3] & 0x04 == 0 {
            return Err(invalid_dictzip("The gzip random-access header is missing."));
        }
        let extra_length = u16::from_le_bytes([header[10], header[11]]) as usize;
        let mut extra = vec![0; extra_length];
        file.read_exact(&mut extra)
            .map_err(|error| io_error("invalidDictzip", error))?;
        let mut cursor = 0;
        let mut random_access = None;
        while cursor + 4 <= extra.len() {
            let length = u16::from_le_bytes([extra[cursor + 2], extra[cursor + 3]]) as usize;
            let end = cursor + 4 + length;
            if end > extra.len() {
                return Err(invalid_dictzip("A dictzip extra field is truncated."));
            }
            if &extra[cursor..cursor + 2] == b"RA" {
                random_access = Some(&extra[cursor + 4..end]);
            }
            cursor = end;
        }
        let random_access = random_access
            .ok_or_else(|| invalid_dictzip("The dictzip random-access table is unavailable."))?;
        if random_access.len() < 6 {
            return Err(invalid_dictzip(
                "The dictzip random-access table is truncated.",
            ));
        }
        if u16::from_le_bytes([random_access[0], random_access[1]]) != 1 {
            return Err(invalid_dictzip(
                "The dictzip random-access version is unsupported.",
            ));
        }
        let chunk_length = u16::from_le_bytes([random_access[2], random_access[3]]) as u64;
        let chunk_count = u16::from_le_bytes([random_access[4], random_access[5]]) as usize;
        if chunk_length == 0
            || chunk_count == 0
            || chunk_count > MAX_DICTZIP_BLOCKS * 64
            || random_access.len() != 6 + chunk_count * 2
        {
            return Err(invalid_dictzip("The dictzip block table is invalid."));
        }
        let mut chunk_sizes = Vec::with_capacity(chunk_count);
        for index in 0..chunk_count {
            let start = 6 + index * 2;
            chunk_sizes.push(u16::from_le_bytes([
                random_access[start],
                random_access[start + 1],
            ]));
        }
        if chunk_sizes.contains(&0) {
            return Err(invalid_dictzip("A dictzip block has an invalid size."));
        }
        skip_gzip_optional_fields(file, header[3])?;
        let data_start = file
            .stream_position()
            .map_err(|error| io_error("invalidDictzip", error))?;
        let mut compressed_offsets = Vec::with_capacity(chunk_count);
        let mut compressed = data_start;
        for size in &chunk_sizes {
            compressed_offsets.push(compressed);
            compressed = compressed.saturating_add(*size as u64);
        }
        if compressed > file_size.saturating_sub(8) {
            return Err(invalid_dictzip("The dictzip block table exceeds the file."));
        }
        file.seek(SeekFrom::End(-4))
            .map_err(|error| io_error("invalidDictzip", error))?;
        let mut size = [0_u8; 4];
        file.read_exact(&mut size)
            .map_err(|error| io_error("invalidDictzip", error))?;
        Ok(Self {
            chunk_length,
            chunk_sizes,
            compressed_offsets,
            uncompressed_size: u32::from_le_bytes(size) as u64,
        })
    }

    fn read_range(
        &self,
        file: &Mutex<File>,
        offset: u64,
        length: u32,
    ) -> Result<Vec<u8>, StarDictError> {
        validate_range(offset, length, self.uncompressed_size)?;
        if length == 0 {
            return Ok(Vec::new());
        }
        let first = (offset / self.chunk_length) as usize;
        let last = ((offset + length as u64 - 1) / self.chunk_length) as usize;
        if last >= self.chunk_sizes.len() || last - first + 1 > MAX_DICTZIP_BLOCKS {
            return Err(invalid_dictzip(
                "The requested dictzip block range is invalid.",
            ));
        }
        let mut decoded = Vec::with_capacity((last - first + 1) * self.chunk_length as usize);
        let mut file = file
            .lock()
            .map_err(|_| StarDictError::new("dataLockFailed", "Dictionary data lock failed."))?;
        for block in first..=last {
            let compressed_size = self.chunk_sizes[block] as usize;
            let mut compressed = vec![0; compressed_size];
            file.seek(SeekFrom::Start(self.compressed_offsets[block]))
                .and_then(|_| file.read_exact(&mut compressed))
                .map_err(|error| io_error("dataReadFailed", error))?;
            let mut decoder = DeflateDecoder::new(compressed.as_slice());
            decoder
                .read_to_end(&mut decoded)
                .map_err(|error| io_error("invalidDictzip", error))?;
            if decoded.len() > (last - first + 1) * self.chunk_length as usize {
                return Err(invalid_dictzip(
                    "A dictzip block expands beyond its declared size.",
                ));
            }
        }
        let start = (offset % self.chunk_length) as usize;
        let end = start
            .checked_add(length as usize)
            .ok_or_else(|| invalid_dictzip("The requested dictzip range overflowed."))?;
        if end > decoded.len() {
            return Err(invalid_dictzip("The requested dictzip data is truncated."));
        }
        Ok(decoded[start..end].to_vec())
    }
}

fn inspect_stardict(master: &Path) -> Result<InspectedDictionary, StarDictError> {
    let inspected = inspect_dictionary_file(master)
        .map_err(|error| StarDictError::new(&error.code, error.message))?;
    if inspected.format != DictionaryFormat::StarDict {
        return Err(StarDictError::new(
            "formatMismatch",
            "The registered dictionary is not StarDict.",
        ));
    }
    Ok(inspected)
}

fn read_ifo(path: &Path) -> Result<std::collections::HashMap<String, String>, StarDictError> {
    let text = fs::read_to_string(path).map_err(|error| io_error("sourceUnreadable", error))?;
    Ok(text
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect())
}

fn parse_index(
    path: &Path,
    offset_bytes: usize,
    data_size: u64,
) -> Result<Vec<SourceEntry>, StarDictError> {
    let bytes = fs::read(path).map_err(|error| io_error("indexUnavailable", error))?;
    if bytes.len() > u32::MAX as usize {
        return Err(invalid_index(
            "The StarDict index exceeds the supported size.",
        ));
    }
    let mut cursor = 0_usize;
    let mut entries = Vec::new();
    while cursor < bytes.len() {
        if entries.len() >= MAX_ENTRIES {
            return Err(invalid_index("The StarDict index has too many entries."));
        }
        let (entry, next) = parse_index_entry(&bytes, cursor as u32, offset_bytes)?;
        validate_range(entry.offset, entry.length, data_size)
            .map_err(|_| invalid_index("A StarDict entry points outside dictionary data."))?;
        entries.push(entry);
        cursor = next;
    }
    if entries.is_empty() {
        return Err(invalid_index("The StarDict index is empty."));
    }
    Ok(entries)
}

fn parse_synonyms(path: &Path, source: &[SourceEntry]) -> Result<Vec<SynonymEntry>, StarDictError> {
    let bytes = fs::read(path).map_err(|error| io_error("invalidSynonym", error))?;
    if bytes.len() > u32::MAX as usize {
        return Err(invalid_synonym(
            "The StarDict synonym list exceeds the supported size.",
        ));
    }
    let mut cursor = 0_usize;
    let mut aliases = Vec::new();
    while cursor < bytes.len() {
        if aliases.len() >= MAX_ENTRIES {
            return Err(invalid_synonym("The StarDict synonym list is too large."));
        }
        let synonym_offset = cursor as u32;
        let end = bytes[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|relative| cursor + relative)
            .ok_or_else(|| invalid_synonym("A StarDict synonym is not terminated."))?;
        if end == cursor || end - cursor > MAX_WORD_BYTES || end + 5 > bytes.len() {
            return Err(invalid_synonym("A StarDict synonym record is invalid."));
        }
        let alias = std::str::from_utf8(&bytes[cursor..end])
            .map_err(|_| invalid_synonym("A StarDict synonym is not UTF-8."))?;
        cursor = end + 1;
        let ordinal = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
        cursor += 4;
        let target = source
            .get(ordinal)
            .ok_or_else(|| invalid_synonym("A StarDict synonym target is out of bounds."))?;
        aliases.push(SynonymEntry {
            key: normalize_key(alias),
            synonym_offset,
            target_index_offset: target.index_offset,
        });
    }
    Ok(aliases)
}

fn dictionary_uncompressed_size(inspected: &InspectedDictionary) -> Result<u64, StarDictError> {
    if let Some(path) = optional_used_file(inspected, DictionaryFileKind::Data) {
        return fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|error| io_error("dataUnavailable", error));
    }
    let path = used_file(inspected, DictionaryFileKind::CompressedData)?;
    let mut file = File::open(path).map_err(|error| io_error("dataUnavailable", error))?;
    file.seek(SeekFrom::End(-4))
        .map_err(|error| io_error("invalidDictzip", error))?;
    let mut bytes = [0_u8; 4];
    file.read_exact(&mut bytes)
        .map_err(|error| io_error("invalidDictzip", error))?;
    Ok(u32::from_le_bytes(bytes) as u64)
}

fn used_file(
    inspected: &InspectedDictionary,
    kind: DictionaryFileKind,
) -> Result<PathBuf, StarDictError> {
    optional_used_file(inspected, kind).ok_or_else(|| {
        StarDictError::new(
            "sourceMissing",
            "A required StarDict companion file is unavailable.",
        )
    })
}

fn optional_used_file(
    inspected: &InspectedDictionary,
    kind: DictionaryFileKind,
) -> Option<PathBuf> {
    inspected
        .files
        .iter()
        .find(|file| file.kind == kind && file.used)
        .map(|file| file.path.clone())
}

fn read_index_header(bytes: &[u8]) -> Result<(DerivedMetadata, usize), StarDictError> {
    let header_length = read_u32_le(bytes, 0)? as usize;
    let header_end = HEADER_LENGTH_BYTES
        .checked_add(header_length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| invalid_derived("The derived StarDict header is truncated."))?;
    let metadata: DerivedMetadata = serde_json::from_slice(&bytes[HEADER_LENGTH_BYTES..header_end])
        .map_err(|error| {
            invalid_derived(&format!("The derived StarDict header is invalid: {error}"))
        })?;
    if metadata.version != INDEX_VERSION {
        return Err(invalid_derived(
            "The derived StarDict index version is unsupported.",
        ));
    }
    Ok((metadata, header_end))
}

fn table_offset(start: usize, count: usize, width: usize) -> Result<usize, StarDictError> {
    count
        .checked_mul(width)
        .and_then(|length| start.checked_add(length))
        .ok_or_else(|| invalid_derived("The derived StarDict table size overflowed."))
}

fn index_data_offset_bytes(
    metadata: &std::collections::HashMap<String, String>,
) -> Result<usize, StarDictError> {
    match metadata.get("idxoffsetbits").map(String::as_str) {
        Some("64") => Ok(8),
        Some("32") | None => Ok(4),
        _ => Err(invalid_index("The StarDict offset width is invalid.")),
    }
}

fn parse_index_entry(
    bytes: &[u8],
    source_offset: u32,
    data_offset_bytes: usize,
) -> Result<(SourceEntry, usize), StarDictError> {
    let start = source_offset as usize;
    let end = bytes
        .get(start..)
        .and_then(|remaining| remaining.iter().position(|byte| *byte == 0))
        .map(|relative| start + relative)
        .ok_or_else(|| invalid_derived("A cached StarDict headword is not terminated."))?;
    if end == start || end - start > MAX_WORD_BYTES {
        return Err(invalid_derived(
            "A cached StarDict headword has an invalid length.",
        ));
    }
    let headword = std::str::from_utf8(&bytes[start..end])
        .map_err(|_| invalid_derived("A cached StarDict headword is not UTF-8."))?
        .to_string();
    let numeric_start = end + 1;
    let numeric_end = numeric_start
        .checked_add(data_offset_bytes + 4)
        .ok_or_else(|| invalid_derived("A cached StarDict index record overflowed."))?;
    if numeric_end > bytes.len() {
        return Err(invalid_derived(
            "A cached StarDict index record is truncated.",
        ));
    }
    let offset = if data_offset_bytes == 8 {
        u64::from_be_bytes(bytes[numeric_start..numeric_start + 8].try_into().unwrap())
    } else {
        u32::from_be_bytes(bytes[numeric_start..numeric_start + 4].try_into().unwrap()) as u64
    };
    let length_start = numeric_start + data_offset_bytes;
    let length = u32::from_be_bytes(bytes[length_start..numeric_end].try_into().unwrap());
    if length as usize > MAX_DEFINITION_BYTES {
        return Err(invalid_derived("A definition exceeds the size limit."));
    }
    Ok((
        SourceEntry {
            key: normalize_key(&headword),
            headword,
            offset,
            length,
            index_offset: source_offset,
        },
        numeric_end,
    ))
}

fn parse_synonym_key(bytes: &[u8], source_offset: u32) -> Result<String, StarDictError> {
    let start = source_offset as usize;
    let end = bytes
        .get(start..)
        .and_then(|remaining| remaining.iter().position(|byte| *byte == 0))
        .map(|relative| start + relative)
        .ok_or_else(|| invalid_derived("A cached StarDict synonym is not terminated."))?;
    if end == start || end - start > MAX_WORD_BYTES || end + 5 > bytes.len() {
        return Err(invalid_derived(
            "A cached StarDict synonym record is invalid.",
        ));
    }
    std::str::from_utf8(&bytes[start..end])
        .map(str::to_string)
        .map_err(|_| invalid_derived("A cached StarDict synonym is not UTF-8."))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, StarDictError> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| invalid_derived("A derived index offset overflowed."))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_derived("The derived index is truncated."))?;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn validate_range(offset: u64, length: u32, size: u64) -> Result<(), StarDictError> {
    if offset
        .checked_add(length as u64)
        .is_none_or(|end| end > size)
    {
        return Err(StarDictError::new(
            "dataOutOfBounds",
            "A StarDict entry points outside dictionary data.",
        ));
    }
    Ok(())
}

fn normalize_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn controlled_text(bytes: &[u8]) -> Result<String, StarDictError> {
    let value = std::str::from_utf8(bytes).map_err(|_| {
        StarDictError::new("invalidDefinition", "A StarDict definition is not UTF-8.")
    })?;
    Ok(value
        .chars()
        .filter(|character| *character == '\n' || *character == '\t' || !character.is_control())
        .collect::<String>()
        .trim()
        .to_string())
}

fn skip_gzip_optional_fields(file: &mut File, flags: u8) -> Result<(), StarDictError> {
    if flags & 0x08 != 0 {
        skip_zero_terminated(file)?;
    }
    if flags & 0x10 != 0 {
        skip_zero_terminated(file)?;
    }
    if flags & 0x02 != 0 {
        file.seek(SeekFrom::Current(2))
            .map_err(|error| io_error("invalidDictzip", error))?;
    }
    Ok(())
}

fn skip_zero_terminated(file: &mut File) -> Result<(), StarDictError> {
    for _ in 0..MAX_WORD_BYTES {
        let mut byte = [0_u8; 1];
        file.read_exact(&mut byte)
            .map_err(|error| io_error("invalidDictzip", error))?;
        if byte[0] == 0 {
            return Ok(());
        }
    }
    Err(invalid_dictzip("A gzip header field is too long."))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), StarDictError> {
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary).map_err(|error| io_error("indexWriteFailed", error))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| io_error("indexWriteFailed", error))?;
    if path.is_file() {
        fs::remove_file(path).map_err(|error| io_error("indexWriteFailed", error))?;
    }
    fs::rename(&temporary, path).map_err(|error| io_error("indexWriteFailed", error))
}

fn io_error(code: &str, error: std::io::Error) -> StarDictError {
    StarDictError::new(code, error.to_string())
}

fn invalid_index(message: &str) -> StarDictError {
    StarDictError::new("invalidIndex", message)
}

fn invalid_synonym(message: &str) -> StarDictError {
    StarDictError::new("invalidSynonym", message)
}

fn invalid_derived(message: &str) -> StarDictError {
    StarDictError::new("invalidDerivedIndex", message)
}

fn invalid_dictzip(message: &str) -> StarDictError {
    StarDictError::new("invalidDictzip", message)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{prepare_index, read_index_header, StarDictReader};
    use crate::dictionary::session::DictionarySessionManager;

    struct Fixture {
        cache: PathBuf,
        ifo: PathBuf,
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("flow-stardict-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_fixture(label: &str, entries: &[(&str, &str)], offset_bits: u8) -> Fixture {
        let root = temp_dir(label);
        let ifo = root.join("fixture.ifo");
        let idx = root.join("fixture.idx");
        let dict = root.join("fixture.dict");
        let cache = root.join("cache");
        let mut index = Vec::new();
        let mut data = Vec::new();
        for (word, definition) in entries {
            index.extend_from_slice(word.as_bytes());
            index.push(0);
            let offset = data.len() as u64;
            if offset_bits == 64 {
                index.extend_from_slice(&offset.to_be_bytes());
            } else {
                index.extend_from_slice(&(offset as u32).to_be_bytes());
            }
            index.extend_from_slice(&(definition.len() as u32).to_be_bytes());
            data.extend_from_slice(definition.as_bytes());
        }
        fs::write(&idx, &index).unwrap();
        fs::write(&dict, data).unwrap();
        fs::write(
            &ifo,
            format!(
                "StarDict's dict ifo file\nversion=2.4.2\nwordcount={}\nidxfilesize={}\nbookname=Fixture\nsametypesequence=m\n{}",
                entries.len(),
                index.len(),
                if offset_bits == 64 { "idxoffsetbits=64\n" } else { "" },
            ),
        )
        .unwrap();
        Fixture { cache, ifo, root }
    }

    fn definitions(reader: &StarDictReader, query: &str) -> Vec<String> {
        reader.lookup(query).unwrap().entries[0].definitions.clone()
    }

    #[test]
    fn builds_a_deterministic_sorted_index_and_queries_32_and_64_bit_offsets() {
        for bits in [32, 64] {
            let fixture = write_fixture(
                &format!("offset-{bits}"),
                &[("Zulu", "last"), ("alpha", "first"), ("alpha", "second")],
                bits,
            );
            prepare_index(&fixture.ifo, &fixture.cache).unwrap();
            let reader = StarDictReader::open(&fixture.ifo, &fixture.cache).unwrap();
            assert_eq!(definitions(&reader, "  ALPHA  "), ["first", "second"]);
            assert!(reader.lookup("missing").unwrap().entries.is_empty());
        }

        let first = write_fixture("deterministic-a", &[("b", "2"), ("a", "1")], 32);
        let second = write_fixture("deterministic-b", &[("b", "2"), ("a", "1")], 32);
        prepare_index(&first.ifo, &first.cache).unwrap();
        prepare_index(&second.ifo, &second.cache).unwrap();
        let first_offsets = fs::read(first.cache.join("offsets.bin")).unwrap();
        let second_offsets = fs::read(second.cache.join("offsets.bin")).unwrap();
        let first_start = read_index_header(&first_offsets).unwrap().1;
        let second_start = read_index_header(&second_offsets).unwrap().1;
        assert_eq!(
            &first_offsets[first_start..],
            &second_offsets[second_start..],
        );
    }

    #[test]
    fn rejects_truncated_and_out_of_bounds_indexes() {
        let truncated = write_fixture("truncated", &[("word", "definition")], 32);
        fs::write(truncated.root.join("fixture.idx"), b"word\0\0").unwrap();
        let error = prepare_index(&truncated.ifo, &truncated.cache).unwrap_err();
        assert_eq!(error.code, "invalidIndex");

        let out_of_bounds = write_fixture("bounds", &[("word", "definition")], 32);
        let mut index = fs::read(out_of_bounds.root.join("fixture.idx")).unwrap();
        let number = 1_000_000_u32.to_be_bytes();
        index[5..9].copy_from_slice(&number);
        fs::write(out_of_bounds.root.join("fixture.idx"), index).unwrap();
        let error = prepare_index(&out_of_bounds.ifo, &out_of_bounds.cache).unwrap_err();
        assert_eq!(error.code, "invalidIndex");
    }

    #[test]
    fn resolves_synonyms_by_original_entry_number_and_rejects_bad_targets() {
        let fixture = write_fixture("synonym", &[("alpha", "first"), ("beta", "second")], 32);
        let mut synonyms = b"alias\0".to_vec();
        synonyms.extend_from_slice(&1_u32.to_be_bytes());
        fs::write(fixture.root.join("fixture.syn"), synonyms).unwrap();
        prepare_index(&fixture.ifo, &fixture.cache).unwrap();
        let reader = StarDictReader::open(&fixture.ifo, &fixture.cache).unwrap();
        assert_eq!(definitions(&reader, "alias"), ["second"]);

        let invalid = write_fixture("bad-synonym", &[("alpha", "first")], 32);
        let mut synonyms = b"alias\0".to_vec();
        synonyms.extend_from_slice(&9_u32.to_be_bytes());
        fs::write(invalid.root.join("fixture.syn"), synonyms).unwrap();
        let error = prepare_index(&invalid.ifo, &invalid.cache).unwrap_err();
        assert_eq!(error.code, "invalidSynonym");
    }

    #[test]
    fn reads_only_the_dictzip_blocks_needed_by_the_hit() {
        let fixture = write_fixture("dictzip", &[], 32);
        fs::remove_file(fixture.root.join("fixture.dict")).unwrap();
        fs::write(fixture.root.join("fixture.dict.dz"), dictzip_fixture()).unwrap();
        let mut index = Vec::new();
        for (word, offset, length) in [
            ("first", 0_u32, 16_u32),
            ("middle", 16_u32, 32_u32),
            ("last", 48_u32, 15_u32),
        ] {
            index.extend_from_slice(word.as_bytes());
            index.push(0);
            index.extend_from_slice(&offset.to_be_bytes());
            index.extend_from_slice(&length.to_be_bytes());
        }
        fs::write(fixture.root.join("fixture.idx"), &index).unwrap();
        fs::write(
            &fixture.ifo,
            format!("StarDict's dict ifo file\nversion=2.4.2\nwordcount=3\nidxfilesize={}\nbookname=Fixture\nsametypesequence=m\n", index.len()),
        )
        .unwrap();
        prepare_index(&fixture.ifo, &fixture.cache).unwrap();
        let reader = StarDictReader::open(&fixture.ifo, &fixture.cache).unwrap();
        let result = reader.lookup("middle").unwrap();
        assert_eq!(
            result.entries[0].definitions,
            ["middle definition crosses chunks"]
        );
    }

    fn dictzip_fixture() -> &'static [u8] {
        &[
            0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0x03, 0x12, 0, 0x52, 0x41, 0x0e, 0, 0x01, 0,
            0x10, 0, 0x04, 0, 0x16, 0, 0x16, 0, 0x16, 0, 0x11, 0, 0x4a, 0xcb, 0x2c, 0x2a, 0x2e,
            0x51, 0x48, 0x49, 0x4d, 0xcb, 0xcc, 0xcb, 0x2c, 0xc9, 0xcc, 0xcf, 0x03, 0, 0, 0, 0xff,
            0xff, 0xca, 0xcd, 0x4c, 0x49, 0xc9, 0x49, 0x55, 0x48, 0x49, 0x4d, 0xcb, 0xcc, 0xcb,
            0x2c, 0xc9, 0xcc, 0x07, 0, 0, 0, 0xff, 0xff, 0xca, 0x53, 0x48, 0x2e, 0xca, 0x2f, 0x2e,
            0x4e, 0x2d, 0x56, 0x48, 0xce, 0x28, 0xcd, 0xcb, 0x2e, 0x06, 0, 0, 0, 0xff, 0xff, 0xcb,
            0x49, 0x2c, 0x2e, 0x51, 0x48, 0x49, 0x4d, 0xcb, 0xcc, 0xcb, 0x2c, 0xc9, 0xcc, 0xcf,
            0x03, 0, 0x49, 0x61, 0x9f, 0xe5, 0x3f, 0, 0, 0,
        ]
    }

    #[test]
    fn detects_source_changes_before_opening_derived_files() {
        let fixture = write_fixture("changed", &[("alpha", "first")], 32);
        prepare_index(&fixture.ifo, &fixture.cache).unwrap();
        fs::write(fixture.root.join("fixture.dict"), b"changed definition").unwrap();
        let error = StarDictReader::open(&fixture.ifo, &fixture.cache).unwrap_err();
        assert_eq!(error.code, "staleIndex");
    }

    #[test]
    fn fixture_paths_are_files_not_copied_dictionary_data() {
        let fixture = write_fixture("no-copy", &[("alpha", "first")], 32);
        prepare_index(&fixture.ifo, &fixture.cache).unwrap();
        let names = fs::read_dir(&fixture.cache)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, ["offsets.bin"]);
        assert!(Path::new(&fixture.root.join("fixture.dict")).is_file());
    }

    #[test]
    fn releases_mmaps_and_the_data_file_with_the_dictionary_session() {
        let fixture = write_fixture("session", &[("alpha", "first")], 32);
        prepare_index(&fixture.ifo, &fixture.cache).unwrap();
        let sessions = DictionarySessionManager::default();
        {
            let reader = sessions
                .get_or_open_stardict(7, "fixture", || {
                    StarDictReader::open(&fixture.ifo, &fixture.cache)
                })
                .unwrap();
            assert_eq!(definitions(&reader, "alpha"), ["first"]);
        }
        assert_eq!(sessions.release(7).unwrap(), 1);
        assert_eq!(sessions.release(7).unwrap(), 0);
    }
}
