//! Google Maps 接続。資格情報・Googleセッションはブラウザーへ公開しない。
pub mod routes;

use crate::{
    auth::verify_access_token,
    config::CONFIG,
    db::{BasemapScope, tiles::load_google_tile_type},
    error::AppError,
    middleware::{extract_cookie_value, token_is_active},
};
use axum::{
    Json,
    body::Body,
    extract::{Extension, Path, Query},
    http::{HeaderMap, Response, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

// 背景地図機能が保存済みのキーを復号できるよう、既存の AAD を引き継ぐ。
const GOOGLE_MAPS_KEY_AAD: &[u8] = b"google-maps-tiles-v1";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum MapType {
    Roadmap,
    Satellite,
    Terrain,
}

#[derive(sqlx::FromRow)]
struct Settings {
    revision: String,
    enabled: bool,
    encrypted_tiles_key: Option<Vec<u8>>,
    language: String,
    region: String,
    requests_per_minute: i32,
}

pub struct GoogleMaps {
    client: reqwest::Client,
    base_url: String,
    cipher: Option<LessSafeKey>,
    sessions: Mutex<HashMap<String, Session>>,
    limits: Mutex<HashMap<String, (Instant, u32)>>,
    concurrent: Semaphore,
    routes: routes::RoutesService,
}

#[derive(Clone)]
struct Session {
    token: String,
    expiry: i64,
}

impl Default for GoogleMaps {
    fn default() -> Self {
        let encryption_key = std::env::var("GOOGLE_MAPS_ENCRYPTION_KEY")
            .or_else(|_| std::env::var("TILE_SETTINGS_ENCRYPTION_KEY"))
            .ok();
        Self::new(
            "https://tile.googleapis.com".into(),
            encryption_key.as_deref(),
        )
    }
}

impl GoogleMaps {
    // base_urlは実行時の管理設定では変更しない。模擬HTTPサーバーによる検証にも使用する。
    pub fn new(base_url: String, encryption_key: Option<&str>) -> Self {
        let cipher = encryption_key
            .and_then(|key| STANDARD.decode(key.trim()).ok())
            .and_then(|bytes| UnboundKey::new(&aead::AES_256_GCM, &bytes).ok())
            .map(LessSafeKey::new);
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Google HTTP client"),
            base_url,
            cipher,
            sessions: Mutex::new(HashMap::new()),
            limits: Mutex::new(HashMap::new()),
            concurrent: Semaphore::new(32),
            routes: routes::RoutesService::default(),
        }
    }

    fn encrypt(&self, key: &str) -> Result<Vec<u8>, AppError> {
        let cipher = self.cipher.as_ref().ok_or_else(|| {
            AppError::Validation("GOOGLE_MAPS_ENCRYPTION_KEYを設定してください。".into())
        })?;
        let mut nonce = [0; aead::NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| AppError::InternalServerError)?;
        let mut bytes = key.as_bytes().to_vec();
        cipher
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(GOOGLE_MAPS_KEY_AAD),
                &mut bytes,
            )
            .map_err(|_| AppError::InternalServerError)?;
        Ok([nonce.as_slice(), bytes.as_slice()].concat())
    }

    fn decrypt(&self, stored: &[u8]) -> Result<String, AppError> {
        let cipher = self.cipher.as_ref().ok_or(AppError::InternalServerError)?;
        let (nonce, data) = stored
            .split_first_chunk::<{ aead::NONCE_LEN }>()
            .ok_or(AppError::InternalServerError)?;
        let mut bytes = data.to_vec();
        let clear = cipher
            .open_in_place(
                Nonce::assume_unique_for_key(*nonce),
                Aad::from(GOOGLE_MAPS_KEY_AAD),
                &mut bytes,
            )
            .map_err(|_| AppError::InternalServerError)?;
        String::from_utf8(clear.to_vec()).map_err(|_| AppError::InternalServerError)
    }

    fn api_key(&self, settings: &Settings) -> Result<String, AppError> {
        self.decrypt(
            settings
                .encrypted_tiles_key
                .as_deref()
                .ok_or(AppError::BadGateway)?,
        )
    }

    async fn limit(&self, actor: &str, maximum: u32) -> Result<(), AppError> {
        let mut limits = self.limits.lock().await;
        limits.retain(|_, (start, _)| start.elapsed() < Duration::from_secs(60));
        for (key, cap) in [
            ("global".to_owned(), maximum),
            (actor.to_owned(), maximum.min(600)),
        ] {
            let entry = limits.entry(key).or_insert((Instant::now(), 0));
            if entry.1 >= cap {
                return Err(AppError::TooManyRequests(
                    "Google背景地図の利用上限に達しました。時間をおいて再試行してください。".into(),
                ));
            }
            entry.1 += 1;
        }
        Ok(())
    }

    async fn session(&self, settings: &Settings, map_type: MapType) -> Result<Session, AppError> {
        let cache_key = format!("{}:{map_type:?}", settings.revision);
        // 同一プロセス内の重複発行を防ぐ。セッション以外のタイル本体は保存しない。
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, value| value.expiry > Utc::now().timestamp() + 60);
        if let Some(session) = sessions.get(&cache_key) {
            return Ok(session.clone());
        }
        let key = self.api_key(settings)?;
        let mut body = json!({"mapType": map_type, "language": settings.language, "region": settings.region, "imageFormat":"png"});
        if map_type == MapType::Terrain {
            body["layerTypes"] = json!(["layerRoadmap"]);
        }
        let response = self
            .client
            .post(format!("{}/v1/createSession", self.base_url))
            .query(&[("key", key)])
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| AppError::BadGateway)?;
        let value: Value = serde_json::from_slice(&read_response(response, 64 * 1024).await?)
            .map_err(|_| AppError::BadGateway)?;
        let expiry = value["expiry"]
            .as_str()
            .and_then(|v| v.parse().ok())
            .or_else(|| value["expiry"].as_i64())
            .ok_or(AppError::BadGateway)?;
        let token = value["session"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() < 4096)
            .ok_or(AppError::BadGateway)?
            .to_owned();
        if expiry <= Utc::now().timestamp() + 60
            || value["tileWidth"] != 256
            || value["tileHeight"] != 256
            || value["imageFormat"] != "png"
        {
            return Err(AppError::BadGateway);
        }
        let session = Session { token, expiry };
        sessions.insert(cache_key, session.clone());
        Ok(session)
    }

    async fn get(
        &self,
        settings: &Settings,
        map_type: MapType,
        path: &str,
        params: &[(String, String)],
    ) -> Result<reqwest::Response, AppError> {
        let session = self.session(settings, map_type).await?;
        let key = self.api_key(settings)?;
        let response = self
            .client
            .get(format!("{}{path}", self.base_url))
            .query(&[("key", key.clone()), ("session", session.token.clone())])
            .query(params)
            .send()
            .await
            .map_err(|_| AppError::BadGateway)?;
        // Google側で期限前に無効化されたセッションは一度だけ更新する。
        if response.status() != reqwest::StatusCode::BAD_REQUEST {
            return Ok(response);
        }
        let cache_key = format!("{}:{map_type:?}", settings.revision);
        {
            let mut sessions = self.sessions.lock().await;
            if sessions
                .get(&cache_key)
                .is_some_and(|current| current.token == session.token)
            {
                sessions.remove(&cache_key);
            }
        }
        let renewed = self.session(settings, map_type).await?;
        self.client
            .get(format!("{}{path}", self.base_url))
            .query(&[("key", key), ("session", renewed.token)])
            .query(params)
            .send()
            .await
            .map_err(|_| AppError::BadGateway)
    }
}

