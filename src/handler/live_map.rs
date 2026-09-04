use axum::{
    Form, Json,
    body::Body,
    extract::{Extension, Path},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, LOCATION, REFERRER_POLICY, SET_COOKIE},
    },
    response::{Html, IntoResponse, Response},
};
use bcrypt::{DEFAULT_COST, hash, verify};
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use std::{collections::HashSet, sync::Arc};
use tera::{Context, Tera};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    config::CONFIG,
    error::AppError,
    middleware::extract_cookie_value,
    model::{
        AdminLiveLocationRow, AdminLiveMapMember, AdminLiveMapSummary, CreateLiveMapPayload,
        CreateLiveMapResponse, LiveMapPasswordAction, LiveMapPasswordForm, PublicLiveMapInfo,
        PublicLiveMapMember, PublicLiveMapPosition, PublicLiveMapSnapshot, TileServers,
        UpdateLiveLocationPermissionPayload,
    },
    utils::vec_to_hashmap,
};

const VIEWER_COOKIE_NAME: &str = "live_map_access";
const VIEWER_TOKEN_PURPOSE: &str = "live_map_access";
const MAX_LIVE_MAP_MEMBERS: usize = 20;

#[derive(FromRow)]
struct LiveMapAccessRow {
    id: String,
    public_id: String,
    name: String,
    password_hash: Option<String>,
    access_version: i64,
    expires_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct AdminLiveMapRow {
    id: String,
    public_id: String,
    name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    member_count: i64,
    is_password_protected: bool,
}

#[derive(Serialize, Deserialize)]
struct LiveMapViewerClaims {
    purpose: String,
    exp: usize,
    map_id: String,
    public_id: String,
    access_version: i64,
}

pub(crate) async fn require_superuser(user_id: &str, pool: &SqlitePool) -> Result<(), AppError> {
    let allowed = sqlx::query_scalar::<_, bool>(
        "SELECT is_superuser FROM user_model WHERE id = $1 AND is_locked = false",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Administrator privileges are required.".into(),
        ))
    }
}

fn validate_map_payload(payload: &CreateLiveMapPayload) -> Result<(), AppError> {
    if payload.name.trim().is_empty() || payload.name.chars().count() > 100 {
        return Err(AppError::Validation(
            "Map name must be between 1 and 100 characters.".into(),
        ));
    }
    if payload.members.is_empty() || payload.members.len() > MAX_LIVE_MAP_MEMBERS {
        return Err(AppError::Validation(format!(
            "A live map requires between 1 and {MAX_LIVE_MAP_MEMBERS} members."
        )));
    }
    let now = Utc::now();
    if payload.expires_at <= now || payload.expires_at > now + Duration::days(30) {
        return Err(AppError::Validation(
            "Expiration must be within the next 30 days.".into(),
        ));
    }
    let mut user_ids = HashSet::new();
    for member in &payload.members {
        if !user_ids.insert(member.user_id.as_str())
            || member.display_name.trim().is_empty()
            || member.display_name.chars().count() > 100
            || !valid_color(&member.marker_color)
        {
            return Err(AppError::Validation("Invalid live map member.".into()));
        }
    }
    if payload.password_action == LiveMapPasswordAction::Set {
        validate_share_password(payload.share_password.as_deref())?;
    }
    Ok(())
}

fn valid_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_share_password(raw: Option<&str>) -> Result<&str, AppError> {
    let password = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Validation("共有パスワードを入力してください。".into()))?;
    if password.chars().count() < 4 {
        return Err(AppError::Validation(
            "共有パスワードは4文字以上で設定してください。".into(),
        ));
    }
    if password.len() > 64 {
        return Err(AppError::Validation(
            "共有パスワードは64バイト以内で設定してください。".into(),
        ));
    }
    Ok(password)
}

