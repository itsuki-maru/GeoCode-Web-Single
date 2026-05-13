use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::path::PathBuf;

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
    pub tile_server_base_url: Option<String>,
    pub tile_server_api_key: Option<String>,
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
