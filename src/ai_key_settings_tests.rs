use super::apply_env_vars;
use axum::{Extension, body::to_bytes, http::StatusCode, response::IntoResponse};
use base64::{Engine, engine::general_purpose::STANDARD};
use geocode_web_single::{
    ai::settings::{self, AiSettingsInput},
    db::{create_user_with_master_layer, run_migrations},
    handler::ai,
    init::{SetupForm, build_env_from_form, read_env_json, read_env_json_readonly},
    model::ApplicationInitSetup,
};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use std::{path::Path, process::Command};

const CHILD: &str = "AI_KEY_SETTINGS_TEST_CASE";
const DIRECTORY: &str = "AI_KEY_SETTINGS_TEST_DIRECTORY";
const TEST_NAME: &str =
    "ai_key_settings_tests::startup_key_configuration_and_saved_credentials_survive_restart";
const LLM_SECRET: &str = "startup-test-llm-secret";
const SPEECH_SECRET: &str = "startup-test-speech-secret";

// 実際の利用者設定・DBや、他のテストのプロセス環境には触れない。
#[test]
fn startup_key_configuration_and_saved_credentials_survive_restart() {
    let external_key = STANDARD.encode([11u8; 32]);
    let Ok(case) = std::env::var(CHILD) else {
        for (case, key) in [
            ("generated", None),
            ("env_migration", Some(external_key.as_str())),
            ("env_precedence", Some(external_key.as_str())),
            ("setup_generated", None),
            ("setup_env", Some(external_key.as_str())),
            ("invalid_env", Some("invalid-external-test-secret")),
            ("invalid_json", Some(external_key.as_str())),
            ("readonly", Some("invalid-external-test-secret")),
        ] {
            run_child(case, None, key);
        }
        return;
    };

    let supplied_directory = std::env::var_os(DIRECTORY);
    let temporary = supplied_directory
        .is_none()
        .then(|| tempfile::tempdir().unwrap());
    let directory = supplied_directory
        .as_deref()
        .map(Path::new)
        .unwrap_or_else(|| temporary.as_ref().unwrap().path());
    let path = directory.join("geocode-web-single.env.json");

    match case.as_str() {
        "restart" | "wrong_key" => {
            let configuration = read_env_json(&directory.to_path_buf()).unwrap();
            // 非同期ランタイムを作成する前の、単独の専用プロセスでだけ適用する。
            unsafe { apply_env_vars(&configuration, "127.0.0.1:3000") };
            runtime().block_on(async {
                let pool = open_pool(&configuration, false).await;
                if case == "wrong_key" {
                    let error = settings::load(&pool)
                        .await
                        .err()
                        .expect("別の鍵では復号できない");
                    assert_redacted(&format!("{error:?} {error}"), &configuration);
                } else {
                    assert_loaded_credentials_and_responses(&pool, &configuration).await;
                }
                pool.close().await;
            });
        },
        "missing_key" => {
            let before = std::fs::read(&path).unwrap();
            let backup = std::fs::read(directory.join("geocode-web-single.env.json.bak")).ok();
            let database = directory.join("assistant.sqlite");
            let database_before = std::fs::read(&database).unwrap();
            let error = read_env_json(&directory.to_path_buf())
                .err()
                .expect("既存の暗号文がある場合は新しい鍵を生成しない");
            assert!(!format!("{error:?} {error}").contains(LLM_SECRET));
            assert!(std::fs::read(&path).unwrap() == before);
            assert!(std::fs::read(&database).unwrap() == database_before);
            assert!(
                std::fs::read(directory.join("geocode-web-single.env.json.bak")).ok() == backup
            );
        },
        "invalid_env" | "invalid_json" => {
            let mut value = minimum_settings(directory);
            let invalid = "invalid-json-test-secret";
            if case == "invalid_json" {
                value["ai_encryption_key"] = json!(invalid);
            }
            write_settings(&path, &value);
            let before = std::fs::read(&path).unwrap();
            let error = read_env_json(&directory.to_path_buf())
                .err()
                .expect("不正な明示鍵を自動生成で置き換えない");
            let message = format!("{error:?} {error}");
            assert!(!message.contains(invalid));
            assert!(!message.contains("invalid-external-test-secret"));
            assert!(!message.contains(&external_key));
            assert!(std::fs::read(&path).unwrap() == before);
            assert!(!directory.join("geocode-web-single.env.json.bak").exists());
            assert!(!directory.join("assistant.sqlite").exists());
        },
        "readonly" => {
            write_settings(&path, &minimum_settings(directory));
            let before = std::fs::read(&path).unwrap();
            let configuration = read_env_json_readonly(&path).unwrap();
            assert!(configuration.ai_encryption_key.is_none());
            assert!(std::fs::read(&path).unwrap() == before);
            assert!(!directory.join("geocode-web-single.env.json.bak").exists());
            assert!(!directory.join("geocode-web-single.env.json.lock").exists());
            assert!(!directory.join("assistant.sqlite").exists());
        },
        "setup_generated" | "setup_env" => {
            let configuration = build_env_from_form(directory.to_path_buf(), setup_form()).unwrap();
            let key = configuration.ai_encryption_key.as_ref().unwrap().as_ref();
            assert_eq!(STANDARD.decode(key).unwrap().len(), 32);
            if case == "setup_env" {
                assert!(key == external_key);
            }
            assert_redacted(&format!("{configuration:?}"), &configuration);
            let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(saved["ai_encryption_key"].as_str() == Some(key));
            unsafe { apply_env_vars(&configuration, "127.0.0.1:3000") };
            assert!(std::env::var("AI_ENCRYPTION_KEY").unwrap() == key);
        },
        "generated" | "env_migration" | "env_precedence" => {
            let mut value = minimum_settings(directory);
            let json_key = STANDARD.encode([9u8; 32]);
            if case == "env_precedence" {
                value["ai_encryption_key"] = json!(&json_key);
            }
            write_settings(&path, &value);
            let previous_database = if case == "env_migration" {
                // 旧版と同じ環境変数鍵で先に保存し、JSON移行前の暗号文を引き継ぐ。
                let previous = read_env_json_readonly(&path).unwrap();
                assert!(previous.ai_encryption_key.is_none());
                runtime().block_on(save_credentials(&previous));
                Some(std::fs::read(&previous.sqlite_database_path).unwrap())
            } else {
                None
            };
            let configuration = read_env_json(&directory.to_path_buf()).unwrap();
            let key = configuration.ai_encryption_key.as_ref().unwrap().as_ref();
            assert_eq!(STANDARD.decode(key).unwrap().len(), 32);
            if case == "env_migration" {
                assert!(
                    key == external_key,
                    "移行時は既存の環境変数と同じ鍵を保存する"
                );
            } else if case == "env_precedence" {
                assert!(key == json_key, "明示されたJSON鍵を上書きしない");
            }
            assert_redacted(&format!("{configuration:?}"), &configuration);
            let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(saved["ai_encryption_key"].as_str() == Some(key));
            unsafe { apply_env_vars(&configuration, "127.0.0.1:3000") };
            let effective = std::env::var("AI_ENCRYPTION_KEY").unwrap();
            assert!(
                effective
                    == if case == "env_precedence" {
                        external_key.as_str()
                    } else {
                        key
                    }
            );
            if let Some(previous_database) = previous_database {
                assert!(
                    std::fs::read(&configuration.sqlite_database_path).unwrap()
                        == previous_database
                );
                runtime().block_on(async {
                    let pool = open_pool(&configuration, false).await;
                    assert_loaded_credentials_and_responses(&pool, &configuration).await;
                    pool.close().await;
                });
            } else {
                runtime().block_on(save_credentials(&configuration));
            }
            let persisted = std::fs::read(&path).unwrap();
            if case == "env_precedence" {
                run_child("restart", Some(directory), Some(&external_key));
                run_child("wrong_key", Some(directory), None);
            } else {
                // 別プロセスで環境変数を消し、保存済みJSONだけから復号する。
                run_child("restart", Some(directory), None);
            }
            assert!(std::fs::read(&path).unwrap() == persisted);
            if case == "generated" {
                let mut without_key: Value = serde_json::from_slice(&persisted).unwrap();
                without_key
                    .as_object_mut()
                    .unwrap()
                    .remove("ai_encryption_key");
                write_settings(&path, &without_key);
                run_child("missing_key", Some(directory), None);
            }
        },
        _ => panic!("unknown isolated test case"),
    }
}

