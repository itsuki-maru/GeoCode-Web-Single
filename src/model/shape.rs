use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct ShapeObject {
    pub id: String,
    pub user_id: String,
    pub shape_type: String,
    pub layer_id: String,
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
    pub geojson: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShapeCreatedResponse {
    pub id: String,
    pub message: String,
}