async fn read_response(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, AppError> {
    match response.status().as_u16() {
        200 => (),
        429 => {
            return Err(AppError::TooManyRequests(
                "Google Maps APIの利用上限に達しました。".into(),
            ));
        },
        404 => return Err(AppError::NotFound),
        _ => return Err(AppError::BadGateway),
    }
    if response
        .content_length()
        .is_some_and(|size| size > max as u64)
    {
        return Err(AppError::BadGateway);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| AppError::BadGateway)? {
        if bytes.len() + chunk.len() > max {
            return Err(AppError::BadGateway);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn settings(pool: &SqlitePool) -> Result<Settings, AppError> {
    load_settings(pool).await
}
async fn load_settings<'e, E: sqlx::Executor<'e, Database = sqlx::Sqlite>>(
    executor: E,
) -> Result<Settings, AppError> {
    Ok(sqlx::query_as::<_, Settings>(
        r#"
        SELECT
            revision,
            enabled,
            encrypted_tiles_key,
            language,
            region,
            requests_per_minute
        FROM google_maps_settings
        WHERE id = 1
        "#,
    )
    .fetch_optional(executor)
    .await?
    .unwrap_or(Settings {
        revision: Uuid::nil().to_string(),
        enabled: false,
        encrypted_tiles_key: None,
        language: "ja-JP".into(),
        region: "JP".into(),
        requests_per_minute: 1200,
    }))
}

fn view(settings: &Settings, service: &GoogleMaps) -> Value {
    json!({"revision":settings.revision, "enabled":settings.enabled, "hasApiKey":settings.encrypted_tiles_key.is_some(),
        "keyStorageConfigured":service.cipher.is_some(), "language":settings.language, "region":settings.region, "requestsPerMinute":settings.requests_per_minute})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsInput {
    revision: Uuid,
    enabled: bool,
    api_key: Option<String>,
    language: String,
    region: String,
    requests_per_minute: i32,
}

fn validate_input(input: &SettingsInput) -> Result<(), AppError> {
    if input.language.is_empty()
        || input.language.len() > 35
        || !input
            .language
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || input.region.len() != 2
        || !input.region.bytes().all(|b| b.is_ascii_uppercase())
        || !(60..=60000).contains(&input.requests_per_minute)
        || input.api_key.as_ref().is_some_and(|key| {
            key.len() > 512
                || key
                    .bytes()
                    .any(|b| !b.is_ascii_alphanumeric() && b != b'-' && b != b'_')
        })
    {
        return Err(AppError::Validation(
            "言語・地域・APIキー・利用上限の形式を確認してください。".into(),
        ));
    }
    Ok(())
}

pub async fn admin_get(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
) -> Result<impl IntoResponse, AppError> {
    crate::handler::live_map::require_superuser(&user, &pool).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(view(&settings(&pool).await?, &service)),
    ))
}

pub async fn admin_update(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
    Json(input): Json<SettingsInput>,
) -> Result<impl IntoResponse, AppError> {
    crate::handler::live_map::require_superuser(&user, &pool).await?;
    validate_input(&input)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let current = load_settings(&mut *tx).await?;
    if current.revision != input.revision.to_string() {
        return Err(AppError::Conflict);
    }
    let encrypted = match input.api_key.as_deref().filter(|key| !key.is_empty()) {
        Some(key) => Some(service.encrypt(key)?),
        None => current.encrypted_tiles_key,
    };
    if input.enabled && encrypted.is_none() {
        return Err(AppError::Validation(
            "Google Maps APIキーを入力してください。".into(),
        ));
    }
    let next = Settings {
        revision: Uuid::new_v4().to_string(),
        enabled: input.enabled,
        encrypted_tiles_key: encrypted,
        language: input.language,
        region: input.region,
        requests_per_minute: input.requests_per_minute,
    };
    sqlx::query(
        r#"
        INSERT INTO google_maps_settings (
            id,
            revision,
            enabled,
            encrypted_tiles_key,
            language,
            region,
            requests_per_minute
        ) VALUES (1, $1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE
        SET
            revision = $1,
            enabled = $2,
            encrypted_tiles_key = $3,
            language = $4,
            region = $5,
            requests_per_minute = $6,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(&next.revision)
    .bind(next.enabled)
    .bind(&next.encrypted_tiles_key)
    .bind(&next.language)
    .bind(&next.region)
    .bind(next.requests_per_minute)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    service.sessions.lock().await.clear();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(view(&next, &service)),
    ))
}

pub async fn admin_check(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
    Json(input): Json<SettingsInput>,
) -> Result<impl IntoResponse, AppError> {
    crate::handler::live_map::require_superuser(&user, &pool).await?;
    validate_input(&input)?;
    let mut candidate = settings(&pool).await?;
    if candidate.revision != input.revision.to_string() {
        return Err(AppError::Conflict);
    }
    if let Some(key) = input.api_key.as_deref().filter(|v| !v.is_empty()) {
        candidate.encrypted_tiles_key = Some(service.encrypt(key)?);
    }
    if candidate.encrypted_tiles_key.is_none() {
        return Err(AppError::Validation(
            "Google Maps APIキーを入力してください。".into(),
        ));
    }
    candidate.revision = Uuid::new_v4().to_string();
    candidate.language = input.language;
    candidate.region = input.region;
    service.limit("admin-check", 30).await?;
    let result = async {
        service.session(&candidate, MapType::Roadmap).await?;
        let response = service
            .get(&candidate, MapType::Roadmap, "/v1/2dtiles/0/0/0", &[])
            .await?;
        let bytes = read_response(response, 4 * 1024 * 1024).await?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(AppError::BadGateway);
        }
        let params = vec![
            ("zoom".into(), "0".into()),
            ("north".into(), "85".into()),
            ("south".into(), "-85".into()),
            ("east".into(), "180".into()),
            ("west".into(), "-180".into()),
        ];
        let response = service
            .get(&candidate, MapType::Roadmap, "/tile/v1/viewport", &params)
            .await?;
        let value: Value = serde_json::from_slice(&read_response(response, 256 * 1024).await?)
            .map_err(|_| AppError::BadGateway)?;
        if !value["copyright"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        {
            return Err(AppError::BadGateway);
        }
        Ok::<(), AppError>(())
    }
    .await;
    service
        .sessions
        .lock()
        .await
        .remove(&format!("{}:{:?}", candidate.revision, MapType::Roadmap));
    result?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"ok":true})),
    ))
}

