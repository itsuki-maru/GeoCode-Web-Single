//! ローカル地図は通常のXYZ PNGだけをHTTPで配信する。管理操作は本体CLIが担う。
use crate::{
    local_tiles::{LocalTiles, runtime::Failure},
    tilegen::tile::TileId,
};
use axum::{
    Json,
    body::Body,
    extract::{Extension, Path},
    http::{Response, StatusCode, header},
    response::IntoResponse,
};
use serde_json::json;
use std::sync::Arc;

impl IntoResponse for Failure {
    fn into_response(self) -> axum::response::Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"error":self.message})),
        )
            .into_response()
    }
}
pub async fn tile(
    Extension(service): Extension<Arc<LocalTiles>>,
    path: Result<Path<(String, String, u8, u32, String)>, axum::extract::rejection::PathRejection>,
) -> Result<Response<Body>, Failure> {
    let Path((dataset, profile, z, x, y)) =
        path.map_err(|_| Failure::new(404, "タイルが見つかりません。"))?;
    let y = y
        .strip_suffix(".png")
        .and_then(|y| y.parse::<u32>().ok())
        .ok_or_else(|| Failure::new(404, "タイルが見つかりません。"))?;
    let tile = TileId::new(z, x, y).map_err(|_| Failure::new(404, "タイル座標が範囲外です。"))?;
    let (bytes, hit) = service.render(&dataset, &profile, tile, false).await?;
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=604800, immutable")
        .header("X-Tile-Cache", if hit { "HIT" } else { "MISS" })
        .body(Body::from(bytes.as_ref().clone()))
        .map_err(Failure::internal)
}
