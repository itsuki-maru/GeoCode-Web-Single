//! 認証済みの短いHTTPS要求で接続情報を交換する。映像はWebRTCでのみ送信する。
//! SQLiteの書き込みトランザクションと有効期限管理により、接続先を固定せずに複数のサーバプロセスで動作させる。
use crate::{config::CONFIG, error::AppError};
use axum::{
    Json,
    extract::{Extension, Path},
    http::{HeaderMap, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

const LEASE: i64 = 15;
const MAX_VIEWERS: i64 = 3;

/// サーバの終了とともに定期処理を中止する。
pub struct CleanupGuard(tokio::task::JoinHandle<()>);
impl Drop for CleanupGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}
pub fn start_cleanup(pool: SqlitePool) -> CleanupGuard {
    let config = CameraConfig::from_env();
    if config.enabled {
        if let Some(reason) = config.configuration_error() {
            tracing::warn!(reason, "Camera sharing disabled by configuration");
        }
    }
    // 機能を無効化した後も、以前の配信の接続情報を期限切れで削除する。
    CleanupGuard(tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            if cleanup(&pool).await.is_err() {
                tracing::warn!("Camera signaling cleanup failed");
            }
        }
    }))
}

#[derive(Clone)]
pub struct CameraConfig {
    pub provider: String,
    pub cloudflare_key_id: String,
    pub cloudflare_api_token: String,
    pub enabled: bool,
    pub urls: Vec<String>,
    pub stun_urls: Vec<String>,
    pub secret: String,
    pub relay_only: bool,
}
impl CameraConfig {
    pub fn from_env() -> Self {
        Self {
            provider: std::env::var("CAMERA_TURN_PROVIDER").unwrap_or_default(),
            cloudflare_key_id: std::env::var("CAMERA_CLOUDFLARE_TURN_KEY_ID").unwrap_or_default(),
            cloudflare_api_token: std::env::var("CAMERA_CLOUDFLARE_TURN_API_TOKEN")
                .unwrap_or_default(),
            enabled: std::env::var("CAMERA_SHARING_ENABLED").as_deref() == Ok("true"),
            urls: std::env::var("CAMERA_TURN_URLS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            secret: std::env::var("CAMERA_TURN_SECRET").unwrap_or_default(),
            stun_urls: std::env::var("CAMERA_STUN_URLS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            relay_only: std::env::var("CAMERA_RELAY_ONLY").as_deref() == Ok("true"),
        }
    }
    pub fn available(&self) -> bool {
        self.enabled && self.configuration_error().is_none()
    }
    pub fn configuration_error(&self) -> Option<&'static str> {
        if !self.stun_urls.iter().all(|u| valid_stun_url(u)) {
            return Some("invalid_stun_url");
        }
        match self.provider.as_str() {
            "cloudflare" => {
                if self.cloudflare_key_id.len() != 32
                    || !self
                        .cloudflare_key_id
                        .bytes()
                        .all(|c| c.is_ascii_hexdigit())
                {
                    return Some("invalid_cloudflare_key_id");
                }
                if self.cloudflare_api_token.is_empty()
                    || self.cloudflare_api_token.len() > 4096
                    || !self
                        .cloudflare_api_token
                        .bytes()
                        .all(|c| c.is_ascii_graphic())
                {
                    return Some("invalid_cloudflare_api_token");
                }
            },
            "none" => {
                if self.relay_only {
                    return Some("relay_requires_turn");
                }
            },
            "" | "coturn" => {
                if self.urls.is_empty() {
                    if !self.secret.is_empty() || self.relay_only || self.provider == "coturn" {
                        return Some("missing_turn_urls");
                    }
                } else if self.secret.len() < 32 || !self.urls.iter().all(|u| valid_turn_url(u)) {
                    return Some("invalid_coturn_config");
                }
            },
            _ => return Some("unknown_turn_provider"),
        }
        None
    }
    fn require(&self) -> Result<(), AppError> {
        if self.available() {
            Ok(())
        } else {
            Err(AppError::NotFound)
        }
    }
    fn ice(&self, identity: Uuid) -> Value {
        let mut servers = Vec::new();
        if !self.stun_urls.is_empty() {
            servers.push(json!({"urls": self.stun_urls}));
        }
        if !self.urls.is_empty() && matches!(self.provider.as_str(), "" | "coturn") {
            let username = format!("{}:{identity}", Utc::now().timestamp() + 86400);
            servers.push(json!({"urls": self.urls, "username": username, "credential": turn_password(&self.secret, &username)}));
        }
        json!(servers)
    }
    async fn connection_ice(&self, identity: Uuid) -> Result<Value, AppError> {
        let servers = self.ice(identity);
        if self.provider == "cloudflare" {
            let result = super::camera_turn::credentials(
                &self.cloudflare_key_id,
                &self.cloudflare_api_token,
                identity,
            )
            .await;
            return self.merge_cloudflare_ice(servers, result);
        }
        Ok(servers)
    }
    fn merge_cloudflare_ice(
        &self,
        mut servers: Value,
        result: Result<Value, &'static str>,
    ) -> Result<Value, AppError> {
        match result {
            Ok(turn) => servers
                .as_array_mut()
                .unwrap()
                .extend(turn.as_array().unwrap().iter().cloned()),
            Err(reason) => {
                tracing::warn!(
                    reason,
                    relay_only = self.relay_only,
                    "Cloudflare TURN credentials unavailable"
                );
                if self.relay_only {
                    return Err(AppError::BadGateway);
                }
            },
        }
        Ok(servers)
    }
}
fn turn_password(secret: &str, username: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts arbitrary key lengths");
    mac.update(username.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}
fn key_hash(key: Uuid) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}

pub(super) fn valid_stun_url(value: &str) -> bool {
    value
        .strip_prefix("stun:")
        .is_some_and(|address| !address.contains('?') && valid_turn_url(&format!("turn:{address}")))
}

pub(super) fn valid_turn_url(value: &str) -> bool {
    let Some((scheme, address)) = value.split_once(':') else {
        return false;
    };
    if !matches!(scheme, "turn" | "turns")
        || value.len() > 512
        || value.contains([' ', '\n', '\r', '@', '\\'])
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&format!("https://{address}")) else {
        return false;
    };
    url.host_str().is_some()
        && url.path() == "/"
        && url.fragment().is_none()
        && matches!(
            url.query(),
            None | Some("transport=tcp") | Some("transport=udp")
        )
        && !(scheme == "turns" && url.query() == Some("transport=udp"))
}