fn run_child(case: &str, directory: Option<&Path>, key: Option<&str>) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", TEST_NAME, "--test-threads=1", "--nocapture"])
        .env(CHILD, case)
        .env("AI_ALLOWED_ORIGINS", "");
    if let Some(directory) = directory {
        command.env(DIRECTORY, directory);
    } else {
        command.env_remove(DIRECTORY);
    }
    if let Some(key) = key {
        command.env("AI_ENCRYPTION_KEY", key);
    } else {
        command.env_remove("AI_ENCRYPTION_KEY");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "case={case}\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn minimum_settings(directory: &Path) -> Value {
    let database = directory.join("assistant.sqlite");
    let database_url = format!(
        "sqlite:{}",
        database
            .to_string_lossy()
            .replace('%', "%25")
            .replace('?', "%3F")
            .replace('#', "%23")
    );
    let options = database_url
        .parse::<sqlx::sqlite::SqliteConnectOptions>()
        .unwrap();
    assert!(
        options.get_filename() == database,
        "検査対象と保存先のDBを一致させる"
    );
    json!({
        "app_title":"AI startup test", "sqlite_database_path":database,
        "database_url":database_url,
        "access_token_exp_minutes":"30", "refresh_token_exp_minutes":"1440",
        "secret_key":"test-only-session-key", "admin_username":"admin",
        "admin_passwotd":"test-only-password", "failed_account_lock":"5",
        "next_challenge_minutes":"5", "challenge_limit_time_failed_count":"3"
    })
}

