#[allow(dead_code)]
mod common;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Extension, Path},
    http::{Request, StatusCode, header},
    routing::get,
};
use chrono::Utc;
use geocode_web_single::{
    build_tera_extension,
    config::CONFIG,
    handler::marker_forms::{
        get_marker_form_config_handler, public_marker_form_get_handler, submit_marker_form_handler,
        update_marker_form_config_handler,
    },
    model::{MarkerFormConfigUpdate, MarkerFormField, MarkerFormSchema},
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;

fn multipart_body(submission: &Value, image: Option<&[u8]>) -> (String, Vec<u8>) {
    const BOUNDARY: &str = "geocode-marker-form-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"submission\"\r\nContent-Type: application/json\r\n\r\n{}\r\n",
            serde_json::to_string(submission).expect("submission should serialize")
        )
        .as_bytes(),
    );
    if let Some(image) = image {
        body.extend_from_slice(
            format!(
                "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"image__photo\"; filename=\"field-photo.png\"\r\nContent-Type: image/png\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(image);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={BOUNDARY}"), body)
}

async fn post_form(
    app: &Router,
    public_id: &str,
    submission: Value,
    image: Option<&[u8]>,
) -> StatusCode {
    post_form_response(app, public_id, submission, image)
        .await
        .0
}

async fn post_form_response(
    app: &Router,
    public_id: &str,
    submission: Value,
    image: Option<&[u8]>,
) -> (StatusCode, Value) {
    let (content_type, body) = multipart_body(&submission, image);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/forms/{public_id}"))
                .header(header::CONTENT_TYPE, content_type)
                .body(Body::from(body))
                .expect("multipart request should build"),
        )
        .await
        .expect("multipart request should complete");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("form response body should be readable");
    let body = serde_json::from_slice(&body).expect("form response should be JSON");
    (status, body)
}
async fn get_form(app: &Router, public_id: &str) -> (StatusCode, String, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/forms/{public_id}"))
                .body(Body::empty())
                .expect("form request should build"),
        )
        .await
        .expect("form request should complete");
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("form response body should be readable");
    (
        status,
        content_type,
        String::from_utf8(body.to_vec()).expect("form response should be UTF-8"),
    )
}
async fn insert_marker(pool: &SqlitePool, user_id: &str, layer_id: &str) -> String {
    let marker_id = uuid::Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id, user_id, layer_id, marker_name, latitude, longitude,
            detail, create_at, update_at
        ) VALUES ($1, $2, $3, '投稿先', 35.0, 139.0, '既存本文', $4, $4)
        "#,
    )
    .bind(&marker_id)
    .bind(user_id)
    .bind(layer_id)
    .bind(now)
    .execute(pool)
    .await
    .expect("marker should be inserted");
    marker_id
}

