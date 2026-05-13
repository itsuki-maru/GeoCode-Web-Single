use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// マーカー情報構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct MarkerObject {
    pub id: String,
    pub layer_id: Option<String>,
    pub marker_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub detail: String,
}

// マーカー情報取得クエリパラメータ
#[derive(Debug, Deserialize)]
pub struct MarkerReadQueryPrams {
    pub layer: Option<String>,
    pub is_master: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MarkerMoveRequestParams {
    pub marker_id: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MarkerCreateRequestParams {
    pub layer_id: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MarkerCreatedResponse {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MarkerInfoUpdateJsonData {
    pub name: String,
    pub detail: String,
    pub layer_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MarkerDeleteResponse {
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MarkerQuerySearchParams {
    pub query1: String,
    pub query2: String,
    pub layer: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct MarkerObjectFromRow {
    pub id: String,
    pub layer_id: Option<String>,
    pub marker_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub detail: String,
}
