use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct TileServers {
    pub id: i64,
    pub layer_name: String,
    pub label: String,
    pub url: String,
    pub attribution: String,
    pub include_foreign_tiles: bool,
    pub min_zoom: Option<i64>,
    pub max_zoom: Option<i64>,
    pub create_at: String,
    pub updated_at: String,
}

// レイヤ情報取得クエリパラメータ
#[derive(Debug, Deserialize)]
pub struct MapReadQueryPrams {
    pub marker_id: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub layer: Option<String>,
    pub is_master: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MapAnotherWindowQueryParams {
    #[serde(default = "default_true")]
    pub is_cluster: Option<bool>,
}

fn default_true() -> Option<bool> {
    Some(true)
}
