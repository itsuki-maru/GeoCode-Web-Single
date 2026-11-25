#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use geocode_web_single::{auth::create_token, build_tera_extension, router::build_router};
use serde_json::{Value, json};
use tower::ServiceExt;

const SETTINGS: &str = "/admin/osrm-settings";
const CHECK: &str = "/admin/osrm-settings/check";
const COMPUTE: &str = "/osrm/routes/compute";

async fn request(
    router: &Router,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Response {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header(header::COOKIE, format!("access_token={token}"));
    }
    let body = match body {
        Some(body) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        },
        None => Body::empty(),
    };
    router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

// 実ルーターを使い、匿名と一般アカウントの設定操作を拒否する。
#[tokio::test]
async fn osrm_settings_api_requires_administrator_access() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "osrm-settings-admin").await;
    let user = common::create_test_user(&pool, "osrm-settings-user").await;
    let admin_token = create_token(&admin, 60, "access_token", 0).unwrap();
    let user_token = create_token(&user, 60, "access_token", 0).unwrap();
    let router = build_router(pool, build_tera_extension().unwrap(), None);

    let attempts = [
        (Method::GET, SETTINGS, None),
        (
            Method::PUT,
            SETTINGS,
            Some(json!({"revision": null, "drive": {"baseUrl": null}})),
        ),
        (
            Method::POST,
            CHECK,
            Some(json!({
                "revision": null,
                "travelMode": "DRIVE",
                "baseUrl": "https://routing.example/car",
                "origin": {"lat": 35.68, "lng": 139.76},
                "destination": {"lat": 35.70, "lng": 139.77},
            })),
        ),
    ];

    for (method, path, body) in attempts {
        let anonymous = request(&router, method.clone(), path, None, body.clone()).await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        let regular_user = request(&router, method, path, Some(&user_token), body).await;
        assert_eq!(regular_user.status(), StatusCode::FORBIDDEN);
    }

    let response = request(&router, Method::GET, SETTINGS, Some(&admin_token), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let settings: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(settings["revision"], Value::Null);
    for mode in ["drive", "walk"] {
        assert_eq!(settings[mode]["baseUrl"], Value::Null);
        assert_eq!(settings[mode]["hasApiKey"], false);
        assert_eq!(settings[mode]["keyUsable"], false);
    }

    let invalid_key = 8675309;
    let response = request(
        &router,
        Method::PUT,
        SETTINGS,
        Some(&admin_token),
        Some(json!({"revision": null, "drive": {"baseUrl": "https://routing.example/car", "key": {"action": "set", "apiKey": invalid_key}}})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert!(!String::from_utf8_lossy(&body).contains(&invalid_key.to_string()));

    let response = request(
        &router,
        Method::PUT,
        SETTINGS,
        Some(&admin_token),
        Some(json!({"revision": null, "drive": {"baseUrl": "https://routing.example:443/car/"}})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let saved: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(saved["drive"]["baseUrl"], "https://routing.example/car");
    assert_eq!(saved["drive"]["hasApiKey"], false);
    assert_eq!(saved["walk"]["baseUrl"], Value::Null);
}

// 匿名要求を拒否し、OSRM未設定時はログイン済みでも上流へ転送しない。
#[tokio::test]
async fn osrm_compute_api_checks_session_and_returns_no_store_when_disabled() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "osrm-compute-user").await;
    let token = create_token(&user, 60, "access_token", 0).unwrap();
    sqlx::query(
        r#"
        INSERT INTO tileserver_model (id, layer_name, label, url, attribution, create_at, updated_at)
        VALUES (1, 'osm', 'OSM', '/tile/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let router = build_router(pool, build_tera_extension().unwrap(), None);
    let payload = json!({
        "backgroundId": 1,
        "origin": {"lat": 35.68, "lng": 139.76},
        "destination": {"lat": 35.70, "lng": 139.77},
        "travelMode": "DRIVE"
    });
    for (session, status) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some(token.as_str()), StatusCode::FORBIDDEN),
    ] {
        let response = request(
            &router,
            Method::POST,
            COMPUTE,
            session,
            Some(payload.clone()),
        )
        .await;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
}
