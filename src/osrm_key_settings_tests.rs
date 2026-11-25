use super::apply_env_vars;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use geocode_web_single::{
    auth::create_token,
    build_tera_extension,
    db::{create_user_with_master_layer, run_migrations},
    init::{read_env_json, read_env_json_readonly},
    router::build_router,
};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{fs, path::Path, process::Command};
use tower::ServiceExt;

const CHILD: &str = "OSRM_KEY_SETTINGS_TEST_CASE";
const DIRECTORY: &str = "OSRM_KEY_SETTINGS_TEST_DIRECTORY";
const TEST_NAME: &str =
    "osrm_key_settings_tests::startup_loads_osrm_keys_and_preserves_decryption_across_processes";
const CONFIG_FILE: &str = "geocode-web-single.env.json";
const ADMIN: &str = "osrm-startup-admin";
const API_KEY: &str = "startup-test-osrm-api-key";
// 設定のGET・PUTは接続せず、保存と復号だけを行う。
const BASE_URL: &str = "https://osrm.example.test/routed-car";

#[test]
fn startup_loads_osrm_keys_and_preserves_decryption_across_processes() {
    if let Ok(case) = std::env::var(CHILD) {
        let directory = std::env::var_os(DIRECTORY).unwrap();
        exercise_startup(&case, Path::new(&directory));
        return;
    }

    // 既定鍵をJSONに保存し、別プロセスでJSONから復号する。
    let generated = tempfile::tempdir().unwrap();
    write_settings(generated.path(), None);
    run_child("save", generated.path(), None);
    let persisted = fs::read(generated.path().join(CONFIG_FILE)).unwrap();
    let generated_key = json_key(&persisted);
    assert_eq!(STANDARD.decode(generated_key).unwrap().len(), 32);
    run_child("read", generated.path(), None);
    assert!(fs::read(generated.path().join(CONFIG_FILE)).unwrap() == persisted);

    // 環境変数だけで暗号化した既存データを残し、同じ鍵をJSONへ継承する。
    let inherited = tempfile::tempdir().unwrap();
    let external = STANDARD.encode([11u8; 32]);
    write_settings(inherited.path(), None);
    run_child("legacy-save", inherited.path(), Some(&external));
    let previous = fs::read(inherited.path().join(CONFIG_FILE)).unwrap();
    let previous: Value = serde_json::from_slice(&previous).unwrap();
    assert!(previous.get("osrm_encryption_key").is_none());
    run_child("read", inherited.path(), Some(&external));
    let persisted = fs::read(inherited.path().join(CONFIG_FILE)).unwrap();
    assert!(json_key(&persisted) == external);
    run_child("read", inherited.path(), None);
    assert!(fs::read(inherited.path().join(CONFIG_FILE)).unwrap() == persisted);

    // JSONの明示鍵を保持しつつ、実行時は従来の環境変数を優先する。
    let precedence = tempfile::tempdir().unwrap();
    let explicit = STANDARD.encode([9u8; 32]);
    write_settings(precedence.path(), Some(&explicit));
    run_child("save", precedence.path(), Some(&external));
    let persisted = fs::read(precedence.path().join(CONFIG_FILE)).unwrap();
    assert!(json_key(&persisted) == explicit);
    run_child("read", precedence.path(), Some(&external));
    run_child("wrong-key", precedence.path(), None);
    assert!(fs::read(precedence.path().join(CONFIG_FILE)).unwrap() == persisted);
}

fn run_child(case: &str, directory: &Path, encryption_key: Option<&str>) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", TEST_NAME, "--test-threads=1", "--nocapture"])
        .env(CHILD, case)
        .env(DIRECTORY, directory)
        .env("OSRM_ALLOWED_ORIGINS", "")
        .env_remove("AI_ENCRYPTION_KEY");
    if let Some(key) = encryption_key {
        command.env("OSRM_ENCRYPTION_KEY", key);
    } else {
        command.env_remove("OSRM_ENCRYPTION_KEY");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "ケース {case}\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_settings(directory: &Path, encryption_key: Option<&str>) {
    let mut value = json!({
        "app_title": "OSRM 起動時設定テスト",
        "access_token_exp_minutes": "30",
        "refresh_token_exp_minutes": "1440",
        "secret_key": "osrm-startup-test-session-key-only",
        "admin_username": "admin",
        "admin_passwotd": "test-only-password",
        "failed_account_lock": "5",
        "next_challenge_minutes": "5",
        "challenge_limit_time_failed_count": "3"
    });
    if let Some(key) = encryption_key {
        value["osrm_encryption_key"] = json!(key);
    }
    fs::write(
        directory.join(CONFIG_FILE),
        serde_json::to_vec_pretty(&value).unwrap(),
    )
    .unwrap();
}

