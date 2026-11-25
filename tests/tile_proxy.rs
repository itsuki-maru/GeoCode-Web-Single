#[allow(dead_code)]
mod common;
#[path = "support/tile_cache.rs"]
mod tile_cache;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Extension, Path, State},
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use geocode_web_single::{
    auth::create_token, build_tera_extension, handler::tiles::proxy_tile_handler,
    router::build_router_with_tile_settings, tile_settings::TileSettings,
};
use image::{ImageFormat, Rgba, RgbaImage};
use serde_json::json;
use std::{
    io::Cursor,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;

type Calls = Arc<Mutex<Vec<(String, String)>>>;
async fn upstream(
    State((calls, png)): State<(Calls, Vec<u8>)>,
    Path((z, x, y)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    calls.lock().unwrap().push((
        format!("/{z}/{x}/{y}"),
        headers
            .get("x-api-key")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string(),
    ));
    match y.as_str() {
        "1.png" => StatusCode::NOT_FOUND.into_response(),
        "2.png" => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        "3.png" => std::future::pending::<Response>().await,
        "4.png" => {
            let chunks =
                futures_util::stream::once(async { Ok::<_, std::io::Error>(b"partial".to_vec()) })
                    .chain(futures_util::stream::once(async {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Err::<Vec<u8>, _>(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "truncated fixture",
                        ))
                    }));
            Response::new(Body::from_stream(chunks))
        },
        _ => (StatusCode::OK, png).into_response(),
    }
}
async fn tile(app: &Router, path: &str) -> Response {
    app.clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

fn proxy_app(settings: Arc<TileSettings>, cache: Option<redis::aio::ConnectionManager>) -> Router {
    Router::new()
        .route("/tile/{z}/{x}/{y_png}", get(proxy_tile_handler))
        .layer(Extension(settings))
        .layer(Extension(cache))
}

#[test]
fn proxy_runs_without_database_environment() {
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "proxy_validates_paths_forwards_api_key_and_handles_upstream_failures",
            "--nocapture",
        ])
        .env_remove("DATABASE_URL")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[tokio::test]
async fn proxy_validates_paths_forwards_api_key_and_handles_upstream_failures() {
    common::init_test_env();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    // CONFIGと上流許可設定の初期化前に、模擬サーバーのオリジンを指定する。
    unsafe {
        std::env::set_var("TILE_PROXY_ALLOWED_ORIGINS", &origin);
        std::env::set_var("TILE_SETTINGS_ENCRYPTION_KEY", STANDARD.encode([7; 32]));
        std::env::set_var("TILE_CACHE_NAMESPACE", "proxy-test");
        std::env::set_var("TILE_CACHE_TTL_SECONDS", "123");
    }
    let calls: Calls = Default::default();
    let mut png = Cursor::new(Vec::new());
    RgbaImage::from_pixel(1, 1, Rgba([255, 0, 0, 255]))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/{z}/{x}/{y}", get(upstream))
                .with_state((calls.clone(), png.clone())),
        )
        .into_future(),
    );
    let pool = common::test_pool().await;
    let settings = Arc::new(TileSettings::from_env());
    let admin = common::create_test_admin(&pool, "tile-proxy-admin").await;
    let token = create_token(&admin, 60, "access_token", 0).unwrap();
    let configure = json!({
        "revision": null, "mode": "managed", "baseUrl": format!("{origin}/"),
        "apiKey": "fixture-key", "tile": {"z": 0, "x": 0, "y": 0}
    });
    let response = build_router_with_tile_settings(
        pool.clone(),
        build_tera_extension().unwrap(),
        None,
        settings.clone(),
    )
    .oneshot(
        Request::put("/admin/tile-server-settings/proxy")
            .header(header::COOKIE, format!("access_token={token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(configure.to_string()))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // 管理APIで設定を保存した後は、配信がメモリー上のスナップショットだけで動作する。
    pool.close().await;
    calls.lock().unwrap().clear();
    let revision = settings.snapshot().proxy_revision.unwrap();
    let app = proxy_app(settings.clone(), None);
    for path in ["/tile/0/0/0.png", "/tile/19/524287/524287.png"] {
        let response = tile(&app, &format!("{path}?v={revision}")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=604800, immutable"
        );
        assert_eq!(response.headers()["x-tile-cache"], "MISS");
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            png.as_slice()
        );
    }
    let count = calls.lock().unwrap().len();
    for path in [
        "/tile/20/0/0.png",
        "/tile/3/8/0.png",
        "/tile/3/0/8.png",
        "/tile/0/1/0.png",
        "/tile/-1/0/0.png",
        "/tile/a/0/0.png",
        "/tile/3/0/no.png",
        "/tile/3/0/0.jpg",
        "/tile/3/0/0.PNG",
        "/tile/3/0/-1.png",
    ] {
        assert_eq!(
            tile(&app, path).await.status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    assert_eq!(
        calls.lock().unwrap().len(),
        count,
        "invalid coordinates must not reach upstream"
    );
    for (y, status) in [
        (1, StatusCode::NOT_FOUND),
        (2, StatusCode::BAD_GATEWAY),
        (3, StatusCode::BAD_GATEWAY),
        (4, StatusCode::BAD_GATEWAY),
    ] {
        assert_eq!(
            tile(&app, &format!("/tile/3/0/{y}.png")).await.status(),
            status
        );
    }
    assert!(
        calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, key)| key == "fixture-key")
    );
    assert_eq!(calls.lock().unwrap()[0].0, "/0/0/0.png");
    assert_eq!(calls.lock().unwrap()[1].0, "/19/524287/524287.png");
    verify_cache_behaviour(settings, revision, &calls).await;
    server.abort();
    let _ = server.await;
    assert_eq!(
        tile(&app, "/tile/3/0/5.png").await.status(),
        StatusCode::BAD_GATEWAY
    );
}

async fn verify_cache_behaviour(
    settings: Arc<TileSettings>,
    revision: Uuid,
    upstream_calls: &Calls,
) {
    let cache = tile_cache::CacheFixture::start().await;
    let app = proxy_app(settings, Some(cache.connection.clone()));
    let cache_key = |x| format!("tile:proxy-test:revision:{revision}:3:{x}:0").into_bytes();
    let before = upstream_calls.lock().unwrap().len();
    let cached_bytes = b"\x89PNG\0\xffcached".to_vec();
    cache
        .state
        .lock()
        .unwrap()
        .values
        .insert(cache_key(1), cached_bytes.clone());
    let hit = tile(&app, &format!("/tile/3/1/0.png?v={revision}")).await;
    assert_eq!(hit.status(), StatusCode::OK);
    assert_eq!(hit.headers()["x-tile-cache"], "HIT");
    assert_eq!(hit.headers()["content-type"], "image/png");
    assert_eq!(
        hit.headers()["cache-control"],
        "public, max-age=604800, immutable"
    );
    assert_eq!(
        to_bytes(hit.into_body(), 1024).await.unwrap().as_ref(),
        cached_bytes
    );
    assert_eq!(
        upstream_calls.lock().unwrap().len(),
        before,
        "a cache hit must not reach upstream"
    );

    let miss = tile(&app, "/tile/3/2/0.png").await;
    assert_eq!(miss.status(), StatusCode::OK);
    assert_eq!(miss.headers()["x-tile-cache"], "MISS");
    let bytes = to_bytes(miss.into_body(), 1024).await.unwrap().to_vec();
    {
        let state = cache.state.lock().unwrap();
        assert_eq!(state.values.get(&cache_key(2)), Some(&bytes));
        assert!(state.calls.contains(&vec![
            b"SETEX".to_vec(),
            cache_key(2),
            b"123".to_vec(),
            bytes.clone()
        ]));
    }
    assert_eq!(
        tile(&app, "/tile/3/2/0.png").await.headers()["x-tile-cache"],
        "HIT"
    );
    assert_eq!(upstream_calls.lock().unwrap().len(), before + 1);

    cache.state.lock().unwrap().fail_get = true;
    let fallback = tile(&app, "/tile/3/3/0.png").await;
    assert_eq!(fallback.status(), StatusCode::OK);
    assert_eq!(fallback.headers()["x-tile-cache"], "MISS");
    assert_eq!(
        to_bytes(fallback.into_body(), 1024).await.unwrap().as_ref(),
        bytes
    );
    cache.state.lock().unwrap().fail_get = false;
    cache.state.lock().unwrap().fail_set = true;
    let write_failure = tile(&app, "/tile/3/4/0.png").await;
    assert_eq!(
        write_failure.status(),
        StatusCode::OK,
        "cache failure must not fail the upstream response"
    );
    assert_eq!(write_failure.headers()["x-tile-cache"], "MISS");
    assert_eq!(
        to_bytes(write_failure.into_body(), 1024)
            .await
            .unwrap()
            .as_ref(),
        bytes
    );
    assert!(
        !cache
            .state
            .lock()
            .unwrap()
            .values
            .contains_key(&cache_key(4))
    );

    cache.state.lock().unwrap().calls.clear();
    assert_eq!(
        tile(&app, "/tile/3/4/1.png").await.status(),
        StatusCode::NOT_FOUND
    );
    assert!(
        cache
            .state
            .lock()
            .unwrap()
            .calls
            .iter()
            .all(|args| args[0] != b"SETEX"),
        "upstream errors must not be cached"
    );
    cache.state.lock().unwrap().calls.clear();
    assert_eq!(
        tile(&app, "/tile/20/0/0.png").await.status(),
        StatusCode::NOT_FOUND
    );
    assert!(
        cache.state.lock().unwrap().calls.is_empty(),
        "invalid coordinates must not access Redis"
    );
}
