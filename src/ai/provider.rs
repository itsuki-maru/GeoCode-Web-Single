//! プロバイダー固有のHTTP契約。接続先は管理者設定のみを使用する。
use super::settings::{AiSettings, invalid};
use crate::error::AppError;
use axum::http::HeaderValue;
use reqwest::{
    Client, Url,
    dns::{Name, Resolve, Resolving},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io, net::IpAddr, sync::Arc, time::Duration};

const RESPONSE_LIMIT: usize = 512 * 1024;
pub const AUDIO_LIMIT: usize = 10 * 1024 * 1024;
// 短いローカル用仮キーが操作名や通常の文章へ一致する誤検知を避ける。
const REFLECTED_KEY_MIN_LENGTH: usize = 16;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => !matches!(
            ip.octets(),
            [0 | 10 | 127 | 224..=255, ..]
                | [100, 64..=127, ..]
                | [169, 254, ..]
                | [172, 16..=31, ..]
                | [192, 168, ..]
                | [192, 0, 0 | 2, _]
                | [192, 88, 99, _]
                | [198, 18 | 19, ..]
                | [198, 51, 100, _]
                | [203, 0, 113, _]
        ),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(v4.into());
            }
            let [prefix, second, ..] = ip.segments();
            (0x2000..0x4000).contains(&prefix)
                && prefix != 0x2002
                && prefix != 0x3fff
                && !(prefix == 0x2001 && (second < 0x0200 || second == 0x0db8))
        },
    }
}
struct PublicDns;
impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|a| public_ip(a.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(io::Error::other("AI upstream has no permitted address").into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}
fn allowed_origins() -> Vec<String> {
    std::env::var("AI_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter_map(|raw| {
            let url = Url::parse(raw).ok()?;
            (matches!(url.scheme(), "http" | "https") && url.origin().ascii_serialization() == raw)
                .then(|| raw.to_owned())
        })
        .collect()
}
pub fn is_explicitly_allowed(url: &Url) -> bool {
    allowed_origins().contains(&url.origin().ascii_serialization())
}
fn validate_with_origins(raw: &str, origins: &[String]) -> Result<Url, AppError> {
    let fail = || {
        invalid(
            "AI接続先は認証情報・クエリ・フラグメントのないHTTPSのベースURLで指定してください。LAN接続は配備側の許可が必要です。",
        )
    };
    if raw.len() > 4096
        || raw.trim() != raw
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
    {
        return Err(fail());
    }
    let url = Url::parse(raw).map_err(|_| fail())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(fail());
    }
    if !origins.contains(&url.origin().ascii_serialization()) {
        if url.scheme() != "https" {
            return Err(fail());
        }
        let host = url.host_str().unwrap().trim_matches(['[', ']']);
        if host.eq_ignore_ascii_case("localhost")
            || host.parse::<IpAddr>().is_ok_and(|ip| !public_ip(ip))
        {
            return Err(fail());
        }
    }
    Ok(url)
}
pub fn validate_base_url(raw: &str) -> Result<Url, AppError> {
    validate_with_origins(raw, &allowed_origins())
}
fn client(url: &Url, timeout: u64, origins: &[String]) -> Result<Client, AppError> {
    let builder = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout));
    let builder = if origins.contains(&url.origin().ascii_serialization()) {
        builder
    } else {
        builder.dns_resolver(Arc::new(PublicDns))
    };
    builder.build().map_err(|_| AppError::InternalServerError)
}
fn endpoint(base: &str, parts: &[&str], origins: &[String]) -> Result<Url, AppError> {
    let mut url = validate_with_origins(base, origins)?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| invalid("AI接続先URLが不正です。"))?;
        path.pop_if_empty();
        for part in parts {
            path.push(part);
        }
    }
    Ok(url)
}
fn bearer(key: &HeaderValue) -> Result<HeaderValue, AppError> {
    let mut bytes = b"Bearer ".to_vec();
    bytes.extend(key.as_bytes());
    let mut value = HeaderValue::from_bytes(&bytes).map_err(|_| AppError::InternalServerError)?;
    value.set_sensitive(true);
    Ok(value)
}
async fn read_json(mut response: reqwest::Response) -> Result<Value, AppError> {
    let status = response.status().as_u16();
    let success = response.status().is_success();
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err(if success {
            upstream("AI接続先の応答が512KiBの上限を超えました。")
        } else {
            http_failure(status, None)
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_failure(&error))?
    {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(if success {
                upstream("AI接続先の応答が512KiBの上限を超えました。")
            } else {
                http_failure(status, None)
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes);
    if !success {
        return Err(http_failure(status, value.as_ref().ok()));
    }
    value.map_err(|_| {
        upstream("AI接続先がJSON以外の応答を返しました。接続先URLとAPI形式を確認してください。")
    })
}

fn upstream(message: &str) -> AppError {
    AppError::AiUpstream(message.into())
}

fn contains_credential(value: &Value, key: &str) -> bool {
    match value {
        Value::String(text) => text.contains(key),
        Value::Array(values) => values.iter().any(|value| contains_credential(value, key)),
        Value::Object(values) => values.values().any(|value| contains_credential(value, key)),
        _ => false,
    }
}

/// 上流の誤応答で認証キー原文を通常利用者へ再配布しないための追加防御。
/// 短い仮キーやエンコードされた秘密一般を検出する仕組みではない。
fn reject_reflected_credentials(value: &Value, settings: &AiSettings) -> Result<(), AppError> {
    for key in [&settings.api_key, &settings.speech_api_key]
        .into_iter()
        .flatten()
    {
        if key.as_bytes().len() < REFLECTED_KEY_MIN_LENGTH {
            continue;
        }
        let key = key.to_str().map_err(|_| AppError::InternalServerError)?;
        if contains_credential(value, key) {
            return Err(upstream(
                "AI接続先が認証情報を含む応答を返したため、応答を破棄しました。接続先の設定を確認してください。",
            ));
        }
    }
    Ok(())
}

/// エラー本文・要求本文・URL・ヘッダーは表示しない。既知のコードだけを説明へ変換する。
fn http_failure(status: u16, body: Option<&Value>) -> AppError {
    let code = body
        .and_then(|v| v.pointer("/error/code"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let param = body
        .and_then(|v| v.pointer("/error/param"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let hint = match (status, code, param) {
        (401 | 403, _, _) => "APIキー・プロジェクト・利用権限を確認してください。",
        (_, "insufficient_quota" | "billing_hard_limit_reached", _) => {
            "APIの利用枠・請求設定・残高を確認してください。"
        },
        (429, _, _) => "AI接続先の利用上限に達しました。時間をおいて再試行してください。",
        (_, "model_not_found", _) | (_, _, "model") => {
            "モデルが存在しないか利用権限がありません。モデル名とプロジェクトを確認してください。"
        },
        (_, "context_length_exceeded", _) => {
            "入力がモデルのコンテキスト上限を超えました。会話や対象の項目を減らしてください。"
        },
        (_, _, "max_tokens") => {
            "この接続先ではmax_tokensを使用できません。max_completion_tokensに対応したアプリへ更新してください。"
        },
        (_, _, "max_completion_tokens") => {
            "この接続先はmax_completion_tokensを受け付けていません。モデルとOpenAI互換APIの仕様を確認してください。"
        },
        (_, _, "response_format") => {
            "指定モデルまたは接続先がJSON応答形式を受け付けていません。モデルと接続方式を確認してください。"
        },
        (_, _, "reasoning_effort") => {
            "指定モデルが推論量の指定を受け付けていません。モデルと接続方式を確認してください。"
        },
        (400 | 422, _, _) => {
            "要求が拒否されました。接続方式・モデル名・JSON出力への対応を確認してください。"
        },
        (404, _, _) => "APIまたはモデルが見つかりません。ベースURLとモデル名を確認してください。",
        (300..=399, _, _) => {
            "リダイレクト先には接続しません。最終接続先のベースURLを指定してください。"
        },
        _ => {
            "AI接続先でエラーが発生しました。サービスの状態を確認し、時間をおいて再試行してください。"
        },
    };
    let message = format!("AI接続先がHTTP {status}を返しました。{hint}");
    if status == 429 {
        AppError::TooManyRequests(message)
    } else {
        AppError::AiUpstream(message)
    }
}

fn transport_failure(error: &reqwest::Error) -> AppError {
    upstream(if error.is_timeout() {
        "AI接続先への要求がタイムアウトしました。接続経路やサービスの混雑を確認し、必要に応じてタイムアウト秒数を増やしてください。"
    } else if error.is_connect() {
        "AI接続先へ接続できませんでした。アプリサーバーからのDNS名前解決・TLS証明書・外向き通信を確認してください（この接続は環境変数のHTTPプロキシを使用しません）。"
    } else {
        "AI接続先との通信が中断されました。ネットワークとサービスの状態を確認してください。"
    })
}
fn parse_output(raw: &str) -> Result<Value, AppError> {
    let text = raw.trim();
    let text = if let Some(inner) = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
    {
        inner
            .strip_suffix("```")
            .ok_or_else(|| upstream("AIのJSON応答が途中で終了しています。出力上限または対応モデルを確認してください。"))?
            .trim()
    } else {
        text
    };
    let value: Value = serde_json::from_str(text).map_err(|_| {
        invalid("AIの応答形式を読み取れませんでした。対応するモデルで再試行してください。")
    })?;
    if !value.is_object() {
        return Err(upstream(
            "AIの応答がJSONオブジェクトではありません。対応するモデルで再試行してください。",
        ));
    }
    Ok(value)
}
pub async fn generate(
    settings: &AiSettings,
    system: &str,
    messages: &[ChatMessage],
    schema: &Value,
) -> Result<Value, AppError> {
    generate_with_origins(settings, system, messages, schema, &allowed_origins()).await
}
pub async fn generate_check(
    settings: &AiSettings,
    system: &str,
    messages: &[ChatMessage],
    schema: &Value,
) -> Result<Value, AppError> {
    generate_with_purpose(settings, system, messages, schema, &allowed_origins(), true).await
}

fn openai_body(
    settings: &AiSettings,
    instruction: &str,
    messages: &[ChatMessage],
    check: bool,
) -> Value {
    let cfg = &settings.config;
    let mut all = vec![json!({"role":"system","content":instruction})];
    all.extend(
        messages
            .iter()
            .map(|m| json!({"role":m.role,"content":m.content})),
    );
    let mut body =
        json!({"model":cfg.model,"messages":all,"response_format":{"type":"json_object"}});
    let official = Url::parse(&cfg.base_url)
        .is_ok_and(|url| url.origin().ascii_serialization() == "https://api.openai.com");
    let recent_gpt = cfg
        .model
        .strip_prefix("gpt-")
        .and_then(|suffix| suffix.split(['-', '.']).next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 5);
    let token_key = if official
        || recent_gpt
        || ["o1", "o3", "o4"]
            .iter()
            .any(|prefix| cfg.model.starts_with(*prefix))
    {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    body[token_key] = json!(cfg.max_output_tokens);
    // Lunaの短い接続確認では、推論に出力予算を消費しない。他モデル・互換APIには追加しない。
    if check && official && (cfg.model == "gpt-6-luna" || cfg.model.starts_with("gpt-6-luna-")) {
        body["reasoning_effort"] = json!("none");
    }
    body
}

async fn generate_with_origins(
    settings: &AiSettings,
    system: &str,
    messages: &[ChatMessage],
    schema: &Value,
    origins: &[String],
) -> Result<Value, AppError> {
    generate_with_purpose(settings, system, messages, schema, origins, false).await
}
async fn generate_with_purpose(
    settings: &AiSettings,
    system: &str,
    messages: &[ChatMessage],
    schema: &Value,
    origins: &[String],
    check: bool,
) -> Result<Value, AppError> {
    let cfg = &settings.config;
    let instruction =
        format!("{system}\n\nReturn only one JSON object matching this JSON Schema:\n{schema}");
    let (url, body) = match cfg.provider.as_str() {
        "openai" => (
            endpoint(&cfg.base_url, &["chat", "completions"], origins)?,
            openai_body(settings, &instruction, messages, check),
        ),
        "anthropic" => (
            endpoint(&cfg.base_url, &["messages"], origins)?,
            json!({"model":cfg.model,"max_tokens":cfg.max_output_tokens,"system":instruction,"messages":messages}),
        ),
        "gemini" => {
            let model = format!(
                "{}:generateContent",
                cfg.model.trim_start_matches("models/")
            );
            let contents:Vec<_>=messages.iter().map(|m|json!({"role":if m.role=="assistant"{"model"}else{"user"},"parts":[{"text":m.content}]})).collect();
            (
                endpoint(&cfg.base_url, &["models", &model], origins)?,
                json!({"systemInstruction":{"parts":[{"text":instruction}]},"contents":contents,"generationConfig":{"responseMimeType":"application/json","maxOutputTokens":cfg.max_output_tokens}}),
            )
        },
        _ => return Err(invalid("未対応のAI接続方式です。")),
    };
    let mut request = client(&url, cfg.timeout_seconds, origins)?
        .post(url)
        .header("Content-Type", "application/json");
    if let Some(key) = &settings.api_key {
        request = match cfg.provider.as_str() {
            "anthropic" => request.header("x-api-key", key.clone()),
            "gemini" => request.header("x-goog-api-key", key.clone()),
            _ => request.header("Authorization", bearer(key)?),
        };
    }
    if cfg.provider == "anthropic" {
        request = request.header("anthropic-version", "2023-06-01");
    }
    let response = read_json(
        request
            .body(serde_json::to_vec(&body).map_err(|_| AppError::InternalServerError)?)
            .send()
            .await
            .map_err(|error| transport_failure(&error))?,
    )
    .await?;
    validate_completion(&response, &cfg.provider)?;
    let raw = match cfg.provider.as_str() {
        "openai" => response
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_owned),
        "anthropic" => response
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            }),
        "gemini" => response
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            }),
        _ => None,
    }
    .filter(|text| !text.trim().is_empty())
    .ok_or_else(|| {
        upstream("AI接続先の応答に本文がありません。モデルの応答形式と出力上限を確認してください。")
    })?;
    let output = parse_output(&raw)?;
    reject_reflected_credentials(&output, settings)?;
    Ok(output)
}

fn validate_completion(response: &Value, provider: &str) -> Result<(), AppError> {
    let reason = match provider {
        "openai" => response.pointer("/choices/0/finish_reason"),
        "anthropic" => response.get("stop_reason"),
        "gemini" => response.pointer("/candidates/0/finishReason"),
        _ => None,
    }
    .and_then(Value::as_str);
    if matches!(reason, Some("length" | "max_tokens" | "MAX_TOKENS")) {
        return Err(upstream(
            "AIの応答が出力上限に達しました。最大出力トークン数を4096〜8192へ増やして再試行してください。推論モデルでは推論分もこの上限に含まれます。",
        ));
    }
    if matches!(
        reason,
        Some(
            "content_filter"
                | "refusal"
                | "SAFETY"
                | "RECITATION"
                | "BLOCKLIST"
                | "PROHIBITED_CONTENT"
                | "SPII"
        )
    ) || response
        .pointer("/choices/0/message/refusal")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        || response
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
            .is_some()
    {
        return Err(upstream(
            "AI接続先が回答を拒否しました。指示内容や使用するモデルを確認してください。",
        ));
    }
    Ok(())
}
fn audio_format(bytes: &[u8]) -> Result<(&'static str, &'static str), AppError> {
    if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        Ok(("webm", "audio/webm"))
    } else if bytes.starts_with(b"OggS") {
        Ok(("ogg", "audio/ogg"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Ok(("wav", "audio/wav"))
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        Ok(("mp4", "audio/mp4"))
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() > 1 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        Ok(("mp3", "audio/mpeg"))
    } else {
        Err(invalid(
            "音声はWebM・Ogg・WAV・MP4・MP3形式で指定してください。",
        ))
    }
}
pub async fn transcribe(settings: &AiSettings, bytes: Vec<u8>) -> Result<String, AppError> {
    transcribe_with_origins(settings, bytes, &allowed_origins()).await
}
async fn transcribe_with_origins(
    settings: &AiSettings,
    bytes: Vec<u8>,
    origins: &[String],
) -> Result<String, AppError> {
    if bytes.is_empty() || bytes.len() > AUDIO_LIMIT {
        return Err(invalid("音声ファイルは10MiB以内で指定してください。"));
    }
    let (extension, mime) = audio_format(&bytes)?;
    let url = endpoint(
        &settings.config.speech_base_url,
        &["audio", "transcriptions"],
        origins,
    )?;
    let boundary = format!("geocode-ai-{}", uuid::Uuid::new_v4().simple());
    let mut body=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.{extension}\"\r\nContent-Type: {mime}\r\n\r\n",settings.config.speech_model).into_bytes();
    body.extend(bytes);
    body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut request = client(&url, settings.config.timeout_seconds, origins)?
        .post(url)
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        );
    if let Some(key) = &settings.speech_api_key {
        request = request.header("Authorization", bearer(key)?);
    }
    let value = read_json(
        request
            .body(body)
            .send()
            .await
            .map_err(|error| transport_failure(&error))?,
    )
    .await?;
    reject_reflected_credentials(&value, settings)?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .filter(|t| t.len() <= 16000)
        .ok_or(AppError::BadGateway)?;
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{HeaderMap, Request, Response},
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;
    type Recorded = (String, String, HeaderMap, Vec<u8>);
    async fn mock_server(
        status: u16,
        body: String,
        location: Option<&str>,
    ) -> (
        String,
        oneshot::Receiver<Recorded>,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let location = location.map(str::to_owned);
        let router = Router::new().fallback(move |request: Request<Body>| {
            let tx = tx.clone();
            let body = body.clone();
            let location = location.clone();
            let count = observed.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                let method = request.method().to_string();
                let uri = request.uri().to_string();
                let headers = request.headers().clone();
                let bytes = to_bytes(request.into_body(), AUDIO_LIMIT + 4096)
                    .await
                    .unwrap()
                    .to_vec();
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send((method, uri, headers, bytes));
                }
                let mut response = Response::builder()
                    .status(status)
                    .header("Content-Type", "application/json");
                if let Some(location) = location {
                    response = response.header("Location", location);
                }
                response.body(Body::from(body)).unwrap()
            }
        });
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (base, rx, count, handle)
    }
    fn settings_at(base: &str, provider: &str) -> AiSettings {
        let mut config = super::super::settings::AiConfig::default();
        config.provider = provider.into();
        config.base_url = format!("{base}/v1");
        config.model = "test-model".into();
        config.speech_base_url = config.base_url.clone();
        config.speech_model = "test-speech".into();
        let key = super::super::settings::validate_key("test-secret").unwrap();
        AiSettings {
            revision: None,
            config,
            api_key: Some(key.clone()),
            speech_api_key: Some(key),
        }
    }
    #[test]
    fn private_and_credential_urls_require_explicit_permission() {
        for url in [
            "http://example.com/v1",
            "https://127.0.0.1/v1",
            "https://[::1]/v1",
            "https://u:p@example.com/v1",
            "https://example.com/v1?key=secret",
            "https://example.com/v1#fragment",
        ] {
            assert!(validate_with_origins(url, &[]).is_err(), "{url}");
        }
        assert!(validate_with_origins("https://api.example.com/v1", &[]).is_ok());
        assert!(
            validate_with_origins(
                "http://127.0.0.1:1234/v1",
                &["http://127.0.0.1:1234".into()]
            )
            .is_ok()
        );
    }
    #[test]
    fn structured_output_does_not_accept_arbitrary_text() {
        assert!(parse_output("{\"message\":\"ok\",\"action\":null}").is_ok());
        assert!(parse_output("```json\n{\"message\":\"ok\"}\n```").is_ok());
        assert!(parse_output("execute this: {\"message\":\"bad\"}").is_err());
        assert!(parse_output("[]").is_err());
    }
    #[test]
    fn audio_uses_content_signatures() {
        assert!(audio_format(b"not audio").is_err());
        assert_eq!(audio_format(b"RIFFxxxxWAVEpayload").unwrap().0, "wav");
        assert_eq!(audio_format(b"\x1a\x45\xdf\xa3payload").unwrap().0, "webm");
    }
    #[test]
    fn official_openai_uses_modern_limits_and_only_luna_check_disables_reasoning() {
        let mut settings = settings_at("https://api.openai.com", "openai");
        settings.config.model = "gpt-6-luna".into();
        let check = openai_body(&settings, "JSON", &[], true);
        assert_eq!(check["max_completion_tokens"], 2048);
        assert!(check.get("max_tokens").is_none());
        assert_eq!(check["reasoning_effort"], "none");
        assert!(
            openai_body(&settings, "JSON", &[], false)
                .get("reasoning_effort")
                .is_none()
        );
        settings.config.model = "gpt-6-astra".into();
        assert!(
            openai_body(&settings, "JSON", &[], true)
                .get("reasoning_effort")
                .is_none()
        );
        settings.config.model = "future-model-without-a-known-prefix".into();
        assert_eq!(
            openai_body(&settings, "JSON", &[], false)["max_completion_tokens"],
            2048
        );
        settings.config.base_url = "https://compatible.example/v1".into();
        let compatible = openai_body(&settings, "JSON", &[], true);
        assert_eq!(compatible["max_tokens"], 2048);
        assert!(compatible.get("max_completion_tokens").is_none());
        assert!(compatible.get("reasoning_effort").is_none());
    }
    #[test]
    fn incomplete_and_refused_responses_are_never_interpreted_as_success() {
        for body in [
            json!({"choices":[{"finish_reason":"length","message":{"content":null}}]}),
            json!({"choices":[{"finish_reason":"length","message":{"content":"{\"message\":\"ok\"}"}}]}),
        ] {
            let error = validate_completion(&body, "openai")
                .unwrap_err()
                .to_string();
            assert!(error.contains("出力上限"));
        }
        assert!(
            validate_completion(
                &json!({"choices":[{"finish_reason":"stop","message":{"refusal":"private text"}}]}),
                "openai"
            )
            .unwrap_err()
            .to_string()
            .contains("拒否")
        );
        assert!(validate_completion(&json!({"stop_reason":"max_tokens"}), "anthropic").is_err());
        assert!(
            validate_completion(
                &json!({"candidates":[{"finishReason":"MAX_TOKENS"}]}),
                "gemini"
            )
            .is_err()
        );
        assert!(
            validate_completion(
                &json!({"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]}),
                "openai"
            )
            .is_ok()
        );
    }
    #[test]
    fn upstream_http_diagnostics_do_not_echo_untrusted_response_fields() {
        let secret = "NEVER-EXPOSE-KEY-OR-PROMPT";
        let error = http_failure(400, Some(&json!({"error":{"message":secret,"code":"unsupported_parameter","param":"max_tokens"}}))).to_string();
        assert!(error.contains("HTTP 400") && error.contains("max_tokens"));
        assert!(!error.contains(secret));
        let error = http_failure(
            400,
            Some(&json!({"error":{"message":secret,"code":secret,"param":secret}})),
        )
        .to_string();
        assert!(!error.contains(secret));
        assert!(
            http_failure(404, Some(&json!({"error":{"code":"model_not_found"}})))
                .to_string()
                .contains("モデル")
        );
        assert!(
            http_failure(429, Some(&json!({"error":{"code":"insufficient_quota"}})))
                .to_string()
                .contains("請求")
        );
    }
    #[test]
    fn reflected_credentials_inspect_string_values_and_keep_short_compatibility_keys() {
        let mut settings = settings_at("https://api.example.com", "openai");
        let model_key = "model-credential-18bd82e9";
        let speech_key = "speech-credential-d3bf08e1";
        settings.api_key = Some(super::super::settings::validate_key(model_key).unwrap());
        settings.speech_api_key = Some(super::super::settings::validate_key(speech_key).unwrap());
        // JSONの項目名は利用者へ返す秘密の原文として扱わない。
        let values = json!({model_key:"safe","action":{"type":"filter"},"count":1});
        assert_eq!(values[model_key], "safe");
        assert!(reject_reflected_credentials(&values, &settings).is_ok());
        for value in [
            json!({"message":format!("Bearer {model_key}")}),
            json!({"action":{"rules":[{"label":speech_key}]}}),
        ] {
            let error = reject_reflected_credentials(&value, &settings)
                .unwrap_err()
                .to_string();
            assert!(error.contains("応答を破棄"));
            assert!(!error.contains(model_key));
            assert!(!error.contains(speech_key));
        }
        settings.api_key = Some(super::super::settings::validate_key("filter").unwrap());
        settings.speech_api_key = Some(super::super::settings::validate_key("a").unwrap());
        assert!(
            reject_reflected_credentials(
                &json!({"message":"a matching filter","action":{"type":"filter"}}),
                &settings,
            )
            .is_ok()
        );
    }
    #[tokio::test]
    async fn reflected_credentials_are_rejected_in_model_and_speech_success_responses() {
        let model_key = "model-credential-18bd82e9";
        let speech_key = "speech-credential-d3bf08e1";
        for provider in ["openai", "anthropic", "gemini"] {
            let reflected = if provider == "anthropic" {
                speech_key
            } else {
                model_key
            };
            let output = json!({"message":format!("認証キー：{reflected}"),"action":null})
                .to_string()
                .replace("credential", "\\u0063redential");
            let response = match provider {
                "openai" => json!({"choices":[{"message":{"content":output}}]}),
                "anthropic" => json!({"content":[{"type":"text","text":output}]}),
                _ => json!({"candidates":[{"content":{"parts":[{"text":output}]}}]}),
            };
            let (base, _, _, handle) = mock_server(200, response.to_string(), None).await;
            let mut settings = settings_at(&base, provider);
            settings.api_key = Some(super::super::settings::validate_key(model_key).unwrap());
            settings.speech_api_key =
                Some(super::super::settings::validate_key(speech_key).unwrap());
            let error = generate_with_origins(
                &settings,
                "system",
                &[],
                &json!({}),
                std::slice::from_ref(&base),
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(error.contains("応答を破棄"), "{provider}");
            assert!(!error.contains(model_key));
            assert!(!error.contains(speech_key));
            handle.abort();
        }
        for reflected in [model_key, speech_key] {
            let (base, _, _, handle) =
                mock_server(200, json!({"text":reflected}).to_string(), None).await;
            let mut settings = settings_at(&base, "openai");
            settings.api_key = Some(super::super::settings::validate_key(model_key).unwrap());
            settings.speech_api_key =
                Some(super::super::settings::validate_key(speech_key).unwrap());
            let error = transcribe_with_origins(
                &settings,
                b"RIFFxxxxWAVErecorded-audio".to_vec(),
                std::slice::from_ref(&base),
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(error.contains("応答を破棄"));
            assert!(!error.contains(model_key));
            assert!(!error.contains(speech_key));
            handle.abort();
        }
    }
    #[tokio::test]
    async fn connection_and_timeout_failures_are_distinguishable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let waiting = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let error = Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();
        assert!(
            transport_failure(&error)
                .to_string()
                .contains("タイムアウト")
        );
        waiting.abort();
        struct FailingDns;
        impl Resolve for FailingDns {
            fn resolve(&self, _name: Name) -> Resolving {
                Box::pin(async {
                    Err(io::Error::new(io::ErrorKind::NotFound, "test DNS failure").into())
                })
            }
        }
        let error = Client::builder()
            .no_proxy()
            .dns_resolver(Arc::new(FailingDns))
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
            .get("https://ai-test.invalid")
            .send()
            .await
            .unwrap_err();
        assert!(
            transport_failure(&error)
                .to_string()
                .contains("接続できません")
        );
    }
    #[tokio::test]
    async fn providers_use_expected_endpoints_headers_and_structured_responses() {
        let output = json!({"message":"確認しました","action":{"type":"reset"}}).to_string();
        for provider in ["openai", "anthropic", "gemini"] {
            let upstream = match provider {
                "openai" => json!({"choices":[{"message":{"content":output}}]}),
                "anthropic" => json!({"content":[{"type":"text","text":output}]}),
                _ => json!({"candidates":[{"content":{"parts":[{"text":output}]}}]}),
            };
            let (base, rx, _, handle) = mock_server(200, upstream.to_string(), None).await;
            let settings = settings_at(&base, provider);
            let result = generate_with_origins(
                &settings,
                "system",
                &[ChatMessage {
                    role: "user".into(),
                    content: "検索して".into(),
                }],
                &json!({"type":"object"}),
                std::slice::from_ref(&base),
            )
            .await
            .unwrap();
            assert_eq!(result["action"]["type"], "reset");
            let (method, path, headers, body) = rx.await.unwrap();
            assert_eq!(method, "POST");
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert!(
                !String::from_utf8(serde_json::to_vec(&body).unwrap())
                    .unwrap()
                    .contains("test-secret")
            );
            match provider {
                "openai" => {
                    assert_eq!(path, "/v1/chat/completions");
                    assert_eq!(headers["authorization"], "Bearer test-secret");
                    assert_eq!(body["messages"][1]["content"], "検索して");
                    assert_eq!(body["max_tokens"], 2048);
                },
                "anthropic" => {
                    assert_eq!(path, "/v1/messages");
                    assert_eq!(headers["x-api-key"], "test-secret");
                    assert_eq!(headers["anthropic-version"], "2023-06-01");
                    assert_eq!(body["max_tokens"], 2048);
                },
                _ => {
                    assert_eq!(path, "/v1/models/test-model:generateContent");
                    assert_eq!(headers["x-goog-api-key"], "test-secret");
                    assert_eq!(body["contents"][0]["role"], "user");
                    assert_eq!(
                        body["generationConfig"]["responseMimeType"],
                        "application/json"
                    );
                },
            }
            handle.abort();
        }
    }
    #[tokio::test]
    async fn upstream_errors_large_responses_and_redirects_are_not_exposed_or_followed() {
        for (status, body, location) in [
            (401, "upstream-secret".into(), None),
            (302, "redirect".into(), Some("/must-not-follow")),
            (200, "x".repeat(RESPONSE_LIMIT + 1), None),
            (200, "invalid json".into(), None),
        ] {
            let (base, _, count, handle) = mock_server(status, body, location).await;
            let settings = settings_at(&base, "openai");
            let result = generate_with_origins(
                &settings,
                "system",
                &[],
                &json!({}),
                std::slice::from_ref(&base),
            )
            .await;
            assert!(result.is_err());
            assert!(!result.unwrap_err().to_string().contains("upstream-secret"));
            assert_eq!(count.load(Ordering::SeqCst), 1);
            handle.abort();
        }
    }
    #[tokio::test]
    async fn speech_uses_independent_connection_and_multipart() {
        let (base, rx, _, handle) =
            mock_server(200, json!({"text":"施設を検索"}).to_string(), None).await;
        let mut settings = settings_at(&base, "openai");
        settings.config.base_url = "https://llm.example.invalid/v1".into();
        settings.speech_api_key =
            Some(super::super::settings::validate_key("speech-secret").unwrap());
        let text = transcribe_with_origins(
            &settings,
            b"RIFFxxxxWAVErecorded-audio".to_vec(),
            std::slice::from_ref(&base),
        )
        .await
        .unwrap();
        assert_eq!(text, "施設を検索");
        let (method, path, headers, bytes) = rx.await.unwrap();
        assert_eq!(method, "POST");
        assert_eq!(path, "/v1/audio/transcriptions");
        assert_eq!(headers["authorization"], "Bearer speech-secret");
        assert!(
            headers["content-type"]
                .to_str()
                .unwrap()
                .starts_with("multipart/form-data; boundary=")
        );
        let raw = String::from_utf8(bytes).unwrap();
        assert!(raw.contains("name=\"model\"\r\n\r\ntest-speech"));
        assert!(raw.contains("filename=\"recording.wav\""));
        assert!(raw.contains("recorded-audio"));
        assert!(!raw.contains("speech-secret"));
        handle.abort();
        assert!(
            transcribe_with_origins(
                &settings,
                vec![0; AUDIO_LIMIT + 1],
                std::slice::from_ref(&base)
            )
            .await
            .is_err()
        );
    }
}