/// 各プロセスで処理量を制限して清掃し、有効期限を過ぎた一時的な通信情報を削除する。
pub async fn cleanup(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        DELETE FROM live_camera_viewer
        WHERE id IN (
            SELECT v.id FROM live_camera_viewer v
            JOIN live_camera_session c ON c.id=v.camera_id
            WHERE v.expires_at<=CURRENT_TIMESTAMP
            OR c.expires_at<=CURRENT_TIMESTAMP
            LIMIT 1000
        )"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        DELETE FROM live_camera_session
        WHERE id IN (
            SELECT id FROM live_camera_session
            WHERE expires_at<datetime('now','-1 day')
            LIMIT 1000
        )"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}
fn reply(value: Value) -> Response {
    ([(CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

pub async fn capabilities(Extension(config): Extension<CameraConfig>) -> Response {
    reply(
        json!({"enabled":config.available(),"protocol":2,"max_viewers":MAX_VIEWERS,"lease_ms":LEASE*1000,"poll_ms":1000}),
    )
}

#[derive(Deserialize)]
pub struct Start {
    pub id: Uuid,
}
#[derive(FromRow)]
struct Camera {
    id: Uuid,
    user_id: String,
    location_session_id: String,
}

pub async fn start(
    Extension(pool): Extension<SqlitePool>,
    Extension(config): Extension<CameraConfig>,
    Extension(user): Extension<String>,
    Path(location): Path<String>,
    Json(input): Json<Start>,
) -> Result<Response, AppError> {
    config.require()?;
    // 外部API待機中はロックを保持せず、取得後に再認可する。
    if config.provider == "cloudflare" {
        let allowed: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(SELECT 1 FROM live_location_session s
            JOIN user_model u ON u.id=s.user_id
            WHERE s.user_id=$1 AND s.session_id=$2
            AND u.can_share_live_location AND NOT u.is_locked
            AND julianday(s.received_at)>julianday('now')-($3/86400.0))
        "#,
        )
        .bind(&user)
        .bind(&location)
        .bind(CONFIG.live_location_offline_seconds as f64)
        .fetch_one(&pool)
        .await?;
        if !allowed {
            return Err(AppError::Forbidden(
                "Camera sharing is not permitted.".into(),
            ));
        }
        // 停止済みID・他人のID・既存配信との競合では資格情報を発行しない。
        let conflict: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(SELECT 1 FROM live_camera_session
                WHERE id=$1 AND (user_id<>$2 OR location_session_id<>$3
                OR expires_at<=CURRENT_TIMESTAMP
                OR created_at<=datetime('now','-23 hours')))
            OR EXISTS(SELECT 1 FROM live_camera_session
                WHERE user_id=$2 AND id<>$1 AND expires_at>CURRENT_TIMESTAMP
                AND created_at>datetime('now','-23 hours'))
        "#,
        )
        .bind(input.id)
        .bind(&user)
        .bind(&location)
        .fetch_one(&pool)
        .await?;
        if conflict {
            return Err(AppError::Conflict);
        }
    }
    let ice_servers = config.connection_ice(input.id).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    // 位置情報の更新処理とロック順序を揃え、同じ所有者の開始処理を直列化する。
    let allowed = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT can_share_live_location AND NOT is_locked
        FROM user_model WHERE id=$1
        "#,
    )
    .bind(&user)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);
    if !allowed {
        return Err(AppError::Forbidden(
            "Camera sharing is not permitted.".into(),
        ));
    }
    let current = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM live_location_session
            WHERE user_id=$1
            AND session_id=$2
            AND julianday(received_at)>julianday('now')-($3/86400.0)
        )
        "#,
    )
    .bind(&user)
    .bind(&location)
    .bind(CONFIG.live_location_offline_seconds as f64)
    .fetch_one(&mut *tx)
    .await?;
    if !current {
        return Err(AppError::Conflict);
    }
    // 遅れて届いた作成要求でセッションが復活しないよう、期限切れのIDを1日間保持する。
    sqlx::query(
        r#"
        DELETE FROM live_camera_session
        WHERE id IN (
            SELECT id FROM live_camera_session
            WHERE expires_at < datetime('now','-1 day') LIMIT 100
        )
        "#,
    )
    .execute(&mut *tx)
    .await?;
    // 停止・期限更新と同じDBの時計で判定し、同時更新は書き込みトランザクションで直列化する。
    if let Some((owner, old_location, active)) = sqlx::query_as::<_, (String, String, bool)>(
        r#"
        SELECT
            user_id,
            location_session_id,
            expires_at>CURRENT_TIMESTAMP AND (NOT $2 OR created_at>datetime('now','-23 hours'))
        FROM live_camera_session WHERE id=$1
        "#,
    )
    .bind(input.id)
    .bind(config.provider == "cloudflare")
    .fetch_optional(&mut *tx)
    .await?
    {
        if owner != user || old_location != location || !active {
            return Err(AppError::Conflict);
        }
    } else {
        let busy = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM live_camera_session
                WHERE user_id=$1
                AND expires_at>CURRENT_TIMESTAMP
                AND (NOT $2 OR created_at>datetime('now','-23 hours'))
            )
            "#,
        )
        .bind(&user)
        .bind(config.provider == "cloudflare")
        .fetch_one(&mut *tx)
        .await?;
        if busy {
            return Err(AppError::Conflict);
        }
        sqlx::query(
            r#"
            INSERT INTO live_camera_session(
              id,
              user_id,
              location_session_id
            ) VALUES($1, $2, $3)
            "#,
        )
        .bind(input.id)
        .bind(&user)
        .bind(&location)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(reply(json!({
        "id": input.id,
        "ice_servers": ice_servers,
        "relay_only": config.relay_only,
        "lease_ms": LEASE * 1000,
    })))
}

