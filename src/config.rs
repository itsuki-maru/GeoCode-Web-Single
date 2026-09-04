use once_cell::sync::Lazy;
use std::env;
use std::str::FromStr;

pub struct Config {
    pub app_title: String,
    pub database_path: String,
    pub database_url: String,
    pub access_token_exp_minutes: i64,
    pub refresh_token_exp_minutes: i64,
    pub secret_key: String,
    pub admin_user_name: String,
    pub admin_user_password: String,
    pub failed_count: String,
    pub next_challenge_minutes: String,
    pub challenge_limit_start: String,
    pub images_path: String,
    pub upload_file_path: String,
    pub cache_control: String,
    pub secure_cookie: bool,
    pub service_name: String,
    pub allow_user_create_account: bool,
    pub allow_user_update_password: bool,
    pub allow_origins: String,
    pub tile_server_base_url: Option<String>,
    pub tile_server_api_key: Option<String>,
    pub redis_url: Option<String>,
    pub redis_connect_timeout_seconds: u64,
    pub tile_cache_ttl_seconds: u64,
    pub tile_cache_namespace: String,
    pub marker_form_storage_quota_bytes: i64,
    pub live_location_upload_interval_seconds: u64,
    pub live_location_stale_seconds: i64,
    pub live_location_offline_seconds: i64,
    pub live_map_snapshot_cache_seconds: u64,
    pub live_map_viewer_session_minutes: i64,
    pub live_map_password_attempt_limit: i32,
    pub live_map_password_window_minutes: i64,
}

