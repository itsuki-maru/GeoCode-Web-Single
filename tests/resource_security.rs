#[allow(dead_code)]
#[path = "support/uuid_fixtures.rs"]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use geocode_web_single::{auth::create_token, config::CONFIG};
use image::{DynamicImage, ImageFormat};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::io::Cursor;
use tower::ServiceExt;
use uuid::Uuid;

// このテスト実行ファイル内では、ファイル削除の検証で CONFIG.images_path を共有する。
static FILE_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn app(pool: &SqlitePool) -> Router {
    geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    )
}

async fn request(
    app: &Router,
    user: Option<Uuid>,
    method: &str,
    uri: &str,
    content_type: &str,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(user) = user {
        request = request.header(
            "cookie",
            format!(
                "access_token={}",
                create_token(&user.to_string(), 30, "access_token", 0).unwrap()
            ),
        );
    }
    if !content_type.is_empty() {
        request = request.header("content-type", content_type);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
}

async fn json_request(
    app: &Router,
    user: Option<Uuid>,
    method: &str,
    uri: &str,
    value: Value,
) -> (StatusCode, Value) {
    let body = if value.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(&value).unwrap()
    };
    let (status, body) = request(app, user, method, uri, "application/json", body).await;
    (status, serde_json::from_slice(&body).unwrap())
}

fn png() -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        80,
        40,
        image::Rgba([200, 30, 10, 255]),
    ))
    .write_to(&mut bytes, ImageFormat::Png)
    .unwrap();
    bytes.into_inner()
}

