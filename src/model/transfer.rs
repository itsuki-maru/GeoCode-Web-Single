//! Database-independent JSON v3 transfer format. Keys have file-local scope.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const LEGACY_LIMIT: usize = 5 * 1024 * 1024;
pub const TRANSFER_LIMIT: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferPackage {
    pub format: String,
    pub version: u32,
    pub exported_at: DateTime<Utc>,
    pub image_policy: String,
    pub layers: Vec<Layer>,
    pub markers: Vec<Marker>,
    pub shapes: Vec<Shape>,
    pub common_forms: Vec<CommonForm>,
    pub form_configs: Vec<FormConfig>,
    pub submissions: Vec<Submission>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceForm {
    pub form_key: String,
    pub version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[serde(rename = "type")]
    pub kind: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layer {
    pub key: String,
    pub layer_name: String,
    pub is_master: bool,
    pub common_form: Option<SourceForm>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Marker {
    pub key: String,
    pub layer_key: String,
    pub marker_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub detail: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shape {
    pub key: String,
    pub layer_key: String,
    pub shape_type: String,
    pub name: Option<String>,
    pub geojson: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    pub version: i32,
    pub form_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommonForm {
    pub key: String,
    pub version: i32,
    pub deleted: bool,
    pub form_title: String,
    pub form_description: String,
    pub form_schema: Value,
    pub revisions: Vec<Revision>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FormConfig {
    pub target: Target,
    pub form_title: String,
    pub form_description: String,
    pub form_schema: Value,
    pub source_form: Option<SourceForm>,
    pub managed_layer_key: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    pub key: String,
    pub target: Target,
    pub submitted_values: Value,
    pub form_snapshot: Option<Value>,
    pub source_form: Option<SourceForm>,
    pub rendered_markdown: String,
    pub created_at: DateTime<Utc>,
    pub source_order: u64,
}
