use std::sync::Arc;

use axum::{
    Json,
    extract::{Extension, rejection::JsonRejection},
    http::header::CACHE_CONTROL,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    error::AppError,
    handler::live_map::require_superuser,
    tile_settings::{ManagedTileUpstream, TileSettings},
    tile_upstream::{fetch_managed_tile, validate_coordinates},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyInput {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    revision: Option<Uuid>,
    mode: ProxyMode,
    base_url: Option<String>,
    api_key: Option<String>,
    tile: Option<TestTile>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ProxyMode {
    Managed,
    Environment,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestTile {
    z: u32,
    x: u32,
    y: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorOriginsInput {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    revision: Option<Uuid>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    origins: Option<Vec<String>>,
}

#[derive(Serialize)]
struct CheckResult {
    ok: bool,
}

fn no_store<T: Serialize>(body: T) -> impl IntoResponse {
    ([(CACHE_CONTROL, "no-store")], Json(body))
}

pub async fn get_settings(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(settings): Extension<Arc<TileSettings>>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&user_id, &pool).await?;
    settings.refresh(&pool).await?;
    Ok(no_store(settings.view()))
}

pub async fn check_proxy(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(settings): Extension<Arc<TileSettings>>,
    input: Result<Json<ProxyInput>, JsonRejection>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&user_id, &pool).await?;
    let Json(input) = input.map_err(|_| AppError::BadRequest)?;
    if input.mode != ProxyMode::Managed {
        return Err(AppError::BadRequest);
    }
    check_candidate(&settings, &pool, &input).await?;
    Ok(no_store(CheckResult { ok: true }))
}

pub async fn update_proxy(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(settings): Extension<Arc<TileSettings>>,
    input: Result<Json<ProxyInput>, JsonRejection>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&user_id, &pool).await?;
    let Json(input) = input.map_err(|_| AppError::BadRequest)?;
    let upstream = if input.mode == ProxyMode::Managed {
        Some(check_candidate(&settings, &pool, &input).await?)
    } else {
        None
    };
    let response = settings
        .set_proxy(&pool, &user_id, input.revision, upstream)
        .await?;
    Ok(no_store(response))
}

pub async fn update_vector_origins(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(settings): Extension<Arc<TileSettings>>,
    input: Result<Json<VectorOriginsInput>, JsonRejection>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&user_id, &pool).await?;
    let Json(input) = input.map_err(|_| AppError::BadRequest)?;
    let response = settings
        .set_vector_origins(&pool, &user_id, input.revision, input.origins)
        .await?;
    Ok(no_store(response))
}

async fn check_candidate(
    settings: &TileSettings,
    pool: &SqlitePool,
    input: &ProxyInput,
) -> Result<ManagedTileUpstream, AppError> {
    let base_url = input
        .base_url
        .as_deref()
        .ok_or_else(|| AppError::Validation("上流タイルサーバのURLを入力してください。".into()))?;
    let tile = input.tile.as_ref().ok_or_else(|| {
        AppError::Validation("接続確認に使うタイルの座標を入力してください。".into())
    })?;
    validate_coordinates(tile.z, tile.x, tile.y)
        .map_err(|_| AppError::Validation("接続確認に使うタイルの座標が範囲外です。".into()))?;
    settings.refresh(pool).await?;
    let upstream = settings.prepare_upstream(input.revision, base_url, input.api_key.as_deref())?;
    fetch_managed_tile(&upstream, tile.z, tile.x, tile.y).await?;
    Ok(upstream)
}
