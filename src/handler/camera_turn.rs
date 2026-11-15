//! Cloudflare TURNの期限付き認証情報を取得する。秘密情報はメモリ内だけで扱う。
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

static CACHE: Lazy<Mutex<HashMap<String, (Instant, Value)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static REQUESTS: Semaphore = Semaphore::const_new(16);
const CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_BODY: usize = 65536;

/// TURN取得先とHTTPクライアントを、設定インスタンス単位で差し替える。
/// 既定値では通常のCloudflare APIとシステムのプロキシ設定を使う。
#[derive(Clone, Default)]
pub struct CloudflareTurnClient {
    transport: Option<Arc<Transport>>,
}

struct Transport {
    client: reqwest::Client,
    endpoint: reqwest::Url,
}

impl CloudflareTurnClient {
    pub fn with_endpoint(
        client: reqwest::Client,
        mut endpoint: reqwest::Url,
    ) -> Result<Self, &'static str> {
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("invalid_turn_endpoint");
        }
        endpoint.set_path(&format!("{}/", endpoint.path().trim_end_matches('/')));
        Ok(Self {
            transport: Some(Arc::new(Transport { client, endpoint })),
        })
    }

    pub(super) async fn credentials(
        &self,
        key: &str,
        token: &str,
        identity: Uuid,
    ) -> Result<Value, &'static str> {
        match &self.transport {
            Some(transport) => {
                let url = transport
                    .endpoint
                    .join(&format!("{key}/credentials/generate-ice-servers"))
                    .map_err(|_| "invalid_turn_endpoint")?;
                cached(url.as_str(), token, identity, Some(&transport.client)).await
            },
            None => credentials(key, token, identity).await,
        }
    }
}

pub(super) async fn credentials(
    key: &str,
    token: &str,
    identity: Uuid,
) -> Result<Value, &'static str> {
    let url = format!(
        "https://rtc.live.cloudflare.com/v1/turn/keys/{key}/credentials/generate-ice-servers"
    );
    cached(&url, token, identity, None).await
}

async fn cached(
    url: &str,
    token: &str,
    identity: Uuid,
    client: Option<&reqwest::Client>,
) -> Result<Value, &'static str> {
    let cache_key = format!(
        "{:x}",
        Sha256::digest(format!("{url}\0{token}\0{identity}"))
    );
    {
        let mut cache = CACHE.lock().await;
        cache.retain(|_, (time, _)| time.elapsed() < CACHE_TTL);
        if let Some((_, value)) = cache.get(&cache_key) {
            return Ok(value.clone());
        }
    }
    // 待機・接続・本文取得をまとめて制限し、端末側の3秒上限に余裕を残す。
    let started = Instant::now();
    let value = within_request_deadline(async {
        let _permit = REQUESTS.acquire().await.map_err(|_| "busy")?;
        match client {
            Some(client) => fetch_with_client(client, url, token).await,
            None => fetch(url, token).await,
        }
    })
    .await?;
    let mut cache = CACHE.lock().await;
    cache.retain(|_, (time, _)| time.elapsed() < CACHE_TTL);
    if cache.len() >= 512 {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (time, _))| *time)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(cache_key, (started, value.clone()));
    Ok(value)
}

async fn within_request_deadline(
    request: impl std::future::Future<Output = Result<Value, &'static str>>,
) -> Result<Value, &'static str> {
    tokio::time::timeout(Duration::from_millis(1500), request)
        .await
        .map_err(|_| "timeout")?
}

async fn fetch(url: &str, token: &str) -> Result<Value, &'static str> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(1500))
        .build()
        .map_err(|_| "client")?;
    fetch_with_client(&client, url, token).await
}

async fn fetch_with_client(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<Value, &'static str> {
    let mut response = client
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .body(r#"{"ttl":86400}"#)
        .send()
        .await
        .map_err(|_| "transport")?;
    if response.status() != reqwest::StatusCode::CREATED {
        return Err("http_status");
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err("body_size");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "body")? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("body_size");
        }
        bytes.extend_from_slice(&chunk);
    }
    normalize(serde_json::from_slice(&bytes).map_err(|_| "json")?)
}

