use crate::model::ApplicationInitSetup;
use dirs::home_dir;
use serde::Deserialize;
use serde::Serialize;
use std::fs;
use std::io::{self};
use std::path::PathBuf;
use uuid::Uuid;

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
    tile_server_base_url: Option<String>,
    tile_server_api_key: Option<String>,
    redis_url: Option<String>,
    redis_connect_timeout_seconds: Option<String>,
    tile_cache_ttl_seconds: Option<String>,
    tile_cache_namespace: Option<String>,
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
}

/// 設定ディレクトリに依存するパス系の値を含めて、現在の既定値を組み立てる。
fn env_defaults(setup_dir: &std::path::Path) -> EnvDefaults {
    let database_path = setup_dir.join("geocode-web.sqlite");
    let database_url = format!("sqlite:{}", database_path.to_string_lossy());
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
    if !env_json_path.exists() {
        return Err(EnvJsonReadError::NotFound);
    }

    let file = fs::File::open(&env_json_path).map_err(|e| EnvJsonReadError::Io(e.to_string()))?;
    let reader = io::BufReader::new(file);
    let value: serde_json::Value = serde_json::from_reader(reader)
        .map_err(|e| EnvJsonReadError::InvalidJson(e.to_string()))?;

    // 直接 ApplicationInitSetup に変換する前に、不足項目の有無を判定しておく。
    // 補完が必要な場合は、読み込み成功後にバックアップを取って書き戻す。
    let migrated = env_json_requires_migration(&value);
    let partial: ApplicationInitSetupPartial =
        serde_json::from_value(value).map_err(|e| EnvJsonReadError::InvalidJson(e.to_string()))?;
    let env = complete_env(setup_dir, partial)?;

    if migrated {
        let backup_path = setup_dir.join("geocode-web-single.env.json.bak");
        if !backup_path.exists() {
            fs::copy(&env_json_path, &backup_path)
                .map_err(|e| EnvJsonReadError::Io(e.to_string()))?;
        }
        write_to_json_file(env_json_path, &env).map_err(|e| EnvJsonReadError::Io(e.to_string()))?;
    }

    Ok(env)
}

/// セットアップフォームの入力値から ApplicationInitSetup を構築し、JSONに保存する。
pub fn build_env_from_form(
    setup_dir: PathBuf,
    form: SetupForm,
) -> Result<ApplicationInitSetup, String> {
    let defaults = env_defaults(&setup_dir);
    let secret_key = Uuid::new_v4().to_string();

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
        tile_server_base_url: None,
        tile_server_api_key: None,
        redis_url: None,
        redis_connect_timeout_seconds: defaults.redis_connect_timeout_seconds,
        tile_cache_ttl_seconds: defaults.tile_cache_ttl_seconds,
        tile_cache_namespace: defaults.tile_cache_namespace,
    };
    let env_json_path = setup_dir.join("geocode-web-single.env.json");
    write_to_json_file(env_json_path, &env).map_err(|e| e.to_string())?;

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
        "tile_server_base_url",
        "tile_server_api_key",
        "redis_url",
        "redis_connect_timeout_seconds",
        "tile_cache_ttl_seconds",
        "tile_cache_namespace",
    ]
    .iter()
    .any(|field| !object.contains_key(*field))
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
        tile_server_base_url: partial.tile_server_base_url,
        tile_server_api_key: partial.tile_server_api_key,
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
    })
}

/// 設定JSONを見やすい形式で保存する。
fn write_to_json_file<T: Serialize>(file_path: PathBuf, data: &T) -> io::Result<()> {
    let file = fs::File::create(file_path)?;
    serde_json::to_writer_pretty(file, data).map_err(io::Error::other)?;
    Ok(())
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
    fn read_env_json_complements_missing_optional_fields_and_writes_migrated_file() {
        let setup_dir = test_setup_dir("migrate");
        write_env_json(&setup_dir, minimum_required_env_json());

        let env = read_env_json(&setup_dir).unwrap();

        assert_eq!(env.app_title, "GeoCode Test");
        assert_eq!(env.service_name, "GeoCode Test");
        assert_eq!(env.cache_control, "no-cache");
        assert_eq!(env.secure_cookie, "true");
        assert_eq!(env.allow_user_create_account, "false");
        assert_eq!(env.allow_user_update_password, "true");
        assert_eq!(env.redis_connect_timeout_seconds, "3");
        assert_eq!(env.tile_cache_ttl_seconds, "604800");
        assert_eq!(env.tile_cache_namespace, "default");
        assert_eq!(env.tile_server_base_url, None);
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
        assert!(
            migrated_value
                .get("redis_connect_timeout_seconds")
                .is_some()
        );
        assert!(migrated_value.get("tile_cache_ttl_seconds").is_some());
        assert!(setup_dir.join("geocode-web-single.env.json.bak").exists());

        fs::remove_dir_all(setup_dir).unwrap();
    }

    #[test]
    fn read_env_json_preserves_existing_optional_values() {
        let setup_dir = test_setup_dir("preserve");
        let mut value = minimum_required_env_json();
        let object = value.as_object_mut().unwrap();
        object.insert("cache_control".to_string(), json!("public"));
        object.insert("secure_cookie".to_string(), json!("false"));
        object.insert("service_name".to_string(), json!("Custom Service"));
        object.insert("redis_url".to_string(), json!("redis://localhost:6379"));
        object.insert("tile_cache_namespace".to_string(), json!("custom"));
        write_env_json(&setup_dir, value);

        let env = read_env_json(&setup_dir).unwrap();

        assert_eq!(env.cache_control, "public");
        assert_eq!(env.secure_cookie, "false");
        assert_eq!(env.service_name, "Custom Service");
        assert_eq!(env.redis_url.as_deref(), Some("redis://localhost:6379"));
        assert_eq!(env.tile_cache_namespace, "custom");

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
