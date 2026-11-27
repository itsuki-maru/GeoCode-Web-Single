use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::path::PathBuf;

// 設定JSONへ保存する配備鍵。検証時のエラーやDebug出力に鍵の原文を含めない。
macro_rules! deployment_key {
    ($name:ident, $service:literal) => {
        #[derive(Clone, Serialize, PartialEq, Eq)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub const INVALID_MESSAGE: &str =
                concat!($service, "用暗号鍵は32バイトをBase64で指定してください。");

            pub fn new(raw: String) -> Result<Self, &'static str> {
                use base64::{Engine, engine::general_purpose::STANDARD};
                if !STANDARD.decode(raw.trim()).is_ok_and(|key| key.len() == 32) {
                    return Err(Self::INVALID_MESSAGE);
                }
                Ok(Self(raw))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(concat!(stringify!($name), "([REDACTED])"))
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let serde_json::Value::String(raw) = serde_json::Value::deserialize(deserializer)?
                else {
                    return Err(serde::de::Error::custom(Self::INVALID_MESSAGE));
                };
                Self::new(raw).map_err(serde::de::Error::custom)
            }
        }
    };
}

deployment_key!(AiEncryptionKey, "AI");
deployment_key!(OsrmEncryptionKey, "OSRM");

// アプリケーション設定情報構造体
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApplicationInitSetup {
    pub app_title: String,
    pub sqlite_database_path: PathBuf,
    pub database_url: String,
    pub access_token_exp_minutes: String,
    pub refresh_token_exp_minutes: String,
    pub secret_key: String,
    pub admin_username: String,
    pub admin_passwotd: String,
    pub image_file_path: String,
    pub upload_file_path: String,
    pub failed_account_lock: String,
    pub next_challenge_minutes: String,
    pub challenge_limit_time_failed_count: String,
    pub cache_control: String,
    pub secure_cookie: String,
    pub service_name: String,
    pub rust_log: String,
    pub allow_user_create_account: String,
    pub allow_user_update_password: String,
    pub allow_origins: String,
    pub http_image_allowed_origins: String,
    pub vector_tile_allowed_origins: String,
    pub tile_proxy_allowed_origins: String,
    pub tile_settings_encryption_key: String,
    #[serde(default)]
    pub ai_encryption_key: Option<AiEncryptionKey>,
    #[serde(default)]
    pub osrm_encryption_key: Option<OsrmEncryptionKey>,
    #[serde(default)]
    pub osrm_allowed_origins: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_routing_http: Option<crate::local_routing::config::HttpSettings>,
    pub camera_sharing_enabled: Option<String>,
    pub camera_turn_provider: Option<String>,
    pub camera_stun_urls: Option<String>,
    pub camera_turn_urls: Option<String>,
    pub camera_turn_secret: Option<String>,
    pub camera_relay_only: Option<String>,
    pub camera_cloudflare_turn_key_id: Option<String>,
    pub camera_cloudflare_turn_api_token: Option<String>,
    pub geocoder_provider: Option<String>,
    pub geocoder_url: Option<String>,
    pub geocoder_api_key: Option<String>,
    pub redis_url: Option<String>,
    pub redis_connect_timeout_seconds: String,
    pub tile_cache_ttl_seconds: String,
    pub tile_cache_namespace: String,
    pub tile_catalog_database_path: String,
    pub tile_dataset_path: String,
    pub tile_cache_path: String,
    pub tile_work_path: String,
    pub local_tile_workers: String,
    pub local_tile_queue_capacity: String,
    pub local_tile_max_subscribers: String,
    pub local_tile_background_queue_capacity: String,
    pub local_tile_job_timeout_seconds: String,
    pub local_tile_http_timeout_seconds: String,
    pub local_tile_precompute_max_tiles: String,
    pub marker_form_storage_quota_bytes: String,
    pub live_location_history_enabled: String,
    pub live_location_upload_interval_seconds: String,
    pub live_location_stale_seconds: String,
    pub live_location_offline_seconds: String,
    pub live_map_snapshot_cache_seconds: String,
    pub live_map_viewer_session_minutes: String,
    pub live_map_password_attempt_limit: String,
    pub live_map_password_window_minutes: String,
}

#[derive(Serialize, Deserialize, FromRow)]
pub struct IsExists {
    pub exists_flag: i64,
}

// ルートのメッセージ構造体
#[derive(Serialize, Deserialize)]
pub struct MessageApi {
    pub message: String,
}

// アプリケーション初期情報構造体
#[derive(Serialize, Deserialize)]
pub struct AppInit {
    pub app_title: String,
    pub allow_user_account_create: bool,
    pub allow_user_update_password: bool,
    pub allow_origins: String,
}

// DB返り値格納構造体（UUID）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReturningId {
    pub id: String,
}

// DB返り値格納構造体（整数）
#[derive(Debug, Serialize, Deserialize)]
pub struct ReturningId64 {
    pub id: i64,
}