#[derive(Clone, Deserialize, Serialize)]
struct Access {
    purpose: String,
    scope: String,
    id: String,
    revision: String,
    exp: usize,
    background_id: Option<i64>,
    map_type: Option<MapType>,
    settings_revision: Option<String>,
}

fn sign(access: &Access, secret: &[u8]) -> Result<String, AppError> {
    encode(
        &Header::default(),
        access,
        &EncodingKey::from_secret(secret),
    )
    .map_err(|_| AppError::InternalServerError)
}
fn password_revision(password: Option<&str>) -> String {
    format!("{:x}", Sha256::digest(password.unwrap_or("").as_bytes()))
}
pub(crate) fn temporary_access(map: &crate::model::TemporaryUrlFromDB) -> Result<String, AppError> {
    let expiry = chrono::NaiveDateTime::parse_from_str(&map.expiration, "%Y-%m-%d %H:%M:%S%.f")
        .map_err(|_| unauthorized())?;
    let access = Access {
        purpose: "google-map-view".into(),
        scope: "temporary".into(),
        id: map.id.clone(),
        revision: password_revision(map.password_hash.as_deref()),
        exp: expiry
            .and_utc()
            .timestamp()
            .try_into()
            .map_err(|_| unauthorized())?,
        background_id: None,
        map_type: None,
        settings_revision: None,
    };
    sign(&access, CONFIG.secret_key.as_bytes())
}
pub(crate) fn live_access(
    id: &str,
    version: i64,
    expiry: chrono::DateTime<Utc>,
) -> Result<String, AppError> {
    let access = Access {
        purpose: "google-map-view".into(),
        scope: "live".into(),
        id: id.to_owned(),
        revision: version.to_string(),
        exp: expiry.timestamp().try_into().map_err(|_| unauthorized())?,
        background_id: None,
        map_type: None,
        settings_revision: None,
    };
    sign(&access, CONFIG.secret_key.as_bytes())
}
fn decode_access(token: &str, purpose: &str, secret: &[u8]) -> Result<Access, AppError> {
    let mut validation = Validation::default();
    validation.leeway = 0;
    let access = decode::<Access>(token, &DecodingKey::from_secret(secret), &validation)
        .map_err(|_| unauthorized())?
        .claims;
    if access.purpose != purpose {
        return Err(unauthorized());
    }
    Ok(access)
}
fn unauthorized() -> AppError {
    AppError::Unauthorized("map_access_required".into())
}
async fn check_access(pool: &SqlitePool, access: &Access) -> Result<(), AppError> {
    let valid = match access.scope.as_str() {
        "account" => {
            token_is_active(
                pool,
                &access.id,
                access.revision.parse().map_err(|_| unauthorized())?,
            )
            .await
        },
        "temporary" => sqlx::query_as::<_, (Option<String>,)>(
            r#"
            SELECT
                password_hash
            FROM temporary_urls
            WHERE id = $1
                AND julianday(expiration) > julianday('now')
            "#,
        )
        .bind(&access.id)
        .fetch_optional(pool)
        .await?
        .is_some_and(|row| password_revision(row.0.as_deref()) == access.revision),
        "live" => sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                access_version
            FROM live_map
            WHERE id = $1
                AND revoked_at IS NULL
                AND julianday(expires_at) > julianday('now')
            "#,
        )
        .bind(&access.id)
        .fetch_optional(pool)
        .await?
        .is_some_and(|version| version.to_string() == access.revision),
        _ => false,
    };
    if valid { Ok(()) } else { Err(unauthorized()) }
}