fn json_key(configuration: &[u8]) -> String {
    let value: Value = serde_json::from_slice(configuration).unwrap();
    value["osrm_encryption_key"].as_str().unwrap().to_owned()
}

fn exercise_startup(case: &str, directory: &Path) {
    let inherited = std::env::var("OSRM_ENCRYPTION_KEY").ok();
    let configuration = if case == "legacy-save" {
        read_env_json_readonly(&directory.join(CONFIG_FILE)).unwrap()
    } else {
        read_env_json(&directory.to_path_buf()).unwrap()
    };
    let saved = configuration
        .osrm_encryption_key
        .as_ref()
        .map(|key| key.as_str());
    let effective = inherited.as_deref().or(saved).unwrap();
    if let Some(key) = saved {
        assert!(!format!("{configuration:?}").contains(key));
    }
    // 他のテストと分離したプロセスで、ランタイムを作成する前に起動時と同じ設定を適用する。
    unsafe { apply_env_vars(&configuration, "127.0.0.1:3000") };
    assert!(std::env::var("OSRM_ENCRYPTION_KEY").ok().as_deref() == Some(effective));
    let create = matches!(case, "save" | "legacy-save");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&configuration.sqlite_database_path)
                    .create_if_missing(create),
            )
            .await
            .unwrap();
        let admin = if create {
            run_migrations(&pool).await.unwrap();
            create_user_with_master_layer(&pool, ADMIN, "unused-test-hash", true)
                .await
                .unwrap()
                .id
        } else {
            sqlx::query_scalar("SELECT id FROM user_model WHERE username = $1")
                .bind(ADMIN)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let token = create_token(&admin, 60, "access_token", 0).unwrap();
        // 実ルーターは Osrm::configured で設定を初期化する。
        let app = build_router(pool.clone(), build_tera_extension().unwrap(), None);
        if create {
            let input = json!({
                "revision": null,
                "drive": {"baseUrl": BASE_URL, "key": {"action": "set", "apiKey": API_KEY}}
            });
            let view = request_settings(&app, &token, Some(input), effective).await;
            assert_eq!(view["drive"]["keyUsable"], true);
            let encrypted: Vec<u8> =
                sqlx::query_scalar("SELECT encrypted_drive_key FROM osrm_settings WHERE id = 1")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert!(encrypted.len() > API_KEY.len());
            assert!(
                !encrypted
                    .windows(API_KEY.len())
                    .any(|part| part == API_KEY.as_bytes())
            );
        }
        let view = request_settings(&app, &token, None, effective).await;
        assert_eq!(view["keyStorageConfigured"], true);
        assert_eq!(view["drive"]["baseUrl"], BASE_URL);
        assert_eq!(view["drive"]["hasApiKey"], true);
        assert_eq!(view["drive"]["keyUsable"], case != "wrong-key");
        pool.close().await;
    });
}

async fn request_settings(
    app: &Router,
    token: &str,
    input: Option<Value>,
    effective_key: &str,
) -> Value {
    let request = Request::builder()
        .uri("/admin/osrm-settings")
        .header(header::COOKIE, format!("access_token={token}"));
    let request = if let Some(input) = input {
        request
            .method(Method::PUT)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(input.to_string()))
    } else {
        request.method(Method::GET).body(Body::empty())
    };
    let response = app.clone().oneshot(request.unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let text = std::str::from_utf8(&body).unwrap();
    assert!(!text.contains(API_KEY));
    assert!(!text.contains(effective_key));
    serde_json::from_str(text).unwrap()
}
