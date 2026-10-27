use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct ShapeObject {
    pub id: String,
    pub user_id: String,
    pub layer_id: String,
    pub shape_type: String,
    pub name: Option<String>,
    pub geojson: Value,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShapeCreateJsonData {
    pub layer_id: String,
    pub shape_type: String,
    pub name: Option<String>,
    pub geojson: Value,
}

#[derive(Debug, Deserialize)]
pub struct ShapeReadQueryParams {
    pub layer_id: Option<String>,
    pub is_master: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShapeUpdateJsonData {
    pub name: Option<String>,
    pub layer_id: Option<String>,
    pub shape_type: Option<String>,
    pub geojson: Option<Value>,
    #[serde(default)]
    pub free_text: Option<String>,
    #[serde(default)]
    pub body_token: Option<String>,
}

/// Coordinate-only updates cannot carry memo, style, layer, or name changes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShapeGeometryUpdateData {
    pub base_shape_type: String,
    pub base_geometry: Value,
    pub shape_type: String,
    pub coordinates: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShapeCreatedResponse {
    pub id: String,
    pub message: String,
    pub object: ShapeObject,
}

/// 保存確定後の本文・更新日時を返す。
#[derive(Debug, Serialize, Deserialize)]
pub struct ShapeUpdatedResponse {
    pub message: String,
    pub object: ShapeObject,
}
