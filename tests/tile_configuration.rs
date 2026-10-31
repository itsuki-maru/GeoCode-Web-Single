#[allow(dead_code)]
mod common;

#[test]
fn missing_upstream_configuration_returns_not_found_in_fresh_processes() {
    const CASE: &str = "GEOCODE_TILE_CONFIGURATION_TEST_CASE";
    if let Ok(case) = std::env::var(CASE) {
        common::init_test_env();
        // データベースや上流サーバーは使わず、ケースごとに別プロセスで CONFIG を初期化し直す。
        unsafe {
            std::env::set_var("DATABASE_URL", "sqlite::memory:");
            std::env::remove_var(if case == "missing-url" {
                "TILE_SERVER_BASE_URL"
            } else {
                "TILE_SERVER_API_KEY"
            });
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use axum::{
                Router,
                body::Body,
                extract::Extension,
                http::{Request, StatusCode},
                routing::get,
            };
            use tower::ServiceExt;
            let app = Router::new()
                .route(
                    "/tile/{z}/{x}/{y_png}",
                    get(geocode_web_single::handler::tiles::proxy_tile_handler),
                )
                .layer(Extension(
                    reqwest::Client::builder()
                        .no_proxy()
                        .timeout(std::time::Duration::from_secs(1))
                        .build()
                        .unwrap(),
                ))
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
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{case}");
        });
        return;
    }
    for case in ["missing-url", "missing-key"] {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "missing_upstream_configuration_returns_not_found_in_fresh_processes",
                "--nocapture",
            ])
            .env(CASE, case)
            .env_remove("DATABASE_URL")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{case}: {}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