async fn camera(
    tx: &mut Transaction<'_, Sqlite>,
    id: Uuid,
    config: &CameraConfig,
) -> Result<Camera, AppError> {
    let c = sqlx::query_as::<_, Camera>(
        r#"
        SELECT * FROM live_camera_session
        WHERE id=$1 AND expires_at>CURRENT_TIMESTAMP
        AND (NOT $2 OR created_at>datetime('now','-23 hours'))
        "#,
    )
    .bind(id)
    .bind(config.provider == "cloudflare")
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let valid = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM live_location_session s
            JOIN user_model u ON u.id=s.user_id
            WHERE s.user_id=$1
            AND s.session_id=$2
            AND u.can_share_live_location
            AND NOT u.is_locked
            AND julianday(s.received_at)>julianday('now')-($3/86400.0)
        )
        "#,
    )
    .bind(&c.user_id)
    .bind(&c.location_session_id)
    .bind(CONFIG.live_location_offline_seconds as f64)
    .fetch_one(&mut **tx)
    .await?;

    if !valid {
        return Err(AppError::NotFound);
    }
    Ok(c)
}

pub async fn stop(
    Extension(pool): Extension<SqlitePool>,
    Extension(user): Extension<String>,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    sqlx::query(
        r#"
        UPDATE live_camera_session
        SET expires_at=min(expires_at,CURRENT_TIMESTAMP)
        WHERE id=$1 AND user_id=$2
        "#,
    )
    .bind(id)
    .bind(&user)
    .execute(&pool)
    .await?;
    Ok(reply(json!({"stopped":true})))
}

