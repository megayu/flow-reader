use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::import::{
    inspect_dictionary_file, DictionaryFileReference, DictionaryFormat, DictionaryImportError,
    InspectedDictionary, SourceFingerprint,
};
use super::stardict::{prepare_index, StarDictError};

const REGISTRY_VERSION: u32 = 1;
const DICTIONARIES_DIR: &str = "dictionaries";
const REGISTRY_FILE: &str = "registry.json";
const CACHE_DIR: &str = "cache";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DictionaryLanguage {
    En,
    Zh,
    Unknown,
}

impl Default for DictionaryLanguage {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DictionaryLanguageSource {
    Manual,
    Metadata,
    Sample,
    Unknown,
}

impl Default for DictionaryLanguageSource {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryLanguageSetting {
    #[serde(default)]
    pub value: DictionaryLanguage,
    #[serde(default)]
    pub source: DictionaryLanguageSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DictionarySourceStatus {
    Available,
    Changed,
    Missing,
}

impl Default for DictionarySourceStatus {
    fn default() -> Self {
        Self::Missing
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDictionaryRecord {
    pub id: String,
    pub name: String,
    pub format: DictionaryFormat,
    pub source_path: PathBuf,
    pub fingerprint: SourceFingerprint,
    #[serde(default)]
    pub files: Vec<DictionaryFileReference>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default)]
    pub order: u32,
    #[serde(default)]
    pub language: DictionaryLanguageSetting,
    #[serde(default)]
    pub source_status: DictionarySourceStatus,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDictionaryUpdate {
    pub enabled: Option<bool>,
    pub order: Option<u32>,
    pub language: Option<DictionaryLanguage>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryRegistryError {
    pub code: String,
    pub message: String,
}

impl DictionaryRegistryError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl From<DictionaryImportError> for DictionaryRegistryError {
    fn from(error: DictionaryImportError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl From<StarDictError> for DictionaryRegistryError {
    fn from(error: StarDictError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl std::fmt::Display for DictionaryRegistryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for DictionaryRegistryError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    dictionaries: Vec<LocalDictionaryRecord>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            dictionaries: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct DictionaryRegistryStore {
    registry_path: PathBuf,
    cache_root: PathBuf,
    state: Mutex<RegistryFile>,
    startup_error: Option<DictionaryRegistryError>,
}

impl DictionaryRegistryStore {
    pub fn open(app_data_root: &Path) -> Result<Self, DictionaryRegistryError> {
        let root = app_data_root.join(DICTIONARIES_DIR);
        let registry_path = root.join(REGISTRY_FILE);
        let cache_root = root.join(CACHE_DIR);
        let temp_registry = registry_path.with_extension("tmp");
        if temp_registry.exists() {
            fs::remove_file(&temp_registry).map_err(|error| {
                DictionaryRegistryError::new(
                    "registryCleanupFailed",
                    format!("Cannot clean an interrupted registry write: {error}"),
                )
            })?;
        }

        let state = load_registry(&registry_path)?;
        validate_registry(&state)?;
        cleanup_orphaned_caches(&cache_root, &state)?;
        Ok(Self {
            registry_path,
            cache_root,
            state: Mutex::new(state),
            startup_error: None,
        })
    }

    pub fn open_for_app(app_data_root: &Path) -> Self {
        match Self::open(app_data_root) {
            Ok(store) => store,
            Err(error) => {
                let root = app_data_root.join(DICTIONARIES_DIR);
                Self {
                    registry_path: root.join(REGISTRY_FILE),
                    cache_root: root.join(CACHE_DIR),
                    state: Mutex::new(RegistryFile::default()),
                    startup_error: Some(error),
                }
            }
        }
    }

    pub fn list(&self) -> Result<Vec<LocalDictionaryRecord>, DictionaryRegistryError> {
        self.ensure_available()?;
        let state = self.lock()?;
        let mut dictionaries = state.dictionaries.clone();
        dictionaries.iter_mut().for_each(refresh_source_status);
        dictionaries.sort_by_key(|dictionary| (dictionary.order, dictionary.created_at));
        Ok(dictionaries)
    }

    pub fn get(&self, id: &str) -> Result<LocalDictionaryRecord, DictionaryRegistryError> {
        self.ensure_available()?;
        if !valid_dictionary_id(id) {
            return Err(DictionaryRegistryError::new(
                "invalidDictionaryId",
                "The dictionary identifier is invalid.",
            ));
        }
        let state = self.lock()?;
        let mut record = state
            .dictionaries
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or_else(|| {
                DictionaryRegistryError::new(
                    "dictionaryNotFound",
                    "The dictionary is not registered.",
                )
            })?;
        refresh_source_status(&mut record);
        Ok(record)
    }

    pub fn cache_path(&self, id: &str) -> Result<PathBuf, DictionaryRegistryError> {
        if !valid_dictionary_id(id) {
            return Err(DictionaryRegistryError::new(
                "invalidDictionaryId",
                "The dictionary identifier is invalid.",
            ));
        }
        Ok(self.cache_root.join(id))
    }

    pub fn register(
        &self,
        source_path: &Path,
    ) -> Result<LocalDictionaryRecord, DictionaryRegistryError> {
        self.ensure_available()?;
        let inspected = inspect_dictionary_file(source_path)?;
        let mut state = self.lock()?;
        let mut next = state.clone();
        let now = unix_time_ms();

        let record = if let Some(existing) = next
            .dictionaries
            .iter_mut()
            .find(|record| record.source_path == inspected.source_path)
        {
            apply_inspection(existing, inspected, now);
            existing.clone()
        } else {
            let id = dictionary_id(&inspected.source_path);
            if next.dictionaries.iter().any(|record| record.id == id) {
                return Err(DictionaryRegistryError::new(
                    "duplicateDictionaryId",
                    "The dictionary identifier conflicts with an existing record.",
                ));
            }
            let record = record_from_inspection(id, inspected, next.dictionaries.len() as u32, now);
            next.dictionaries.push(record.clone());
            record
        };

        let cache = self.cache_root.join(&record.id);
        let cache_existed = cache.exists();
        fs::create_dir_all(&cache).map_err(|error| {
            DictionaryRegistryError::new(
                "cacheCreateFailed",
                format!("Cannot prepare the dictionary cache folder: {error}"),
            )
        })?;
        if record.format == DictionaryFormat::StarDict {
            if let Err(error) = prepare_index(&record.source_path, &cache) {
                if !cache_existed {
                    let _ = fs::remove_dir_all(&cache);
                }
                return Err(error.into());
            }
        }
        if let Err(error) = persist_registry(&self.registry_path, &next) {
            if !cache_existed {
                let _ = fs::remove_dir_all(&cache);
            }
            return Err(error);
        }
        *state = next;
        Ok(record)
    }

    pub fn update(
        &self,
        id: &str,
        update: LocalDictionaryUpdate,
    ) -> Result<LocalDictionaryRecord, DictionaryRegistryError> {
        self.ensure_available()?;
        let mut state = self.lock()?;
        let mut next = state.clone();
        let record = find_record_mut(&mut next, id)?;
        if let Some(enabled) = update.enabled {
            record.enabled = enabled;
        }
        if let Some(order) = update.order {
            record.order = order;
        }
        if let Some(language) = update.language {
            record.language = DictionaryLanguageSetting {
                value: language,
                source: DictionaryLanguageSource::Manual,
            };
        }
        if let Some(name) = update.name {
            let name = name.trim();
            if name.is_empty() {
                return Err(DictionaryRegistryError::new(
                    "invalidDictionaryName",
                    "Dictionary name cannot be empty.",
                ));
            }
            record.name = name.to_string();
        }
        record.updated_at = unix_time_ms();
        let result = record.clone();
        persist_registry(&self.registry_path, &next)?;
        *state = next;
        Ok(result)
    }

    pub fn relocate(
        &self,
        id: &str,
        source_path: &Path,
    ) -> Result<LocalDictionaryRecord, DictionaryRegistryError> {
        self.ensure_available()?;
        let inspected = inspect_dictionary_file(source_path)?;
        let mut state = self.lock()?;
        if state
            .dictionaries
            .iter()
            .any(|record| record.id != id && record.source_path == inspected.source_path)
        {
            return Err(DictionaryRegistryError::new(
                "duplicateSourcePath",
                "This master file is already registered.",
            ));
        }

        let mut next = state.clone();
        let record = find_record_mut(&mut next, id)?;
        if record.format != inspected.format {
            return Err(DictionaryRegistryError::new(
                "formatMismatch",
                "The replacement master file must use the same dictionary format.",
            ));
        }
        apply_inspection(record, inspected, unix_time_ms());
        let result = record.clone();
        if result.format == DictionaryFormat::StarDict {
            prepare_index(&result.source_path, &self.cache_root.join(id))?;
        }
        persist_registry(&self.registry_path, &next)?;
        *state = next;
        Ok(result)
    }

    pub fn remove(&self, id: &str) -> Result<(), DictionaryRegistryError> {
        self.ensure_available()?;
        if !valid_dictionary_id(id) {
            return Err(DictionaryRegistryError::new(
                "invalidDictionaryId",
                "The dictionary identifier is invalid.",
            ));
        }
        let mut state = self.lock()?;
        let mut next = state.clone();
        let initial_len = next.dictionaries.len();
        next.dictionaries.retain(|record| record.id != id);
        if next.dictionaries.len() == initial_len {
            return Err(DictionaryRegistryError::new(
                "dictionaryNotFound",
                "The dictionary is not registered.",
            ));
        }
        let cache = self.cache_root.join(id);
        if cache.exists() {
            fs::remove_dir_all(&cache).map_err(|error| {
                DictionaryRegistryError::new(
                    "cacheRemoveFailed",
                    format!("Cannot remove the app-generated dictionary cache: {error}"),
                )
            })?;
        }
        persist_registry(&self.registry_path, &next)?;
        *state = next;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, RegistryFile>, DictionaryRegistryError> {
        self.state.lock().map_err(|_| {
            DictionaryRegistryError::new("registryLockFailed", "Dictionary registry lock failed.")
        })
    }

    fn ensure_available(&self) -> Result<(), DictionaryRegistryError> {
        match &self.startup_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

fn load_registry(path: &Path) -> Result<RegistryFile, DictionaryRegistryError> {
    if !path.exists() {
        return Ok(RegistryFile::default());
    }
    let bytes = fs::read(path).map_err(|error| {
        DictionaryRegistryError::new(
            "registryUnreadable",
            format!("Cannot read the dictionary registry: {error}"),
        )
    })?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        DictionaryRegistryError::new(
            "registryDamaged",
            format!("The dictionary registry is damaged: {error}"),
        )
    })?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    if version > REGISTRY_VERSION {
        return Err(DictionaryRegistryError::new(
            "registryVersionUnsupported",
            "The dictionary registry was created by a newer app version.",
        ));
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("version".to_string(), REGISTRY_VERSION.into());
    }
    serde_json::from_value(value).map_err(|error| {
        DictionaryRegistryError::new(
            "registryDamaged",
            format!("The dictionary registry is invalid: {error}"),
        )
    })
}

fn validate_registry(registry: &RegistryFile) -> Result<(), DictionaryRegistryError> {
    let mut ids = HashSet::new();
    for record in &registry.dictionaries {
        if !valid_dictionary_id(&record.id) || !ids.insert(&record.id) {
            return Err(DictionaryRegistryError::new(
                "duplicateDictionaryId",
                "The dictionary registry contains a duplicate or invalid identifier.",
            ));
        }
        if !record.source_path.is_absolute() {
            return Err(DictionaryRegistryError::new(
                "invalidSourcePath",
                "Dictionary source paths must be absolute.",
            ));
        }
    }
    Ok(())
}

fn cleanup_orphaned_caches(
    cache_root: &Path,
    registry: &RegistryFile,
) -> Result<(), DictionaryRegistryError> {
    if !cache_root.exists() {
        return Ok(());
    }
    let registered = registry
        .dictionaries
        .iter()
        .map(|record| record.id.as_str())
        .collect::<HashSet<_>>();
    for entry in fs::read_dir(cache_root).map_err(|error| {
        DictionaryRegistryError::new(
            "registryCleanupFailed",
            format!("Cannot inspect dictionary caches: {error}"),
        )
    })? {
        let entry = entry.map_err(|error| {
            DictionaryRegistryError::new(
                "registryCleanupFailed",
                format!("Cannot inspect a dictionary cache: {error}"),
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_dir()
            && valid_dictionary_id(&name)
            && !registered.contains(name.as_str())
        {
            fs::remove_dir_all(entry.path()).map_err(|error| {
                DictionaryRegistryError::new(
                    "registryCleanupFailed",
                    format!("Cannot remove an interrupted dictionary cache: {error}"),
                )
            })?;
        }
    }
    Ok(())
}

fn persist_registry(path: &Path, registry: &RegistryFile) -> Result<(), DictionaryRegistryError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            DictionaryRegistryError::new(
                "registryWriteFailed",
                format!("Cannot create the dictionary registry folder: {error}"),
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(registry).map_err(|error| {
        DictionaryRegistryError::new(
            "registryWriteFailed",
            format!("Cannot encode the dictionary registry: {error}"),
        )
    })?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|error| {
        DictionaryRegistryError::new(
            "registryWriteFailed",
            format!("Cannot write the dictionary registry: {error}"),
        )
    })?;
    if let Err(error) = fs::rename(&temp, path) {
        let backup = path.with_extension("bak");
        if path.exists() {
            let _ = fs::remove_file(&backup);
            fs::rename(path, &backup).map_err(|backup_error| {
                DictionaryRegistryError::new(
                    "registryWriteFailed",
                    format!("Cannot replace the dictionary registry: {backup_error}"),
                )
            })?;
        }
        if let Err(replace_error) = fs::rename(&temp, path) {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(DictionaryRegistryError::new(
                "registryWriteFailed",
                format!("Cannot replace the dictionary registry: {error}; {replace_error}"),
            ));
        }
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn record_from_inspection(
    id: String,
    inspected: InspectedDictionary,
    order: u32,
    now: u64,
) -> LocalDictionaryRecord {
    let language = automatic_language(&inspected);
    LocalDictionaryRecord {
        id,
        name: inspected.name,
        format: inspected.format,
        source_path: inspected.source_path,
        fingerprint: inspected.fingerprint,
        files: inspected.files,
        enabled: true,
        order,
        language,
        source_status: DictionarySourceStatus::Available,
        created_at: now,
        updated_at: now,
    }
}

fn apply_inspection(record: &mut LocalDictionaryRecord, inspected: InspectedDictionary, now: u64) {
    let automatic_language = automatic_language(&inspected);
    record.name = inspected.name;
    record.format = inspected.format;
    record.source_path = inspected.source_path;
    record.fingerprint = inspected.fingerprint;
    record.files = inspected.files;
    record.source_status = DictionarySourceStatus::Available;
    record.updated_at = now;
    if record.language.source != DictionaryLanguageSource::Manual {
        record.language = automatic_language;
    }
}

fn automatic_language(inspected: &InspectedDictionary) -> DictionaryLanguageSetting {
    let value = match inspected.metadata_language.as_deref() {
        Some("en") => DictionaryLanguage::En,
        Some("zh") => DictionaryLanguage::Zh,
        _ => DictionaryLanguage::Unknown,
    };
    DictionaryLanguageSetting {
        source: if value == DictionaryLanguage::Unknown {
            DictionaryLanguageSource::Unknown
        } else {
            DictionaryLanguageSource::Metadata
        },
        value,
    }
}

fn refresh_source_status(record: &mut LocalDictionaryRecord) {
    if !record.source_path.is_file() {
        record.source_status = DictionarySourceStatus::Missing;
        return;
    }
    record.source_status = match inspect_dictionary_file(&record.source_path) {
        Ok(inspected) if inspected.fingerprint == record.fingerprint => {
            DictionarySourceStatus::Available
        }
        _ => DictionarySourceStatus::Changed,
    };
}

fn find_record_mut<'a>(
    registry: &'a mut RegistryFile,
    id: &str,
) -> Result<&'a mut LocalDictionaryRecord, DictionaryRegistryError> {
    registry
        .dictionaries
        .iter_mut()
        .find(|record| record.id == id)
        .ok_or_else(|| {
            DictionaryRegistryError::new("dictionaryNotFound", "The dictionary is not registered.")
        })
}

fn dictionary_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("dict-{}", &digest[..20])
}

fn valid_dictionary_id(id: &str) -> bool {
    id.strip_prefix("dict-")
        .is_some_and(|suffix| suffix.len() == 20 && suffix.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{
        DictionaryLanguage, DictionaryLanguageSource, DictionaryRegistryStore,
        DictionarySourceStatus, LocalDictionaryUpdate,
    };

    fn temp_dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "flow-reader-dictionary-registry-{name}-{}-{}",
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
            "StarDict's dict ifo file\nversion=2.4.2\nwordcount=1\nidxfilesize=13\nbookname=Registry Test\nlang_from=English\nsametypesequence=m\n",
        )
        .unwrap();
        let mut index = b"entry\0".to_vec();
        index.extend_from_slice(&0_u32.to_be_bytes());
        index.extend_from_slice(&11_u32.to_be_bytes());
        fs::write(root.join(format!("{stem}.idx")), index).unwrap();
        fs::write(root.join(format!("{stem}.dict")), b"source body").unwrap();
        ifo
    }

    #[test]
    fn handles_missing_migrated_damaged_and_invalid_registries() {
        let root = temp_dir("load");
        let store = DictionaryRegistryStore::open(&root).unwrap();
        assert!(store.list().unwrap().is_empty());

        let dictionaries = root.join("dictionaries");
        fs::create_dir_all(&dictionaries).unwrap();
        fs::write(dictionaries.join("registry.json"), b"{").unwrap();
        assert_eq!(
            DictionaryRegistryStore::open(&root).unwrap_err().code,
            "registryDamaged"
        );
        assert_eq!(
            DictionaryRegistryStore::open_for_app(&root)
                .list()
                .unwrap_err()
                .code,
            "registryDamaged"
        );

        fs::write(
            dictionaries.join("registry.json"),
            r#"{"version":0,"dictionaries":[]}"#,
        )
        .unwrap();
        assert!(DictionaryRegistryStore::open(&root)
            .unwrap()
            .list()
            .unwrap()
            .is_empty());

        fs::write(
            dictionaries.join("registry.json"),
            r#"{"version":1,"dictionaries":[{"id":"dict-00000000000000000000","name":"one","format":"mdict","sourcePath":"relative.mdx","fingerprint":{"size":1,"modifiedMs":0,"sampleHash":"x"}},{"id":"dict-00000000000000000000","name":"two","format":"mdict","sourcePath":"relative2.mdx","fingerprint":{"size":1,"modifiedMs":0,"sampleHash":"x"}}]}"#,
        )
        .unwrap();
        assert_eq!(
            DictionaryRegistryStore::open(&root).unwrap_err().code,
            "duplicateDictionaryId"
        );
        fs::write(
            dictionaries.join("registry.json"),
            r#"{"version":1,"dictionaries":[{"id":"dict-11111111111111111111","name":"relative","format":"mdict","sourcePath":"relative.mdx","fingerprint":{"size":1,"modifiedMs":0,"sampleHash":"x"}}]}"#,
        )
        .unwrap();
        assert_eq!(
            DictionaryRegistryStore::open(&root).unwrap_err().code,
            "invalidSourcePath"
        );
        fs::write(
            dictionaries.join("registry.json"),
            r#"{"version":1,"dictionaries":[{"id":"dict-22222222222222222222"}]}"#,
        )
        .unwrap();
        assert_eq!(
            DictionaryRegistryStore::open(&root).unwrap_err().code,
            "registryDamaged"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_registration_refreshes_record_and_manual_language_wins() {
        let root = temp_dir("duplicate");
        let sources = root.join("sources");
        fs::create_dir_all(&sources).unwrap();
        let ifo = write_stardict(&sources, "alpha");
        let store = DictionaryRegistryStore::open(&root).unwrap();
        let first = store.register(&ifo).unwrap();
        assert_eq!(first.language.value, DictionaryLanguage::En);
        let manual = store
            .update(
                &first.id,
                LocalDictionaryUpdate {
                    language: Some(DictionaryLanguage::Zh),
                    ..LocalDictionaryUpdate::default()
                },
            )
            .unwrap();
        assert_eq!(manual.language.source, DictionaryLanguageSource::Manual);
        fs::write(&ifo, "StarDict's dict ifo file\nbookname=Refreshed\n").unwrap();
        let refreshed = store.register(&ifo).unwrap();
        assert_eq!(refreshed.id, first.id);
        assert_eq!(refreshed.name, "Refreshed");
        assert_eq!(refreshed.language.value, DictionaryLanguage::Zh);
        assert_eq!(store.list().unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn renamed_dictionary_name_is_trimmed_and_persisted() {
        let root = temp_dir("rename");
        let sources = root.join("sources");
        fs::create_dir_all(&sources).unwrap();
        let ifo = write_stardict(&sources, "fixture");
        let store = DictionaryRegistryStore::open(&root).unwrap();
        let record = store.register(&ifo).unwrap();

        let renamed = store
            .update(
                &record.id,
                LocalDictionaryUpdate {
                    name: Some("  Reader Lexicon  ".to_string()),
                    ..LocalDictionaryUpdate::default()
                },
            )
            .unwrap();

        assert_eq!(renamed.name, "Reader Lexicon");
        drop(store);
        assert_eq!(
            DictionaryRegistryStore::open(&root)
                .unwrap()
                .list()
                .unwrap()[0]
                .name,
            "Reader Lexicon"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reports_missing_sources_and_remove_never_deletes_user_files() {
        let root = temp_dir("remove");
        let sources = root.join("sources");
        fs::create_dir_all(&sources).unwrap();
        let ifo = write_stardict(&sources, "alpha");
        let data = sources.join("alpha.dict");
        let store = DictionaryRegistryStore::open(&root).unwrap();
        let record = store.register(&ifo).unwrap();
        fs::remove_file(&ifo).unwrap();
        assert_eq!(
            store.list().unwrap()[0].source_status,
            DictionarySourceStatus::Missing
        );
        store.remove(&record.id).unwrap();
        assert!(data.exists());
        assert!(store.list().unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_temp_registry_is_cleaned_without_creating_a_record() {
        let root = temp_dir("interrupted");
        let dictionaries = root.join("dictionaries");
        fs::create_dir_all(&dictionaries).unwrap();
        fs::write(dictionaries.join("registry.tmp"), b"partial").unwrap();
        let orphan = dictionaries.join("cache").join("dict-deadbeefdeadbeefdead");
        fs::create_dir_all(&orphan).unwrap();
        let store = DictionaryRegistryStore::open(&root).unwrap();
        assert!(!dictionaries.join("registry.tmp").exists());
        assert!(!orphan.exists());
        assert!(store.list().unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
