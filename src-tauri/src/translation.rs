use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

const GOOGLE_URL: &str = "https://translate.googleapis.com/translate_a/single";
const AZURE_AUTH_URL: &str = "https://edge.microsoft.com/translate/auth";
const AZURE_TRANSLATE_URL: &str = "https://api-edge.cognitive.microsofttranslator.com/translate";
const MAX_TEXT_BYTES: usize = 40 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const AZURE_TOKEN_TTL: Duration = Duration::from_secs(9 * 60);
const PRE_CANCELLED_SESSION_TTL: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranslationProvider {
    Google,
    Azure,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRequest {
    provider: TranslationProvider,
    texts: Vec<String>,
    source_language: String,
    target_language: String,
    session_id: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResponse {
    bodies: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TranslationError {
    code: String,
    message: String,
}

impl TranslationError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

struct CachedToken {
    value: String,
    expires_at: Instant,
}

pub struct TranslationHttpClient {
    client: Client,
    azure_token: Mutex<Option<CachedToken>>,
    sessions: Mutex<TranslationSessions>,
}

#[derive(Default)]
struct TranslationSessions {
    active: HashMap<u64, CancellationToken>,
    pre_cancelled: HashMap<u64, Instant>,
}

impl TranslationSessions {
    fn prune_pre_cancelled(&mut self, now: Instant) {
        self.pre_cancelled
            .retain(|_, cancelled_at| now.duration_since(*cancelled_at) <= PRE_CANCELLED_SESSION_TTL);
    }
}

impl TranslationHttpClient {
    pub fn new() -> Result<Self, TranslationError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(12))
            .redirect(Policy::limited(2))
            .build()
            .map_err(|error| TranslationError::new("configuration", error.to_string()))?;
        Ok(Self {
            client,
            azure_token: Mutex::new(None),
            sessions: Mutex::new(TranslationSessions::default()),
        })
    }

    async fn translate(&self, request: TranslationRequest) -> Result<TranslationResponse, TranslationError> {
        validate_request(&request)?;
        let cancellation = CancellationToken::new();
        {
            let mut sessions = self.sessions.lock().expect("translation session lock poisoned");
            sessions.prune_pre_cancelled(Instant::now());
            if sessions.pre_cancelled.remove(&request.session_id).is_some() {
                return Err(TranslationError::new("cancelled", "Translation cancelled"));
            }
            if sessions.active.contains_key(&request.session_id) {
                return Err(TranslationError::new(
                    "invalid_request",
                    "Translation session is already active",
                ));
            }
            sessions.active.insert(request.session_id, cancellation.clone());
        }
        let operation = async {
            match request.provider {
                TranslationProvider::Google => self.google(&request).await,
                TranslationProvider::Azure => self.azure(&request).await,
            }
        };
        let result = cancellation
            .run_until_cancelled(operation)
            .await
            .unwrap_or_else(|| Err(TranslationError::new("cancelled", "Translation cancelled")));
        self.sessions
            .lock()
            .expect("translation session lock poisoned")
            .active
            .remove(&request.session_id);
        result
    }

    async fn google(&self, request: &TranslationRequest) -> Result<TranslationResponse, TranslationError> {
        let mut bodies = Vec::with_capacity(request.texts.len());
        for text in &request.texts {
            let mut url = Url::parse(GOOGLE_URL).expect("fixed Google translation URL");
            url.query_pairs_mut()
                .append_pair("client", "gtx")
                .append_pair("dt", "t")
                .append_pair(
                    "sl",
                    if request.source_language.is_empty() {
                        "auto"
                    } else {
                        &request.source_language
                    },
                )
                .append_pair("tl", &request.target_language)
                .append_pair("q", text);
            bodies.push(read_response(self.client.get(url).send().await, "Google").await?);
        }
        Ok(TranslationResponse { bodies })
    }

    async fn azure(&self, request: &TranslationRequest) -> Result<TranslationResponse, TranslationError> {
        let token = self.azure_token().await?;
        let mut url = Url::parse(AZURE_TRANSLATE_URL).expect("fixed Azure translation URL");
        url.query_pairs_mut()
            .append_pair("api-version", "3.0")
            .append_pair("to", &request.target_language);
        if !request.source_language.is_empty() {
            url.query_pairs_mut().append_pair("from", &request.source_language);
        }
        let body = request
            .texts
            .iter()
            .map(|text| format!("{{\"Text\":{}}}", serde_json::to_string(text).expect("text JSON")))
            .collect::<Vec<_>>()
            .join(",");
        let response = self
            .client
            .post(url)
            .bearer_auth(token)
            .header("Content-Type", "application/json; charset=UTF-8")
            .body(format!("[{body}]"))
            .send()
            .await;
        Ok(TranslationResponse {
            bodies: vec![read_response(response, "Azure").await?],
        })
    }

    async fn azure_token(&self) -> Result<String, TranslationError> {
        if let Some(token) = self.azure_token.lock().expect("Azure token lock poisoned").as_ref()
            && token.expires_at > Instant::now()
        {
            return Ok(token.value.clone());
        }
        let requested_at = Instant::now();
        let response = self
            .client
            .get(AZURE_AUTH_URL)
            .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
            .send()
            .await;
        let token = read_response(response, "Azure authentication")
            .await?
            .trim()
            .to_string();
        if token.len() > 16 * 1024 || token.is_empty() {
            return Err(TranslationError::new(
                "invalid_response",
                "Azure authentication returned an invalid token",
            ));
        }
        self.azure_token
            .lock()
            .expect("Azure token lock poisoned")
            .replace(CachedToken {
                value: token.clone(),
                expires_at: requested_at + AZURE_TOKEN_TTL,
            });
        Ok(token)
    }

    fn cancel(&self, session_id: u64) {
        let mut sessions = self.sessions.lock().expect("translation session lock poisoned");
        let now = Instant::now();
        sessions.prune_pre_cancelled(now);
        if let Some(token) = sessions.active.remove(&session_id) {
            token.cancel();
        } else {
            sessions.pre_cancelled.insert(session_id, now);
        }
    }
}

fn validate_request(request: &TranslationRequest) -> Result<(), TranslationError> {
    let total = request.texts.iter().map(String::len).sum::<usize>();
    if request.texts.is_empty() || request.texts.len() > 32 || total == 0 || total > MAX_TEXT_BYTES {
        return Err(TranslationError::new(
            "invalid_request",
            "Translation text is empty or too large",
        ));
    }
    if request.target_language.is_empty() || request.target_language.len() > 16 || request.source_language.len() > 16 {
        return Err(TranslationError::new(
            "invalid_request",
            "Translation language is invalid",
        ));
    }
    Ok(())
}

async fn read_response(
    response: Result<reqwest::Response, reqwest::Error>,
    service: &str,
) -> Result<String, TranslationError> {
    let response = response.map_err(|error| TranslationError::new("network", error.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(TranslationError::new(
            "http_status",
            format!("{service} returned HTTP {}", status.as_u16()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(TranslationError::new(
            "response_too_large",
            "Translation response is too large",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| TranslationError::new("network", error.to_string()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(TranslationError::new(
            "response_too_large",
            "Translation response is too large",
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn fetch_translation(
    client: tauri::State<'_, TranslationHttpClient>,
    request: TranslationRequest,
) -> Result<TranslationResponse, TranslationError> {
    client.translate(request).await
}

#[tauri::command]
pub fn cancel_translation_session(client: tauri::State<'_, TranslationHttpClient>, session_id: u64) {
    client.cancel(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_oversized_requests() {
        let request = TranslationRequest {
            provider: TranslationProvider::Google,
            texts: vec![],
            source_language: String::new(),
            target_language: "en".into(),
            session_id: 1,
        };
        assert_eq!(validate_request(&request).unwrap_err().code, "invalid_request");
        let request = TranslationRequest {
            texts: vec!["x".repeat(MAX_TEXT_BYTES + 1)],
            ..request
        };
        assert_eq!(validate_request(&request).unwrap_err().code, "invalid_request");
    }
}