pub static CONFIG: Lazy<Config> = Lazy::new(|| Config {
    app_title: env::var("APP_TITLE").expect("APP_TITLE must be set"),
    database_path: env::var("CREATEDATABASE_PATH").expect("CREATEDATABASE_PATH must be set."),
    database_url: env::var("DATABASE_URL").expect("DATABASE_URL must be set."),
    access_token_exp_minutes: env::var("ACCESS_TOKEN_EXP_MINUTUES")
        .expect("ACCESS_TOKEN_EXP_HOURS must be set.")
        .parse::<i64>()
        .expect("Failed Count Parse Error."),
    refresh_token_exp_minutes: env::var("REFRESH_TOKEN_EXP_MINUTUES")
        .expect("REFRESH_TOKEN_EXP_MINUTUES must be set.")
        .parse::<i64>()
        .expect("Failed Count Parse Error."),
    secret_key: get_required_secret("SECRET_KEY", 32),
    admin_user_name: env::var("ADMIN_USERNAME").expect("ADMIN_USERNAME must be set."),
    // デスクトップ版は導入容易性を優先し、初期値 `geocodeweb`（10文字）を許可する。
    admin_user_password: get_required_secret("ADMIN_PASSWORD", 8),
    failed_count: env::var("FAILED_ACCOUNT_LOCK").expect("FAILED_ACCOUNT_LOCK must be set."),
    next_challenge_minutes: env::var("NEXT_CHALLENGE_MINUTES")
        .expect("NEXT_CHALLENGE_MINUTES must be set."),
    challenge_limit_start: env::var("CHALLENGE_LIMIT_TIME_FAILEDCOUNT")
        .expect("CHALLENGE_LIMIT_TIME_FAILEDCOUNT must be set."),
    images_path: env::var("IMAGE_FILES_PATH").expect("IMAGE_FILES_PATH must be set"),
    upload_file_path: env::var("UPLOAD_FILE_PATH").expect("UPLOAD_FILE_PATH must be set"),
    cache_control: get_cache_control_from_env().to_header_value(),
    secure_cookie: env::var("SECURE_COOKIE")
        .expect("SECURE_COOKIE must be set")
        .parse::<bool>()
        .expect("SECURE_COOKIE Parse Error."),
    service_name: env::var("SERVICE_NAME").expect("SERVICE_NAME must be set"),
    allow_user_create_account: env::var("ALLOW_USER_CREATE_ACCOUNT")
        .expect("ALLOW_USER_CREATE_ACCOUNT must be set")
        .parse::<bool>()
        .expect("ALLOW_USER_CREATE_ACCOUNT Parse Error."),
    allow_user_update_password: env::var("ALLOW_USER_UPDATE_PASSWORD")
        .expect("ALLOW_USER_UPDATE_PASSWORD must be set")
        .parse::<bool>()
        .expect("Failed Parse Error."),
    allow_origins: env::var("ALLOW_ORIGINS").expect("ALLOW_ORIGINS must be set"),
    tile_server_base_url: env::var("TILE_SERVER_BASE_URL").ok(),
    tile_server_api_key: env::var("TILE_SERVER_API_KEY").ok(),
    redis_url: env::var("REDIS_URL").ok(),
    redis_connect_timeout_seconds: env::var("REDIS_CONNECT_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(3),
    tile_cache_ttl_seconds: env::var("TILE_CACHE_TTL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(604800),
    tile_cache_namespace: env::var("TILE_CACHE_NAMESPACE")
        .unwrap_or_else(|_| "default".to_string()),
    marker_form_storage_quota_bytes: env::var("MARKER_FORM_STORAGE_QUOTA_BYTES")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1024 * 1024 * 1024),
    live_location_upload_interval_seconds: env::var("LIVE_LOCATION_UPLOAD_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(5),
    live_location_stale_seconds: env::var("LIVE_LOCATION_STALE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(20),
    live_location_offline_seconds: env::var("LIVE_LOCATION_OFFLINE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(120),
    live_map_snapshot_cache_seconds: env::var("LIVE_MAP_SNAPSHOT_CACHE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(2),
    live_map_viewer_session_minutes: env::var("LIVE_MAP_VIEWER_SESSION_MINUTES")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(720),
    live_map_password_attempt_limit: env::var("LIVE_MAP_PASSWORD_ATTEMPT_LIMIT")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(5),
    live_map_password_window_minutes: env::var("LIVE_MAP_PASSWORD_WINDOW_MINUTES")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(10),
});

fn get_required_secret(name: &str, minimum_length: usize) -> String {
    let value = env::var(name).unwrap_or_else(|_| panic!("{name} must be set."));
    if !cfg!(debug_assertions)
        && (value.chars().count() < minimum_length
            || value.starts_with("CHANGE_ME_")
            || matches!(value.as_str(), "TESTPASS" | "SEACRET-KEY" | "P@ssw0rd"))
    {
        panic!("{name} must be a non-default secret with at least {minimum_length} characters.");
    }
    value
}
#[derive(Debug)]
pub enum CacheControl {
    Public,
    Private(Option<u64>), // max-age（秒）を指定可能
    NoStore,
    NoCache,
}

impl FromStr for CacheControl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let lower = s.trim().to_lowercase();
        if lower == "public" {
            Ok(CacheControl::Public)
        } else if lower.starts_with("private") {
            // private, private=max-age=3600
            if let Some(pos) = lower.find("max-age=") {
                let value = &lower[pos + 8..];
                let secs = value
                    .parse::<u64>()
                    .map_err(|e| format!("Invalid max-age value: {}", e))?;
                Ok(CacheControl::Private(Some(secs)))
            } else {
                Ok(CacheControl::Private(None))
            }
        } else if lower == "no-store" {
            Ok(CacheControl::NoStore)
        } else if lower == "no-cache" {
            Ok(CacheControl::NoCache)
        } else {
            Err(format!("Unknown cache control: {}", s))
        }
    }
}

impl CacheControl {
    pub fn to_header_value(&self) -> String {
        match self {
            CacheControl::Public => "public".to_string(),
            CacheControl::Private(Some(age)) => format!("private, max-age={}", age),
            CacheControl::Private(None) => "private".to_string(),
            CacheControl::NoStore => "no-store".to_string(),
            CacheControl::NoCache => "no-cache".to_string(),
        }
    }
}

fn get_cache_control_from_env() -> CacheControl {
    let default = "no-store".to_string();
    let value = env::var("CACHE_CONTROL").unwrap_or(default);
    CacheControl::from_str(&value).unwrap_or(CacheControl::NoStore)
}
