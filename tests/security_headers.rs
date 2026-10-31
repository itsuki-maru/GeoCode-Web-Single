#[allow(dead_code)]
mod common;

// CONFIG はプロセスごとに一度だけ初期化する。並列テスト中に環境を切り替えない。
#[test]
fn origin_checks_and_security_headers_follow_the_sqlite_configuration() {
    const CASE: &str = "GEOCODE_SECURITY_HEADERS_CASE";
    let Ok(case) = std::env::var(CASE) else {
        for case in ["http", "https"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "origin_checks_and_security_headers_follow_the_sqlite_configuration",
                    "--nocapture",
                ])
                .env(CASE, case)
                .env_remove("DATABASE_URL")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{case}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    common::init_test_env();
    unsafe {
        std::env::set_var(
            "SECURE_COOKIE",
            if case == "https" { "true" } else { "false" },
        );
        std::env::set_var(
            "ALLOW_ORIGINS",
            " http://localhost:5173 , https://trusted.example ",
        );
        std::env::set_var(
            "HTTP_IMAGE_ALLOWED_ORIGINS",
            "http://192.168.1.20,http://192.168.1.21:8080",
        );
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        use axum::{Router, body::Body, http::{Request, StatusCode}, middleware, routing::any};
        use tower::ServiceExt;
        let app = Router::new().route("/change", any(|| async { StatusCode::OK }))
            .layer(middleware::from_fn(geocode_web_single::middleware::security::security_headers_and_origin));
        for method in ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] {
            for (origin, host, expected) in [
                (None, None, StatusCode::OK),
                (Some("http://localhost:5173"), None, StatusCode::OK),
                (Some("https://trusted.example"), Some("local.test:3000"), StatusCode::OK),
                (Some("http://local.test:3000"), Some("local.test:3000"), StatusCode::OK),
                (Some("https://local.test:3000"), Some("local.test:3000"), StatusCode::OK),
                (Some("https://evil.example"), Some("local.test:3000"), StatusCode::FORBIDDEN),
                (Some("http://local.test:3000.evil.example"), Some("local.test:3000"), StatusCode::FORBIDDEN),
                (Some("null"), None, StatusCode::FORBIDDEN),
            ] {
                let mut request = Request::builder().method(method).uri("/change");
                if let Some(origin) = origin { request = request.header("origin", origin); }
                if let Some(host) = host { request = request.header("host", host); }
                let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
                let expected = if matches!(method, "GET" | "HEAD" | "OPTIONS") { StatusCode::OK } else { expected };
                assert_eq!(response.status(), expected, "{case}: {method} {origin:?} {host:?}");
                if expected != StatusCode::OK { continue; }
                let headers = response.headers();
                assert_eq!(headers["x-content-type-options"], "nosniff");
                assert_eq!(headers["referrer-policy"], "strict-origin-when-cross-origin");
                assert_eq!(headers["x-frame-options"], "SAMEORIGIN");
                assert_eq!(headers["permissions-policy"], "camera=(), microphone=(), geolocation=(self)");
                assert_eq!(headers.contains_key("strict-transport-security"), case == "https");
                if case == "https" { assert_eq!(headers["strict-transport-security"], "max-age=31536000; includeSubDomains"); }
                let csp = headers["content-security-policy"].to_str().unwrap();
                assert!(csp.contains("frame-ancestors 'self'"));
                assert!(csp.contains("img-src 'self' data: blob: https: http://192.168.1.20 http://192.168.1.21:8080;"));
            }
        }
    });
}