fn password_change(payload: &CreateLiveMapPayload) -> Result<(bool, Option<String>), AppError> {
    match payload.password_action {
        LiveMapPasswordAction::Keep => Ok((false, None)),
        LiveMapPasswordAction::Remove => Ok((true, None)),
        LiveMapPasswordAction::Set => hash(
            validate_share_password(payload.share_password.as_deref())?,
            DEFAULT_COST,
        )
        .map(|password_hash| (true, Some(password_hash)))
        .map_err(|_| AppError::InternalServerError),
    }
}

fn snapshot_cache_key(map_id: &str, access_version: i64) -> String {
    format!("live-map:snapshot:{map_id}:{access_version}")
}

fn is_single_live_map_violation(error: &sqlx::Error) -> bool {
    error.as_database_error().is_some_and(|database_error| {
        database_error.is_unique_violation()
            && database_error
                .message()
                .contains("idx_live_map_single_unrevoked")
    })
}

async fn validate_members(
    pool: &SqlitePool,
    payload: &CreateLiveMapPayload,
) -> Result<(), AppError> {
    for member in &payload.members {
        let allowed = sqlx::query_scalar::<_, bool>(
            "SELECT can_share_live_location FROM user_model WHERE id = $1",
        )
        .bind(&member.user_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or(false);
        if !allowed {
            return Err(AppError::Validation(
                "Every map member must have live location sharing enabled.".into(),
            ));
        }
    }
    Ok(())
}

async fn sync_members(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    map_id: &str,
    payload: &CreateLiveMapPayload,
) -> Result<(), AppError> {
    let selected_ids: HashSet<&str> = payload
        .members
        .iter()
        .map(|member| member.user_id.as_str())
        .collect();
    let existing_ids =
        sqlx::query_scalar::<_, String>("SELECT user_id FROM live_map_member WHERE map_id = $1")
            .bind(map_id)
            .fetch_all(&mut **transaction)
            .await?;
    for user_id in existing_ids {
        if !selected_ids.contains(user_id.as_str()) {
            sqlx::query("DELETE FROM live_map_member WHERE map_id = $1 AND user_id = $2")
                .bind(map_id)
                .bind(user_id)
                .execute(&mut **transaction)
                .await?;
        }
    }

    for (index, member) in payload.members.iter().enumerate() {
        sqlx::query(
            r#"
            INSERT INTO live_map_member (
                id,
                map_id,
                user_id,
                display_name,
                marker_color,
                sort_order
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (map_id, user_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                marker_color = EXCLUDED.marker_color,
                sort_order = EXCLUDED.sort_order
            "#,
        )
        .bind(Uuid::now_v7().to_string())
        .bind(map_id)
        .bind(&member.user_id)
        .bind(member.display_name.trim())
        .bind(member.marker_color.to_ascii_lowercase())
        .bind(index as i32)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

pub async fn get_admin_live_locations_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<Vec<AdminLiveLocationRow>>, AppError> {
    require_superuser(&user_id, &pool).await?;
    let rows = sqlx::query_as::<_, AdminLiveLocationRow>(
        r#"
        SELECT
            u.id AS user_id,
            u.username,
            u.can_share_live_location,
            s.session_id,
            s.latitude,
            s.longitude,
            s.accuracy_m,
            s.heading_deg,
            s.speed_mps,
            s.observed_at,
            s.received_at
        FROM user_model u
        LEFT JOIN live_location_session s ON s.user_id = u.id
        WHERE u.can_share_live_location = true
        ORDER BY u.username
        "#,
    )
    .fetch_all(&pool)
    .await?;
    Ok(Json(rows))
}

pub async fn update_live_location_permission_handler(
    Extension(admin_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateLiveLocationPermissionPayload>,
) -> Result<StatusCode, AppError> {
    require_superuser(&admin_id, &pool).await?;
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("UPDATE user_model SET can_share_live_location = $1 WHERE id = $2")
        .bind(payload.enabled)
        .bind(&user_id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    if !payload.enabled {
        sqlx::query("DELETE FROM live_location_session WHERE user_id = $1")
            .bind(&user_id)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_live_map_handler(
    Extension(admin_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(_cache): Extension<Option<redis::aio::ConnectionManager>>,
    Json(payload): Json<CreateLiveMapPayload>,
) -> Result<Json<CreateLiveMapResponse>, AppError> {
    require_superuser(&admin_id, &pool).await?;
    validate_map_payload(&payload)?;
    validate_members(&pool, &payload).await?;
    let (_, password_hash) = password_change(&payload)?;
    let map_id = Uuid::now_v7().to_string();
    let public_id = Uuid::new_v4().to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE live_map
        SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE revoked_at IS NULL AND expires_at <= CURRENT_TIMESTAMP
        "#,
    )
    .execute(&mut *transaction)
    .await?;
    let insert_result = sqlx::query(
        r#"
        INSERT INTO live_map (
            id,
            public_id,
            name,
            created_by,
            password_hash,
            expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(&map_id)
    .bind(&public_id)
    .bind(payload.name.trim())
    .bind(&admin_id)
    .bind(password_hash)
    .bind(payload.expires_at)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = insert_result {
        if is_single_live_map_violation(&error) {
            return Err(AppError::Conflict);
        }
        return Err(error.into());
    }
    sync_members(&mut transaction, &map_id, &payload).await?;
    transaction.commit().await?;

    Ok(Json(CreateLiveMapResponse {
        id: map_id,
        name: payload.name.trim().to_string(),
        expires_at: payload.expires_at,
        share_url: format!("/live/{public_id}"),
    }))
}

pub async fn list_live_maps_handler(
    Extension(admin_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<Vec<AdminLiveMapSummary>>, AppError> {
    require_superuser(&admin_id, &pool).await?;
    let map = sqlx::query_as::<_, AdminLiveMapRow>(
        r#"
        SELECT
            m.id,
            m.public_id,
            m.name,
            m.created_at,
            m.updated_at,
            m.expires_at,
            m.revoked_at,
            COUNT(mm.id) AS member_count,
            (m.password_hash IS NOT NULL) AS is_password_protected
        FROM live_map m
        LEFT JOIN live_map_member mm ON mm.map_id = m.id
        WHERE m.revoked_at IS NULL AND m.expires_at > CURRENT_TIMESTAMP
        GROUP BY m.id
        "#,
    )
    .fetch_optional(&pool)
    .await?;
    let Some(map) = map else {
        return Ok(Json(Vec::new()));
    };
    let members = sqlx::query_as::<_, AdminLiveMapMember>(
        r#"
        SELECT
            user_id,
            display_name,
            marker_color
        FROM live_map_member
        WHERE map_id = $1
        ORDER BY sort_order, display_name
        "#,
    )
    .bind(&map.id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(vec![AdminLiveMapSummary {
        id: map.id,
        name: map.name,
        created_at: map.created_at,
        updated_at: map.updated_at,
        expires_at: map.expires_at,
        revoked_at: map.revoked_at,
        member_count: map.member_count,
        share_url: format!("/live/{}", map.public_id),
        is_password_protected: map.is_password_protected,
        members,
    }]))
}

pub async fn update_live_map_handler(
    Extension(admin_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(cache): Extension<Option<redis::aio::ConnectionManager>>,
    Path(map_id): Path<String>,
    Json(payload): Json<CreateLiveMapPayload>,
) -> Result<StatusCode, AppError> {
    require_superuser(&admin_id, &pool).await?;
    validate_map_payload(&payload)?;
    validate_members(&pool, &payload).await?;
    let old_access_version = get_map_access_version(&pool, &map_id).await?;
    let (change_password, password_hash) = password_change(&payload)?;
    let mut transaction = pool.begin().await?;
    let result = sqlx::query(
        r#"
        UPDATE live_map
        SET name = $1, expires_at = $2,
            password_hash = CASE WHEN $3 THEN $4 ELSE password_hash END,
            access_version = CASE WHEN $3 THEN access_version + 1 ELSE access_version END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5 AND revoked_at IS NULL
        "#,
    )
    .bind(payload.name.trim())
    .bind(payload.expires_at)
    .bind(change_password)
    .bind(password_hash)
    .bind(&map_id)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    sync_members(&mut transaction, &map_id, &payload).await?;
    transaction.commit().await?;
    delete_cached_snapshot(cache.as_ref(), &map_id, old_access_version).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_map_access_version(pool: &SqlitePool, map_id: &str) -> Result<i64, AppError> {
    sqlx::query_scalar::<_, i64>("SELECT access_version FROM live_map WHERE id = $1")
        .bind(map_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn rotate_live_map_url_handler(
    Extension(admin_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(cache): Extension<Option<redis::aio::ConnectionManager>>,
    Path(map_id): Path<String>,
) -> Result<Json<CreateLiveMapResponse>, AppError> {
    require_superuser(&admin_id, &pool).await?;
    let old_access_version = get_map_access_version(&pool, &map_id).await?;
    let public_id = Uuid::new_v4().to_string();
    let row = sqlx::query_as::<_, LiveMapAccessRow>(
        r#"
        UPDATE live_map
        SET public_id = $1, access_version = access_version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        RETURNING id, public_id, name, password_hash, access_version, expires_at
        "#,
    )
    .bind(&public_id)
    .bind(&map_id)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::NotFound)?;
    delete_cached_snapshot(cache.as_ref(), &map_id, old_access_version).await;
    Ok(Json(CreateLiveMapResponse {
        id: row.id,
        name: row.name,
        expires_at: row.expires_at,
        share_url: format!("/live/{}", row.public_id),
    }))
}

pub async fn revoke_live_map_handler(
    Extension(admin_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(cache): Extension<Option<redis::aio::ConnectionManager>>,
    Path(map_id): Path<String>,
) -> Result<StatusCode, AppError> {
    require_superuser(&admin_id, &pool).await?;
    let old_access_version = get_map_access_version(&pool, &map_id).await?;
    let result = sqlx::query(
        "UPDATE live_map SET revoked_at = CURRENT_TIMESTAMP, access_version = access_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND revoked_at IS NULL",
    )
    .bind(&map_id)
    .execute(&pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    delete_cached_snapshot(cache.as_ref(), &map_id, old_access_version).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn find_active_map(pool: &SqlitePool, public_id: &str) -> Result<LiveMapAccessRow, AppError> {
    sqlx::query_as::<_, LiveMapAccessRow>(
        r#"
        SELECT
            id,
            public_id,
            name,
            password_hash,
            access_version,
            expires_at
        FROM live_map
        WHERE public_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        "#,
    )
    .bind(public_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

fn viewer_cookie_is_valid(headers: &HeaderMap, map: &LiveMapAccessRow) -> bool {
    let Some(token) = extract_cookie_value(headers, VIEWER_COOKIE_NAME) else {
        return false;
    };
    let Ok(data) = decode::<LiveMapViewerClaims>(
        token,
        &DecodingKey::from_secret(CONFIG.secret_key.as_ref()),
        &Validation::default(),
    ) else {
        return false;
    };
    let claims = data.claims;
    claims.purpose == VIEWER_TOKEN_PURPOSE
        && claims.map_id == map.id
        && claims.public_id == map.public_id
        && claims.access_version == map.access_version
}

fn viewer_cookie(map: &LiveMapAccessRow) -> Result<String, AppError> {
    let expires_at = std::cmp::min(
        map.expires_at,
        Utc::now() + Duration::minutes(CONFIG.live_map_viewer_session_minutes),
    );
    let claims = LiveMapViewerClaims {
        purpose: VIEWER_TOKEN_PURPOSE.to_string(),
        exp: expires_at.timestamp() as usize,
        map_id: map.id.clone(),
        public_id: map.public_id.clone(),
        access_version: map.access_version,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(CONFIG.secret_key.as_ref()),
    )
    .map_err(|_| AppError::InternalServerError)?;
    let secure = if CONFIG.secure_cookie { " Secure;" } else { "" };
    let max_age = (expires_at - Utc::now()).num_seconds().max(1);
    Ok(format!(
        "{VIEWER_COOKIE_NAME}={token};{secure} HttpOnly; SameSite=Lax; Max-Age={max_age}; Path=/"
    ))
}

fn no_store_html(rendered: String) -> Response {
    (
        [
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
        ],
        Html(rendered),
    )
        .into_response()
}

async fn render_password_page(
    tera: &Arc<Mutex<Tera>>,
    public_id: &str,
    error_message: Option<&str>,
) -> Result<Response, AppError> {
    let mut context = Context::new();
    context.insert("publicId", &public_id);
    context.insert("errorMessage", &error_message.unwrap_or(""));
    let rendered = tera
        .lock()
        .await
        .render("live-map-password.html", &context)
        .map_err(|error| {
            tracing::error!(%error, "failed to render live map password page");
            AppError::InternalServerError
        })?;
    Ok(no_store_html(rendered))
}

async fn render_live_map(
    tera: &Arc<Mutex<Tera>>,
    pool: &SqlitePool,
    public_id: &str,
) -> Result<Response, AppError> {
    let tile_servers = sqlx::query_as::<_, TileServers>(
        r#"
        SELECT
            id,
            layer_name,
            label,
            url,
            attribution,
            include_foreign_tiles,
            min_zoom,
            max_zoom,
            create_at,
            updated_at
        FROM tileserver_model
        ORDER BY id
        "#,
    )
    .fetch_all(pool)
    .await?;
    let tile_servers = vec_to_hashmap(tile_servers, |tile_server| tile_server.id);
    let mut context = Context::new();
    context.insert("publicId", &public_id);
    context.insert("tileServers", &tile_servers);
    let rendered = tera
        .lock()
        .await
        .render("live-map.html", &context)
        .map_err(|error| {
            tracing::error!(%error, "failed to render live map");
            AppError::InternalServerError
        })?;
    Ok(no_store_html(rendered))
}

async fn render_live_map_not_found(tera: &Arc<Mutex<Tera>>) -> Result<Response, AppError> {
    let mut context = Context::new();
    context.insert("viewport_content", "1.0");
    context.insert("statuscode", "Not Found");
    context.insert(
        "message",
        "現在位置共有マップが見つかりません。リンクが失効したか、URLが変更された可能性があります。",
    );
    let rendered = tera
        .lock()
        .await
        .render("notfound.html", &context)
        .map_err(|error| {
            tracing::error!(%error, "failed to render live map not-found page");
            AppError::InternalServerError
        })?;
    Ok((
        StatusCode::NOT_FOUND,
        [
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
        ],
        Html(rendered),
    )
        .into_response())
}

pub async fn live_map_page_handler(
    headers: HeaderMap,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Extension(pool): Extension<SqlitePool>,
    Path(public_id): Path<String>,
) -> Result<Response, AppError> {
    let public_id = match Uuid::parse_str(&public_id) {
        Ok(public_id) => public_id.to_string(),
        Err(_) => return render_live_map_not_found(&tera).await,
    };
    let map = match find_active_map(&pool, &public_id).await {
        Ok(map) => map,
        Err(AppError::NotFound) => return render_live_map_not_found(&tera).await,
        Err(error) => return Err(error),
    };
    if map.password_hash.is_some() && !viewer_cookie_is_valid(&headers, &map) {
        return render_password_page(&tera, &public_id, None).await;
    }
    render_live_map(&tera, &pool, &public_id).await
}

fn client_rate_limit_key(headers: &HeaderMap) -> String {
    let address = headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
        })
        .unwrap_or("unknown");
    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    let digest = Sha256::digest(format!("{address}|{user_agent}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn check_password_rate_limit(
    pool: &SqlitePool,
    map_id: &str,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let window_started_cutoff =
        Utc::now() - Duration::minutes(CONFIG.live_map_password_window_minutes);
    let window_started_cutoff = window_started_cutoff
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let attempts = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO live_map_password_rate_limit (
            map_id,
            client_key,
            attempt_count
        ) VALUES ($1, $2, 1)
        ON CONFLICT (map_id, client_key) DO UPDATE
        SET attempt_count = CASE
                WHEN live_map_password_rate_limit.window_started_at
                     <= $3
                THEN 1 ELSE live_map_password_rate_limit.attempt_count + 1 END,
            window_started_at = CASE
                WHEN live_map_password_rate_limit.window_started_at
                     <= $3
                THEN CURRENT_TIMESTAMP ELSE live_map_password_rate_limit.window_started_at END
        RETURNING attempt_count
        "#,
    )
    .bind(map_id)
    .bind(client_rate_limit_key(headers))
    .bind(window_started_cutoff)
    .fetch_one(pool)
    .await?;
    if attempts > i64::from(CONFIG.live_map_password_attempt_limit) {
        return Err(AppError::TooManyRequests(
            "パスワードの試行回数が上限に達しました。しばらくしてから再試行してください。".into(),
        ));
    }
    Ok(())
}

pub async fn authenticate_live_map_handler(
    headers: HeaderMap,
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Path(public_id): Path<String>,
    Form(form): Form<LiveMapPasswordForm>,
) -> Result<Response, AppError> {
    let public_id = Uuid::parse_str(&public_id)
        .map_err(|_| AppError::NotFound)?
        .to_string();
    let map = find_active_map(&pool, &public_id).await?;
    let Some(password_hash) = map.password_hash.as_deref() else {
        return Ok(Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(LOCATION, format!("/live/{public_id}"))
            .body(Body::empty())
            .map_err(|_| AppError::InternalServerError)?);
    };
    check_password_rate_limit(&pool, &map.id, &headers).await?;
    if !verify(form.password.trim(), password_hash).unwrap_or(false) {
        return render_password_page(&tera, &public_id, Some("パスワードが正しくありません。"))
            .await;
    }
    sqlx::query("DELETE FROM live_map_password_rate_limit WHERE map_id = $1 AND client_key = $2")
        .bind(&map.id)
        .bind(client_rate_limit_key(&headers))
        .execute(&pool)
        .await?;
    Ok(Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(LOCATION, format!("/live/{public_id}"))
        .header(SET_COOKIE, viewer_cookie(&map)?)
        .header(CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .map_err(|_| AppError::InternalServerError)?)
}

pub async fn get_public_live_map_positions_handler(
    Extension(pool): Extension<SqlitePool>,
    Extension(cache): Extension<Option<redis::aio::ConnectionManager>>,
    Path(public_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let public_id = Uuid::parse_str(&public_id)
        .map_err(|_| AppError::NotFound)?
        .to_string();
    let map = find_active_map(&pool, &public_id).await?;
    if map.password_hash.is_some() && !viewer_cookie_is_valid(&headers, &map) {
        return Err(AppError::Unauthorized("live_map_password_required".into()));
    }
    let cache_key = snapshot_cache_key(&map.id, map.access_version);
    if let Some(snapshot) = get_cached_snapshot(cache.as_ref(), &cache_key).await {
        return snapshot_response(snapshot);
    }

    let members = sqlx::query_as::<_, PublicLiveMapMember>(
        r#"
        SELECT
            mm.id,
            mm.display_name,
            mm.marker_color,
            s.latitude,
            s.longitude,
            s.accuracy_m,
            s.heading_deg,
            s.speed_mps,
            s.observed_at,
            s.received_at
        FROM live_map_member mm
        JOIN user_model u ON u.id = mm.user_id AND u.can_share_live_location = true
        LEFT JOIN live_location_session s ON s.user_id = mm.user_id
        WHERE mm.map_id = $1
        ORDER BY mm.sort_order, mm.display_name
        "#,
    )
    .bind(&map.id)
    .fetch_all(&pool)
    .await?;

    let now = Utc::now();
    let positions = members
        .into_iter()
        .map(|member| {
            let age = member
                .received_at
                .map(|received| (now - received).num_seconds());
            let status = match age {
                Some(seconds) if seconds <= CONFIG.live_location_stale_seconds => "live",
                Some(seconds) if seconds <= CONFIG.live_location_offline_seconds => "stale",
                _ => "offline",
            }
            .to_string();
            let show_position = status != "offline";
            PublicLiveMapPosition {
                id: member.id,
                display_name: member.display_name,
                marker_color: member.marker_color,
                status,
                latitude: show_position.then_some(member.latitude).flatten(),
                longitude: show_position.then_some(member.longitude).flatten(),
                accuracy_m: show_position.then_some(member.accuracy_m).flatten(),
                heading_deg: show_position.then_some(member.heading_deg).flatten(),
                speed_mps: show_position.then_some(member.speed_mps).flatten(),
                observed_at: show_position.then_some(member.observed_at).flatten(),
                received_at: show_position.then_some(member.received_at).flatten(),
            }
        })
        .collect();
    let snapshot = PublicLiveMapSnapshot {
        map: PublicLiveMapInfo {
            id: map.public_id,
            name: map.name,
        },
        server_time: now,
        refresh_after_ms: CONFIG.live_location_upload_interval_seconds * 1000,
        positions,
    };
    if CONFIG.live_map_snapshot_cache_seconds > 0 {
        set_cached_snapshot(cache.as_ref(), &cache_key, &snapshot).await;
    }
    snapshot_response(snapshot)
}

fn snapshot_response(snapshot: PublicLiveMapSnapshot) -> Result<Response, AppError> {
    Ok((
        [
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
        ],
        Json(snapshot),
    )
        .into_response())
}

async fn get_cached_snapshot(
    cache: Option<&redis::aio::ConnectionManager>,
    key: &str,
) -> Option<PublicLiveMapSnapshot> {
    let mut connection = cache?.clone();
    let json: Option<String> = connection.get(key).await.ok()?;
    serde_json::from_str(&json?).ok()
}

async fn set_cached_snapshot<T: Serialize>(
    cache: Option<&redis::aio::ConnectionManager>,
    key: &str,
    snapshot: &T,
) {
    let (Some(connection), Ok(json)) = (cache, serde_json::to_string(snapshot)) else {
        return;
    };
    let mut connection = connection.clone();
    let result: redis::RedisResult<()> = connection
        .set_ex(key, json, CONFIG.live_map_snapshot_cache_seconds)
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, "failed to cache live map snapshot");
    }
}

async fn delete_cached_snapshot(
    cache: Option<&redis::aio::ConnectionManager>,
    map_id: &str,
    access_version: i64,
) {
    let Some(connection) = cache else { return };
    let mut connection = connection.clone();
    let _: redis::RedisResult<()> = connection
        .del(snapshot_cache_key(map_id, access_version))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map_payload(member_count: usize) -> CreateLiveMapPayload {
        CreateLiveMapPayload {
            name: "現在位置共有マップ".into(),
            expires_at: Utc::now() + Duration::hours(1),
            members: (0..member_count)
                .map(|index| crate::model::CreateLiveMapMemberPayload {
                    user_id: Uuid::new_v4().to_string(),
                    display_name: format!("共有対象{}", index + 1),
                    marker_color: "#1a73e8".into(),
                })
                .collect(),
            password_action: LiveMapPasswordAction::Remove,
            share_password: None,
        }
    }

    #[test]
    fn validates_marker_colors() {
        assert!(valid_color("#1a73e8"));
        assert!(!valid_color("red"));
        assert!(!valid_color("#xyzxyz"));
    }

    #[test]
    fn validates_share_password_length() {
        assert!(validate_share_password(Some("abcd")).is_ok());
        assert!(validate_share_password(Some("abc")).is_err());
        assert!(validate_share_password(None).is_err());
        assert!(validate_share_password(Some(&"a".repeat(65))).is_err());
    }

    #[test]
    fn validates_live_map_member_count() {
        assert!(validate_map_payload(&map_payload(20)).is_ok());
        assert!(validate_map_payload(&map_payload(0)).is_err());
        assert!(validate_map_payload(&map_payload(21)).is_err());
    }
}
