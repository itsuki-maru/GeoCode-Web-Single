use super::apply_env_vars;
use geocode_web_single::{handler::live_camera, init::read_env_json};
use serde_json::json;

#[test]
fn json_is_only_camera_configuration_source() {
    const CHILD: &str = "GEOCODE_CAMERA_SETTINGS_TEST_CASE";
    let keys = [
        "camera_sharing_enabled",
        "camera_turn_provider",
        "camera_stun_urls",
        "camera_turn_urls",
        "camera_turn_secret",
        "camera_relay_only",
        "camera_cloudflare_turn_key_id",
        "camera_cloudflare_turn_api_token",
    ];
    let Ok(case) = std::env::var(CHILD) else {
        // 環境変数を変更する検証は専用プロセスに隔離し、他のテストへ影響させない。
        for case in ["missing", "null", "false", "p2p", "cloudflare"] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "camera_settings_tests::json_is_only_camera_configuration_source",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(CHILD, case);
            for key in keys {
                command.env(
                    key.to_ascii_uppercase(),
                    if key == "camera_sharing_enabled" {
                        "true"
                    } else {
                        "external-value-must-not-survive"
                    },
                );
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "case={case}\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };

    let directory = std::env::current_dir()
        .unwrap()
        .join("target")
        .join(format!("camera-settings-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("geocode-web-single.env.json");
    let mut value = json!({
        "app_title": "Camera settings test", "access_token_exp_minutes": "30",
        "refresh_token_exp_minutes": "1440", "secret_key": "test-only-secret",
        "admin_username": "admin", "admin_passwotd": "test-only-password",
        "failed_account_lock": "5", "next_challenge_minutes": "5",
        "challenge_limit_time_failed_count": "3"
    });
    if case != "missing" {
        for key in keys {
            value[key] = serde_json::Value::Null;
        }
    }
    if case == "false" {
        value["camera_sharing_enabled"] = json!("false");
    }
    let enabled = matches!(case.as_str(), "p2p" | "cloudflare");
    if enabled {
        value["camera_sharing_enabled"] = json!("true");
        value["camera_turn_provider"] = json!(if case == "p2p" { "none" } else { "cloudflare" });
        value["camera_relay_only"] = json!("false");
    }
    if case == "cloudflare" {
        value["camera_stun_urls"] = json!("stun:stun.example.com:3478");
        value["camera_cloudflare_turn_key_id"] = json!("a".repeat(32));
        value["camera_cloudflare_turn_api_token"] = json!("json-test-token");
    }
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let settings = read_env_json(&directory).unwrap();
    // 専用プロセスの単独テスト内、非同期ランタイムなどの開始前に適用する。
    unsafe {
        apply_env_vars(&settings, "127.0.0.1:3000");
    }
    for key in keys {
        assert_eq!(
            std::env::var(key.to_ascii_uppercase()).ok().as_deref(),
            value[key].as_str(),
            "{key}"
        );
    }
    let reloaded = serde_json::to_value(read_env_json(&directory).unwrap()).unwrap();
    for key in keys {
        assert_eq!(reloaded[key], value[key], "{key}");
    }
    // Web画面の利用可否判定とAPIが同じ設定で有効・無効になることを確認する。
    let config = live_camera::CameraConfig::from_env();
    assert_eq!(config.available(), enabled);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let response = live_camera::capabilities(axum::extract::Extension(config)).await;
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["enabled"], enabled);
    });
    std::fs::remove_file(path).unwrap();
    let backup = directory.join("geocode-web-single.env.json.bak");
    if backup.exists() {
        std::fs::remove_file(backup).unwrap();
    }
    std::fs::remove_dir(directory).unwrap();
}