#[derive(Deserialize)]
pub struct Join {
    pub id: Uuid,
    pub key: Uuid,
}
pub async fn join(
    Extension(pool): Extension<SqlitePool>,
    Extension(config): Extension<CameraConfig>,
    Path((public, member)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<Join>,
) -> Result<Response, AppError> {
    config.require()?;
    let map = super::live_map::authorize_camera_viewer(&pool, &public, &headers).await?;
    let id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT c.id FROM live_camera_session c
        JOIN live_map_member m ON m.user_id=c.user_id
        WHERE m.id=$1 AND m.map_id=$2
        AND c.expires_at>CURRENT_TIMESTAMP
        ORDER BY c.created_at DESC LIMIT 1
        "#,
    )
    .bind(&member)
    .bind(&map.id)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::NotFound)?;

    // 外部通信前に配信を検証し、ロックを解放する。
    if config.provider == "cloudflare" {
        let mut preflight = pool.begin_with("BEGIN IMMEDIATE").await?;
        camera(&mut preflight, id, &config).await?;
        prune(&mut preflight, id).await?;
        let existing: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM live_camera_viewer
                WHERE id=$1
                AND camera_id=$2
                AND member_id=$3
                AND key_hash=$4
                AND access_version=$5
                AND NOT failed
            )
            "#,
        )
        .bind(input.id)
        .bind(id)
        .bind(&member)
        .bind(key_hash(input.key))
        .bind(map.access_version)
        .fetch_one(&mut *preflight)
        .await?;
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM live_camera_viewer WHERE camera_id=$1 AND NOT failed",
        )
        .bind(id)
        .fetch_one(&mut *preflight)
        .await?;
        if !existing && count >= MAX_VIEWERS {
            return Err(AppError::TooManyRequests("camera_full".into()));
        }
        preflight.commit().await?;
    }
    let ice_servers = config.connection_ice(input.id).await?;
    let map = super::live_map::authorize_camera_viewer(&pool, &public, &headers).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let member_valid: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM live_map_member m
            JOIN live_camera_session c
            ON c.user_id=m.user_id
            JOIN live_map lm
            ON lm.id=m.map_id
            WHERE m.id=$1
            AND m.map_id=$2
            AND c.id=$3
            AND lm.public_id=$4
            AND lm.access_version=$5
            AND lm.revoked_at IS NULL
            AND julianday(lm.expires_at)>julianday('now')
        )
        "#,
    )
    .bind(&member)
    .bind(&map.id)
    .bind(id)
    .bind(&public)
    .bind(map.access_version)
    .fetch_one(&mut *tx)
    .await?;
    if !member_valid {
        return Err(AppError::NotFound);
    }
    camera(&mut tx, id, &config).await?;
    prune(&mut tx, id).await?;
    let existing = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM live_camera_viewer
            WHERE id=$1 AND camera_id=$2
            AND member_id=$3
            AND key_hash=$4
            AND access_version=$5)
            "#,
    )
    .bind(input.id)
    .bind(id)
    .bind(&member)
    .bind(key_hash(input.key))
    .bind(map.access_version)
    .fetch_one(&mut *tx)
    .await?;

    if !existing {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM live_camera_viewer WHERE camera_id=$1 AND NOT failed",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if count >= MAX_VIEWERS {
            return Err(AppError::TooManyRequests("camera_full".into()));
        }
        sqlx::query(
            r#"
            INSERT INTO live_camera_viewer(
                id,
                camera_id,
                member_id,
                key_hash,
                access_version
            ) VALUES($1, $2, $3, $4, $5)
            "#,
        )
        .bind(input.id)
        .bind(id)
        .bind(&member)
        .bind(key_hash(input.key))
        .bind(map.access_version)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(reply(json!({
        "camera_id": id,
        "viewer_id": input.id,
        "ice_servers": ice_servers,
        "relay_only": config.relay_only,
        "lease_ms": LEASE * 1000,
    })))
}

