pub mod http;
pub mod import;
pub mod mdict;
pub mod registry;
pub mod session;
pub mod stardict;

use http::{
    DictionaryHttpClient, DictionaryHttpDiagnostics, DictionaryHttpError, DictionaryHttpResponse,
};
use mdict::{MdictError, MdictLookupResponse, MdictReader, MdictTextResource};
use registry::{
    DictionaryRegistryError, DictionaryRegistryStore, LocalDictionaryRecord, LocalDictionaryUpdate,
};
use serde::Serialize;
use session::{DictionarySessionDiagnostics, DictionarySessionManager};
use stardict::{prepare_index, StarDictError, StarDictLookupResult, StarDictReader};

pub fn create_http_client() -> Result<DictionaryHttpClient, DictionaryHttpError> {
    DictionaryHttpClient::new()
}

#[tauri::command]
pub async fn fetch_zdic(
    client: tauri::State<'_, DictionaryHttpClient>,
    query: String,
    session_id: u64,
) -> Result<DictionaryHttpResponse, DictionaryHttpError> {
    client.fetch_zdic(&query, session_id).await
}

#[tauri::command]
pub async fn fetch_merriam_webster(
    client: tauri::State<'_, DictionaryHttpClient>,
    query: String,
    key: String,
    session_id: u64,
) -> Result<DictionaryHttpResponse, DictionaryHttpError> {
    client.fetch_merriam_webster(&query, &key, session_id).await
}

#[tauri::command]
pub fn cancel_dictionary_session(
    client: tauri::State<'_, DictionaryHttpClient>,
    sessions: tauri::State<'_, DictionarySessionManager>,
    session_id: u64,
) {
    client.cancel_session(session_id);
    let _ = sessions.release(session_id);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryRuntimeDiagnostics {
    http: DictionaryHttpDiagnostics,
    local: DictionarySessionDiagnostics,
}

#[tauri::command]
pub fn dictionary_runtime_diagnostics(
    client: tauri::State<'_, DictionaryHttpClient>,
    sessions: tauri::State<'_, DictionarySessionManager>,
) -> Result<DictionaryRuntimeDiagnostics, String> {
    Ok(DictionaryRuntimeDiagnostics {
        http: client.diagnostics(),
        local: sessions.diagnostics()?,
    })
}

#[tauri::command]
pub fn list_local_dictionaries(
    registry: tauri::State<'_, DictionaryRegistryStore>,
) -> Result<Vec<LocalDictionaryRecord>, DictionaryRegistryError> {
    registry.list()
}

#[tauri::command]
pub fn register_local_dictionary(
    registry: tauri::State<'_, DictionaryRegistryStore>,
    path: String,
) -> Result<LocalDictionaryRecord, DictionaryRegistryError> {
    registry.register(std::path::Path::new(&path))
}

#[tauri::command]
pub fn update_local_dictionary(
    registry: tauri::State<'_, DictionaryRegistryStore>,
    id: String,
    changes: LocalDictionaryUpdate,
) -> Result<LocalDictionaryRecord, DictionaryRegistryError> {
    registry.update(&id, changes)
}

#[tauri::command]
pub fn relocate_local_dictionary(
    registry: tauri::State<'_, DictionaryRegistryStore>,
    id: String,
    path: String,
) -> Result<LocalDictionaryRecord, DictionaryRegistryError> {
    registry.relocate(&id, std::path::Path::new(&path))
}

#[tauri::command]
pub fn remove_local_dictionary(
    registry: tauri::State<'_, DictionaryRegistryStore>,
    id: String,
) -> Result<(), DictionaryRegistryError> {
    registry.remove(&id)
}

#[tauri::command]
pub fn lookup_stardict(
    registry: tauri::State<'_, DictionaryRegistryStore>,
    sessions: tauri::State<'_, DictionarySessionManager>,
    dictionary_id: String,
    query: String,
    session_id: u64,
) -> Result<StarDictLookupResult, StarDictError> {
    let record = registry
        .get(&dictionary_id)
        .map_err(|error| StarDictError::new(&error.code, error.message))?;
    if !record.enabled {
        return Err(StarDictError::new(
            "dictionaryDisabled",
            "The local dictionary is disabled.",
        ));
    }
    if record.source_status != registry::DictionarySourceStatus::Available {
        return Err(StarDictError::new(
            "sourceChanged",
            "The local dictionary source is missing or changed.",
        ));
    }
    if record.format != import::DictionaryFormat::StarDict {
        return Err(StarDictError::new(
            "formatMismatch",
            "The selected local dictionary is not StarDict.",
        ));
    }
    let cache = registry
        .cache_path(&dictionary_id)
        .map_err(|error| StarDictError::new(&error.code, error.message))?;
    if !cache.join("offsets.bin").is_file() {
        prepare_index(&record.source_path, &cache)?;
    }
    let reader = sessions.get_or_open_stardict(session_id, &dictionary_id, || {
        StarDictReader::open(&record.source_path, &cache)
    })?;
    reader.lookup(&query)
}

#[tauri::command]
pub fn lookup_mdict(
    registry: tauri::State<'_, DictionaryRegistryStore>,
    sessions: tauri::State<'_, DictionarySessionManager>,
    dictionary_id: String,
    query: String,
    session_id: u64,
) -> Result<MdictLookupResponse, MdictError> {
    let record = mdict_record(&registry, &dictionary_id)?;
    let reader = sessions.get_or_open_mdict(session_id, &dictionary_id, || {
        MdictReader::open(&record.source_path)
    })?;
    let entry = reader.lookup(&query)?;
    Ok(MdictLookupResponse {
        diagnostics: reader.diagnostics()?,
        entry,
        resource_url_prefix: mdict::resource_url_prefix(session_id, &dictionary_id),
    })
}

#[tauri::command]
pub fn load_mdict_stylesheet(
    registry: tauri::State<'_, DictionaryRegistryStore>,
    sessions: tauri::State<'_, DictionarySessionManager>,
    dictionary_id: String,
    key: String,
    session_id: u64,
) -> Result<Option<MdictTextResource>, MdictError> {
    let record = mdict_record(&registry, &dictionary_id)?;
    let reader = sessions.get_or_open_mdict(session_id, &dictionary_id, || {
        MdictReader::open(&record.source_path)
    })?;
    reader.load_stylesheet(&key)
}

fn mdict_record(
    registry: &DictionaryRegistryStore,
    dictionary_id: &str,
) -> Result<LocalDictionaryRecord, MdictError> {
    let record = registry
        .get(dictionary_id)
        .map_err(|error| MdictError::new(&error.code, error.message))?;
    if !record.enabled {
        return Err(MdictError::new(
            "dictionaryDisabled",
            "The local dictionary is disabled.",
        ));
    }
    if record.source_status != registry::DictionarySourceStatus::Available {
        return Err(MdictError::new(
            "sourceChanged",
            "The local dictionary source is missing or changed.",
        ));
    }
    if record.format != import::DictionaryFormat::MDict {
        return Err(MdictError::new(
            "formatMismatch",
            "The selected local dictionary is not MDict.",
        ));
    }
    Ok(record)
}
