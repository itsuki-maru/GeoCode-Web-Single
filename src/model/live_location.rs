use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Deserialize)]
pub struct LiveLocationPositionPayload {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy_m: Option<f64>,
    pub heading_deg: Option<f64>,
    pub speed_mps: Option<f64>,
    pub observed_at: DateTime<Utc>,
    #[serde(default)]
    pub sequence_no: i64,
}

#[derive(Debug, Serialize)]
pub struct LiveLocationSessionResponse {
    pub session_id: String,
    pub upload_interval_ms: u64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct AdminLiveLocationRow {
    pub user_id: String,
    pub username: String,
    pub can_share_live_location: bool,
    pub session_id: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub accuracy_m: Option<f64>,
    pub heading_deg: Option<f64>,
    pub speed_mps: Option<f64>,
    pub observed_at: Option<DateTime<Utc>>,
    pub received_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLiveLocationPermissionPayload {
    pub enabled: bool,
}