async fn prune(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<(), AppError> {
    // 新規トークン要求時だけでなく、既存の接続も再検証する。削除時には待機中のSDP/ICEも消去する。
    sqlx::query(
        r#"
        DELETE FROM live_camera_viewer AS v
        WHERE camera_id=$1
        AND (
            v.expires_at<=CURRENT_TIMESTAMP OR NOT EXISTS(
                SELECT 1 FROM live_map_member mm JOIN live_map m
                ON m.id=mm.map_id
                JOIN live_camera_session c
                ON c.id=v.camera_id
                WHERE mm.id=v.member_id
                AND mm.user_id=c.user_id
                AND m.revoked_at IS NULL
                AND julianday(m.expires_at)>julianday('now')
                AND m.access_version=v.access_version)
            )
        "#,
    )
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct Exchange {
    #[serde(default)]
    pub failed_viewers: Vec<Uuid>,
    #[serde(default)]
    pub after: i64,
    #[serde(default)]
    pub messages: Vec<Outgoing>,
    pub key: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct Outgoing {
    pub message_id: Uuid,
    pub viewer_id: Uuid,
    pub kind: String,
    pub data: Value,
}

#[derive(Serialize, FromRow)]
struct Incoming {
    id: i64,
    viewer_id: Uuid,
    kind: String,
    data: Value,
}

fn validate_signal(signal: &Outgoing, publisher: bool) -> Result<(), AppError> {
    let max_json = if signal.kind == "ice" { 8192 } else { 65536 };
    if signal.data.to_string().len() > max_json {
        return Err(AppError::PayloadTooLarge("Camera signal too large".into()));
    }
    let valid = match signal.kind.as_str() {
        "offer" if publisher => signal
            .data
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 65536),
        "answer" if !publisher => signal
            .data
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 65536),
        "ice" => {
            signal
                .data
                .get("candidate")
                .and_then(Value::as_str)
                .is_some_and(|s| s.len() <= 4096)
                && signal
                    .data
                    .get("sdpMLineIndex")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n < 16)
                && signal
                    .data
                    .get("sdpMid")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.len() < 64)
        },
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest)
    }
}

