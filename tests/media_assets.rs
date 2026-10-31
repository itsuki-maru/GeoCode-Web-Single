#[allow(dead_code)]
#[path = "support/uuid_fixtures.rs"]
mod common;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use geocode_web_single::{auth::create_token, config::CONFIG};
use image::{DynamicImage, ImageFormat};
use serde_json::Value;
use sqlx::SqlitePool;
use std::{io::Cursor, path::PathBuf};
use tower::ServiceExt;
use uuid::Uuid;
static FILE_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn app(pool: &SqlitePool) -> Router {
    geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    )
}
async fn send(
    app: &Router,
    user: Option<Uuid>,
    method: &str,
    path: &str,
    content_type: &str,
    body: Vec<u8>,
    range: Option<&str>,
) -> Response {
    let mut request = Request::builder().method(method).uri(path);
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
    if let Some(range) = range {
        request = request.header("range", range);
    }
    app.clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap()
}
async fn bytes(response: Response) -> Vec<u8> {
    to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec()
}
async fn json(response: Response) -> Value {
    serde_json::from_slice(&bytes(response).await).unwrap()
}
fn png(width: u32, height: u32) -> Vec<u8> {
    let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([150, 80, 30, 255]),
    ));
    let mut data = Cursor::new(Vec::new());
    image.write_to(&mut data, ImageFormat::Png).unwrap();
    data.into_inner()
}
fn multipart(kind: &str, name: &str, data: &[u8], poster: Option<&[u8]>) -> Vec<u8> {
    let mut body=format!("--media-test\r\nContent-Disposition: form-data; name=\"asset_kind\"\r\n\r\n{kind}\r\n--media-test\r\nContent-Disposition: form-data; name=\"ignored_field\"\r\n\r\nignored\r\n").into_bytes();
    if let Some(poster) = poster {
        body.extend_from_slice(b"--media-test\r\nContent-Disposition: form-data; name=\"poster_file\"; filename=\"poster.png\"\r\nContent-Type: image/png\r\n\r\n");
        body.extend_from_slice(poster);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--media-test\r\nContent-Disposition: form-data; name=\"upload_file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n--media-test--\r\n");
    body
}
async fn upload(
    app: &Router,
    user: Uuid,
    kind: &str,
    name: &str,
    data: &[u8],
    poster: Option<&[u8]>,
) -> Response {
    send(
        app,
        Some(user),
        "POST",
        "/images/upload",
        "multipart/form-data; boundary=media-test",
        multipart(kind, name, data, poster),
        None,
    )
    .await
}
fn disk(name: &str) -> PathBuf {
    PathBuf::from(&CONFIG.upload_file_path)
        .join(&name[..5])
        .join(name)
}
async fn get(app: &Router, user: Option<Uuid>, path: &str) -> Response {
    send(app, user, "GET", path, "", Vec::new(), None).await
}
async fn delete(app: &Router, user: Uuid, id: &str) -> Response {
    send(
        app,
        Some(user),
        "DELETE",
        &format!("/images/delete/{id}"),
        "",
        Vec::new(),
        None,
    )
    .await
}

