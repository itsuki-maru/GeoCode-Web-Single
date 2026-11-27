use crate::model::{AiEncryptionKey, ApplicationInitSetup, OsrmEncryptionKey};
use crate::routing::osrm_origins;
use base64::{Engine, engine::general_purpose::STANDARD};
use dirs::home_dir;
use rand::RngCore;
use serde::Deserialize;
use std::fs;
use std::io::{self};
use std::path::PathBuf;
use uuid::Uuid;

mod deployment_key;
mod persistence;
pub(crate) mod routing_http;

pub(crate) fn protect_maintenance_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> io::Result<()> {
    persistence::protect_maintenance_file(source, destination)
}

pub(crate) fn create_maintenance_directory(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> io::Result<()> {
    persistence::create_maintenance_directory(source, destination)
}
pub(crate) use persistence::{backup_configuration, lock_configuration, write_to_json_file};
use persistence::{create_json_file, reject_non_regular_file};

/// セットアップフォームの入力フィールド（Tauriコマンドで受け取る）
#[derive(Debug, Deserialize)]
pub struct SetupForm {
    pub app_title: String,
    pub admin_username: String,
    pub admin_password: String,
    pub failed_account_lock: String,
    pub next_challenge_minutes: String,
    pub challenge_limit_time_failed_count: String,
    pub access_token_exp_minutes: String,
    pub refresh_token_exp_minutes: String,
}

/// 設定JSONの読み込み・移行時に発生するエラー。
/// 初回セットアップ未実施と、既存ファイルの破損・必須項目不足を区別する。
#[derive(Debug)]
pub enum EnvJsonReadError {
    NotFound,
    InvalidJson(String),
    MissingRequiredFields(Vec<&'static str>),
    Io(String),
}

impl std::fmt::Display for EnvJsonReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "設定ファイルが見つかりません"),
            Self::InvalidJson(message) => write!(f, "設定ファイルのJSONが不正です: {}", message),
            Self::MissingRequiredFields(fields) => {
                write!(
                    f,
                    "設定ファイルに必須項目が不足しています: {}",
                    fields.join(", ")
                )
            },
            Self::Io(message) => write!(f, "設定ファイルの読み書きに失敗しました: {}", message),
        }
    }
}

impl std::error::Error for EnvJsonReadError {}

/// 既存の設定JSONを移行用に読み込むための構造体。
/// 新しい項目が追加された古いJSONでも deserialize できるよう、全項目を Option で受ける。
#[derive(Debug, Deserialize)]
struct ApplicationInitSetupPartial {
    app_title: Option<String>,
    sqlite_database_path: Option<PathBuf>,
    database_url: Option<String>,
    access_token_exp_minutes: Option<String>,
    refresh_token_exp_minutes: Option<String>,
    secret_key: Option<String>,
    admin_username: Option<String>,
    admin_passwotd: Option<String>,
    image_file_path: Option<String>,
    upload_file_path: Option<String>,
    failed_account_lock: Option<String>,
    next_challenge_minutes: Option<String>,
    challenge_limit_time_failed_count: Option<String>,
    cache_control: Option<String>,
    secure_cookie: Option<String>,
    service_name: Option<String>,
    rust_log: Option<String>,
    allow_user_create_account: Option<String>,
    allow_user_update_password: Option<String>,
    allow_origins: Option<String>,
    http_image_allowed_origins: Option<String>,
    vector_tile_allowed_origins: Option<String>,
    tile_proxy_allowed_origins: Option<String>,
    tile_settings_encryption_key: Option<String>,
    ai_encryption_key: Option<AiEncryptionKey>,
    osrm_encryption_key: Option<OsrmEncryptionKey>,
    osrm_allowed_origins: Option<String>,
    local_routing_http: Option<crate::local_routing::config::HttpSettings>,
    camera_sharing_enabled: Option<String>,
    camera_turn_provider: Option<String>,
    camera_stun_urls: Option<String>,
    camera_turn_urls: Option<String>,
    camera_turn_secret: Option<String>,
    camera_relay_only: Option<String>,
    camera_cloudflare_turn_key_id: Option<String>,
    camera_cloudflare_turn_api_token: Option<String>,
    geocoder_provider: Option<String>,
    geocoder_url: Option<String>,
    geocoder_api_key: Option<String>,
    redis_url: Option<String>,
    redis_connect_timeout_seconds: Option<String>,
    tile_cache_ttl_seconds: Option<String>,
    tile_cache_namespace: Option<String>,
    tile_catalog_database_path: Option<String>,
    tile_dataset_path: Option<String>,
    tile_cache_path: Option<String>,
    tile_work_path: Option<String>,
    local_tile_workers: Option<String>,
    local_tile_queue_capacity: Option<String>,
    local_tile_max_subscribers: Option<String>,
    local_tile_background_queue_capacity: Option<String>,
    local_tile_job_timeout_seconds: Option<String>,
    local_tile_http_timeout_seconds: Option<String>,
    local_tile_precompute_max_tiles: Option<String>,
    marker_form_storage_quota_bytes: Option<String>,
    live_location_history_enabled: Option<String>,
    live_location_upload_interval_seconds: Option<String>,
    live_location_stale_seconds: Option<String>,
    live_location_offline_seconds: Option<String>,
    live_map_snapshot_cache_seconds: Option<String>,
    live_map_viewer_session_minutes: Option<String>,
    live_map_password_attempt_limit: Option<String>,
    live_map_password_window_minutes: Option<String>,
}

/// 初回セットアップ作成時と既存JSON移行時で共有する既定値。
struct EnvDefaults {
    sqlite_database_path: PathBuf,
    database_url: String,
    image_file_path: String,
    upload_file_path: String,
    cache_control: String,
    secure_cookie: String,
    rust_log: String,
    allow_user_create_account: String,
    allow_user_update_password: String,
    allow_origins: String,
    redis_connect_timeout_seconds: String,
    tile_cache_ttl_seconds: String,
    tile_cache_namespace: String,
    local_tiles: crate::local_tiles::config::LocalTileConfig,
    marker_form_storage_quota_bytes: String,
    live_location_history_enabled: String,
    live_location_upload_interval_seconds: String,
    live_location_stale_seconds: String,
    live_location_offline_seconds: String,
    live_map_snapshot_cache_seconds: String,
    live_map_viewer_session_minutes: String,
    live_map_password_attempt_limit: String,
    live_map_password_window_minutes: String,
}

/// 設定ディレクトリに依存するパス系の値を含めて、現在の既定値を組み立てる。
fn env_defaults(setup_dir: &std::path::Path) -> EnvDefaults {
    let database_path = setup_dir.join("geocode-web.sqlite");
    // SQLxは?より後を接続オプションとし、%を復号する。Windowsのverbatimパスも
    // ファイル名として往復できるよう、パス内の区切り文字だけを符号化する。
    let database_url = format!(
        "sqlite:{}",
        database_path
            .to_string_lossy()
            .replace('%', "%25")
            .replace('?', "%3F")
            .replace('#', "%23")
    );
    let images_path = setup_dir.join("images").to_string_lossy().into_owned();

    EnvDefaults {
        sqlite_database_path: database_path,
        database_url,
        image_file_path: images_path.clone(),
        upload_file_path: images_path,
        cache_control: "no-cache".to_string(),
        secure_cookie: "true".to_string(),
        rust_log: "geocode_web_single=info,tower_http=info".to_string(),
        allow_user_create_account: "false".to_string(),
        allow_user_update_password: "true".to_string(),
        allow_origins: "http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000"
            .to_string(),
        redis_connect_timeout_seconds: "3".to_string(),
        tile_cache_ttl_seconds: "604800".to_string(),
        tile_cache_namespace: "default".to_string(),
        local_tiles: crate::local_tiles::config::LocalTileConfig::defaults(setup_dir),
        marker_form_storage_quota_bytes: "1073741824".to_string(),
        live_location_history_enabled: "false".to_string(),
        live_location_upload_interval_seconds: "5".to_string(),
        live_location_stale_seconds: "20".to_string(),
        live_location_offline_seconds: "120".to_string(),
        live_map_snapshot_cache_seconds: "2".to_string(),
        live_map_viewer_session_minutes: "720".to_string(),
        live_map_password_attempt_limit: "5".to_string(),
        live_map_password_window_minutes: "10".to_string(),
    }
}

