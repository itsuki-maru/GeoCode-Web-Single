use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// レイヤ情報構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct LayerObject {
    pub id: String,
    pub user_id: String,
    pub layer_name: String,
    pub is_master: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MasterLayerIdResponse {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LayerIsMaster {
    pub is_master: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LayerCreateQueryParams {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LayerCreatedResponse {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LayerNameUpdatePayload {
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LayerDeleteResponse {
    pub message: String,
}

// レイヤ情報構造体（DBの行マッピング用）
#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct LayerObjectFromRow {
    pub id: String,
    pub user_id: String,
    pub layer_name: String,
    pub is_master: bool,
}