fn write_settings(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn setup_form() -> SetupForm {
    SetupForm {
        app_title: "AI setup test".into(),
        admin_username: "admin".into(),
        admin_password: "test-only-password".into(),
        failed_account_lock: "5".into(),
        next_challenge_minutes: "5".into(),
        challenge_limit_time_failed_count: "3".into(),
        access_token_exp_minutes: "30".into(),
        refresh_token_exp_minutes: "1440".into(),
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

async fn open_pool(configuration: &ApplicationInitSetup, create: bool) -> SqlitePool {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&configuration.sqlite_database_path)
        .create_if_missing(create);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}

async fn save_credentials(configuration: &ApplicationInitSetup) {
    let pool = open_pool(configuration, true).await;
    run_migrations(&pool).await.unwrap();
    let admin = create_user_with_master_layer(&pool, "ai-startup-admin", "unused-test-hash", true)
        .await
        .unwrap()
        .id;
    let input: AiSettingsInput = serde_json::from_value(json!({
        "revision":null,"enabled":false,"model":"startup-test-model",
        "apiKey":LLM_SECRET,"speechApiKey":SPEECH_SECRET
    }))
    .unwrap();
    let view = settings::save(&pool, &admin, 0, &input).await.unwrap();
    assert_redacted(&serde_json::to_string(&view).unwrap(), configuration);
    let encrypted: (Vec<u8>, Vec<u8>) = sqlx::query_as(
        r#"
        SELECT encrypted_api_key, encrypted_speech_api_key
        FROM ai_settings
        WHERE id = 1
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !encrypted
            .0
            .windows(LLM_SECRET.len())
            .any(|part| part == LLM_SECRET.as_bytes())
    );
    assert!(
        !encrypted
            .1
            .windows(SPEECH_SECRET.len())
            .any(|part| part == SPEECH_SECRET.as_bytes())
    );
    assert_loaded_credentials_and_responses(&pool, configuration).await;
    pool.close().await;
}

async fn assert_loaded_credentials_and_responses(
    pool: &SqlitePool,
    configuration: &ApplicationInitSetup,
) {
    let loaded = settings::load(pool).await.unwrap();
    assert!(loaded.api_key.as_ref().unwrap().as_bytes() == LLM_SECRET.as_bytes());
    assert!(loaded.speech_api_key.as_ref().unwrap().as_bytes() == SPEECH_SECRET.as_bytes());
    assert!(loaded.api_key.as_ref().unwrap().is_sensitive());
    assert!(loaded.speech_api_key.as_ref().unwrap().is_sensitive());
    let admin: String =
        sqlx::query_scalar("SELECT id FROM user_model WHERE username = 'ai-startup-admin'")
            .fetch_one(pool)
            .await
            .unwrap();
    let response = ai::admin_get(Extension(admin.clone()), Extension(pool.clone()))
        .await
        .unwrap()
        .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_redacted(std::str::from_utf8(&body).unwrap(), configuration);
    let view: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(view["hasApiKey"], true);
    assert_eq!(view["hasSpeechApiKey"], true);
    assert_eq!(view["keyStorageConfigured"], true);
    assert!(view.get("apiKey").is_none());
    assert!(view.get("speechApiKey").is_none());
    assert!(view.get("ai_encryption_key").is_none());
    let response = ai::capabilities(Extension(admin), Extension(pool.clone()))
        .await
        .unwrap()
        .into_response();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_redacted(std::str::from_utf8(&body).unwrap(), configuration);
}

fn assert_redacted(text: &str, configuration: &ApplicationInitSetup) {
    assert!(!text.contains(LLM_SECRET));
    assert!(!text.contains(SPEECH_SECRET));
    if let Some(key) = &configuration.ai_encryption_key {
        assert!(
            !text.contains(key.as_ref()),
            "JSON用の暗号鍵をレスポンスやDebugへ出さない"
        );
    }
    if let Ok(key) = std::env::var("AI_ENCRYPTION_KEY") {
        assert!(
            !text.contains(&key),
            "有効な暗号鍵をレスポンスやDebugへ出さない"
        );
    }
}
