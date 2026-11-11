#[allow(dead_code)]
mod common;
#[path = "support/tile_cache.rs"]
mod tile_cache;

use std::io::Cursor;

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, State},
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use geocode_web_single::{auth::create_token, build_tera_extension, router::build_router};
use image::{ImageFormat, Rgba, RgbaImage};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const SETTINGS: &str = "/admin/tile-server-settings";
const PROXY: &str = "/admin/tile-server-settings/proxy";
const CHECK: &str = "/admin/tile-server-settings/proxy/check";
const ORIGINS: &str = "/admin/tile-server-settings/vector-origins";
const TILE: &str = "/tile/0/0/0.png";
const REVISION_SCRIPT: &str = "/tile-proxy-revision.js";
const ENV_ORIGIN: &str = "https://env-vector.example.test";
const MANAGED_ORIGIN: &str = "https://managed-vector.example.test";
const KEY_A: &str = "local-fixture-key-a";
const KEY_B: &str = "local-fixture-key-b";
const IMMUTABLE: &str = "public, max-age=604800, immutable";

fn png(color: [u8; 4]) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    RgbaImage::from_pixel(1, 1, Rgba(color))
        .write_to(&mut output, ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

async fn upstream(
    Path(provider): Path<String>,
    State((a, b)): State<(Vec<u8>, Vec<u8>)>,
    headers: HeaderMap,
) -> Response {
    let (expected_key, bytes) = match provider.as_str() {
        "a" => (KEY_A, a),
        "b" => (KEY_B, b),
        "broken" => (KEY_B, b"not a PNG".to_vec()),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    if headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        != Some(expected_key)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    payload: Option<&Value>,
) -> Response {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::COOKIE, format!("access_token={token}"));
    }
    let body = match payload {
        Some(payload) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(payload.to_string())
        },
        None => Body::empty(),
    };
    app.clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap()
}

async fn response_text(response: Response) -> String {
    let body = to_bytes(response.into_body(), 8192).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    for secret in [KEY_A, KEY_B] {
        assert!(
            !text.contains(secret),
            "応答に検証用APIキーが含まれています。"
        );
    }
    text
}

async fn response_json(response: Response) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    serde_json::from_str(&response_text(response).await).unwrap()
}

