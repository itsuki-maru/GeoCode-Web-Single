use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct MarkerIconData {
    pub id: String,
    pub user_id: String,
    pub filename: String,
    pub uuid_filename: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct MarkerIconDeleted {
    pub id: String,
    pub uuid_filename: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MarkerIconUploadResponse {
    pub id: String,
    pub user_id: String,
    pub filename: String,
    pub uuid_filename: String,
}

#[derive(Debug, Deserialize)]
pub struct MarkerIconSearchParams {
    pub query: String,
}

#[derive(Debug, Serialize)]
pub struct MarkerIconDeleteResponse {
    pub id: String,
    pub message: String,
}