async fn allowed_map_type(
    pool: &SqlitePool,
    access: &Access,
    id: i64,
) -> Result<MapType, AppError> {
    let scope = match access.scope.as_str() {
        "account" => BasemapScope::Normal,
        "temporary" => BasemapScope::Temporary,
        "live" => BasemapScope::Live,
        _ => return Err(unauthorized()),
    };
    match load_google_tile_type(pool, id, scope).await?.as_deref() {
        Some("roadmap") => Ok(MapType::Roadmap),
        Some("satellite") => Ok(MapType::Satellite),
        Some("terrain") => Ok(MapType::Terrain),
        _ => Err(AppError::Forbidden("この背景地図は使用できません。".into())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextInput {
    background_id: i64,
    access: Option<String>,
}
pub async fn context(
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
    headers: HeaderMap,
    Json(input): Json<ContextInput>,
) -> Result<impl IntoResponse, AppError> {
    let mut access = if let Some(token) = input.access.as_deref() {
        decode_access(token, "google-map-view", CONFIG.secret_key.as_bytes())?
    } else {
        let token = extract_cookie_value(&headers, "access_token").ok_or_else(unauthorized)?;
        let claims = verify_access_token(token).map_err(|_| unauthorized())?;
        Access {
            purpose: String::new(),
            scope: "account".into(),
            id: claims.sub,
            revision: claims.auth_version.to_string(),
            exp: claims.exp,
            background_id: None,
            map_type: None,
            settings_revision: None,
        }
    };
    if access.exp <= Utc::now().timestamp() as usize {
        return Err(unauthorized());
    }
    check_access(&pool, &access).await?;
    let map_type = allowed_map_type(&pool, &access, input.background_id).await?;
    let settings = settings(&pool).await?;
    if !settings.enabled {
        return Err(AppError::Forbidden("Google背景地図は無効です。".into()));
    }
    let routes_enabled = access.scope == "account" && routes::enabled(&pool).await?;
    service
        .limit(
            &format!("{}:{}", access.scope, access.id),
            settings.requests_per_minute as u32,
        )
        .await?;
    let _permit = service
        .concurrent
        .try_acquire()
        .map_err(|_| AppError::TooManyRequests("Google背景地図が混雑しています。".into()))?;
    service.session(&settings, map_type).await?;
    access.purpose = "google-map-tiles".into();
    access.background_id = Some(input.background_id);
    access.map_type = Some(map_type);
    access.settings_revision = Some(settings.revision);
    access.exp = access.exp.min((Utc::now().timestamp() + 600) as usize);
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "grant": sign(&access, CONFIG.secret_key.as_bytes())?,
            "expiresAt": access.exp,
            "tileSize": 256,
            "routesEnabled": routes_enabled,
        })),
    ))
}