async fn exchange(
    tx: &mut Transaction<'_, Sqlite>,
    c: &Camera,
    viewer: Option<Uuid>,
    input: &Exchange,
) -> Result<Value, AppError> {
    if input.after < 0
        || input.messages.len() > 32
        || input.failed_viewers.len() > 3
        || (viewer.is_some() && !input.failed_viewers.is_empty())
    {
        return Err(AppError::BadRequest);
    }
    prune(tx, c.id).await?;
    // 配信者が検出した失敗は、この配信に属する接続だけに反映する。
    for viewer_id in &input.failed_viewers {
        sqlx::query("UPDATE live_camera_viewer SET failed=true WHERE camera_id=$1 AND id=$2")
            .bind(c.id)
            .bind(viewer_id)
            .execute(&mut **tx)
            .await?;
    }
    let failed_peers: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM live_camera_viewer WHERE camera_id=$1 AND failed")
            .bind(c.id)
            .fetch_all(&mut **tx)
            .await?;
    sqlx::query("DELETE FROM live_camera_signal WHERE viewer_id IN (SELECT id FROM live_camera_viewer WHERE camera_id=$1 AND failed)")
        .bind(c.id).execute(&mut **tx).await?;
    let peers: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM live_camera_viewer WHERE camera_id=$1 AND NOT failed ORDER BY id",
    )
    .bind(c.id)
    .fetch_all(&mut **tx)
    .await?;
    if viewer.is_some_and(|id| !peers.contains(&id)) {
        return Err(AppError::NotFound);
    }
    for msg in &input.messages {
        validate_signal(msg, viewer.is_none())?;
        if !peers.contains(&msg.viewer_id) {
            continue;
        } // ICEの転送中に視聴者が退出している場合がある。
        if viewer.is_some_and(|id| id != msg.viewer_id) {
            return Err(AppError::Forbidden("Invalid signaling recipient".into()));
        }
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM live_camera_signal WHERE viewer_id=$1")
                .bind(msg.viewer_id)
                .fetch_one(&mut **tx)
                .await?;
        if count >= 256 {
            return Err(AppError::TooManyRequests("signaling_queue_full".into()));
        }
        sqlx::query(
            r#"
            INSERT INTO live_camera_signal(
                message_id,
                viewer_id,
                to_publisher,
                kind,
                data
            ) VALUES($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(msg.message_id)
        .bind(msg.viewer_id)
        .bind(viewer.is_some())
        .bind(&msg.kind)
        .bind(&msg.data)
        .execute(&mut **tx)
        .await?;
    }
    // 件数を制限したメッセージを接続削除まで保持し、一意のIDで再送の重複を排除する。
    // 受信側が処理済みでも、送信側がHTTP応答を受け取れなかった場合に対応する。
    let messages = sqlx::query_as::<_, Incoming>(
        r#"
        SELECT
            s.id,
            s.viewer_id,
            s.kind,
            s.data
        FROM live_camera_signal s
        JOIN live_camera_viewer v ON v.id=s.viewer_id
        WHERE v.camera_id=$1
        AND ($2 IS NULL OR v.id=$2)
        AND s.to_publisher=$3
        AND s.id>$4
        ORDER BY s.id
        LIMIT 96
        "#,
    )
    .bind(c.id)
    .bind(viewer)
    .bind(viewer.is_none())
    .bind(input.after)
    .fetch_all(&mut **tx)
    .await?;
    // 各応答をAndroidのカメラ通信に設定された256 KiBの上限未満に収める。
    // 残りのメッセージは破棄せず、次のカーソル付き要求で返す。
    let mut bytes = 0;
    let messages: Vec<_> = messages
        .into_iter()
        .take_while(|m| {
            bytes += m.data.to_string().len() + 256;
            bytes <= 240_000
        })
        .collect();
    Ok(json!({"peers":peers,"failed_peers":failed_peers,"messages":messages,"lease_ms":LEASE*1000}))
}

pub async fn publisher_exchange(
    Extension(pool): Extension<SqlitePool>,
    Extension(config): Extension<CameraConfig>,
    Extension(user): Extension<String>,
    Path(id): Path<Uuid>,
    Json(input): Json<Exchange>,
) -> Result<Response, AppError> {
    config.require()?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let c = camera(&mut tx, id, &config).await?;
    if c.user_id != user {
        return Err(AppError::Forbidden("Not the publisher".into()));
    }
    let value = exchange(&mut tx, &c, None, &input).await?;
    sqlx::query(
        r#"
        UPDATE live_camera_session
        SET expires_at=datetime('now','+15 seconds')
        WHERE id=$1
        "#,
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(reply(value))
}

pub async fn viewer_exchange(
    Extension(pool): Extension<SqlitePool>,
    Extension(config): Extension<CameraConfig>,
    Path((public, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<Exchange>,
) -> Result<Response, AppError> {
    config.require()?;
    let map = super::live_map::authorize_camera_viewer(&pool, &public, &headers).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let camera_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT v.camera_id
        FROM live_camera_viewer v
        JOIN live_map_member m ON m.id=v.member_id
        WHERE v.id=$1
        AND m.map_id=$2
        AND v.access_version=$3
        AND v.key_hash=$4
        AND v.expires_at>CURRENT_TIMESTAMP
        "#,
    )
    .bind(id)
    .bind(&map.id)
    .bind(map.access_version)
    .bind(key_hash(input.key.ok_or(AppError::BadRequest)?))
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;

    let c = camera(&mut tx, camera_id, &config).await?;
    let value = exchange(&mut tx, &c, Some(id), &input).await?;
    sqlx::query(
        r#"
        UPDATE live_camera_viewer
        SET expires_at=datetime('now','+15 seconds')
        WHERE id=$1
        "#,
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(reply(value))
}

#[derive(Deserialize)]
pub struct Leave {
    pub key: Uuid,
    #[serde(default)]
    pub failed: bool,
}

pub async fn leave(
    Extension(pool): Extension<SqlitePool>,
    Path((_public, id)): Path<(String, Uuid)>,
    Json(input): Json<Leave>,
) -> Result<Response, AppError> {
    // 失敗通知は有効期限まで保持し、配信者の次の取得で伝える。通常の退出は削除する。
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        r#"
        SELECT id FROM live_camera_session
        WHERE id=(
            SELECT camera_id FROM live_camera_viewer
            WHERE id=$1 AND key_hash=$2
        )

        "#,
    )
    .bind(id)
    .bind(key_hash(input.key))
    .fetch_optional(&mut *tx)
    .await?;

    let query = if input.failed {
        "UPDATE live_camera_viewer SET failed=true WHERE id=$1 AND key_hash=$2"
    } else {
        "DELETE FROM live_camera_viewer WHERE id=$1 AND key_hash=$2 AND NOT failed"
    };
    sqlx::query(query)
        .bind(id)
        .bind(key_hash(input.key))
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
        DELETE FROM live_camera_signal
        WHERE viewer_id IN (
            SELECT id FROM live_camera_viewer
            WHERE id=$1 AND key_hash=$2 AND failed
        )
        "#,
    )
    .bind(id)
    .bind(key_hash(input.key))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(reply(json!({"stopped":true})))
}

#[cfg(test)]
mod tests {
    #[test]
    fn cloudflare_provider_configuration_and_fallback() {
        let mut c = CameraConfig {
            enabled: true,
            provider: "cloudflare".into(),
            cloudflare_key_id: "a".repeat(32),
            cloudflare_api_token: "test-token".into(),
            stun_urls: vec!["stun:stun.cloudflare.com:3478".into()],
            urls: vec![],
            secret: String::new(),
            relay_only: false,
        };
        assert!(c.available());
        let ice = c.ice(Uuid::new_v4());
        assert_eq!(
            c.merge_cloudflare_ice(ice.clone(), Err("timeout")).unwrap(),
            ice
        );
        let turn =
            json!([{"urls":["turn:turn.cloudflare.com:3478"],"username":"u","credential":"c"}]);
        let merged = c.merge_cloudflare_ice(ice.clone(), Ok(turn)).unwrap();
        assert_eq!(merged.as_array().unwrap().len(), 2);
        assert!(!merged.to_string().contains("test-token"));
        c.relay_only = true;
        assert!(c.available());
        assert!(matches!(
            c.merge_cloudflare_ice(ice, Err("http_status")),
            Err(AppError::BadGateway)
        ));
        c.cloudflare_api_token.clear();
        assert!(!c.available());
        c.cloudflare_api_token = "token\ninvalid".into();
        assert!(!c.available());
        c.cloudflare_api_token = "test-token".into();
        c.cloudflare_key_id = "../key".into();
        assert!(!c.available());
        c.provider = "none".into();
        assert!(!c.available());
        c.relay_only = false;
        assert!(c.available());
        c.provider = "coturn".into();
        assert!(!c.available());
        c.provider = "unknown".into();
        assert!(!c.available());
        c.enabled = false;
        assert!(!c.available());
    }
    use super::*;
    #[test]
    fn turn_uses_coturn_rest_hmac_sha1() {
        assert_eq!(
            turn_password("key", "The quick brown fox jumps over the lazy dog"),
            "3nybhbi3iqa8ino29wqQcBydtNk="
        );
    }
    #[test]
    fn signal_direction_and_size_are_validated() {
        let mut m = Outgoing {
            message_id: Uuid::new_v4(),
            viewer_id: Uuid::new_v4(),
            kind: "offer".into(),
            data: json!("v=0"),
        };
        assert!(validate_signal(&m, true).is_ok());
        assert!(validate_signal(&m, false).is_err());
        m.data = json!("x".repeat(65537));
        assert!(validate_signal(&m, true).is_err());
        m.data = json!("\u{0000}".repeat(12000));
        assert!(validate_signal(&m, true).is_err());
        m.kind = "ice".into();
        m.data = json!({"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0});
        assert!(validate_signal(&m, false).is_ok());
        m.data["sdpMLineIndex"] = json!(-1);
        assert!(validate_signal(&m, false).is_err());
    }
    #[test]
    fn unsafe_turn_config_disables_camera() {
        let mut c = CameraConfig {
            provider: String::new(),
            cloudflare_key_id: String::new(),
            cloudflare_api_token: String::new(),
            enabled: true,
            stun_urls: vec![],
            urls: vec!["turns:turn.example.com:443".into()],
            secret: "a".repeat(32),
            relay_only: false,
        };
        assert!(c.available());
        c.urls = vec!["https://example.com".into()];
        assert!(!c.available());
        c.urls = vec!["turn:user@host".into()];
        assert!(!c.available());
    }
    #[test]
    fn optional_ice_servers_and_incomplete_configuration() {
        let mut c = CameraConfig {
            provider: String::new(),
            cloudflare_key_id: String::new(),
            cloudflare_api_token: String::new(),
            enabled: true,
            urls: vec![],
            stun_urls: vec![],
            secret: String::new(),
            relay_only: false,
        };
        assert!(c.available());
        assert_eq!(c.ice(Uuid::new_v4()), json!([]));
        c.stun_urls = vec!["stun:stun.example.com:3478".into()];
        assert!(c.available());
        assert_eq!(c.ice(Uuid::new_v4()), json!([{"urls": c.stun_urls}]));
        c.relay_only = true;
        assert!(!c.available());
        c.relay_only = false;
        c.secret = "a".repeat(32);
        assert!(!c.available());
        c.urls = vec!["turn:turn.example.com:3478".into()];
        assert!(c.available());
        assert_eq!(c.ice(Uuid::new_v4()).as_array().unwrap().len(), 2);
        c.secret.clear();
        assert!(!c.available());
        c.urls.clear();
        for bad in [
            "https://host",
            "stun:user@host",
            "stun:host/path",
            "stun:host?transport=tcp",
        ] {
            c.stun_urls = vec![bad.into()];
            assert!(!c.available());
        }
        c.stun_urls.clear();
        c.enabled = false;
        assert!(!c.available());
    }
}
