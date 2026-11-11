use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::collections::HashMap;

use super::MarkerObject;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct TileServers {
    pub id: i64,
    pub layer_name: String,
    pub label: String,
    pub url: String,
    #[serde(default = "default_tile_kind")]
    pub kind: String,
    #[serde(default)]
    pub style_url: Option<String>,
    pub attribution: String,
    pub include_foreign_tiles: bool,
    pub min_zoom: Option<i64>,
    pub max_zoom: Option<i64>,
    pub create_at: String,
    pub updated_at: String,
}

fn default_tile_kind() -> String {
    "raster".into()
}

/// スタイルは公開可能な HTTPS URL または同一オリジンの絶対パスに限定する。
pub fn is_valid_basemap_style_url(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || value.contains(['\\', '#'])
    {
        return false;
    }
    if value.starts_with('/') {
        return !value.starts_with("//");
    }
    if !value
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        return false;
    }
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

pub fn is_valid_basemap_definition(kind: &str, style_url: Option<&str>) -> bool {
    match kind {
        "raster" => style_url.is_none(),
        "vector" => style_url.is_some_and(is_valid_basemap_style_url),
        _ => false,
    }
}

// レイヤ情報取得クエリパラメータ
#[derive(Debug, Deserialize)]
pub struct MapReadQueryPrams {
    pub marker_id: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub layer: Option<String>,
    pub is_master: Option<bool>,
    /// parent の場合、オブジェクト原本は埋め込み元から受け取る。
    pub data_source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MapObjectQuerySearchParams {
    pub query1: String,
    pub query2: String,
    pub layer: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MapObjectQueryResponse {
    pub markers: HashMap<String, MarkerObject>,
    pub shape_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MapAnotherWindowQueryParams {
    #[serde(default = "default_true")]
    pub is_cluster: Option<bool>,
}

fn default_true() -> Option<bool> {
    Some(true)
}