/// アプリケーションのユーザー設定ディレクトリを取得し、存在しなければ作成する。
/// 設定JSONの作成は行わない。
pub fn get_application_user_setup_path() -> PathBuf {
    let home_dir = home_dir().expect("User home directory get error.");
    let setup_file_dir = home_dir.join(".geocode-web-single");
    if !setup_file_dir.exists() {
        fs::create_dir(&setup_file_dir).expect("Directory `~/.geocode-web-single` create error.");
        let images_dir = &setup_file_dir.join("images");
        fs::create_dir(images_dir).expect("Directory `~/.geocode-web-single/images` create error.");
    }
    setup_file_dir
}

/// 設定JSONファイルを読み込み、追加済みの任意項目が欠けていれば補完して保存する。
pub fn read_env_json(setup_dir: &PathBuf) -> Result<ApplicationInitSetup, EnvJsonReadError> {
    let env_json_path = setup_dir.join("geocode-web-single.env.json");
    read_env_json_at(setup_dir, &env_json_path, true, |name| {
        std::env::var_os(name)
    })
}

/// CLIの照会では任意項目をメモリ上で補完し、JSON・バックアップ・ディレクトリを作成しない。
pub fn read_env_json_readonly(
    env_json_path: &std::path::Path,
) -> Result<ApplicationInitSetup, EnvJsonReadError> {
    ensure_no_pending_move(env_json_path)?;
    read_relocation_settings(env_json_path)
}

pub(crate) fn ensure_no_pending_move(path: &std::path::Path) -> Result<(), EnvJsonReadError> {
    if crate::local_tiles::catalog::rebind::relocation::pending_path(path)
        .try_exists()
        .map_err(|e| EnvJsonReadError::Io(e.to_string()))?
    {
        return Err(EnvJsonReadError::Io(
            "保存先の更新が中断しています。local-tiles gui の「データの保存先」で再開してください。".into(),
        ));
    }
    Ok(())
}

pub(crate) fn read_relocation_settings(
    env_json_path: &std::path::Path,
) -> Result<ApplicationInitSetup, EnvJsonReadError> {
    let setup_dir = env_json_path
        .parent()
        .ok_or_else(|| EnvJsonReadError::Io("設定ファイルの親ディレクトリがありません。".into()))?
        .to_path_buf();
    read_env_json_at(&setup_dir, env_json_path, false, |_| None)
}

fn read_env_json_at(
    setup_dir: &PathBuf,
    env_json_path: &std::path::Path,
    persist_defaults: bool,
    inherited: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<ApplicationInitSetup, EnvJsonReadError> {
    if persist_defaults {
        ensure_no_pending_move(env_json_path)?;
    }
    let mut value = read_env_value(env_json_path)?;
    // 移行が必要な場合だけ生成から保存までを直列化する。完成済み設定では
    // 読取り専用の設定ディレクトリでも起動でき、照会CLIも何も作成しない。
    let _lock = if persist_defaults && env_json_requires_migration(&value) {
        let lock = lock_configuration(env_json_path)
            .map_err(|error| EnvJsonReadError::Io(error.to_string()))?;
        // 待っている間に他の起動処理が保存した鍵を必ず再読込する。
        value = read_env_value(env_json_path)?;
        Some(lock)
    } else {
        None
    };

    // 直接 ApplicationInitSetup に変換する前に、不足項目の有無を判定しておく。
    // 補完が必要な場合は、読み込み成功後にバックアップを取って書き戻す。
    let migrated = env_json_requires_migration(&value);
    let mut env = parse_env_value(setup_dir, &value, || {
        if persist_defaults {
            inherited("OSRM_ALLOWED_ORIGINS")
        } else {
            None
        }
    })?;

    if persist_defaults {
        env.ai_encryption_key = Some(deployment_key::AI.complete(
            env.ai_encryption_key.take(),
            inherited(deployment_key::AI.environment).as_deref(),
            &env.database_url,
        )?);
        env.osrm_encryption_key = Some(deployment_key::OSRM.complete(
            env.osrm_encryption_key.take(),
            inherited(deployment_key::OSRM.environment).as_deref(),
            &env.database_url,
        )?);
    }

    if migrated && persist_defaults {
        let backup_path = setup_dir.join("geocode-web-single.env.json.bak");
        backup_configuration(env_json_path, &backup_path)
            .map_err(|error| EnvJsonReadError::Io(error.to_string()))?;
        write_to_json_file(env_json_path.to_path_buf(), &env)
            .map_err(|e| EnvJsonReadError::Io(e.to_string()))?;
    }

    Ok(env)
}

fn parse_env_value(
    setup_dir: &std::path::Path,
    value: &serde_json::Value,
    legacy_origins: impl FnOnce() -> Option<std::ffi::OsString>,
) -> Result<ApplicationInitSetup, EnvJsonReadError> {
    if let Some(origins) = value.get("osrm_allowed_origins")
        && !(origins.is_null() || origins.is_string())
    {
        return Err(EnvJsonReadError::InvalidJson(
            "osrm_allowed_origins はカンマ区切りの文字列で指定してください。".into(),
        ));
    }
    let mut partial = ApplicationInitSetupPartial::deserialize(value)
        .map_err(|e| EnvJsonReadError::InvalidJson(e.to_string()))?;
    // nullや空文字は明示的な「例外なし」。項目そのものがない旧JSONでだけ引き継ぐ。
    if value.get("osrm_allowed_origins").is_none()
        && let Some(raw) = legacy_origins().and_then(|s| s.into_string().ok())
    {
        partial.osrm_allowed_origins = Some(osrm_origins::from_legacy(&raw));
    }
    let env = complete_env(setup_dir, partial)?;
    crate::local_tiles::config::LocalTileConfig::from_setup(&env)
        .map_err(EnvJsonReadError::InvalidJson)?;
    Ok(env)
}

fn read_env_value(path: &std::path::Path) -> Result<serde_json::Value, EnvJsonReadError> {
    reject_non_regular_file(path).map_err(|error| EnvJsonReadError::Io(error.to_string()))?;
    let file = fs::File::open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            EnvJsonReadError::NotFound
        } else {
            EnvJsonReadError::Io(error.to_string())
        }
    })?;
    serde_json::from_reader(io::BufReader::new(file))
        .map_err(|error| EnvJsonReadError::InvalidJson(error.to_string()))
}