async fn authorize_grant(
    pool: &SqlitePool,
    headers: &HeaderMap,
    service: &GoogleMaps,
) -> Result<(Settings, MapType), AppError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(unauthorized)?;
    let access = decode_access(token, "google-map-tiles", CONFIG.secret_key.as_bytes())?;
    check_access(pool, &access).await?;
    let id = access.background_id.ok_or_else(unauthorized)?;
    let map_type = allowed_map_type(pool, &access, id).await?;
    if access.map_type != Some(map_type) {
        return Err(AppError::Conflict);
    }
    let settings = settings(pool).await?;
    if !settings.enabled || access.settings_revision.as_deref() != Some(settings.revision.as_str())
    {
        return Err(AppError::Conflict);
    }
    service
        .limit(
            &format!("{}:{}", access.scope, access.id),
            settings.requests_per_minute as u32,
        )
        .await?;
    Ok((settings, map_type))
}

pub async fn tile(
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
    headers: HeaderMap,
    Path((z, x, y)): Path<(u32, u32, u32)>,
) -> Result<Response<Body>, AppError> {
    if z > 22 || x >= 1u32 << z || y >= 1u32 << z {
        return Err(AppError::NotFound);
    }
    let (settings, map_type) = authorize_grant(&pool, &headers, &service).await?;
    let _permit = service
        .concurrent
        .try_acquire()
        .map_err(|_| AppError::TooManyRequests("Google背景地図が混雑しています。".into()))?;
    let response = service
        .get(
            &settings,
            map_type,
            &format!("/v1/2dtiles/{z}/{x}/{y}"),
            &[],
        )
        .await?;
    let bytes = read_response(response, 4 * 1024 * 1024).await?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::BadGateway);
    }
    // 上流の許可より厳しいno-storeとし、既存Redis・7日immutableキャッシュへ混ぜない。
    Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .map_err(|_| AppError::InternalServerError)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    zoom: u32,
    north: f64,
    south: f64,
    east: f64,
    west: f64,
}
pub async fn viewport(
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
    headers: HeaderMap,
    Query(view): Query<Viewport>,
) -> Result<impl IntoResponse, AppError> {
    if view.zoom > 22
        || ![view.north, view.south, view.east, view.west]
            .iter()
            .all(|v| v.is_finite())
        || !(-90.0..=90.0).contains(&view.south)
        || !(view.south..=90.0).contains(&view.north)
        || !(-180.0..=180.0).contains(&view.west)
        || !(-180.0..=180.0).contains(&view.east)
    {
        return Err(AppError::BadRequest);
    }
    let (settings, map_type) = authorize_grant(&pool, &headers, &service).await?;
    let _permit = service
        .concurrent
        .try_acquire()
        .map_err(|_| AppError::TooManyRequests("Google背景地図が混雑しています。".into()))?;
    let params = vec![
        ("zoom".into(), view.zoom.to_string()),
        ("north".into(), view.north.to_string()),
        ("south".into(), view.south.to_string()),
        ("east".into(), view.east.to_string()),
        ("west".into(), view.west.to_string()),
    ];
    let response = service
        .get(&settings, map_type, "/tile/v1/viewport", &params)
        .await?;
    let value: Value = serde_json::from_slice(&read_response(response, 256 * 1024).await?)
        .map_err(|_| AppError::BadGateway)?;
    let copyright = value["copyright"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() < 16000)
        .ok_or(AppError::BadGateway)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"copyright":copyright,"maxZoomRects":value["maxZoomRects"]})),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sessions_are_shared_renewed_at_expiry_and_retried_only_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let upstream_calls = calls.clone();
        let tiles = Arc::new(AtomicUsize::new(0));
        let upstream_tiles = tiles.clone();
        let app=axum::Router::new().route("/v1/createSession",axum::routing::post(move || {
            let calls=upstream_calls.clone();async move {
                let number=calls.fetch_add(1,Ordering::SeqCst)+1;
                Json(json!({"session":format!("session-{number}"),"expiry":(Utc::now().timestamp()+3600).to_string(),"tileWidth":256,"tileHeight":256,"imageFormat":"png"}))
            }
        })).route("/v1/2dtiles/0/0/0",axum::routing::get(move || {
            let calls=upstream_tiles.clone();async move {
                if calls.fetch_add(1,Ordering::SeqCst)==0 { axum::http::StatusCode::BAD_REQUEST } else { axum::http::StatusCode::OK }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = GoogleMaps::new(
            format!("http://{}", listener.local_addr().unwrap()),
            Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let settings = Settings {
            revision: Uuid::new_v4().to_string(),
            enabled: true,
            encrypted_tiles_key: Some(service.encrypt("fixture-key").unwrap()),
            language: "ja-JP".into(),
            region: "JP".into(),
            requests_per_minute: 1200,
        };
        let (a, b, c) = tokio::join!(
            service.session(&settings, MapType::Roadmap),
            service.session(&settings, MapType::Roadmap),
            service.session(&settings, MapType::Roadmap)
        );
        assert_eq!(a.unwrap().token, b.unwrap().token);
        assert!(c.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        service
            .sessions
            .lock()
            .await
            .values_mut()
            .for_each(|session| session.expiry = Utc::now().timestamp() + 30);
        service.session(&settings, MapType::Roadmap).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(
            service
                .get(&settings, MapType::Roadmap, "/v1/2dtiles/0/0/0", &[])
                .await
                .unwrap()
                .status()
                .is_success()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(tiles.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[test]
    fn credential_encryption_detects_tampering_and_never_accepts_an_unconfigured_cipher() {
        let service = GoogleMaps::new(
            "http://127.0.0.1:9".into(),
            Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
        );
        let mut stored = service.encrypt("private-tiles-key").unwrap();
        assert_eq!(service.decrypt(&stored).unwrap(), "private-tiles-key");
        assert!(!String::from_utf8_lossy(&stored).contains("private-tiles-key"));
        stored[15] ^= 1;
        assert!(service.decrypt(&stored).is_err());
        assert!(
            GoogleMaps::new("http://127.0.0.1:9".into(), None)
                .encrypt("key")
                .is_err()
        );
        assert!(serde_json::from_value::<MapType>(json!("streetview")).is_err());
    }

    #[test]
    fn map_grants_reject_cross_purpose_tampering_and_expiry() {
        let mut access = Access {
            purpose: "google-map-tiles".into(),
            scope: "temporary".into(),
            id: Uuid::new_v4().to_string(),
            revision: "hash".into(),
            exp: (Utc::now().timestamp() + 60) as usize,
            background_id: Some(2),
            map_type: Some(MapType::Roadmap),
            settings_revision: Some(Uuid::new_v4().to_string()),
        };
        let secret = b"google-maps-test-secret";
        let token = sign(&access, secret).unwrap();
        assert!(decode_access(&token, "google-map-tiles", secret).is_ok());
        assert!(decode_access(&token, "google-map-view", secret).is_err());
        assert!(decode_access(&format!("{token}x"), "google-map-tiles", secret).is_err());
        access.exp = 1;
        assert!(
            decode_access(&sign(&access, secret).unwrap(), "google-map-tiles", secret).is_err()
        );
        assert_ne!(
            password_revision(Some("before")),
            password_revision(Some("after"))
        );
    }

    #[tokio::test]
    async fn invalid_access_and_coordinates_fail_without_touching_database_or_upstream() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_lazy("sqlite::memory:")
            .unwrap();
        let service = Arc::new(GoogleMaps::new("http://127.0.0.1:9".into(), None));
        assert!(matches!(
            context(
                Extension(pool.clone()),
                Extension(service.clone()),
                HeaderMap::new(),
                Json(ContextInput {
                    background_id: 2,
                    access: None
                })
            )
            .await,
            Err(AppError::Unauthorized(_))
        ));
        assert!(matches!(
            tile(
                Extension(pool),
                Extension(service),
                HeaderMap::new(),
                Path((23, 0, 0))
            )
            .await,
            Err(AppError::NotFound)
        ));
    }

    #[tokio::test]
    async fn per_actor_limits_and_global_limits_are_bounded() {
        let service = GoogleMaps::new("http://127.0.0.1:9".into(), None);
        service.limit("viewer-a", 2).await.unwrap();
        service.limit("viewer-b", 2).await.unwrap();
        assert!(matches!(
            service.limit("viewer-c", 2).await,
            Err(AppError::TooManyRequests(_))
        ));
    }
}