async fn proxy_revision(app: &Router) -> Option<Uuid> {
    let response = request(app, "GET", REVISION_SCRIPT, None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let text = response_text(response).await;
    let revision = text
        .trim()
        .strip_prefix("window.__GEOCODE_TILE_PROXY_REVISION__ = ")
        .unwrap()
        .strip_suffix(';')
        .unwrap();
    serde_json::from_str(revision).unwrap()
}

async fn assert_tile(app: &Router, url: &str, bytes: &[u8], hit: &str, cache_control: &str) {
    let response = request(app, "GET", url, None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(response.headers()[header::CACHE_CONTROL], cache_control);
    assert_eq!(response.headers()["x-tile-cache"], hit);
    assert_eq!(to_bytes(response.into_body(), 8192).await.unwrap(), bytes);
}

async fn csp(app: &Router) -> String {
    request(app, "GET", REVISION_SCRIPT, None, None)
        .await
        .headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .to_owned()
}

/// 管理者認可・接続確認・設定保存・キャッシュの切替と切り戻しを確認する。
#[tokio::test]
async fn admin_changes_the_live_proxy_and_vector_policy_with_rollback() {
    let pool = common::test_pool().await;
    common::init_test_env();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let base_a = format!("{origin}/a");
    let base_b = format!("{origin}/b");
    // この実行ファイルに含まれるテストはこの1件。アプリ設定の初期化や
    // バックグラウンドサーバーの起動前に、検証用の環境変数を設定する。
    unsafe {
        std::env::set_var("TILE_SERVER_BASE_URL", &base_a);
        std::env::set_var("TILE_SERVER_API_KEY", KEY_A);
        std::env::set_var("TILE_PROXY_ALLOWED_ORIGINS", &origin);
        std::env::set_var("TILE_SETTINGS_ENCRYPTION_KEY", STANDARD.encode([7; 32]));
        std::env::set_var("TILE_CACHE_TTL_SECONDS", "123");
        std::env::set_var("TILE_CACHE_NAMESPACE", "tile-settings-test");
        std::env::set_var("VECTOR_TILE_ALLOWED_ORIGINS", ENV_ORIGIN);
    }
    let a = png([255, 0, 0, 255]);
    let b = png([0, 255, 0, 255]);
    let upstream = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/{provider}/0/0/0.png", get(upstream))
                .with_state((a.clone(), b.clone())),
        )
        .into_future(),
    );
    let cache = tile_cache::CacheFixture::start().await;
    let admin = common::create_test_admin(&pool, "tile-settings-admin").await;
    let user = common::create_test_user(&pool, "tile-settings-user").await;
    let token = create_token(&admin, 60, "access_token", 0).unwrap();
    let regular_token = create_token(&user, 60, "access_token", 0).unwrap();
    let app = build_router(
        pool,
        build_tera_extension().unwrap(),
        Some(cache.connection.clone()),
    );

    for (method, path) in [
        ("GET", SETTINGS),
        ("POST", CHECK),
        ("PUT", PROXY),
        ("PUT", ORIGINS),
    ] {
        assert_eq!(
            request(&app, method, path, None, None).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, method, path, Some(&regular_token), None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let initial = response_json(request(&app, "GET", SETTINGS, Some(&token), None).await).await;
    assert_eq!(initial["revision"], Value::Null);
    assert_eq!(
        initial["proxy"],
        json!({"source": "environment", "baseUrl": base_a, "hasApiKey": true})
    );
    assert_eq!(initial["keyStorageConfigured"], true);
    assert_eq!(proxy_revision(&app).await, None);
    assert_tile(&app, TILE, &a, "MISS", IMMUTABLE).await;

    let candidate = json!({
        "revision": null, "mode": "managed", "baseUrl": base_b,
        "apiKey": KEY_B, "tile": {"z": 0, "x": 0, "y": 0}
    });
    let checked =
        response_json(request(&app, "POST", CHECK, Some(&token), Some(&candidate)).await).await;
    assert_eq!(checked, json!({"ok": true}));
    let mut broken = candidate.clone();
    broken["baseUrl"] = json!(format!("{origin}/broken"));
    for (method, path) in [("POST", CHECK), ("PUT", PROXY)] {
        let failed = request(&app, method, path, Some(&token), Some(&broken)).await;
        assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);
        response_text(failed).await;
    }
    assert_eq!(proxy_revision(&app).await, None);
    assert_tile(&app, TILE, &a, "HIT", IMMUTABLE).await;

    let applied =
        response_json(request(&app, "PUT", PROXY, Some(&token), Some(&candidate)).await).await;
    assert_eq!(
        applied["proxy"],
        json!({"source": "managed", "baseUrl": base_b, "hasApiKey": true})
    );
    let reloaded = response_json(request(&app, "GET", SETTINGS, Some(&token), None).await).await;
    assert_eq!(reloaded["revision"], applied["revision"]);
    assert_eq!(reloaded["proxy"], applied["proxy"]);
    let revision_b = proxy_revision(&app).await.unwrap();
    let url_b = format!("{TILE}?v={revision_b}");
    assert_tile(&app, TILE, &b, "MISS", "no-store").await;
    assert_tile(&app, &url_b, &b, "HIT", IMMUTABLE).await;
    {
        let cache = cache.state.lock().unwrap();
        assert!(cache.values.values().any(|value| value == &a));
        assert!(cache.values.values().any(|value| value == &b));
    }

    let vector = json!({"revision": applied["revision"], "origins": [MANAGED_ORIGIN]});
    let policy =
        response_json(request(&app, "PUT", ORIGINS, Some(&token), Some(&vector)).await).await;
    assert_eq!(
        policy["vectorOrigins"],
        json!({"source": "managed", "origins": [MANAGED_ORIGIN]})
    );
    let header = csp(&app).await;
    assert!(header.contains(MANAGED_ORIGIN));
    assert!(!header.contains(ENV_ORIGIN));
    assert!(header.contains("worker-src 'self'"));
    assert_eq!(proxy_revision(&app).await, Some(revision_b));

    let stale = json!({"revision": applied["revision"], "mode": "environment"});
    assert_eq!(
        request(&app, "PUT", PROXY, Some(&token), Some(&stale))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let rollback = json!({"revision": policy["revision"], "mode": "environment"});
    let restored =
        response_json(request(&app, "PUT", PROXY, Some(&token), Some(&rollback)).await).await;
    assert_eq!(restored["proxy"], initial["proxy"]);
    let revision_a = proxy_revision(&app).await.unwrap();
    assert_ne!(revision_a, revision_b);
    assert_tile(&app, &url_b, &a, "MISS", "no-store").await;
    assert_tile(
        &app,
        &format!("{TILE}?v={revision_a}"),
        &a,
        "HIT",
        IMMUTABLE,
    )
    .await;

    let reset = json!({"revision": restored["revision"], "origins": null});
    let reset =
        response_json(request(&app, "PUT", ORIGINS, Some(&token), Some(&reset)).await).await;
    assert_eq!(reset["vectorOrigins"], initial["vectorOrigins"]);
    assert!(csp(&app).await.contains(ENV_ORIGIN));
    assert_eq!(proxy_revision(&app).await, Some(revision_a));
    upstream.abort();
}
