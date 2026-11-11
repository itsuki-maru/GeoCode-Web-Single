use crate::model::TilePathParams;
use crate::{config::CONFIG, error::AppError};
use crate::{
    tile_settings::TileSettings,
    tile_upstream::{fetch_managed_tile, validate_coordinates},
};
use axum::{
    body::Body,
    extract::{Extension, Path, RawQuery, rejection::PathRejection},
    http::{
        HeaderName, Response, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::IntoResponse,
};
use redis::AsyncCommands;
use reqwest::Client;
use std::sync::Arc;
use uuid::Uuid;

const TILE_PROXY_CACHE_CONTROL: &str = "public, max-age=604800, immutable";

// 地図ページは、タイル要求の組み立てにこの公開値だけを使用する。
pub async fn tile_proxy_revision_script(
    Extension(settings): Extension<Arc<TileSettings>>,
) -> impl IntoResponse {
    let revision = settings.snapshot().proxy_revision;
    (
        [
            (CONTENT_TYPE, "application/javascript; charset=utf-8"),
            (CACHE_CONTROL, "no-store"),
        ],
        format!(
            "window.__GEOCODE_TILE_PROXY_REVISION__ = {};\n",
            serde_json::json!(revision)
        ),
    )
}

// タイルサーバ中継API
pub async fn proxy_tile_handler(
    Extension(client): Extension<Client>,
    Extension(tile_cache): Extension<Option<redis::aio::ConnectionManager>>,
    settings: Option<Extension<Arc<TileSettings>>>,
    RawQuery(query): RawQuery,
    path: Result<Path<TilePathParams>, PathRejection>,
) -> Result<impl IntoResponse, AppError> {
    // タイル座標を検証
    let Path(TilePathParams { z, x, y_png }) = path.map_err(|_| AppError::NotFound)?;
    let y = parse_y_png(&y_png)?;
    validate_coordinates(z, x, y)?;

    // 要求の処理中に管理者が別の設定を適用した場合も、
    // キャッシュ参照・取得・保存には同じ設定スナップショットを使用する。
    let active = settings.map(|Extension(settings)| settings.snapshot());
    let revision = active.as_ref().and_then(|settings| settings.proxy_revision);
    let cache_key = cache_key_for_revision(&CONFIG.tile_cache_namespace, revision, z, x, y);
    let cache_control = cache_control_for_revision(revision, query.as_deref());
    if let Some(tile_bytes) = get_cached_tile(tile_cache.as_ref(), &cache_key).await {
        return build_tile_response(tile_bytes, "HIT", cache_control);
    }

    let tile_bytes = match active.and_then(|settings| settings.managed_upstream) {
        Some(upstream) => fetch_managed_tile(&upstream, z, x, y).await?,
        None => fetch_environment_tile(&client, z, x, y).await?,
    };
    set_cached_tile(tile_cache.as_ref(), &cache_key, &tile_bytes).await;
    build_tile_response(tile_bytes, "MISS", cache_control)
}

async fn fetch_environment_tile(
    client: &Client,
    z: u32,
    x: u32,
    y: u32,
) -> Result<Vec<u8>, AppError> {
    // タイルサーバのURLを構築
    let upstream_base_url = CONFIG.tile_server_base_url.as_deref().ok_or_else(|| {
        tracing::error!("TILE_SERVER_BASE_URL is not configured.");
        AppError::NotFound
    })?;

    // タイルサーバのAPIキーを取得
    let api_key = CONFIG.tile_server_api_key.as_deref().ok_or_else(|| {
        tracing::error!("TILE_SERVER_API_KEY is not configured.");
        AppError::NotFound
    })?;

    // タイルのURLを構築
    let upstream_url = build_upstream_tile_url(upstream_base_url, z, x, y);

    // タイルを取得
    let upstream_response = client
        .get(&upstream_url)
        .header("X-API-Key", api_key)
        .send()
        .await
        .map_err(map_upstream_error)?;

    // タイルが見つからない場合は404を返す
    if upstream_response.status() == StatusCode::NOT_FOUND {
        return Err(AppError::NotFound);
    }

    // タイルが取得できない場合は502を返す
    if !upstream_response.status().is_success() {
        tracing::warn!(
            status = %upstream_response.status(),
            url = %upstream_url,
            "Tile upstream returned non-success status."
        );
        return Err(AppError::BadGateway);
    }

    // タイルを取得
    let tile_bytes = upstream_response
        .bytes()
        .await
        .map_err(map_upstream_error)?;
    Ok(tile_bytes.to_vec())
}

// タイルレスポンスを構築する
fn build_tile_response(
    tile_bytes: Vec<u8>,
    cache_status: &'static str,
    cache_control: &'static str,
) -> Result<Response<Body>, AppError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "image/png")
        .header(CACHE_CONTROL, cache_control)
        .header(HeaderName::from_static("x-tile-cache"), cache_status)
        .body(Body::from(tile_bytes))
        .map_err(|_| AppError::InternalServerError)
}

// y 座標セグメントの末尾が .png であることを検証して数値化する
fn parse_y_png(y_png: &str) -> Result<u32, AppError> {
    let y = y_png.strip_suffix(".png").ok_or(AppError::NotFound)?;
    y.parse::<u32>().map_err(|_| AppError::NotFound)
}

// タイルのURLを構築する
fn build_upstream_tile_url(base_url: &str, z: u32, x: u32, y: u32) -> String {
    format!("{}/{}/{}/{}.png", base_url.trim_end_matches('/'), z, x, y)
}

