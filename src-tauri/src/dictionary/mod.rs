pub mod http;

use http::{DictionaryHttpClient, DictionaryHttpError, DictionaryHttpResponse};

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
pub fn cancel_dictionary_session(client: tauri::State<'_, DictionaryHttpClient>, session_id: u64) {
    client.cancel_session(session_id);
}
