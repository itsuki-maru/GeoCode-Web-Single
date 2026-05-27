use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode, header},
    response::IntoResponse,
};
use geocode_web_single::{
    build_tera_extension, build_tera_from_embed, custom_not_found_handler, get_app_init_handler,
    health_check_handler, index_handler, licenses_get_handler, root_handler, serve_favicon,
};
use std::sync::Once;

static TEST_ENV: Once = Once::new();

fn init_test_env() {
    TEST_ENV.call_once(|| unsafe {
        std::env::set_var("APP_TITLE", "GeoCode Test");
        std::env::set_var("CREATEDATABASE_PATH", ":memory:");
        std::env::set_var("DATABASE_URL", "sqlite::memory:");
        std::env::set_var("SECRET_KEY", "test-secret-key");
        std::env::set_var("IMAGE_FILES_PATH", "target\\lib-handler-tests");
        std::env::set_var("UPLOAD_FILE_PATH", "target\\lib-handler-tests");
        std::env::set_var("FAILED_ACCOUNT_LOCK", "5");
        std::env::set_var("NEXT_CHALLENGE_MINUTES", "5");
        std::env::set_var("CHALLENGE_LIMIT_TIME_FAILEDCOUNT", "3");
        std::env::set_var("ADMIN_USERNAME", "admin");
        std::env::set_var("ADMIN_PASSWORD", "password123");
        std::env::set_var("ACCESS_TOKEN_EXP_MINUTUES", "30");
        std::env::set_var("REFRESH_TOKEN_EXP_MINUTUES", "1440");
        std::env::set_var("CACHE_CONTROL", "no-cache");
        std::env::set_var("SECURE_COOKIE", "false");
        std::env::set_var("SERVICE_NAME", "GeoCode Test");
        std::env::set_var("ALLOW_USER_CREATE_ACCOUNT", "true");
        std::env::set_var("ALLOW_USER_UPDATE_PASSWORD", "true");
        std::env::set_var("ALLOW_ORIGINS", "http://localhost:3000");
        std::env::set_var("TILE_SERVER_BASE_URL", "http://localhost");
        std::env::set_var("TILE_SERVER_API_KEY", "test-api-key");
    });
}

// ルートとfallbackが /index への恒久リダイレクトを返すことを確認する。
#[tokio::test]
async fn redirect_handlers_point_to_index() {
    let root_response = root_handler().await.into_response();
    assert_eq!(root_response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        root_response.headers().get(header::LOCATION).unwrap(),
        "/index"
    );

    let fallback_response = custom_not_found_handler(
        Request::builder()
            .uri("/missing")
            .body(Body::empty())
            .expect("request should build"),
    )
    .await
    .into_response();
    assert_eq!(fallback_response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        fallback_response.headers().get(header::LOCATION).unwrap(),
        "/index"
    );
}

// ヘルスチェックが固定メッセージのJSONを返すことを確認する。
#[tokio::test]
async fn health_check_returns_expected_message() {
    let response = health_check_handler().await;
    assert_eq!(response.message, "Hello, I'm administrator.");
}

// 初期設定APIが環境変数由来のCONFIG値を返すことを確認する。
#[tokio::test]
async fn app_init_returns_config_values() {
    init_test_env();

    let response = get_app_init_handler(
        Request::builder()
            .uri("/app-init")
            .body(Body::empty())
            .expect("request should build"),
    )
    .await;

    assert_eq!(response.app_title, "GeoCode Test");
    assert!(response.allow_user_account_create);
    assert!(response.allow_user_update_password);
    assert_eq!(response.allow_origins, "http://localhost:3000");
}

// User-Agentに応じて通常版/モバイル版の埋め込みindex HTMLを返すことを確認する。
#[tokio::test]
async fn index_handler_serves_desktop_and_mobile_html() {
    let desktop_html = index_handler(HeaderMap::new())
        .await
        .expect("desktop index should be embedded");
    assert!(!desktop_html.0.is_empty());

    let mut mobile_headers = HeaderMap::new();
    mobile_headers.insert(
        header::USER_AGENT,
        "Mozilla/5.0 Mobile"
            .parse()
            .expect("user-agent should parse"),
    );
    let mobile_html = index_handler(mobile_headers)
        .await
        .expect("mobile index should be embedded");
    assert!(!mobile_html.0.is_empty());
}

// ライセンスHTMLが埋め込みアセットから返ることを確認する。
#[tokio::test]
async fn licenses_handler_serves_embedded_html() {
    let html = licenses_get_handler()
        .await
        .expect("licenses html should be embedded");
    assert!(!html.0.is_empty());
}

// faviconが埋め込みアセットから image/x-icon として返ることを確認する。
#[tokio::test]
async fn favicon_handler_serves_icon_asset() {
    let response = serve_favicon().await.expect("favicon should be embedded");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/x-icon"
    );

    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("favicon body should be readable");
    assert!(!body.is_empty());
}

// Teraが埋め込みテンプレートを読み込めることを確認する。
#[test]
fn build_tera_from_embed_registers_templates() {
    let tera = build_tera_from_embed().expect("embedded templates should build");
    let template_names = tera.get_template_names().collect::<Vec<_>>();

    assert!(template_names.contains(&"map.html"));
    assert!(template_names.contains(&"notfound.html"));
    assert!(template_names.contains(&"image-preview.html"));
}

// Tera拡張用のArc<Mutex<Tera>>を構築し、テンプレートへアクセスできることを確認する。
#[tokio::test]
async fn build_tera_extension_wraps_embedded_templates() {
    let tera = build_tera_extension().expect("tera extension should build");
    let tera = tera.lock().await;
    let template_names = tera.get_template_names().collect::<Vec<_>>();

    assert!(template_names.contains(&"map.html"));
    assert!(template_names.contains(&"temporary-map.html"));
}