async fn upload(
    app: &Router,
    user: Option<Uuid>,
    field: &str,
    filename: &str,
    bytes: &[u8],
) -> (StatusCode, Value) {
    let mut body = format!("--resource-test\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n--resource-test--\r\n");
    let (status, body) = request(
        app,
        user,
        "POST",
        "/marker-icons/upload",
        "multipart/form-data; boundary=resource-test",
        body,
    )
    .await;
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn icon_upload_listing_search_and_deletion_are_owner_scoped() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "icon-owner").await;
    let other = common::create_test_user(&pool, "icon-other").await;
    let app = app(&pool);
    let (status, icon) = upload(
        &app,
        Some(owner),
        "upload_file",
        "literal%_name.PNG",
        &png(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{icon}");
    assert_eq!(icon["user_id"], owner.to_string());
    assert_eq!(icon["filename"], "literal%_name.PNG");
    let id = icon["id"].as_str().unwrap();
    let filename = icon["uuid_filename"].as_str().unwrap();
    assert!(filename.ends_with(".png"));
    let file = std::path::Path::new(&CONFIG.images_path)
        .join("marker-icons")
        .join(filename);
    let stored = image::load_from_memory(&tokio::fs::read(&file).await.unwrap()).unwrap();
    assert_eq!((stored.width(), stored.height()), (30, 30));
    // 引き伸ばさず、透明な余白を加えて縦横比を保つ。
    assert_eq!(stored.to_rgba8().get_pixel(0, 0).0[3], 0);
    assert_eq!(stored.to_rgba8().get_pixel(15, 15).0, [200, 30, 10, 255]);
    let (status, ordinary) = upload(&app, Some(owner), "upload_file", "ordinary.png", &png()).await;
    assert_eq!(status, StatusCode::OK);
    let layer = common::master_layer_id(&pool, &owner).await;
    sqlx::query(
        r#"
        UPDATE layer_model
        SET
            marker_icon_id = $1
        WHERE id = $2
        "#,
    )
    .bind(id)
    .bind(layer.to_string())
    .execute(&pool)
    .await
    .unwrap();
    for (user, expected_count) in [(owner, 1), (other, 0)] {
        for path in [
            "/marker-icons",
            "/marker-icons/search?query=%25",
            "/marker-icons/search?query=%5F",
            "/marker-icons/search?query=%20LITERAL%20",
        ] {
            let (status, list) = json_request(&app, Some(user), "GET", path, Value::Null).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(
                list.as_array().unwrap().len(),
                if path == "/marker-icons" && user == owner {
                    2
                } else {
                    expected_count
                },
                "{path}: {list}"
            );
        }
    }
    // バックスラッシュそのものや存在しない部分文字列を、SQL のワイルドカードとして扱わない。
    for path in [
        "/marker-icons/search?query=%5C",
        "/marker-icons/search?query=missing",
    ] {
        let (_, list) = json_request(&app, Some(owner), "GET", path, Value::Null).await;
        assert!(list.as_array().unwrap().is_empty());
    }
    let path = format!("/marker-icons/{id}");
    let (status, _) = json_request(&app, Some(other), "DELETE", &path, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(file.is_file());
    let (status, bytes) = request(
        &app,
        Some(owner),
        "GET",
        &format!("/static/marker-icons/{filename}"),
        "",
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(image::load_from_memory(&bytes).is_ok());
    let (status, result) = json_request(&app, Some(owner), "DELETE", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["id"], id);
    assert!(!file.exists());
    assert!(
        sqlx::query_scalar::<_, Option<String>>(
            r#"
            SELECT
                marker_icon_id
            FROM layer_model
            WHERE id = $1
            "#
        )
        .bind(layer.to_string())
        .fetch_one(&pool)
        .await
        .unwrap()
        .is_none()
    );
    let (status, _) = json_request(&app, Some(owner), "DELETE", &path, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = json_request(
        &app,
        Some(owner),
        "DELETE",
        &format!("/marker-icons/{}", ordinary["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn icon_upload_rejects_unauthenticated_invalid_and_oversized_inputs() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "icon-validation").await;
    let app = app(&pool);
    for (method, path) in [
        ("GET", "/marker-icons"),
        ("GET", "/marker-icons/search?query=x"),
        (
            "DELETE",
            "/marker-icons/00000000-0000-0000-0000-000000000000",
        ),
    ] {
        let (status, _) = json_request(&app, None, method, path, Value::Null).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _) = upload(&app, None, "upload_file", "valid.png", &png()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    for (field, filename, bytes, expected) in [
        (
            "wrong",
            "valid.png".to_string(),
            png(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "upload_file",
            "".to_string(),
            png(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "upload_file",
            "a".repeat(101),
            png(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "upload_file",
            "payload.svg".to_string(),
            png(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "upload_file",
            "payload".to_string(),
            png(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "upload_file",
            "payload.png".to_string(),
            b"<script>not an image</script>".to_vec(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "upload_file",
            "empty.png".to_string(),
            Vec::new(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "upload_file",
            "large.png".to_string(),
            vec![0; 5 * 1024 * 1024 + 1],
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let (status, _) = upload(&app, Some(owner), field, &filename, &bytes).await;
        assert_eq!(status, expected, "{field}: {filename}");
    }
    let (status, _) = request(
        &app,
        Some(owner),
        "POST",
        "/marker-icons/upload",
        "multipart/form-data; boundary=resource-test",
        b"--resource-test--\r\n".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM marker_icon_model
            WHERE user_id = $1
            "#,
        )
        .bind(owner.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn failed_icon_insert_removes_its_file_and_missing_files_do_not_block_deletion() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "icon-cleanup").await;
    let app = app(&pool);
    sqlx::query(
        r#"
        CREATE TRIGGER reject_test_icon
        BEFORE INSERT ON marker_icon_model
        WHEN NEW.filename = 'reject.png'
        BEGIN
            SELECT RAISE(ABORT, 'fixture rejection');
        END
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let directory = std::path::Path::new(&CONFIG.images_path).join("marker-icons");
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let names = || {
        std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let before = names();
    let (status, result) = upload(&app, Some(owner), "upload_file", "reject.png", &png()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(result["error"], "database error");
    assert_eq!(
        names(),
        before,
        "failed insert must not leave an orphaned file"
    );
    let (status, icon) = upload(&app, Some(owner), "upload_file", "valid.png", &png()).await;
    assert_eq!(status, StatusCode::OK);
    let file = directory.join(icon["uuid_filename"].as_str().unwrap());
    tokio::fs::remove_file(&file).await.unwrap();
    let (status, _) = json_request(
        &app,
        Some(owner),
        "DELETE",
        &format!("/marker-icons/{}", icon["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn external_site_settings_require_login_and_are_normalized_and_isolated() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "site-owner").await;
    let other = common::create_test_user(&pool, "site-other").await;
    let app = app(&pool);
    for method in ["GET", "PUT"] {
        let (status, _) = json_request(
            &app,
            None,
            method,
            "/external-site-url",
            json!({"url":"https://example.test/"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, default) =
        json_request(&app, Some(owner), "GET", "/external-site-url", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(default["url"], "https://project.geocode-web.com");
    for (input, expected) in [
        (
            "  HTTPS://EXAMPLE.TEST/path?q=1  ",
            "https://example.test/path?q=1",
        ),
        ("http://second.test", "http://second.test/"),
    ] {
        let (status, result) = json_request(
            &app,
            Some(owner),
            "PUT",
            "/external-site-url",
            json!({"url":input}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["url"], expected);
        let (_, stored) =
            json_request(&app, Some(owner), "GET", "/external-site-url", Value::Null).await;
        assert_eq!(stored, result);
    }
    let (_, other_setting) =
        json_request(&app, Some(other), "GET", "/external-site-url", Value::Null).await;
    assert_eq!(other_setting, default);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM external_site_urls
            WHERE user_id = $1
            "#,
        )
        .bind(owner.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    sqlx::query(
        r#"
        UPDATE external_site_urls
        SET
            url = '   '
        WHERE user_id = $1
        "#,
    )
    .bind(owner.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let (_, blank) =
        json_request(&app, Some(owner), "GET", "/external-site-url", Value::Null).await;
    assert_eq!(blank, default);
}

#[tokio::test]
async fn invalid_external_urls_never_replace_a_saved_setting() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "site-validation").await;
    let app = app(&pool);
    let valid = json!({"url":"https://example.test/saved"});
    let (status, saved) = json_request(&app, Some(owner), "PUT", "/external-site-url", valid).await;
    assert_eq!(status, StatusCode::OK);
    for (input, reason) in [
        (" ".to_string(), "no input"),
        ("not a url".to_string(), "invalid url"),
        (
            "javascript:alert(1)".to_string(),
            "http or https scheme required",
        ),
        (
            "data:text/html,hello".to_string(),
            "http or https scheme required",
        ),
        (
            "ftp://example.test".to_string(),
            "http or https scheme required",
        ),
        (
            format!("https://example.test/{}", "x".repeat(2048)),
            "over length",
        ),
    ] {
        let (status, error) = json_request(
            &app,
            Some(owner),
            "PUT",
            "/external-site-url",
            json!({"url":input}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert!(error["error"].as_str().unwrap().contains(reason));
        let (_, actual) =
            json_request(&app, Some(owner), "GET", "/external-site-url", Value::Null).await;
        assert_eq!(actual, saved);
    }
}

#[tokio::test]
async fn icon_upload_accepts_exact_byte_and_unicode_filename_limits() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "icon-boundaries").await;
    let app = app(&pool);
    let mut bytes = png();
    bytes.resize(5 * 1024 * 1024, 0);
    let filename = format!("{}.PnG", "あ".repeat(96));
    assert_eq!(filename.chars().count(), 100);
    let (status, icon) = upload(&app, Some(owner), "upload_file", &filename, &bytes).await;
    assert_eq!(status, StatusCode::OK, "{icon}");
    assert_eq!(icon["filename"], filename);
    let (status, _) = json_request(
        &app,
        Some(owner),
        "DELETE",
        &format!("/marker-icons/{}", icon["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
