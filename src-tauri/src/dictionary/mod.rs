pub mod http;
pub mod import;
pub mod registry;
pub mod session;

use http::{DictionaryHttpClient, DictionaryHttpError, DictionaryHttpResponse};
use registry::{
    DictionaryRegistryError, DictionaryRegistryStore, LocalDictionaryRecord, LocalDictionaryUpdate,
};
use session::DictionarySessionManager;

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