/// セットアップフォームの入力値から ApplicationInitSetup を構築し、JSONに保存する。
pub fn build_env_from_form(
    setup_dir: PathBuf,
    form: SetupForm,
) -> Result<ApplicationInitSetup, String> {
    // 入力エラーの場合はlockも設定JSONも作らない。
    validate_setup_form(&form)?;
    let env_json_path = setup_dir.join("geocode-web-single.env.json");
    let _lock = lock_configuration(&env_json_path).map_err(|error| error.to_string())?;
    match fs::symlink_metadata(&env_json_path) {
        Ok(_) => return Err("設定JSONが既に存在します。既存設定は上書きしません。".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
    }
    let env = build_env_settings(&setup_dir, form)?;
    create_json_file(env_json_path, &env).map_err(|e| e.to_string())?;
    Ok(env)
}

/// サーバ起動・環境変数・ファイル作成を伴わず、初期設定の入力だけを検証する。
pub fn validate_setup_form(form: &SetupForm) -> Result<(), String> {
    crate::utils::validate_username(&form.admin_username).map_err(|error| error.to_string())?;
    if form.admin_password.chars().count() < 8
        || matches!(form.admin_password.as_str(), "password123" | "P@ssw0rd")
    {
        return Err("管理者パスワードは8文字以上の値を指定してください。".to_string());
    }
    for (name, value) in [
        ("アカウントロック回数", &form.failed_account_lock),
        ("次の試行までの分数", &form.next_challenge_minutes),
        (
            "試行時間制限の開始回数",
            &form.challenge_limit_time_failed_count,
        ),
        ("アクセストークン有効分数", &form.access_token_exp_minutes),
        ("更新トークン有効分数", &form.refresh_token_exp_minutes),
    ] {
        if value.parse::<u32>().ok().is_none_or(|number| number == 0) {
            return Err(format!("{name}は1以上の整数で指定してください。"));
        }
    }
    Ok(())
}

/// 初期設定値だけを構築する。保存とサーバ起動は呼出側の責務。
pub fn build_env_settings(
    setup_dir: &std::path::Path,
    form: SetupForm,
) -> Result<ApplicationInitSetup, String> {
    validate_setup_form(&form)?;
    let defaults = env_defaults(setup_dir);
    let secret_key = Uuid::new_v4().to_string();
    let ai_encryption_key = Some(
        deployment_key::AI
            .complete(
                None,
                std::env::var_os(deployment_key::AI.environment).as_deref(),
                &defaults.database_url,
            )
            .map_err(|error| error.to_string())?,
    );
    let osrm_encryption_key = Some(
        deployment_key::OSRM
            .complete(
                None,
                std::env::var_os(deployment_key::OSRM.environment).as_deref(),
                &defaults.database_url,
            )
            .map_err(|error| error.to_string())?,
    );

    let env = ApplicationInitSetup {
        app_title: form.app_title.clone(),
        sqlite_database_path: defaults.sqlite_database_path,
        database_url: defaults.database_url,
        image_file_path: defaults.image_file_path,
        upload_file_path: defaults.upload_file_path,
        failed_account_lock: form.failed_account_lock,
        next_challenge_minutes: form.next_challenge_minutes,
        challenge_limit_time_failed_count: form.challenge_limit_time_failed_count,
        admin_username: form.admin_username,
        admin_passwotd: form.admin_password,
        access_token_exp_minutes: form.access_token_exp_minutes,
        refresh_token_exp_minutes: form.refresh_token_exp_minutes,
        secret_key,
        cache_control: defaults.cache_control,
        secure_cookie: defaults.secure_cookie,
        service_name: form.app_title,
        rust_log: defaults.rust_log,
        allow_user_create_account: defaults.allow_user_create_account,
        allow_user_update_password: defaults.allow_user_update_password,
        allow_origins: defaults.allow_origins,
        http_image_allowed_origins: String::new(),
        vector_tile_allowed_origins: String::new(),
        tile_proxy_allowed_origins: String::new(),
        tile_settings_encryption_key: generate_tile_settings_key(),
        ai_encryption_key,
        osrm_encryption_key,
        osrm_allowed_origins: String::new(),
        local_routing_http: None,
        camera_sharing_enabled: None,
        camera_turn_provider: None,
        camera_stun_urls: None,
        camera_turn_urls: None,
        camera_turn_secret: None,
        camera_relay_only: None,
        camera_cloudflare_turn_key_id: None,
        camera_cloudflare_turn_api_token: None,
        geocoder_provider: None,
        geocoder_url: None,
        geocoder_api_key: None,
        redis_url: None,
        redis_connect_timeout_seconds: defaults.redis_connect_timeout_seconds,
        tile_cache_ttl_seconds: defaults.tile_cache_ttl_seconds,
        tile_cache_namespace: defaults.tile_cache_namespace,
        tile_catalog_database_path: defaults
            .local_tiles
            .catalog_database_path
            .to_string_lossy()
            .into_owned(),
        tile_dataset_path: defaults
            .local_tiles
            .dataset_path
            .to_string_lossy()
            .into_owned(),
        tile_cache_path: defaults
            .local_tiles
            .cache_path
            .to_string_lossy()
            .into_owned(),
        tile_work_path: defaults
            .local_tiles
            .work_path
            .to_string_lossy()
            .into_owned(),
        local_tile_workers: defaults.local_tiles.workers.to_string(),
        local_tile_queue_capacity: defaults.local_tiles.queue_capacity.to_string(),
        local_tile_max_subscribers: defaults.local_tiles.max_subscribers.to_string(),
        local_tile_background_queue_capacity: defaults
            .local_tiles
            .background_queue_capacity
            .to_string(),
        local_tile_job_timeout_seconds: defaults.local_tiles.job_timeout_seconds.to_string(),
        local_tile_http_timeout_seconds: defaults.local_tiles.http_timeout_seconds.to_string(),
        local_tile_precompute_max_tiles: defaults.local_tiles.precompute_max_tiles.to_string(),
        marker_form_storage_quota_bytes: defaults.marker_form_storage_quota_bytes,
        live_location_history_enabled: defaults.live_location_history_enabled,
        live_location_upload_interval_seconds: defaults.live_location_upload_interval_seconds,
        live_location_stale_seconds: defaults.live_location_stale_seconds,
        live_location_offline_seconds: defaults.live_location_offline_seconds,
        live_map_snapshot_cache_seconds: defaults.live_map_snapshot_cache_seconds,
        live_map_viewer_session_minutes: defaults.live_map_viewer_session_minutes,
        live_map_password_attempt_limit: defaults.live_map_password_attempt_limit,
        live_map_password_window_minutes: defaults.live_map_password_window_minutes,
    };
    crate::local_tiles::config::LocalTileConfig::from_setup(&env)?;
    Ok(env)
}

/// 既存の設定JSONに、現在の ApplicationInitSetup が持つ任意項目が欠けているか判定する。
/// 欠落していても安全に補完できる項目だけを移行対象に含める。
fn env_json_requires_migration(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };

    [
        "sqlite_database_path",
        "database_url",
        "image_file_path",
        "upload_file_path",
        "cache_control",
        "secure_cookie",
        "service_name",
        "rust_log",
        "allow_user_create_account",
        "allow_user_update_password",
        "allow_origins",
        "http_image_allowed_origins",
        "vector_tile_allowed_origins",
        "tile_proxy_allowed_origins",
        "tile_settings_encryption_key",
        "ai_encryption_key",
        "osrm_encryption_key",
        "osrm_allowed_origins",
        "camera_sharing_enabled",
        "camera_turn_provider",
        "camera_stun_urls",
        "camera_turn_urls",
        "camera_turn_secret",
        "camera_relay_only",
        "camera_cloudflare_turn_key_id",
        "camera_cloudflare_turn_api_token",
        "geocoder_provider",
        "geocoder_url",
        "geocoder_api_key",
        "redis_url",
        "redis_connect_timeout_seconds",
        "tile_cache_ttl_seconds",
        "tile_cache_namespace",
        "tile_catalog_database_path",
        "tile_dataset_path",
        "tile_cache_path",
        "tile_work_path",
        "local_tile_workers",
        "local_tile_queue_capacity",
        "local_tile_max_subscribers",
        "local_tile_background_queue_capacity",
        "local_tile_job_timeout_seconds",
        "local_tile_http_timeout_seconds",
        "local_tile_precompute_max_tiles",
        "marker_form_storage_quota_bytes",
        "live_location_history_enabled",
        "live_location_upload_interval_seconds",
        "live_location_stale_seconds",
        "live_location_offline_seconds",
        "live_map_snapshot_cache_seconds",
        "live_map_viewer_session_minutes",
        "live_map_password_attempt_limit",
        "live_map_password_window_minutes",
    ]
    .iter()
    .any(|field| {
        !object.contains_key(*field)
            || (matches!(
                *field,
                "tile_settings_encryption_key"
                    | "ai_encryption_key"
                    | "osrm_encryption_key"
                    | "osrm_allowed_origins"
            ) && object[*field].is_null())
            || ((field.starts_with("local_tile_")
                || matches!(
                    *field,
                    "tile_catalog_database_path"
                        | "tile_dataset_path"
                        | "tile_cache_path"
                        | "tile_work_path"
                ))
                && object[*field].is_null())
    })
}

