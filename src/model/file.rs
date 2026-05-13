use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Deserialize, Serialize, FromRow)]
pub struct ExportJsonScheme {
    pub id: String,
    pub user_id: String,
    pub layer_id: String,
    pub marker_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub detail: String,
    pub layer_model_id: String,
    pub layer_model_user_id: String,
    pub layer_name: String,
    pub is_master: bool,
}

#[derive(Debug, Deserialize, Serialize, FromRow)]
pub struct ExportShapeJsonScheme {
    pub id: String,
    pub user_id: String,
    pub layer_id: String,
    pub shape_type: String,
    pub name: Option<String>,
    pub geojson: Value,
    pub layer_name: String,
    pub is_master: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExportMarkers {
    pub id: String,
    pub user_id: String,
    pub layer_id: String,
    pub marker_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub detail: String,
    pub layer: ExportLayers,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExportLayers {
    pub id: String,
    pub user_id: String,
    pub layer_name: String,
    pub is_master: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportLayers {
    pub layer_name: String,
    pub is_master: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExportShapes {
    pub id: String,
    pub user_id: String,
    pub layer_id: String,
    pub shape_type: String,
    pub name: Option<String>,
    pub geojson: Value,
    pub layer: ExportLayers,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportMarkers {
    pub marker_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub detail: String,
    pub layer: ImportLayers,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportShapes {
    pub shape_type: String,
    pub name: Option<String>,
    pub geojson: Value,
    pub layer: ImportLayers,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExportPackage {
    pub version: u32,
    pub markers: Vec<ExportMarkers>,
    pub shapes: Vec<ExportShapes>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportPackage {
    pub version: Option<u32>,
    pub markers: Vec<ImportMarkers>,
    #[serde(default)]
    pub shapes: Vec<ImportShapes>,
}
