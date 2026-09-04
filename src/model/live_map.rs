use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Deserialize)]
pub struct CreateLiveMapMemberPayload {
    pub user_id: String,
    pub display_name: String,
    pub marker_color: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateLiveMapPayload {
    pub name: String,
    pub expires_at: DateTime<Utc>,
    pub members: Vec<CreateLiveMapMemberPayload>,
    #[serde(default)]
    pub password_action: LiveMapPasswordAction,
    #[serde(default)]
    pub share_password: Option<String>,
}

#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LiveMapPasswordAction {
    #[default]
    Keep,
    Set,
    Remove,
}

#[derive(Debug, Deserialize)]
pub struct LiveMapPasswordForm {
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct CreateLiveMapResponse {
    pub id: String,
    pub name: String,
    pub expires_at: DateTime<Utc>,
    pub share_url: String,
}

#[derive(Debug, Serialize)]
pub struct AdminLiveMapSummary {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub member_count: i64,
    pub share_url: String,
    pub is_password_protected: bool,
    pub members: Vec<AdminLiveMapMember>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct AdminLiveMapMember {
    pub user_id: String,
    pub display_name: String,
    pub marker_color: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PublicLiveMapMember {
    pub id: String,
    pub display_name: String,
    pub marker_color: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub accuracy_m: Option<f64>,
    pub heading_deg: Option<f64>,
    pub speed_mps: Option<f64>,
    pub observed_at: Option<DateTime<Utc>>,
    pub received_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PublicLiveMapPosition {
    pub id: String,
    pub display_name: String,
    pub marker_color: String,
    pub status: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub accuracy_m: Option<f64>,
    pub heading_deg: Option<f64>,
    pub speed_mps: Option<f64>,
    pub observed_at: Option<DateTime<Utc>>,
    pub received_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PublicLiveMapSnapshot {
    pub map: PublicLiveMapInfo,
    pub server_time: DateTime<Utc>,
    pub refresh_after_ms: u64,
    pub positions: Vec<PublicLiveMapPosition>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PublicLiveMapInfo {
    pub id: String,
    pub name: String,
}