/// タイル中継のAPIキーを暗号化する鍵を生成し、設定JSONへ永続化する。
fn generate_tile_settings_key() -> String {
    let mut key = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    STANDARD.encode(key)
}

fn complete_env(
    setup_dir: &std::path::Path,
    partial: ApplicationInitSetupPartial,
) -> Result<ApplicationInitSetup, EnvJsonReadError> {
    let defaults = env_defaults(setup_dir);
    let mut missing = Vec::new();

    // 起動に不可欠な値は推測で作らず、欠落項目としてまとめて報告する。
    macro_rules! required {
        ($field:ident) => {
            match partial.$field {
                Some(value) => value,
                None => {
                    missing.push(stringify!($field));
                    Default::default()
                },
            }
        };
    }

    let app_title = required!(app_title);
    let access_token_exp_minutes = required!(access_token_exp_minutes);
    let refresh_token_exp_minutes = required!(refresh_token_exp_minutes);
    let secret_key = required!(secret_key);
    let admin_username = required!(admin_username);
    let admin_passwotd = required!(admin_passwotd);
    let failed_account_lock = required!(failed_account_lock);
    let next_challenge_minutes = required!(next_challenge_minutes);
    let challenge_limit_time_failed_count = required!(challenge_limit_time_failed_count);

    if !missing.is_empty() {
        return Err(EnvJsonReadError::MissingRequiredFields(missing));
    }

    let osrm_allowed_origins = partial.osrm_allowed_origins.unwrap_or_default();
    osrm_origins::validate(&osrm_allowed_origins).map_err(|message| {
        EnvJsonReadError::InvalidJson(format!("osrm_allowed_origins: {message}"))
    })?;

    // 設定の補完・保存より前にHTTP画像配信元を検証する。
    let http_image_allowed_origins = partial.http_image_allowed_origins.unwrap_or_default();
    crate::config::parse_http_image_allowed_origins(Some(&http_image_allowed_origins)).map_err(
        |message| EnvJsonReadError::InvalidJson(format!("http_image_allowed_origins: {message}")),
    )?;

    let vector_tile_allowed_origins = partial.vector_tile_allowed_origins.unwrap_or_default();
    crate::config::parse_vector_tile_allowed_origins(Some(&vector_tile_allowed_origins)).map_err(
        |message| EnvJsonReadError::InvalidJson(format!("vector_tile_allowed_origins: {message}")),
    )?;
    let tile_proxy_allowed_origins = partial.tile_proxy_allowed_origins.unwrap_or_default();
    if !tile_proxy_allowed_origins
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .all(|origin| {
            reqwest::Url::parse(origin).is_ok_and(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.origin().ascii_serialization() == origin
            })
        })
    {
        return Err(EnvJsonReadError::InvalidJson(
            "tile_proxy_allowed_originsが不正です。".into(),
        ));
    }
    let tile_settings_encryption_key = partial
        .tile_settings_encryption_key
        .unwrap_or_else(generate_tile_settings_key);
    if !STANDARD
        .decode(&tile_settings_encryption_key)
        .is_ok_and(|key| key.len() == 32)
    {
        return Err(EnvJsonReadError::InvalidJson(
            "tile_settings_encryption_keyは32バイトをBase64で指定してください。".into(),
        ));
    }

    // 任意項目は既存値を優先し、欠落している場合だけ現在の既定値で補完する。
    Ok(ApplicationInitSetup {
        service_name: partial.service_name.unwrap_or_else(|| app_title.clone()),
        app_title,
        sqlite_database_path: partial
            .sqlite_database_path
            .unwrap_or(defaults.sqlite_database_path),
        database_url: partial.database_url.unwrap_or(defaults.database_url),
        access_token_exp_minutes,
        refresh_token_exp_minutes,
        secret_key,
        admin_username,
        admin_passwotd,
        image_file_path: partial.image_file_path.unwrap_or(defaults.image_file_path),
        upload_file_path: partial
            .upload_file_path
            .unwrap_or(defaults.upload_file_path),
        failed_account_lock,
        next_challenge_minutes,
        challenge_limit_time_failed_count,
        cache_control: partial.cache_control.unwrap_or(defaults.cache_control),
        secure_cookie: partial.secure_cookie.unwrap_or(defaults.secure_cookie),
        rust_log: partial.rust_log.unwrap_or(defaults.rust_log),
        allow_user_create_account: partial
            .allow_user_create_account
            .unwrap_or(defaults.allow_user_create_account),
        allow_user_update_password: partial
            .allow_user_update_password
            .unwrap_or(defaults.allow_user_update_password),
        allow_origins: partial.allow_origins.unwrap_or(defaults.allow_origins),
        http_image_allowed_origins,
        vector_tile_allowed_origins,
        tile_proxy_allowed_origins,
        tile_settings_encryption_key,
        ai_encryption_key: partial.ai_encryption_key,
        osrm_encryption_key: partial.osrm_encryption_key,
        osrm_allowed_origins,
        local_routing_http: partial.local_routing_http,
        camera_sharing_enabled: partial.camera_sharing_enabled,
        camera_turn_provider: partial.camera_turn_provider,
        camera_stun_urls: partial.camera_stun_urls,
        camera_turn_urls: partial.camera_turn_urls,
        camera_turn_secret: partial.camera_turn_secret,
        camera_relay_only: partial.camera_relay_only,
        camera_cloudflare_turn_key_id: partial.camera_cloudflare_turn_key_id,
        camera_cloudflare_turn_api_token: partial.camera_cloudflare_turn_api_token,
        geocoder_provider: partial.geocoder_provider,
        geocoder_url: partial.geocoder_url,
        geocoder_api_key: partial.geocoder_api_key,
        redis_url: partial.redis_url,
        redis_connect_timeout_seconds: partial
            .redis_connect_timeout_seconds
            .unwrap_or(defaults.redis_connect_timeout_seconds),
        tile_cache_ttl_seconds: partial
            .tile_cache_ttl_seconds
            .unwrap_or(defaults.tile_cache_ttl_seconds),
        tile_cache_namespace: partial
            .tile_cache_namespace
            .unwrap_or(defaults.tile_cache_namespace),
        tile_catalog_database_path: partial.tile_catalog_database_path.unwrap_or_else(|| {
            defaults
                .local_tiles
                .catalog_database_path
                .to_string_lossy()
                .into_owned()
        }),
        tile_dataset_path: partial.tile_dataset_path.unwrap_or_else(|| {
            defaults
                .local_tiles
                .dataset_path
                .to_string_lossy()
                .into_owned()
        }),
        tile_cache_path: partial.tile_cache_path.unwrap_or_else(|| {
            defaults
                .local_tiles
                .cache_path
                .to_string_lossy()
                .into_owned()
        }),
        tile_work_path: partial.tile_work_path.unwrap_or_else(|| {
            defaults
                .local_tiles
                .work_path
                .to_string_lossy()
                .into_owned()
        }),
        local_tile_workers: partial
            .local_tile_workers
            .unwrap_or_else(|| defaults.local_tiles.workers.to_string()),
        local_tile_queue_capacity: partial
            .local_tile_queue_capacity
            .unwrap_or_else(|| defaults.local_tiles.queue_capacity.to_string()),
        local_tile_max_subscribers: partial
            .local_tile_max_subscribers
            .unwrap_or_else(|| defaults.local_tiles.max_subscribers.to_string()),
        local_tile_background_queue_capacity: partial
            .local_tile_background_queue_capacity
            .unwrap_or_else(|| defaults.local_tiles.background_queue_capacity.to_string()),
        local_tile_job_timeout_seconds: partial
            .local_tile_job_timeout_seconds
            .unwrap_or_else(|| defaults.local_tiles.job_timeout_seconds.to_string()),
        local_tile_http_timeout_seconds: partial
            .local_tile_http_timeout_seconds
            .unwrap_or_else(|| defaults.local_tiles.http_timeout_seconds.to_string()),
        local_tile_precompute_max_tiles: partial
            .local_tile_precompute_max_tiles
            .unwrap_or_else(|| defaults.local_tiles.precompute_max_tiles.to_string()),
        marker_form_storage_quota_bytes: partial
            .marker_form_storage_quota_bytes
            .unwrap_or(defaults.marker_form_storage_quota_bytes),
        live_location_history_enabled: partial
            .live_location_history_enabled
            .unwrap_or(defaults.live_location_history_enabled),
        live_location_upload_interval_seconds: partial
            .live_location_upload_interval_seconds
            .unwrap_or(defaults.live_location_upload_interval_seconds),
        live_location_stale_seconds: partial
            .live_location_stale_seconds
            .unwrap_or(defaults.live_location_stale_seconds),
        live_location_offline_seconds: partial
            .live_location_offline_seconds
            .unwrap_or(defaults.live_location_offline_seconds),
        live_map_snapshot_cache_seconds: partial
            .live_map_snapshot_cache_seconds
            .unwrap_or(defaults.live_map_snapshot_cache_seconds),
        live_map_viewer_session_minutes: partial
            .live_map_viewer_session_minutes
            .unwrap_or(defaults.live_map_viewer_session_minutes),
        live_map_password_attempt_limit: partial
            .live_map_password_attempt_limit
            .unwrap_or(defaults.live_map_password_attempt_limit),
        live_map_password_window_minutes: partial
            .live_map_password_window_minutes
            .unwrap_or(defaults.live_map_password_window_minutes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_setup_dir(test_name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "geocode-web-single-{}-{}",
            test_name,
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_env_json(setup_dir: &std::path::Path, value: serde_json::Value) {
        fs::write(
            setup_dir.join("geocode-web-single.env.json"),
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    fn minimum_required_env_json() -> serde_json::Value {
        json!({
            "app_title": "GeoCode Test",
            "access_token_exp_minutes": "30",
            "refresh_token_exp_minutes": "1440",
            "secret_key": "secret",
            "admin_username": "admin",
            "admin_passwotd": "password",
            "failed_account_lock": "5",
            "next_challenge_minutes": "10",
            "challenge_limit_time_failed_count": "3"
        })
    }

    #[test]
    fn concurrent_startup_persists_one_set_of_keys_and_osrm_origins_and_keeps_original_backup() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        write_env_json(&setup_dir, minimum_required_env_json());
        let path = setup_dir.join("geocode-web-single.env.json");
        let original = fs::read(&path).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let mut threads = Vec::new();
        for i in 0..8 {
            let setup_dir = setup_dir.clone();
            let path = path.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                let env = read_env_json_at(&setup_dir, &path, true, |name| {
                    (name == "OSRM_ALLOWED_ORIGINS")
                        .then(|| format!("http://localhost:500{i}").into())
                })
                .unwrap();
                (
                    env.ai_encryption_key.unwrap(),
                    env.osrm_encryption_key.unwrap(),
                    env.osrm_allowed_origins,
                )
            }));
        }
        let keys: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(keys.iter().all(|key| key == &keys[0]));
        let saved: ApplicationInitSetup = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.ai_encryption_key.as_ref(), Some(&keys[0].0));
        assert_eq!(saved.osrm_encryption_key.as_ref(), Some(&keys[0].1));
        assert!(
            saved
                .osrm_allowed_origins
                .starts_with("http://localhost:500")
        );
        assert_eq!(saved.osrm_allowed_origins, keys[0].2);
        assert_eq!(
            fs::read(setup_dir.join("geocode-web-single.env.json.bak")).unwrap(),
            original
        );
        assert!(!setup_dir.join("geocode-web.sqlite").exists());
    }

    #[test]
    fn readonly_and_failed_persistence_do_not_publish_a_generated_key() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        write_env_json(&setup_dir, minimum_required_env_json());
        let path = setup_dir.join("geocode-web-single.env.json");
        let original = fs::read(&path).unwrap();
        let readonly = read_env_json_at(&setup_dir, &path, false, |_| {
            panic!("読み取り専用操作は起動元の環境を参照しない")
        })
        .unwrap();
        assert!(readonly.ai_encryption_key.is_none());
        assert!(readonly.osrm_encryption_key.is_none());
        assert!(readonly.osrm_allowed_origins.is_empty());
        assert_eq!(fs::read_dir(&setup_dir).unwrap().count(), 1);
        let backup = setup_dir.join("geocode-web-single.env.json.bak");
        fs::create_dir(&backup).unwrap();
        assert!(read_env_json_at(&setup_dir, &path, true, |_| None).is_err());
        assert_eq!(fs::read(path).unwrap(), original);
        assert!(!setup_dir.join("geocode-web.sqlite").exists());
    }

    #[test]
    fn complete_configuration_does_not_need_to_create_or_open_a_lock() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        write_env_json(&setup_dir, minimum_required_env_json());
        let path = setup_dir.join("geocode-web-single.env.json");
        let first = read_env_json_at(&setup_dir, &path, true, |_| None).unwrap();
        assert!(first.osrm_allowed_origins.is_empty());
        let lock = setup_dir.join("geocode-web-single.env.json.lock");
        fs::remove_file(&lock).unwrap();
        // lockを作れない環境でも、移行済み設定を読み取れることを検証する。
        fs::create_dir(&lock).unwrap();
        let original = fs::read(&path).unwrap();
        let reloaded = read_env_json_at(&setup_dir, &path, true, |_| None).unwrap();
        assert_eq!(first.ai_encryption_key, reloaded.ai_encryption_key);
        assert_eq!(first.osrm_encryption_key, reloaded.osrm_encryption_key);
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn osrm_origins_migrate_once_then_follow_json_including_empty_and_null() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        let path = setup_dir.join("geocode-web-single.env.json");
        write_env_json(&setup_dir, minimum_required_env_json());
        let complete = read_env_json_at(&setup_dir, &path, true, |_| None).unwrap();
        let mut legacy = serde_json::to_value(complete).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("osrm_allowed_origins");
        write_env_json(&setup_dir, legacy);
        let first = read_env_json_at(&setup_dir, &path, true, |name| {
            (name == "OSRM_ALLOWED_ORIGINS").then(|| {
                "http://localhost:5000,http://invalid.example/path,https://example.com".into()
            })
        })
        .unwrap();
        assert_eq!(
            first.osrm_allowed_origins,
            "http://localhost:5000,https://example.com"
        );
        let mut saved = read_env_value(&path).unwrap();
        assert_eq!(saved["osrm_allowed_origins"], first.osrm_allowed_origins);
        let json_only = |name: &str| {
            assert_ne!(name, "OSRM_ALLOWED_ORIGINS");
            None
        };
        let reloaded = read_env_json_at(&setup_dir, &path, true, json_only).unwrap();
        assert_eq!(reloaded.osrm_allowed_origins, first.osrm_allowed_origins);
        for (raw, expected) in [
            (json!("http://localhost:3000"), "http://localhost:3000"),
            (json!(""), ""),
            (json!(null), ""),
        ] {
            saved["osrm_allowed_origins"] = raw;
            write_env_json(&setup_dir, saved.clone());
            let loaded = read_env_json_at(&setup_dir, &path, true, json_only).unwrap();
            assert_eq!(loaded.osrm_allowed_origins, expected);
            assert_eq!(
                read_env_value(&path).unwrap()["osrm_allowed_origins"],
                expected
            );
        }
    }

    #[test]
    fn invalid_explicit_osrm_origins_do_not_rewrite_settings_or_echo_input() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        let path = setup_dir.join("geocode-web-single.env.json");
        let mut value = minimum_required_env_json();
        let sensitive = "https://user:fixture-password@example.com";
        for raw in [json!(sensitive), json!([sensitive])] {
            value["osrm_allowed_origins"] = raw;
            write_env_json(&setup_dir, value.clone());
            let original = fs::read(&path).unwrap();
            let error = read_env_json_at(&setup_dir, &path, true, |_| None)
                .unwrap_err()
                .to_string();
            assert!(error.contains("osrm_allowed_origins"));
            assert!(!error.contains("fixture-password"));
            assert_eq!(fs::read(&path).unwrap(), original);
            assert!(!setup_dir.join("geocode-web-single.env.json.bak").exists());
        }
    }

    #[test]
    fn null_osrm_key_is_persisted_in_an_otherwise_complete_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        let path = setup_dir.join("geocode-web-single.env.json");
        write_env_json(&setup_dir, minimum_required_env_json());
        let complete = read_env_json_at(&setup_dir, &path, true, |_| None).unwrap();
        let mut config = serde_json::to_value(complete).unwrap();
        config["osrm_encryption_key"] = serde_json::Value::Null;
        write_env_json(&setup_dir, config);

        let completed = read_env_json_at(&setup_dir, &path, true, |_| None).unwrap();
        let saved: ApplicationInitSetup = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(completed.osrm_encryption_key.is_some());
        assert_eq!(saved.osrm_encryption_key, completed.osrm_encryption_key);
    }

    #[test]
    fn missing_osrm_key_with_encrypted_credentials_requires_restoration() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        let path = setup_dir.join("geocode-web-single.env.json");
        let database_path = env_defaults(&setup_dir).sqlite_database_path;
        let database = rusqlite::Connection::open(&database_path).unwrap();
        // URL列が追加される前のスキーマでも、車・徒歩の暗号文を検出する。
        database
            .execute_batch(include_str!(
                "../migrations/20261123090000_add_osrm_settings.sql"
            ))
            .unwrap();
        for (column, explicit_null) in
            [("encrypted_drive_key", false), ("encrypted_walk_key", true)]
        {
            let mut config = minimum_required_env_json();
            if explicit_null {
                config["osrm_encryption_key"] = serde_json::Value::Null;
            }
            write_env_json(&setup_dir, config);
            database
                .execute(
                    &format!("UPDATE osrm_settings SET revision = 'legacy', {column} = X'010203'"),
                    [],
                )
                .unwrap();
            let original_config = fs::read(&path).unwrap();
            let original_database = fs::read(&database_path).unwrap();
            let error = read_env_json_at(&setup_dir, &path, true, |_| None).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("元のosrm_encryption_keyまたはOSRM_ENCRYPTION_KEYを復元")
            );
            assert_eq!(fs::read(&path).unwrap(), original_config);
            assert_eq!(fs::read(&database_path).unwrap(), original_database);
            assert!(!setup_dir.join("geocode-web-single.env.json.bak").exists());
            database
                .execute(&format!("UPDATE osrm_settings SET {column} = NULL"), [])
                .unwrap();
        }
    }

    #[test]
    fn invalid_osrm_keys_are_rejected_without_exposing_values() {
        let directory = tempfile::tempdir().unwrap();
        let setup_dir = directory.path().to_path_buf();
        let path = setup_dir.join("geocode-web-single.env.json");
        let mut config = minimum_required_env_json();
        let invalid_key = "invalid-osrm-secret";
        for value in [
            json!(invalid_key),
            json!(12345),
            json!(""),
            json!(STANDARD.encode([0_u8; 31])),
        ] {
            config["osrm_encryption_key"] = value;
            write_env_json(&setup_dir, config.clone());
            let error = read_env_json_at(&setup_dir, &path, true, |_| None)
                .unwrap_err()
                .to_string();
            assert!(error.contains(OsrmEncryptionKey::INVALID_MESSAGE));
            assert!(!error.contains(invalid_key));
        }
        config["osrm_encryption_key"] = json!(STANDARD.encode([0_u8; 32]));
        write_env_json(&setup_dir, config);
        let original = fs::read(&path).unwrap();
        let error = read_env_json_at(&setup_dir, &path, true, |name| {
            (name == "OSRM_ENCRYPTION_KEY").then(|| invalid_key.into())
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains(OsrmEncryptionKey::INVALID_MESSAGE));
        assert!(!error.contains(invalid_key));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!setup_dir.join("geocode-web-single.env.json.bak").exists());
    }

    #[test]
    // 旧設定を補完した暗号鍵は再読込でも保持し、手動指定の配信元も検証する。
    fn tile_settings_configuration_migrates_and_keeps_its_encryption_key() {
        let setup_dir = test_setup_dir("tile-settings-migration");
        let mut original = minimum_required_env_json();
        original["tile_server_base_url"] = json!("https://legacy.example");
        original["tile_server_api_key"] = json!("legacy-fixture-key");
        write_env_json(&setup_dir, original.clone());
        let first = read_env_json(&setup_dir).unwrap();
        let backup = fs::read(setup_dir.join("geocode-web-single.env.json.bak")).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&backup).unwrap(),
            original
        );
        let active = serde_json::to_value(&first).unwrap();
        assert!(active.get("tile_server_base_url").is_none());
        assert!(active.get("tile_server_api_key").is_none());
        assert_eq!(
            STANDARD
                .decode(&first.tile_settings_encryption_key)
                .unwrap()
                .len(),
            32
        );
        let second = read_env_json(&setup_dir).unwrap();
        assert_eq!(
            first.tile_settings_encryption_key,
            second.tile_settings_encryption_key
        );
        assert!(second.vector_tile_allowed_origins.is_empty());
        assert!(second.tile_proxy_allowed_origins.is_empty());
        let mut value = serde_json::to_value(&second).unwrap();
        value["vector_tile_allowed_origins"] = json!("https://tiles.example");
        value["tile_proxy_allowed_origins"] = json!("http://localhost:8080");
        write_env_json(&setup_dir, value.clone());
        let explicit = read_env_json(&setup_dir).unwrap();
        assert_eq!(
            explicit.vector_tile_allowed_origins,
            "https://tiles.example"
        );
        assert_eq!(explicit.tile_proxy_allowed_origins, "http://localhost:8080");
        assert_eq!(
            explicit.tile_settings_encryption_key,
            second.tile_settings_encryption_key
        );
        for (key, invalid) in [
            ("vector_tile_allowed_origins", "http://tiles.example"),
            ("tile_proxy_allowed_origins", "https://tiles.example/path"),
            ("tile_settings_encryption_key", "invalid-key"),
        ] {
            let mut invalid_value = value.clone();
            invalid_value[key] = json!(invalid);
            write_env_json(&setup_dir, invalid_value);
            assert!(read_env_json(&setup_dir).is_err());
        }
        // 明示nullでも生成した鍵を書き戻し、次回読込で同じ鍵を使用する。
        value["tile_settings_encryption_key"] = serde_json::Value::Null;
        write_env_json(&setup_dir, value);
        let generated = read_env_json(&setup_dir).unwrap();
        assert_eq!(
            generated.tile_settings_encryption_key,
            read_env_json(&setup_dir)
                .unwrap()
                .tile_settings_encryption_key
        );
        fs::remove_dir_all(setup_dir).unwrap();
    }

    #[test]
    fn build_env_from_form_accepts_desktop_default_credentials() {
        let setup_dir = test_setup_dir("default-credentials");
        let form = SetupForm {
            app_title: "GeoCode-Web".to_string(),
            admin_username: "geocodeweb".to_string(),
            admin_password: "geocodeweb".to_string(),
            failed_account_lock: "15".to_string(),
            next_challenge_minutes: "5".to_string(),
            challenge_limit_time_failed_count: "5".to_string(),
            access_token_exp_minutes: "60".to_string(),
            refresh_token_exp_minutes: "1440".to_string(),
        };

        let env = build_env_from_form(setup_dir.clone(), form).unwrap();

        assert!(env.http_image_allowed_origins.is_empty());
        assert!(env.osrm_allowed_origins.is_empty());

        assert_eq!(env.admin_username, "geocodeweb");
        assert_eq!(env.admin_passwotd, "geocodeweb");

        let saved_text = fs::read_to_string(setup_dir.join("geocode-web-single.env.json")).unwrap();
        let saved: ApplicationInitSetup = serde_json::from_str(&saved_text).unwrap();
        assert_eq!(saved.admin_username, "geocodeweb");
        assert_eq!(saved.admin_passwotd, "geocodeweb");
        let saved_json: serde_json::Value = serde_json::from_str(&saved_text).unwrap();
        assert_eq!(saved_json["osrm_allowed_origins"], "");
        for key in [
            "camera_sharing_enabled",
            "camera_turn_provider",
            "camera_stun_urls",
            "camera_turn_urls",
            "camera_turn_secret",
            "camera_relay_only",
            "camera_cloudflare_turn_key_id",
            "camera_cloudflare_turn_api_token",
        ] {
            assert_eq!(saved_json.get(key), Some(&serde_json::Value::Null), "{key}");
        }

        fs::remove_dir_all(setup_dir).unwrap();
    }

    #[test]
    fn gui_saves_routing_and_appends_origins_to_the_selected_config_atomically() {
        use crate::local_routing::config::HttpSettings;
        let dir = tempfile::tempdir().unwrap();
        let (graphs, _) = crate::local_routing::http::app_with_graph(None);
        let path = dir.path().join("管理画面 設定.json");
        let mut original = minimum_required_env_json();
        original["tile_dataset_path"] = json!(graphs.path());
        original["future_setting"] = json!({"keep": [1, 2]});
        let bytes = serde_json::to_vec(&original).unwrap();
        fs::write(&path, &bytes).unwrap();
        let off = HttpSettings::default();
        let local = "http://127.0.0.1:3000";

        for (name, origin) in [
            ("不存在", local),
            ("試験", ""),
            ("試験", "http://localhost/local-routing/car"),
            ("試験", "http://localhost,http://example.org"),
        ] {
            assert!(routing_http::save(&path, &off, Some(name), Some(origin)).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        assert!(!path.with_added_extension("bak").exists());
        routing_http::save(&path, &off, Some("試験"), Some(local)).unwrap();
        let on = HttpSettings {
            enabled: true,
            dataset: "試験".into(),
        };
        let mut expected = original;
        expected["local_routing_http"] = json!(on);
        expected["osrm_allowed_origins"] = json!(local);
        assert_eq!(read_env_value(&path).unwrap(), expected);
        assert_eq!(fs::read(path.with_added_extension("bak")).unwrap(), bytes);
        assert!(!dir.path().join("geocode-web-single.env.json").exists());

        // 同じ表示状態から2画面で別々のオリジンを追加しても取りこぼさない。
        std::thread::scope(|scope| {
            for origin in ["https://example.org", "http://localhost:5050"] {
                let (path, on) = (&path, &on);
                scope.spawn(move || {
                    routing_http::save(path, on, Some("試験"), Some(origin)).unwrap()
                });
            }
        });
        let allowed = read_env_json_readonly(&path).unwrap().osrm_allowed_origins;
        let mut entries: Vec<_> = allowed.split(',').collect();
        entries.sort_unstable();
        assert_eq!(
            entries,
            [local, "http://localhost:5050", "https://example.org"]
        );
        let before_retry = fs::read(&path).unwrap();
        routing_http::save(&path, &on, Some("試験"), Some(local)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before_retry);
        assert!(routing_http::save(&path, &off, None, None).is_err());
        assert_eq!(fs::read(&path).unwrap(), before_retry);

        drop(graphs);
        routing_http::save(&path, &on, None, None).unwrap();
        expected["local_routing_http"]["enabled"] = json!(false);
        expected["osrm_allowed_origins"] = json!(allowed);
        assert_eq!(read_env_value(&path).unwrap(), expected);
    }

    #[test]
    fn gui_only_publishes_a_graph_without_changing_omitted_or_null_origins() {
        let dir = tempfile::tempdir().unwrap();
        let (graphs, _) = crate::local_routing::http::app_with_graph(None);
        let path = dir.path().join("geocode-web-single.env.json");
        let mut old = minimum_required_env_json();
        old["tile_dataset_path"] = json!(graphs.path());
        for origin in [None, Some(serde_json::Value::Null), Some(json!(""))] {
            if let Some(value) = &origin {
                old["osrm_allowed_origins"] = value.clone();
            }
            fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
            routing_http::save(&path, &Default::default(), Some("試験"), None).unwrap();
            assert_eq!(
                read_env_value(&path).unwrap().get("osrm_allowed_origins"),
                origin.as_ref()
            );
        }
    }

    #[test]
    fn migration_preserves_explicit_local_routing_publication() {
        let dir = tempfile::tempdir().unwrap();
        let setup_dir = dir.path().to_path_buf();
        let mut values = minimum_required_env_json();
        values["local_routing_http"] = serde_json::json!({"enabled":true,"dataset":"日本"});
        write_env_json(dir.path(), values);
        for _ in 0..2 {
            let settings = read_env_json(&setup_dir)
                .unwrap()
                .local_routing_http
                .unwrap();
            assert!(settings.enabled);
            assert_eq!(settings.dataset, "日本");
        }
    }

    #[test]
    fn read_env_json_complements_missing_optional_fields_and_writes_migrated_file() {
        let setup_dir = test_setup_dir("migrate");
        write_env_json(&setup_dir, minimum_required_env_json());

        let env = read_env_json(&setup_dir).unwrap();
        assert!(env.http_image_allowed_origins.is_empty());
        assert!(env.local_routing_http.is_none());

        assert_eq!(env.app_title, "GeoCode Test");
        assert_eq!(env.service_name, "GeoCode Test");
        assert_eq!(env.cache_control, "no-cache");
        assert_eq!(env.secure_cookie, "true");
        assert_eq!(env.allow_user_create_account, "false");
        assert_eq!(env.allow_user_update_password, "true");
        assert_eq!(env.redis_connect_timeout_seconds, "3");
        assert_eq!(env.tile_cache_ttl_seconds, "604800");
        assert_eq!(env.tile_cache_namespace, "default");
        assert_eq!(env.marker_form_storage_quota_bytes, "1073741824");
        assert_eq!(env.live_location_history_enabled, "false");
        assert_eq!(env.live_location_upload_interval_seconds, "5");
        assert_eq!(env.live_location_stale_seconds, "20");
        assert_eq!(env.live_location_offline_seconds, "120");
        assert_eq!(env.live_map_snapshot_cache_seconds, "2");
        assert_eq!(env.live_map_viewer_session_minutes, "720");
        assert_eq!(env.live_map_password_attempt_limit, "5");
        assert_eq!(env.live_map_password_window_minutes, "10");
        assert_eq!(env.geocoder_provider, None);
        assert_eq!(env.camera_sharing_enabled, None);
        assert_eq!(env.camera_cloudflare_turn_api_token, None);
        assert_eq!(env.geocoder_url, None);
        assert_eq!(env.geocoder_api_key, None);
        assert!(
            crate::geocoding::GeocoderConfig::from_values(
                env.geocoder_provider.as_deref(),
                env.geocoder_url.as_deref(),
                env.geocoder_api_key.as_deref()
            )
            .unwrap()
            .uses_csis()
        );
        assert_eq!(
            env.sqlite_database_path,
            setup_dir.join("geocode-web.sqlite")
        );
        assert_eq!(
            env.image_file_path,
            setup_dir.join("images").to_string_lossy()
        );

        let migrated_text =
            fs::read_to_string(setup_dir.join("geocode-web-single.env.json")).unwrap();
        let migrated_value: serde_json::Value = serde_json::from_str(&migrated_text).unwrap();
        assert!(migrated_value.get("tile_server_base_url").is_none());
        assert!(migrated_value.get("tile_server_api_key").is_none());
        assert!(
            migrated_value
                .get("redis_connect_timeout_seconds")
                .is_some()
        );
        assert_eq!(migrated_value["live_location_history_enabled"], "false");
        assert!(migrated_value.get("geocoder_provider").unwrap().is_null());
        assert!(migrated_value.get("geocoder_url").unwrap().is_null());
        assert!(migrated_value.get("geocoder_api_key").unwrap().is_null());
        assert_eq!(
            read_env_json(&setup_dir)
                .unwrap()
                .live_location_history_enabled,
            "false"
        );
        assert!(migrated_value.get("tile_cache_ttl_seconds").is_some());
        assert!(
            migrated_value
                .get("marker_form_storage_quota_bytes")
                .is_some()
        );
        assert!(
            migrated_value
                .get("live_location_upload_interval_seconds")
                .is_some()
        );
        assert!(
            migrated_value
                .get("live_map_snapshot_cache_seconds")
                .is_some()
        );
        assert!(setup_dir.join("geocode-web-single.env.json.bak").exists());

        fs::remove_dir_all(setup_dir).unwrap();
    }

    #[test]
    fn read_env_json_preserves_existing_optional_values() {
        let setup_dir = test_setup_dir("preserve");
        let mut value = minimum_required_env_json();
        value["http_image_allowed_origins"] =
            json!("http://192.168.1.20:80,http://192.168.1.21:8080");
        let object = value.as_object_mut().unwrap();
        object.insert("live_location_history_enabled".to_string(), json!("true"));
        object.insert("cache_control".to_string(), json!("public"));
        object.insert("secure_cookie".to_string(), json!("false"));
        object.insert("service_name".to_string(), json!("Custom Service"));
        object.insert("redis_url".to_string(), json!("redis://localhost:6379"));
        object.insert("geocoder_provider".to_string(), json!("abr"));
        object.insert(
            "geocoder_url".to_string(),
            json!("http://localhost:3000/geocode"),
        );
        object.insert("geocoder_api_key".to_string(), json!("test-key"));
        object.insert("camera_sharing_enabled".to_string(), json!("true"));
        object.insert("camera_turn_provider".to_string(), json!("cloudflare"));
        object.insert(
            "camera_cloudflare_turn_api_token".to_string(),
            json!("test-token"),
        );
        object.insert("tile_cache_namespace".to_string(), json!("custom"));
        object.insert(
            "marker_form_storage_quota_bytes".to_string(),
            json!("536870912"),
        );
        object.insert(
            "live_location_upload_interval_seconds".to_string(),
            json!("8"),
        );
        object.insert("live_map_snapshot_cache_seconds".to_string(), json!("0"));
        write_env_json(&setup_dir, value);

        let env = read_env_json(&setup_dir).unwrap();
        assert_eq!(
            env.http_image_allowed_origins,
            "http://192.168.1.20:80,http://192.168.1.21:8080"
        );

        assert_eq!(env.live_location_history_enabled, "true");
        assert_eq!(
            read_env_json(&setup_dir)
                .unwrap()
                .live_location_history_enabled,
            "true"
        );
        assert_eq!(env.cache_control, "public");
        assert_eq!(env.secure_cookie, "false");
        assert_eq!(env.service_name, "Custom Service");
        assert_eq!(env.redis_url.as_deref(), Some("redis://localhost:6379"));
        let reloaded = read_env_json(&setup_dir).unwrap();
        assert_eq!(reloaded.camera_sharing_enabled.as_deref(), Some("true"));
        assert_eq!(reloaded.camera_turn_provider.as_deref(), Some("cloudflare"));
        assert_eq!(
            reloaded.camera_cloudflare_turn_api_token.as_deref(),
            Some("test-token")
        );
        assert_eq!(reloaded.geocoder_provider.as_deref(), Some("abr"));
        assert_eq!(
            reloaded.geocoder_url.as_deref(),
            Some("http://localhost:3000/geocode")
        );
        assert_eq!(reloaded.geocoder_api_key.as_deref(), Some("test-key"));
        assert_eq!(env.tile_cache_namespace, "custom");
        assert_eq!(env.marker_form_storage_quota_bytes, "536870912");
        assert_eq!(env.live_location_upload_interval_seconds, "8");
        assert_eq!(env.live_map_snapshot_cache_seconds, "0");

        fs::remove_dir_all(setup_dir).unwrap();
    }

    #[test]
    fn read_env_json_reports_missing_required_fields() {
        let setup_dir = test_setup_dir("missing-required");
        let mut value = minimum_required_env_json();
        value.as_object_mut().unwrap().remove("secret_key");
        write_env_json(&setup_dir, value);

        let error = read_env_json(&setup_dir).unwrap_err();

        match error {
            EnvJsonReadError::MissingRequiredFields(fields) => {
                assert_eq!(fields, vec!["secret_key"]);
            },
            _ => panic!("unexpected error: {:?}", error),
        }

        fs::remove_dir_all(setup_dir).unwrap();
    }

    #[test]
    fn invalid_http_image_origin_does_not_rewrite_settings() {
        let directory = test_setup_dir("invalid-http-image");
        let mut value = minimum_required_env_json();
        value["http_image_allowed_origins"] = json!("http://*; script-src *");
        write_env_json(&directory, value);
        let path = directory.join("geocode-web-single.env.json");
        let original = fs::read(&path).unwrap();
        assert!(
            read_env_json(&directory)
                .unwrap_err()
                .to_string()
                .contains("http_image_allowed_origins")
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!directory.join("geocode-web-single.env.json.bak").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn read_env_json_reports_invalid_json() {
        let setup_dir = test_setup_dir("invalid");
        fs::write(
            setup_dir.join("geocode-web-single.env.json"),
            "{ invalid json",
        )
        .unwrap();

        let error = read_env_json(&setup_dir).unwrap_err();

        assert!(matches!(error, EnvJsonReadError::InvalidJson(_)));

        fs::remove_dir_all(setup_dir).unwrap();
    }
}
