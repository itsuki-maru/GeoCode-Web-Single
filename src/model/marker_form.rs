use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkerFormField {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub max_length: Option<usize>,
    #[serde(default)]
    pub choices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct MarkerFormSchema {
    #[serde(default)]
    pub fields: Vec<MarkerFormField>,
}

#[derive(Debug, Deserialize)]
pub struct MarkerFormConfigUpdate {
    pub enabled: bool,
    pub form_title: String,
    #[serde(default)]
    pub form_description: String,
    pub form_schema: MarkerFormSchema,
    #[serde(default)]
    pub password_mode: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MarkerFormConfigResponse {
    pub marker_id: String,
    pub enabled: bool,
    pub form_title: String,
    pub form_description: String,
    pub form_schema: MarkerFormSchema,
    pub is_password_protected: bool,
    pub public_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MarkerFormSubmissionRequest {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub values: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct MarkerFormSubmissionResponse {
    pub message: String,
}
