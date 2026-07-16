use std::{collections::HashMap, sync::Mutex, time::Duration};

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client, Url};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

const ZDIC_BASE_URL: &str = "https://zdic.net/hans/";
const MERRIAM_WEBSTER_BASE_URL: &str =
    "https://www.dictionaryapi.com/api/v3/references/collegiate/json/";
const DEFAULT_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REDIRECTS: usize = 3;
const REDIRECT_FORBIDDEN_MARKER: &str = "dictionary redirect target is not allowed";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryHttpResponse {
    pub body: String,
    pub final_url: String,
    pub status: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryHttpError {
    pub code: String,
    pub message: String,
}

impl DictionaryHttpError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

struct ProviderTransport {
    base_url: Url,
    client: Client,
}

struct SessionState {
    active_requests: usize,
    cancellation: CancellationToken,
}

pub struct DictionaryHttpClient {
    zdic: ProviderTransport,
    merriam_webster: ProviderTransport,
    max_response_bytes: usize,
    sessions: Mutex<HashMap<u64, SessionState>>,
}

impl DictionaryHttpClient {
    pub fn new() -> Result<Self, DictionaryHttpError> {
        Self::with_configuration(
            Url::parse(ZDIC_BASE_URL).map_err(|_| configuration_error())?,
            Url::parse(MERRIAM_WEBSTER_BASE_URL).map_err(|_| configuration_error())?,
            DEFAULT_MAX_RESPONSE_BYTES,
            DEFAULT_TIMEOUT,
        )
    }

    #[cfg(test)]
    fn for_test(
        base_url: Url,
        max_response_bytes: usize,
        timeout: Duration,
    ) -> Result<Self, DictionaryHttpError> {
        Self::with_configuration(base_url.clone(), base_url, max_response_bytes, timeout)
    }

    fn with_configuration(
        zdic_base_url: Url,
        merriam_webster_base_url: Url,
        max_response_bytes: usize,
        timeout: Duration,
    ) -> Result<Self, DictionaryHttpError> {
        Ok(Self {
            zdic: build_transport(zdic_base_url, timeout)?,
            merriam_webster: build_transport(merriam_webster_base_url, timeout)?,
            max_response_bytes,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub async fn fetch_zdic(
        &self,
        query: &str,
        session_id: u64,
    ) -> Result<DictionaryHttpResponse, DictionaryHttpError> {
        let url = provider_lookup_url(&self.zdic.base_url, query)?;
        self.fetch(&self.zdic, url, session_id).await
    }

    pub async fn fetch_merriam_webster(
        &self,
        query: &str,
        key: &str,
        session_id: u64,
    ) -> Result<DictionaryHttpResponse, DictionaryHttpError> {
        let mut url = provider_lookup_url(&self.merriam_webster.base_url, query)?;
        url.query_pairs_mut().append_pair("key", key);
        self.fetch(&self.merriam_webster, url, session_id).await
    }

    pub fn cancel_session(&self, session_id: u64) {
        if let Some(session) = self
            .sessions
            .lock()
            .expect("dictionary session lock poisoned")
            .remove(&session_id)
        {
            session.cancellation.cancel();
        }
    }

    async fn fetch(
        &self,
        transport: &ProviderTransport,
        url: Url,
        session_id: u64,
    ) -> Result<DictionaryHttpResponse, DictionaryHttpError> {
        let cancellation = self.begin_request(session_id);
        let request = self.fetch_response(transport, url);
        let result = cancellation
            .run_until_cancelled(request)
            .await
            .unwrap_or_else(|| Err(DictionaryHttpError::new("cancelled", "Request cancelled")));
        self.finish_request(session_id, &cancellation);
        result
    }

    async fn fetch_response(
        &self,
        transport: &ProviderTransport,
        url: Url,
    ) -> Result<DictionaryHttpResponse, DictionaryHttpError> {
        let response = transport
            .client
            .get(url)
            .send()
            .await
            .map_err(map_request_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(DictionaryHttpError::new(
                "http_status",
                &format!("Dictionary service returned HTTP {}", status.as_u16()),
            ));
        }

        if response
            .content_length()
            .is_some_and(|length| length > self.max_response_bytes as u64)
        {
            return Err(response_too_large());
        }

        let final_url = response.url().to_string();
        let mut body = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or_default()
                .min(self.max_response_bytes as u64) as usize,
        );
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(map_request_error)?;
            if body.len().saturating_add(chunk.len()) > self.max_response_bytes {
                return Err(response_too_large());
            }
            body.extend_from_slice(&chunk);
        }

        Ok(DictionaryHttpResponse {
            body: String::from_utf8_lossy(&body).into_owned(),
            final_url,
            status: status.as_u16(),
        })
    }

    fn begin_request(&self, session_id: u64) -> CancellationToken {
        let mut sessions = self
            .sessions
            .lock()
            .expect("dictionary session lock poisoned");
        let session = sessions.entry(session_id).or_insert_with(|| SessionState {
            active_requests: 0,
            cancellation: CancellationToken::new(),
        });
        session.active_requests += 1;
        session.cancellation.clone()
    }

    fn finish_request(&self, session_id: u64, cancellation: &CancellationToken) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("dictionary session lock poisoned");
        let Some(session) = sessions.get_mut(&session_id) else {
            return;
        };

        if cancellation.is_cancelled() {
            return;
        }
        session.active_requests = session.active_requests.saturating_sub(1);
        if session.active_requests == 0 {
            sessions.remove(&session_id);
        }
    }
}

pub fn zdic_lookup_url(query: &str) -> Result<Url, DictionaryHttpError> {
    let base = Url::parse(ZDIC_BASE_URL).map_err(|_| configuration_error())?;
    provider_lookup_url(&base, query)
}

pub fn merriam_webster_lookup_url(query: &str, key: &str) -> Result<Url, DictionaryHttpError> {
    let base = Url::parse(MERRIAM_WEBSTER_BASE_URL).map_err(|_| configuration_error())?;
    let mut url = provider_lookup_url(&base, query)?;
    url.query_pairs_mut().append_pair("key", key);
    Ok(url)
}

fn provider_lookup_url(base_url: &Url, query: &str) -> Result<Url, DictionaryHttpError> {
    let mut url = base_url.clone();
    url.path_segments_mut()
        .map_err(|_| configuration_error())?
        .pop_if_empty()
        .push(query);
    Ok(url)
}

fn build_transport(
    base_url: Url,
    timeout: Duration,
) -> Result<ProviderTransport, DictionaryHttpError> {
    let allowed_origin = base_url.origin().ascii_serialization();
    let redirect_policy = Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.stop();
        }
        if attempt.url().origin().ascii_serialization() == allowed_origin {
            attempt.follow()
        } else {
            attempt.error(REDIRECT_FORBIDDEN_MARKER)
        }
    });
    let client = Client::builder()
        .timeout(timeout)
        .redirect(redirect_policy)
        .build()
        .map_err(|_| configuration_error())?;

    Ok(ProviderTransport { base_url, client })
}