// タイルキャッシュのキーを構築する
fn build_tile_cache_key(namespace: &str, z: u32, x: u32, y: u32) -> String {
    format!("tile:{}:{}:{}:{}", namespace, z, x, y)
}

fn cache_key_for_revision(
    namespace: &str,
    revision: Option<Uuid>,
    z: u32,
    x: u32,
    y: u32,
) -> String {
    match revision {
        Some(revision) => format!("tile:{namespace}:revision:{revision}:{z}:{x}:{y}"),
        None => build_tile_cache_key(namespace, z, x, y),
    }
}

fn cache_control_for_revision(revision: Option<Uuid>, query: Option<&str>) -> &'static str {
    let requested =
        query.and_then(|query| query.split('&').find_map(|item| item.strip_prefix("v=")));
    match (revision, requested) {
        (None, None) => TILE_PROXY_CACHE_CONTROL,
        (Some(revision), Some(value)) if Uuid::parse_str(value).ok() == Some(revision) => {
            TILE_PROXY_CACHE_CONTROL
        },
        // 旧形式のURLや旧版を持つタブにも現在の画像を返す。
        // この応答はブラウザやCDNの長期キャッシュへ保存しない。
        _ => "no-store",
    }
}

async fn get_cached_tile(
    tile_cache: Option<&redis::aio::ConnectionManager>,
    cache_key: &str,
) -> Option<Vec<u8>> {
    let mut connection = tile_cache?.clone();
    match connection.get::<_, Option<Vec<u8>>>(cache_key).await {
        Ok(Some(tile_bytes)) => {
            tracing::debug!(cache_key = %cache_key, "Tile cache hit.");
            Some(tile_bytes)
        },
        Ok(None) => {
            tracing::debug!(cache_key = %cache_key, "Tile cache miss.");
            None
        },
        Err(error) => {
            tracing::warn!(error = %error, cache_key = %cache_key, "Failed to read tile cache.");
            None
        },
    }
}

async fn set_cached_tile(
    tile_cache: Option<&redis::aio::ConnectionManager>,
    cache_key: &str,
    tile_bytes: &[u8],
) {
    let Some(connection) = tile_cache else {
        return;
    };

    let mut connection = connection.clone();
    let result: redis::RedisResult<()> = connection
        .set_ex(cache_key, tile_bytes, CONFIG.tile_cache_ttl_seconds)
        .await;

    if let Err(error) = result {
        tracing::warn!(error = %error, cache_key = %cache_key, "Failed to write tile cache.");
    }
}

// タイルの取得に失敗した場合のエラーをマッピングする
fn map_upstream_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        tracing::warn!(error = %error, "Tile upstream request timed out.");
        AppError::BadGateway
    } else {
        tracing::error!(error = %error, "Tile upstream request failed.");
        AppError::BadGateway
    }
}

#[cfg(test)]
mod tests {
    use super::{
        TILE_PROXY_CACHE_CONTROL, build_tile_cache_key, build_upstream_tile_url,
        cache_control_for_revision, cache_key_for_revision, parse_y_png, validate_coordinates,
    };

    #[test]
    fn validates_tile_coordinate_upper_bounds() {
        assert!(validate_coordinates(0, 0, 0).is_ok());
        assert!(validate_coordinates(19, (1 << 19) - 1, (1 << 19) - 1).is_ok());
        assert!(validate_coordinates(20, 0, 0).is_err());
        assert!(validate_coordinates(2, 4, 0).is_err());
        assert!(validate_coordinates(2, 0, 4).is_err());
    }

    #[test]
    fn builds_upstream_url_without_duplicate_slashes() {
        let url = build_upstream_tile_url("https://tiles.example.com/", 14, 14523, 6342);
        assert_eq!(url, "https://tiles.example.com/14/14523/6342.png");
    }

    #[test]
    fn parses_png_suffix_in_y_segment() {
        assert_eq!(parse_y_png("6342.png").unwrap(), 6342);
        assert!(parse_y_png("6342.jpg").is_err());
        assert!(parse_y_png("abc.png").is_err());
    }

    #[test]
    fn builds_tile_cache_key() {
        assert_eq!(
            build_tile_cache_key("default", 14, 14523, 6342),
            "tile:default:14:14523:6342"
        );
    }

    /// 上流切替でキャッシュを分離し、有効な設定版と一致する要求だけを長期キャッシュする。
    #[test]
    fn switching_source_separates_cache_entries_and_only_caches_the_matching_revision() {
        let current = uuid::Uuid::from_u128(1);
        let previous = uuid::Uuid::from_u128(2);
        let query = format!("v={current}");
        assert_eq!(
            cache_control_for_revision(None, None),
            TILE_PROXY_CACHE_CONTROL
        );
        assert_eq!(
            cache_control_for_revision(Some(current), Some(&query)),
            TILE_PROXY_CACHE_CONTROL
        );
        assert_eq!(
            cache_control_for_revision(Some(previous), Some(&query)),
            "no-store"
        );
        assert_eq!(cache_control_for_revision(Some(current), None), "no-store");
        assert_eq!(cache_control_for_revision(None, Some(&query)), "no-store");
        assert_ne!(
            cache_key_for_revision("maps", Some(current), 0, 0, 0),
            cache_key_for_revision("maps", Some(previous), 0, 0, 0)
        );
        assert_ne!(
            cache_key_for_revision("maps", Some(current), 0, 0, 0),
            cache_key_for_revision("maps", None, 0, 0, 0)
        );
    }
}
