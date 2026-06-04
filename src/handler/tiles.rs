use crate::model::TilePathParams;
use crate::{config::CONFIG, error::AppError};
use axum::{
    body::Body,
    extract::{Extension, Path, rejection::PathRejection},
    http::{
        HeaderName, Response, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::IntoResponse,
};
use redis::AsyncCommands;
use reqwest::Client;

const TILE_PROXY_MAX_ZOOM: u32 = 19;
const TILE_PROXY_CACHE_CONTROL: &str = "public, max-age=604800, immutable";

// タイルサーバ中継API
pub async fn proxy_tile_handler(
    Extension(client): Extension<Client>,
    Extension(tile_cache): Extension<Option<redis::aio::ConnectionManager>>,
    path: Result<Path<TilePathParams>, PathRejection>,
) -> Result<impl IntoResponse, AppError> {
    // タイル座標を検証
    let Path(TilePathParams { z, x, y_png }) = path.map_err(|_| AppError::NotFound)?;
    let y = parse_y_png(&y_png)?;
    validate_tile_coordinates(z, x, y)?;

    let cache_key = build_tile_cache_key(&CONFIG.tile_cache_namespace, z, x, y);
    if let Some(tile_bytes) = get_cached_tile(tile_cache.as_ref(), &cache_key).await {
        return build_tile_response(tile_bytes, "HIT");
    }

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
    let tile_bytes = tile_bytes.to_vec();

    set_cached_tile(tile_cache.as_ref(), &cache_key, &tile_bytes).await;

    build_tile_response(tile_bytes, "MISS")
}

// タイルレスポンスを構築する
fn build_tile_response(
    tile_bytes: Vec<u8>,
    cache_status: &'static str,
) -> Result<Response<Body>, AppError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "image/png")
        .header(CACHE_CONTROL, TILE_PROXY_CACHE_CONTROL)
        .header(HeaderName::from_static("x-tile-cache"), cache_status)
        .body(Body::from(tile_bytes))
        .map_err(|_| AppError::InternalServerError)
}

// y 座標セグメントの末尾が .png であることを検証して数値化する
fn parse_y_png(y_png: &str) -> Result<u32, AppError> {
    let y = y_png.strip_suffix(".png").ok_or(AppError::NotFound)?;
    y.parse::<u32>().map_err(|_| AppError::NotFound)
}

// タイルの座標を検証する
fn validate_tile_coordinates(z: u32, x: u32, y: u32) -> Result<(), AppError> {
    if z > TILE_PROXY_MAX_ZOOM {
        return Err(AppError::NotFound);
    }

    let upper_bound = 1u32 << z;
    if x >= upper_bound || y >= upper_bound {
        return Err(AppError::NotFound);
    }

    Ok(())
}

// タイルのURLを構築する
fn build_upstream_tile_url(base_url: &str, z: u32, x: u32, y: u32) -> String {
    format!("{}/{}/{}/{}.png", base_url.trim_end_matches('/'), z, x, y)
}

// タイルキャッシュのキーを構築する
fn build_tile_cache_key(namespace: &str, z: u32, x: u32, y: u32) -> String {
    format!("tile:{}:{}:{}:{}", namespace, z, x, y)
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
        build_tile_cache_key, build_upstream_tile_url, parse_y_png, validate_tile_coordinates,
    };

    #[test]
    fn validates_tile_coordinate_upper_bounds() {
        assert!(validate_tile_coordinates(0, 0, 0).is_ok());
        assert!(validate_tile_coordinates(19, (1 << 19) - 1, (1 << 19) - 1).is_ok());
        assert!(validate_tile_coordinates(20, 0, 0).is_err());
        assert!(validate_tile_coordinates(2, 4, 0).is_err());
        assert!(validate_tile_coordinates(2, 0, 4).is_err());
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
}