#[tokio::test]
async fn image_upload_creates_a_thumbnail_and_enforces_read_and_delete_ownership() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "media-owner").await;
    let other = common::create_test_user(&pool, "media-other").await;
    let app = app(&pool);
    let response = upload(&app, owner, "image", "photo.png", &png(800, 400), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = json(response).await;
    let filename = saved["uuid_filename"].as_str().unwrap();
    let id = saved["new_image_id"].as_str().unwrap();
    assert_eq!(saved["filename"], "photo.png");
    assert_eq!(saved["user_id"], owner.to_string());
    let file = disk(filename);
    let thumb = file.parent().unwrap().join("thumb").join(filename);
    assert_eq!(image::open(&file).unwrap().width(), 800);
    let thumbnail = image::open(&thumb).unwrap();
    assert_eq!((thumbnail.width(), thumbnail.height()), (450, 225));
    let path = format!("/static/images/{filename}");
    sqlx::query(
        r#"
        UPDATE user_model
        SET
            is_private = false
        WHERE id = $1
        "#,
    )
    .bind(owner.to_string())
    .execute(&pool)
    .await
    .unwrap();
    for user in [Some(owner), Some(other), None] {
        let response = get(&app, user, &path).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert!(image::load_from_memory(&bytes(response).await).is_ok());
    }
    sqlx::query(
        r#"
        UPDATE user_model
        SET
            is_private = true
        WHERE id = $1
        "#,
    )
    .bind(owner.to_string())
    .execute(&pool)
    .await
    .unwrap();
    for user in [Some(other), None] {
        assert_eq!(get(&app, user, &path).await.status(), StatusCode::NOT_FOUND);
    }
    assert_eq!(get(&app, Some(owner), &path).await.status(), StatusCode::OK);
    let response = delete(&app, other, id).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(json(response).await["error"], "database error");
    assert!(file.is_file() && thumb.is_file());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM image_model
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let response = delete(&app, owner, id).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!file.exists() && !thumb.exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM image_model
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn video_poster_range_requests_and_file_cleanup_work_together() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "video-owner").await;
    let app = app(&pool);
    let video = b"\0\0\0\x18ftypisomfixture-video-data";
    let response = upload(
        &app,
        owner,
        "video",
        "clip.mp4",
        video,
        Some(&png(800, 400)),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = json(response).await;
    let filename = saved["uuid_filename"].as_str().unwrap();
    let id = saved["new_image_id"].as_str().unwrap();
    let file = disk(filename);
    let stem = file.file_stem().unwrap().to_str().unwrap();
    let poster = file
        .parent()
        .unwrap()
        .join("thumb")
        .join(format!("{stem}.jpg"));
    assert!(poster.is_file());
    let response = get(
        &app,
        Some(owner),
        &format!("/static/images/{filename}?thumb=true"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/jpeg");
    let decoded = image::load_from_memory(&bytes(response).await).unwrap();
    assert!(decoded.width() <= 450 && decoded.height() <= 450);
    let response = send(
        &app,
        Some(owner),
        "GET",
        &format!("/static/images/{filename}"),
        "",
        Vec::new(),
        Some("bytes=0-7"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-type"], "video/mp4");
    assert_eq!(response.headers()["accept-ranges"], "bytes");
    assert_eq!(
        response.headers()["content-range"],
        format!("bytes 0-7/{}", video.len())
    );
    assert_eq!(bytes(response).await, &video[..8]);
    let response = delete(&app, owner, id).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!file.exists() && !poster.exists());
}

#[tokio::test]
async fn image_search_escapes_wildcards_limits_blank_queries_and_never_leaks_other_owners() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "search-owner").await;
    let other = common::create_test_user(&pool, "search-other").await;
    let app = app(&pool);
    // UTC を明示したテストデータで、セッションのタイムゾーン変換と作成時刻の重複を避ける。
    let base = chrono::DateTime::parse_from_rfc3339("2025-01-01T00:00:00Z")
        .unwrap()
        .naive_utc();
    for index in 0..53u128 {
        let user = if index == 52 { other } else { owner };
        let id = Uuid::from_u128(index + 1000);
        let name = if index >= 51 {
            "literal%_back\\slash.png".to_string()
        } else {
            format!("item-{index}.png")
        };
        sqlx::query(
            r#"
            INSERT INTO image_model (
                id,
                user_id,
                filename,
                uuid_filename,
                create_at
            ) VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(id.to_string())
        .bind(user.to_string())
        .bind(name)
        .bind(format!("{id}.png"))
        .bind(base + chrono::Duration::seconds(index as i64))
        .execute(&pool)
        .await
        .unwrap();
    }
    let response = get(&app, Some(owner), "/images/eneble-images").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await.as_object().unwrap().len(), 52);
    for (query, count) in [
        ("query=%20&limit=0", 1),
        ("query=&limit=999", 50),
        ("query=", 50),
    ] {
        let response = get(
            &app,
            Some(owner),
            &format!("/images/eneble-images/search?{query}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let results = json(response).await;
        assert_eq!(results.as_object().unwrap().len(), count);
        assert!(results.get(Uuid::from_u128(1051).to_string()).is_some());
    }
    for query in ["%25", "%5F", "%5C", "%20LITERAL%20"] {
        for (user, id) in [(owner, 1051), (other, 1052)] {
            let response = get(
                &app,
                Some(user),
                &format!("/images/eneble-images/search?query={query}"),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let results = json(response).await;
            assert_eq!(results.as_object().unwrap().len(), 1, "{query}: {results}");
            assert!(results.get(Uuid::from_u128(id).to_string()).is_some());
        }
    }
    let response = get(
        &app,
        Some(owner),
        "/images/eneble-images/search?query=absent",
    )
    .await;
    assert!(json(response).await.as_object().unwrap().is_empty());
    assert_eq!(
        get(&app, None, "/images/eneble-images").await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn invalid_document_headers_extensions_and_oversized_posters_create_no_database_rows() {
    let pool = common::test_pool().await;
    let _serial = FILE_TESTS.lock().await;
    let owner = common::create_test_user(&pool, "invalid-media").await;
    let app = app(&pool);
    for (name, kind) in [
        ("fake.pdf", "pdf"),
        ("fake.mp4", "video"),
        ("payload.exe", "file"),
        ("no-extension", "file"),
    ] {
        assert_eq!(
            upload(&app, owner, kind, name, b"<script>invalid</script>", None)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        upload(
            &app,
            owner,
            "video",
            "valid.mp4",
            b"\0\0\0\x18ftypisomfixture",
            Some(&vec![0; 5 * 1024 * 1024 + 1])
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let response = send(
        &app,
        Some(owner),
        "POST",
        "/images/upload",
        "multipart/form-data; boundary=media-test",
        b"--media-test--\r\n".to_vec(),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM image_model
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
