use axum::{
    Json,
    extract::{Extension, Path},
    response::{Html, IntoResponse},
};
use bcrypt::{DEFAULT_COST, hash};

use crate::db::create_user_with_master_layer;
use crate::error::AppError;
use crate::model::{
    IsExists, IsSuperuser, ResponseUserData, ReturningId, SignupPayload, UpdateUserData,
};
use crate::utils::{validate_password, vec_to_hashmap};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::query_as;
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use uuid::Uuid;

#[derive(RustEmbed)]
#[folder = "dist/"]
struct Asset;

const CLUSTERING_MIN_ZOOM_KEY: &str = "clustering_min_zoom";
const DEFAULT_CLUSTERING_MIN_ZOOM: i32 = 15;
const CLUSTERING_MIN_ZOOM_RANGE: std::ops::RangeInclusive<i32> = 0..=22;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDisplaySettings {
    pub clustering_min_zoom: i32,
}

pub(super) async fn load_clustering_min_zoom(pool: &SqlitePool) -> Result<i32, AppError> {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT setting_value FROM application_settings WHERE setting_key = $1",
    )
    .bind(CLUSTERING_MIN_ZOOM_KEY)
    .fetch_optional(pool)
    .await?;

    if let Some(value) = value {
        if let Ok(zoom) = value.parse::<i32>()
            && CLUSTERING_MIN_ZOOM_RANGE.contains(&zoom)
        {
            return Ok(zoom);
        }
        tracing::warn!("Invalid clustering_min_zoom setting; using the default");
    }
    Ok(DEFAULT_CLUSTERING_MIN_ZOOM)
}

pub async fn get_map_display_settings(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<MapDisplaySettings>, AppError> {
    require_superuser(user_id, &pool).await?;
    Ok(Json(MapDisplaySettings {
        clustering_min_zoom: load_clustering_min_zoom(&pool).await?,
    }))
}

pub async fn update_map_display_settings(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(settings): Json<MapDisplaySettings>,
) -> Result<Json<MapDisplaySettings>, AppError> {
    require_superuser(user_id, &pool).await?;
    if !CLUSTERING_MIN_ZOOM_RANGE.contains(&settings.clustering_min_zoom) {
        return Err(AppError::Validation(
            "クラスタ解除の最小ズームには0〜22の整数を指定してください。".into(),
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO application_settings (id, setting_key, setting_value, create_at, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (setting_key) DO UPDATE
        SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
        "#,
    )
    .bind(Uuid::now_v7().to_string())
    .bind(CLUSTERING_MIN_ZOOM_KEY)
    .bind(settings.clustering_min_zoom.to_string())
    .execute(&pool)
    .await?;

    Ok(Json(settings))
}

// スーパーユーザー判定ヘルパー関数
async fn require_superuser(user_id: String, pool: &SqlitePool) -> Result<(), AppError> {
    let super_user_exists = query_as!(
        IsSuperuser,
        r#"
        SELECT
            is_superuser
        FROM user_model
        WHERE id = $1
        "#,
        user_id,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    if super_user_exists.is_superuser {
        Ok(())
    } else {
        Err(AppError::Unauthorized("Not admin user.".into()))
    }
}

// 管理画面の HTML を取得する。
pub async fn admin_index_get_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Html<String>, AppError> {
    let is_admin = require_superuser(user_id, &pool).await.is_ok();

    let html_file = if is_admin {
        "index-admin.html"
    } else {
        "index.html"
    };

    match Asset::get(html_file) {
        Some(content) => {
            let html_content = String::from_utf8(content.data.into_owned()).unwrap();
            Ok(Html(html_content))
        },
        None => Err(AppError::NotFound),
    }
}

// ユーザー一覧を取得
pub async fn get_users_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<HashMap<String, ResponseUserData>>, AppError> {
    require_superuser(user_id, &pool).await?;

    let users = sqlx::query_as::<_, ResponseUserData>(
        r#"
        SELECT
            id,
            username,
            create_at,
            is_superuser,
            is_locked,
            can_share_live_location
        FROM user_model
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let users_hash_map = vec_to_hashmap(users, |u| u.id.clone());
    Ok(Json(users_hash_map))
}

// ユーザーのパスワードを更新する。
pub async fn update_users_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(update_user_id): Path<String>,
    Json(payload): Json<UpdateUserData>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(user_id, &pool).await?;
    validate_password(&payload.new_password)?;

    let hashed_password =
        hash(payload.new_password, DEFAULT_COST).map_err(|_| AppError::InternalServerError)?;

    query_as!(
        ReturningId,
        r#"
        UPDATE user_model
        SET
            password = $1,
            auth_version = auth_version + 1
        WHERE id = $2
        RETURNING id
        "#,
        hashed_password,
        update_user_id,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;
    let body = json!({"message": "Password Reset Ok."}).to_string();
    Ok(body)
}

// アカウントロック解除ハンドラー
pub async fn unlock_account_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(unlock_user_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(user_id, &pool).await?;

    query_as!(
        ReturningId,
        r#"
        UPDATE user_model
        SET
            is_locked = $1,
            auth_version = auth_version + 1
        WHERE id = $2
        RETURNING id
        "#,
        false,
        unlock_user_id,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;
    let body = json!({"message": "Unlock Ok."}).to_string();
    Ok(body)
}

// ユーザー作成ハンドラー
pub async fn create_users_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<SignupPayload>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(user_id, &pool).await?;
    validate_password(&payload.password)?;

    // 既に同名のユーザーが存在するか確認
    let user_exists = query_as!(
        IsExists,
        r#"
        SELECT EXISTS(SELECT 1 FROM user_model
        WHERE username = $1) as exists_flag
        "#,
        payload.username
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // `i64`を`bool`に変換
    let user_exists = user_exists.exists_flag != 0;

    // 同名のユーザーが既に存在する場合はエラーを返す
    if user_exists {
        return Err(AppError::Conflict);
    }

    // パスワードをハッシュ化(ソルト値はハッシュ値に組み込んで管理)
    let hashed_password =
        hash(payload.password, DEFAULT_COST).map_err(|_| AppError::InternalServerError)?;

    let new_user_id =
        create_user_with_master_layer(&pool, &payload.username, &hashed_password, false).await?;

    Ok(Json(new_user_id))
}