fn normalize(response: Value) -> Result<Value, &'static str> {
    let entries = response
        .get("iceServers")
        .and_then(Value::as_array)
        .ok_or("ice_servers")?;
    if entries.is_empty() || entries.len() > 8 {
        return Err("ice_servers");
    }
    let mut servers = Vec::new();
    let mut has_turn = false;
    for entry in entries {
        let urls = entry.get("urls").and_then(Value::as_array).ok_or("urls")?;
        if urls.is_empty() || urls.len() > 8 {
            return Err("urls");
        }
        let mut turn = false;
        for url in urls {
            let url = url.as_str().ok_or("url")?;
            if super::live_camera::valid_turn_url(url) {
                turn = true;
            } else if !super::live_camera::valid_stun_url(url) {
                return Err("url");
            }
        }
        let mut server = json!({"urls": urls});
        if turn {
            for field in ["username", "credential"] {
                let value = entry
                    .get(field)
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty() && v.len() <= 4096)
                    .ok_or("credential")?;
                server[field] = json!(value);
            }
            has_turn = true;
        }
        servers.push(server);
    }
    if !has_turn {
        return Err("missing_turn");
    }
    Ok(json!(servers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn response() -> Value {
        json!({"iceServers":[
            {"urls":["stun:stun.cloudflare.com:3478"]},
            {"urls":["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], "username":"temporary-user", "credential":"temporary-password", "extra":"discard"}
        ]})
    }

    async fn cached(url: &str, token: &str, identity: Uuid) -> Result<Value, &'static str> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(1500))
            .build()
            .unwrap();
        super::cached(url, token, identity, Some(&client)).await
    }
    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (url, task)
    }
    #[tokio::test]
    async fn credentials_request_cache_isolation_and_expiration() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let (url, task) = serve(Router::new().route(
            "/",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let calls = calls.clone();
                async move {
                    assert!(
                        headers["authorization"]
                            .to_str()
                            .unwrap()
                            .starts_with("Bearer test-")
                    );
                    assert_eq!(body, json!({"ttl":86400}));
                    calls.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::CREATED, Json(response()))
                }
            }),
        ))
        .await;
        let id = Uuid::new_v4();
        let first = cached(&url, "test-token", id).await.unwrap();
        assert_eq!(first.as_array().unwrap().len(), 2);
        assert!(first[1].get("extra").is_none());
        assert_eq!(first, cached(&url, "test-token", id).await.unwrap());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        cached(&url, "test-token", Uuid::new_v4()).await.unwrap();
        cached(&url, "test-rotated", id).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 3);
        let key = format!("{:x}", Sha256::digest(format!("{url}\0test-token\0{id}")));
        CACHE.lock().await.get_mut(&key).unwrap().0 = Instant::now() - CACHE_TTL;
        cached(&url, "test-token", id).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 4);
        task.abort();
    }
    #[test]
    fn rejects_invalid_credentials_and_urls() {
        for bad in [
            json!({}),
            json!({"iceServers":[]}),
            json!({"iceServers":[{"urls":["stun:host"]}]}),
            json!({"iceServers":[{"urls":["https://host"],"username":"u","credential":"c"}]}),
            json!({"iceServers":[{"urls":["turn:host"],"username":"u"}]}),
        ] {
            assert!(normalize(bad).is_err());
        }
    }
    #[tokio::test]
    async fn http_errors_are_redacted_and_not_cached() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (url, task) = serve(Router::new().route(
            "/",
            post(move || {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::UNAUTHORIZED, "sensitive upstream error")
                }
            }),
        ))
        .await;
        let id = Uuid::new_v4();
        for _ in 0..2 {
            assert_eq!(cached(&url, "test-secret", id).await, Err("http_status"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        task.abort();
    }
    #[tokio::test]
    async fn invalid_json_and_oversize_are_rejected() {
        for (body, expected) in [
            ("invalid".to_owned(), "json"),
            ("x".repeat(MAX_BODY + 1), "body_size"),
        ] {
            let (url, task) = serve(Router::new().route(
                "/",
                post(move || {
                    let body = body.clone();
                    async move { (StatusCode::CREATED, body) }
                }),
            ))
            .await;
            assert_eq!(
                cached(&url, "test-token", Uuid::new_v4()).await,
                Err(expected)
            );
            task.abort();
        }
    }
    #[tokio::test(start_paused = true)]
    async fn upstream_wait_is_bounded() {
        // ネットワークや共有キャッシュのロックを使わず、cached() と同じ期限を検証する。
        let request = within_request_deadline(std::future::pending());
        tokio::pin!(request);
        assert!(futures_util::poll!(request.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(1499)).await;
        assert!(futures_util::poll!(request.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(
            futures_util::poll!(request.as_mut()),
            std::task::Poll::Ready(Err("timeout"))
        );
    }
}
