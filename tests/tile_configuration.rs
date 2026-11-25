#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::Body,
    extract::Extension,
    http::{Request, StatusCode, header},
    routing::get,
};
use geocode_web_single::{handler::tiles::proxy_tile_handler, tile_settings::TileSettings};
use std::sync::Arc;
use tower::ServiceExt;

/// 旧環境変数が設定されていても、DB未登録の中継はソケット接続なしで404を返す。
#[tokio::test]
async fn unconfigured_proxy_ignores_the_old_environment_variables() {
    common::init_test_env();
    // この統合テストプロセスは1件だけを実行し、CONFIGを初期化する前に設定する。
    unsafe {
        std::env::set_var("TILE_SERVER_BASE_URL", "http://127.0.0.1:9/tiles");
        std::env::set_var("TILE_SERVER_API_KEY", "legacy-fixture-key");
    }
    let app = Router::new()
        .route("/tile/{z}/{x}/{y_png}", get(proxy_tile_handler))
        .layer(Extension(Arc::new(TileSettings::from_env())))
        .layer(Extension(None::<redis::aio::ConnectionManager>));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/tile/0/0/0.png")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
}