fn map_request_error(error: reqwest::Error) -> DictionaryHttpError {
    if error.is_timeout() {
        return DictionaryHttpError::new("timeout", "Dictionary request timed out");
    }
    if error.to_string().contains(REDIRECT_FORBIDDEN_MARKER) {
        return DictionaryHttpError::new(
            "redirect_forbidden",
            "Dictionary service redirected to an unexpected host",
        );
    }
    DictionaryHttpError::new("network", "Dictionary request failed")
}

fn configuration_error() -> DictionaryHttpError {
    DictionaryHttpError::new("configuration", "Dictionary transport is unavailable")
}

fn response_too_large() -> DictionaryHttpError {
    DictionaryHttpError::new(
        "response_too_large",
        "Dictionary response exceeded the size limit",
    )
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
        thread,
        time::Duration,
    };

    use reqwest::Url;

    use super::*;

    #[test]
    fn constructs_provider_urls_without_accepting_an_arbitrary_target() {
        let zdic = zdic_lookup_url("天 空").expect("zdic URL");
        assert_eq!(
            zdic.as_str(),
            "https://zdic.net/hans/%E5%A4%A9%20%E7%A9%BA"
        );

        let merriam_webster = merriam_webster_lookup_url("well being", "free-key").expect("MW URL");
        assert_eq!(merriam_webster.scheme(), "https");
        assert_eq!(merriam_webster.host_str(), Some("www.dictionaryapi.com"));
        assert_eq!(
            merriam_webster.path(),
            "/api/v3/references/collegiate/json/well%20being"
        );
        assert_eq!(
            merriam_webster
                .query_pairs()
                .find(|(name, _)| name == "key")
                .map(|(_, value)| value.into_owned()),
            Some("free-key".to_string())
        );
    }

    #[tokio::test]
    async fn returns_a_bounded_success_response() {
        let (base_url, server) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\ndefinition",
            Duration::ZERO,
        );
        let client = DictionaryHttpClient::for_test(base_url, 32, Duration::from_secs(1))
            .expect("test client");

        let response = client.fetch_zdic("天空", 1).await.expect("response");
        server.join().expect("server thread");

        assert_eq!(response.body, "definition");
        assert_eq!(response.status, 200);
        assert!(response.final_url.starts_with("http://127.0.0.1:"));
    }

    #[tokio::test]
    async fn rejects_error_status_and_oversized_responses() {
        let (status_base_url, status_server) = serve_once(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 7\r\n\r\nmissing",
            Duration::ZERO,
        );
        let status_client =
            DictionaryHttpClient::for_test(status_base_url, 32, Duration::from_secs(1))
                .expect("status client");
        let status_error = status_client
            .fetch_zdic("天空", 2)
            .await
            .expect_err("status error");
        status_server.join().expect("status server thread");
        assert_eq!(status_error.code, "http_status");

        let (size_base_url, size_server) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\ndefinition",
            Duration::ZERO,
        );
        let size_client = DictionaryHttpClient::for_test(size_base_url, 4, Duration::from_secs(1))
            .expect("size client");
        let size_error = size_client
            .fetch_zdic("天空", 3)
            .await
            .expect_err("size error");
        size_server.join().expect("size server thread");
        assert_eq!(size_error.code, "response_too_large");
    }

    #[tokio::test]
    async fn rejects_redirects_outside_the_configured_origin() {
        let (base_url, server) = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: https://example.com/private\r\nContent-Length: 0\r\n\r\n",
            Duration::ZERO,
        );
        let client = DictionaryHttpClient::for_test(base_url, 32, Duration::from_secs(1))
            .expect("redirect client");

        let error = client
            .fetch_zdic("天空", 4)
            .await
            .expect_err("redirect error");
        server.join().expect("server thread");

        assert_eq!(error.code, "redirect_forbidden");
    }

    #[tokio::test]
    async fn times_out_and_cancels_an_active_session() {
        let (timeout_base_url, timeout_server) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nlate",
            Duration::from_millis(150),
        );
        let timeout_client =
            DictionaryHttpClient::for_test(timeout_base_url, 32, Duration::from_millis(20))
                .expect("timeout client");
        let timeout_error = timeout_client
            .fetch_zdic("天空", 5)
            .await
            .expect_err("timeout error");
        timeout_server.join().expect("timeout server thread");
        assert_eq!(timeout_error.code, "timeout");

        let (cancel_base_url, cancel_server) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nlate",
            Duration::from_millis(150),
        );
        let cancel_client = Arc::new(
            DictionaryHttpClient::for_test(cancel_base_url, 32, Duration::from_secs(1))
                .expect("cancel client"),
        );
        let request_client = Arc::clone(&cancel_client);
        let request = tokio::spawn(async move { request_client.fetch_zdic("天空", 6).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel_client.cancel_session(6);
        let cancel_error = request
            .await
            .expect("request task")
            .expect_err("cancel error");
        cancel_server.join().expect("cancel server thread");
        assert_eq!(cancel_error.code, "cancelled");
    }

    fn serve_once(response: &str, delay: Duration) -> (Url, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let response = response.as_bytes().to_vec();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            thread::sleep(delay);
            let _ = stream.write_all(&response);
        });

        (
            Url::parse(&format!("http://{address}/hans/")).expect("test URL"),
            handle,
        )
    }
}