#[tokio::test]
async fn owner_can_enable_form_and_public_user_can_only_append() {
    let pool = common::test_pool().await;
    common::init_test_env();
    let owner_id = common::create_test_user(&pool, "form-owner").await;
    let layer_id = common::master_layer_id(&pool, &owner_id).await;
    let marker_id = insert_marker(&pool, &owner_id, &layer_id).await;

    let initial = get_marker_form_config_handler(
        Extension(owner_id.clone()),
        Extension(pool.clone()),
        Path(marker_id.clone()),
    )
    .await
    .expect("owner should read the default form config")
    .0;
    assert_eq!(initial.form_title, "投稿先");
    assert!(initial.public_path.is_none());

    let config = MarkerFormConfigUpdate {
        enabled: true,
        form_title: "現地報告".into(),
        form_description: "状況を入力してください".into(),
        form_schema: MarkerFormSchema {
            fields: vec![
                MarkerFormField {
                    id: "comment".into(),
                    label: "コメント".into(),
                    field_type: "textarea".into(),
                    required: true,
                    max_length: Some(200),
                    choices: vec![],
                },
                MarkerFormField {
                    id: "photo".into(),
                    label: "写真".into(),
                    field_type: "image".into(),
                    required: false,
                    max_length: None,
                    choices: vec![],
                },
                MarkerFormField {
                    id: "reported_on".into(),
                    label: "確認日".into(),
                    field_type: "date".into(),
                    required: true,
                    max_length: None,
                    choices: vec![],
                },
            ],
        },
        password_mode: "set".into(),
        password: Some("secret123".into()),
    };

    let saved = update_marker_form_config_handler(
        Extension(owner_id.clone()),
        Extension(pool.clone()),
        Path(marker_id.clone()),
        Json(config),
    )
    .await
    .expect("form config should be saved")
    .0;
    assert!(saved.enabled);
    assert!(saved.is_password_protected);
    let public_id = saved
        .public_path
        .expect("public path should be generated")
        .trim_start_matches("/forms/")
        .to_string();

    let app = Router::new()
        .route(
            "/forms/{public_id}",
            get(public_marker_form_get_handler).post(submit_marker_form_handler),
        )
        .layer(Extension(
            build_tera_extension().expect("embedded templates should load"),
        ))
        .layer(Extension(pool.clone()));

    let (active_status, active_content_type, active_body) = get_form(&app, &public_id).await;
    assert_eq!(active_status, StatusCode::OK);
    assert!(active_content_type.starts_with("text/html"));
    assert!(active_body.contains("現地報告"));
    let bad_password = post_form(
        &app,
        &public_id,
        json!({
            "password": "wrong",
            "values": { "comment": "改ざん" }
        }),
        None,
    )
    .await;
    assert_eq!(bad_password, StatusCode::UNAUTHORIZED);

    let numeric_date = post_form(
        &app,
        &public_id,
        json!({
            "password": "secret123",
            "values": {
                "comment": "数値による型検証の迂回",
                "reported_on": 20260801
            }
        }),
        None,
    )
    .await;
    assert_eq!(numeric_date, StatusCode::BAD_REQUEST);

    let image_bytes = std::fs::read("icons/icon.png").expect("fixture image should be readable");
    let image_count_before_invalid: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM image_model WHERE user_id = $1")
            .bind(&owner_id)
            .fetch_one(&pool)
            .await
            .expect("image count should be readable");
    let invalid_date = post_form(
        &app,
        &public_id,
        json!({
            "password": "secret123",
            "values": {
                "comment": "日付の検証",
                "reported_on": "2026-99-99"
            }
        }),
        Some(&image_bytes),
    )
    .await;
    assert_eq!(invalid_date, StatusCode::BAD_REQUEST);
    let image_count_after_invalid: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM image_model WHERE user_id = $1")
            .bind(&owner_id)
            .fetch_one(&pool)
            .await
            .expect("image count should be readable");
    assert_eq!(image_count_after_invalid, image_count_before_invalid);
    let (success, success_body) = post_form_response(
        &app,
        &public_id,
        json!({
            "password": "secret123",
            "values": {
                "comment": "# 見出し [危険](javascript:alert(1))",
                "reported_on": "2026-08-01"
            }
        }),
        Some(&image_bytes),
    )
    .await;
    assert_eq!(success, StatusCode::OK);
    assert_eq!(success_body["message"], "送信が完了しました。");

    let detail: String = sqlx::query_scalar("SELECT detail FROM marker_info_model WHERE id = $1")
        .bind(&marker_id)
        .fetch_one(&pool)
        .await
        .expect("marker detail should be readable");
    assert!(detail.starts_with("既存本文"));
    assert!(detail.contains("フォーム投稿: 現地報告"));
    assert!(detail.contains("\\# 見出し"));
    assert!(detail.contains("2026-08-01"));
    assert!(!detail.contains("2026\\-08\\-01"));
    assert!(!detail.contains("[危険](javascript:"));

    let submission_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM marker_form_submission_model WHERE marker_id = $1",
    )
    .bind(&marker_id)
    .fetch_one(&pool)
    .await
    .expect("submission count should be readable");
    assert_eq!(submission_count, 1);

    let uploaded_filename: String = sqlx::query_scalar(
        "SELECT uuid_filename FROM image_model WHERE user_id = $1 AND filename = 'field-photo.png'",
    )
    .bind(&owner_id)
    .fetch_one(&pool)
    .await
    .expect("submitted image should be registered");
    assert!(detail.contains(&format!("/static/images/{uploaded_filename}")));
    let image_path = std::path::Path::new("target/handler-tests")
        .join(&uploaded_filename[..5])
        .join(&uploaded_filename);
    let thumb_path = image_path
        .parent()
        .expect("image should have a parent directory")
        .join("thumb")
        .join(&uploaded_filename);
    assert!(image_path.exists());
    assert!(thumb_path.exists());

    let stored_bytes: i64 =
        sqlx::query_scalar("SELECT stored_bytes FROM marker_form_image_model WHERE owner_id = $1")
            .bind(&owner_id)
            .fetch_one(&pool)
            .await
            .expect("stored form image bytes should be readable");
    let actual_bytes = i64::try_from(
        std::fs::metadata(&image_path)
            .expect("stored image metadata should be readable")
            .len()
            + std::fs::metadata(&thumb_path)
                .expect("thumbnail metadata should be readable")
                .len(),
    )
    .expect("stored byte count should fit in i64");
    assert_eq!(stored_bytes, actual_bytes);

    sqlx::query("UPDATE marker_form_image_model SET stored_bytes = $1 WHERE owner_id = $2")
        .bind(CONFIG.marker_form_storage_quota_bytes)
        .bind(&owner_id)
        .execute(&pool)
        .await
        .expect("form image usage should be raised to the quota");
    let image_count_before_quota: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM image_model WHERE user_id = $1")
            .bind(&owner_id)
            .fetch_one(&pool)
            .await
            .expect("image count should be readable");
    let over_quota = post_form(
        &app,
        &public_id,
        json!({
            "password": "secret123",
            "values": {
                "comment": "容量上限の検証",
                "reported_on": "2026-08-02"
            }
        }),
        Some(&image_bytes),
    )
    .await;
    assert_eq!(over_quota, StatusCode::PAYLOAD_TOO_LARGE);
    let image_count_after_quota: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM image_model WHERE user_id = $1")
            .bind(&owner_id)
            .fetch_one(&pool)
            .await
            .expect("image count should be readable");
    assert_eq!(image_count_after_quota, image_count_before_quota);

    sqlx::query(
        "UPDATE marker_form_rate_limit_model SET window_started_at = $1, attempt_count = 30 WHERE marker_id = $2",
    )
    .bind(Utc::now().timestamp())
    .bind(&marker_id)
    .execute(&pool)
    .await
    .expect("shared rate limit should be prepared");
    let rate_limited = post_form(
        &app,
        &public_id,
        json!({
            "password": "secret123",
            "values": {
                "comment": "レート制限の検証",
                "reported_on": "2026-08-02"
            }
        }),
        None,
    )
    .await;
    assert_eq!(rate_limited, StatusCode::TOO_MANY_REQUESTS);

    sqlx::query("UPDATE marker_form_config_model SET enabled = false WHERE marker_id = $1")
        .bind(&marker_id)
        .execute(&pool)
        .await
        .expect("form should be disabled");

    for path in [
        &public_id,
        "00000000-0000-0000-0000-000000000000",
        "not-a-valid-id",
    ] {
        let (status, content_type, body) = get_form(&app, path).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(content_type.starts_with("text/html"));
        assert!(body.contains("Not Found"));
        assert!(body.contains("入力フォームが見つかりません。"));
    }
    let loaded = get_marker_form_config_handler(
        Extension(owner_id.clone()),
        Extension(pool),
        Path(marker_id),
    )
    .await
    .expect("owner should read form config")
    .0;
    assert_eq!(loaded.form_schema.fields.len(), 3);

    let _ = std::fs::remove_file(&image_path);
    let _ = std::fs::remove_file(&thumb_path);
}
