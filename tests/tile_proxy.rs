#[allow(dead_code)]
mod common;
#[path = "support/tile_cache.rs"]
mod tile_cache;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Extension, Path, State},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

type Calls = Arc<Mutex<Vec<(String, String)>>>;
async fn upstream(
    State(calls): State<Calls>,
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
        _ => (StatusCode::OK, b"\x89PNG\r\n\x1a\nfixture".to_vec()).into_response(),
    }
}
async fn tile(app: &Router, path: &str) -> Response {
    app.clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
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
    let address = listener.local_addr().unwrap();
    let calls: Calls = Default::default();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/{z}/{x}/{y}", get(upstream))
                .with_state(calls.clone()),
        )
        .into_future(),
    );
    // CONFIG はプロセスごとに不変とする。この実行ファイルは一つのテストだけを持ち、このローカルのテストデータだけを使う。
    unsafe {
        // このハンドラーはデータベースに接続しないが、CONFIG ではこの値が必須となる。
        // DB の環境設定がなくても、このテストを単独で実行できるようにする。
        std::env::set_var("DATABASE_URL", "sqlite::memory:");
        std::env::set_var("TILE_SERVER_BASE_URL", format!("http://{address}/"));
        std::env::set_var("TILE_SERVER_API_KEY", "fixture-key");
        std::env::set_var("TILE_CACHE_NAMESPACE", "proxy-test");
        std::env::set_var("TILE_CACHE_TTL_SECONDS", "123");
    }
    let app = Router::new()
        .route(
            "/tile/{z}/{x}/{y_png}",
            get(geocode_web_single::handler::tiles::proxy_tile_handler),
        )
        .layer(Extension(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .no_proxy()
                .build()
                .unwrap(),
        ))
        .layer(Extension(None::<redis::aio::ConnectionManager>));
    for path in ["/tile/0/0/0.png", "/tile/19/524287/524287.png"] {
        let response = tile(&app, path).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=604800, immutable"
        );
        assert_eq!(response.headers()["x-tile-cache"], "MISS");
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            b"\x89PNG\r\n\x1a\nfixture"
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
    verify_cache_behaviour(&calls).await;
    server.abort();
    let _ = server.await;
    assert_eq!(
        tile(&app, "/tile/3/0/5.png").await.status(),
        StatusCode::BAD_GATEWAY
    );
}

async fn verify_cache_behaviour(upstream_calls: &Calls) {
    let cache = tile_cache::CacheFixture::start().await;
    let app = Router::new()
        .route(
            "/tile/{z}/{x}/{y_png}",
            get(geocode_web_single::handler::tiles::proxy_tile_handler),
        )
        .layer(Extension(
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        ))
        .layer(Extension(Some(cache.connection.clone())));
    let before = upstream_calls.lock().unwrap().len();
    let cached_bytes = b"\x89PNG\0\xffcached".to_vec();
    cache
        .state
        .lock()
        .unwrap()
        .values
        .insert(b"tile:proxy-test:3:1:0".to_vec(), cached_bytes.clone());
    let hit = tile(&app, "/tile/3/1/0.png").await;
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
        assert_eq!(
            state.values.get(b"tile:proxy-test:3:2:0".as_slice()),
            Some(&bytes)
        );
        assert!(state.calls.contains(&vec![
            b"SETEX".to_vec(),
            b"tile:proxy-test:3:2:0".to_vec(),
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
            .contains_key(b"tile:proxy-test:3:4:0".as_slice())
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
