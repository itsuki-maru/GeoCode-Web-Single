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
        get_marker_form_config_handler, get_shape_form_config_handler,
        public_marker_form_get_handler, public_shape_form_get_handler, submit_marker_form_handler,
        submit_shape_form_handler, update_marker_form_config_handler,
        update_shape_form_config_handler,
    },
    model::{MarkerFormConfigUpdate, MarkerFormField, MarkerFormSchema},
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;
use uuid::Uuid;

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

async fn insert_shape(pool: &SqlitePool, user_id: &str, layer_id: &str) -> String {
    let shape_id = uuid::Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();
    sqlx::query(
        r#"
        INSERT INTO shape_model (id, user_id, layer_id, shape_type, name, geojson, created_at, updated_at)
        VALUES ($1, $2, $3, 'polyline', '巡回経路', $4, $5, $5)
        "#,
    )
    .bind(&shape_id)
    .bind(user_id)
    .bind(layer_id)
    .bind(sqlx::types::Json(json!({
        "type": "Feature",
        "properties": { "memo": "既存メモ", "style": { "weight": 4 } },
        "geometry": { "type": "LineString", "coordinates": [[139.0, 35.0], [139.1, 35.1]] }
    })))
    .bind(now)
    .execute(pool)
    .await
    .expect("shape should be inserted");
    shape_id
}

async fn post_shape_form(app: &Router, public_id: &str, submission: Value) -> StatusCode {
    let (content_type, body) = multipart_body(&submission, None);
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/shape-forms/{public_id}"))
                .header(header::CONTENT_TYPE, content_type)
                .body(Body::from(body))
                .expect("multipart request should build"),
        )
        .await
        .expect("shape form request should complete")
        .status()
}

async fn get_shape_form(app: &Router, public_id: &str) -> (StatusCode, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/shape-forms/{public_id}"))
                .body(Body::empty())
                .expect("shape form request should build"),
        )
        .await
        .expect("shape form request should complete");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("shape form response should be readable");
    (status, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test]
async fn shape_form_appends_markdown_without_changing_geometry() {
    let pool = common::test_pool().await;
    common::init_test_env();
    let owner_id = common::create_test_user(&pool, "shape-form-owner").await;
    let other_id = common::create_test_user(&pool, "shape-form-other").await;
    let layer_id = common::master_layer_id(&pool, &owner_id).await;
    let shape_id = insert_shape(&pool, &owner_id, &layer_id).await;
    assert!(
        get_shape_form_config_handler(
            Extension(other_id),
            Extension(pool.clone()),
            Path(shape_id.clone()),
        )
        .await
        .is_err()
    );
    let saved = update_shape_form_config_handler(
        Extension(owner_id),
        Extension(pool.clone()),
        Path(shape_id.clone()),
        Json(MarkerFormConfigUpdate {
            source_form: None,
            enabled: true,
            form_title: "経路報告".into(),
            form_description: String::new(),
            form_schema: MarkerFormSchema {
                fields: vec![MarkerFormField {
                    id: "comment".into(),
                    label: "コメント".into(),
                    field_type: "textarea".into(),
                    required: true,
                    max_length: Some(200),
                    choices: vec![],
                }],
            },
            password_mode: "keep".into(),
            password: None,
        }),
    )
    .await
    .expect("shape form should be saved")
    .0;
    let public_id = saved
        .public_path
        .expect("public path should exist")
        .trim_start_matches("/shape-forms/")
        .to_string();
    let app = Router::new()
        .route(
            "/shape-forms/{public_id}",
            get(public_shape_form_get_handler).post(submit_shape_form_handler),
        )
        .layer(Extension(
            build_tera_extension().expect("embedded templates should load"),
        ))
        .layer(Extension(pool.clone()));
    let (get_status, form_html) = get_shape_form(&app, &public_id).await;
    assert_eq!(get_status, StatusCode::OK);
    assert!(form_html.contains(&format!("/shape-forms/{public_id}")));
    let status = post_shape_form(
        &app,
        &public_id,
        json!({ "values": { "comment": "異常なし" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let geojson: sqlx::types::Json<Value> =
        sqlx::query_scalar("SELECT geojson FROM shape_model WHERE id = $1")
            .bind(&shape_id)
            .fetch_one(&pool)
            .await
            .expect("shape geojson should load");
    assert_eq!(geojson["geometry"]["type"], "LineString");
    assert_eq!(geojson["properties"]["style"]["weight"], 4);
    let memo = geojson["properties"]["memo"].as_str().unwrap_or_default();
    assert!(memo.starts_with("既存メモ"));
    assert!(memo.contains("## フォーム投稿: 経路報告"));
    assert!(memo.contains("### コメント"));
    assert!(memo.contains("異常なし"));
    let submissions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shape_form_submission_model WHERE shape_id = $1")
            .bind(&shape_id)
            .fetch_one(&pool)
            .await
            .expect("submission count should load");
    assert_eq!(submissions, 1);
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
        source_form: None,
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
    assert!(detail.contains("## フォーム投稿: 現地報告"));
    assert!(detail.contains("### コメント\n\n\\# 見出し"));
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

#[tokio::test]
async fn common_forms_are_owned_copied_and_preserve_submission_definitions() {
    let pool = common::test_pool().await;
    use geocode_web_single::handler::marker_forms::*;
    common::init_test_env();
    let owner = common::create_test_user(&pool, "common-owner").await;
    let other = common::create_test_user(&pool, "common-other").await;
    let layer = common::master_layer_id(&pool, &owner).await;
    let marker = insert_marker(&pool, &owner, &layer).await;
    let shape = insert_shape(&pool, &owner, &layer).await;
    let config = |source: Option<Value>, label: &str| -> MarkerFormConfigUpdate {
        serde_json::from_value(json!({"source_form": source, "enabled": true,
            "form_title": "観測", "form_description": "説明", "password_mode": "keep",
            "form_schema": {"fields": [{"id":"amount", "label":label, "type":"number", "required":false, "choices":[]}]}})).unwrap()
    };
    let created = create_common_form_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Json(CommonFormUpdate {
            expected_managed_count: None,
            expected_applied_count: None,
            version: None,
            config: config(None, "値"),
        }),
    )
    .await
    .unwrap()
    .0;
    let id = created.id;
    assert_eq!(created.version, 1);
    assert!(
        list_common_forms_handler(Extension(other.clone()), Extension(pool.clone()))
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        get_common_form_handler(
            Extension(other.clone()),
            Extension(pool.clone()),
            Path(id.clone())
        )
        .await
        .is_err()
    );
    assert!(
        update_common_form_handler(
            Extension(other.clone()),
            Extension(pool.clone()),
            Path(id.clone()),
            Json(CommonFormUpdate {
                expected_managed_count: None,
                expected_applied_count: None,
                version: Some(1),
                config: config(None, "変更")
            })
        )
        .await
        .is_err()
    );
    assert!(
        delete_common_form_handler(
            Extension(other.clone()),
            Extension(pool.clone()),
            Path(id.clone())
        )
        .await
        .is_err()
    );
    let source = Some(json!({"id":id,"version":1}));
    assert!(
        update_marker_form_config_handler(
            Extension(other.clone()),
            Extension(pool.clone()),
            Path(marker.clone()),
            Json(config(source.clone(), "値"))
        )
        .await
        .is_err()
    );
    // A template owned by a different user cannot be attached to one's own object.
    let other_layer = common::master_layer_id(&pool, &other).await;
    let other_marker = insert_marker(&pool, &other, &other_layer).await;
    assert!(
        update_marker_form_config_handler(
            Extension(other.clone()),
            Extension(pool.clone()),
            Path(other_marker.clone()),
            Json(config(source.clone(), "値"))
        )
        .await
        .is_err()
    );
    let marker_config = update_marker_form_config_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(marker.clone()),
        Json(config(source.clone(), "値")),
    )
    .await
    .unwrap()
    .0;
    let shape_config = update_shape_form_config_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(shape.clone()),
        Json(config(source.clone(), "値")),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(marker_config.form_schema.fields[0].id, "amount");
    assert_eq!(shape_config.form_schema.fields[0].id, "amount");
    let marker_public: String = marker_config
        .public_path
        .as_ref()
        .unwrap()
        .trim_start_matches("/forms/")
        .parse()
        .unwrap();
    let shape_public: String = shape_config
        .public_path
        .as_ref()
        .unwrap()
        .trim_start_matches("/shape-forms/")
        .parse()
        .unwrap();
    let app = Router::new()
        .route(
            "/forms/{public_id}",
            get(public_marker_form_get_handler).post(submit_marker_form_handler),
        )
        .route(
            "/shape-forms/{public_id}",
            get(public_shape_form_get_handler).post(submit_shape_form_handler),
        )
        .layer(Extension(build_tera_extension().unwrap()))
        .layer(Extension(pool.clone()));
    assert_eq!(
        post_form(
            &app,
            &marker_public,
            json!({"values":{"amount":"12.5"}}),
            None
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        post_shape_form(&app, &shape_public, json!({"values":{"amount":"8"}})).await,
        StatusCode::OK
    );
    let updated = update_common_form_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(id.clone()),
        Json(CommonFormUpdate {
            expected_managed_count: None,
            expected_applied_count: None,
            version: Some(1),
            config: config(None, "測定値"),
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(updated.version, 2);
    assert_eq!(updated.form_schema.0.fields[0].id, "amount");
    assert!(
        update_common_form_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Path(id.clone()),
            Json(CommonFormUpdate {
                expected_managed_count: None,
                expected_applied_count: None,
                version: Some(1),
                config: config(None, "競合")
            })
        )
        .await
        .is_err()
    );
    let mut wrong_type = config(None, "型変更");
    wrong_type.form_schema.fields[0].field_type = "text".into();
    assert!(
        update_common_form_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Path(id.clone()),
            Json(CommonFormUpdate {
                expected_managed_count: None,
                expected_applied_count: None,
                version: Some(2),
                config: wrong_type
            })
        )
        .await
        .is_err()
    );
    let target = get_marker_form_config_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(marker.clone()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(target.form_schema.fields[0].label, "値");
    // A local edit keeps the field ID, URL, and source version; earlier answers keep their original definition.
    let edited = update_marker_form_config_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(marker.clone()),
        Json(config(source.clone(), "対象独自の値")),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(edited.public_path, marker_config.public_path);
    assert_eq!(edited.source_form, source);
    assert_eq!(
        post_form(
            &app,
            &marker_public,
            json!({"values":{"amount":"20"}}),
            None
        )
        .await,
        StatusCode::OK
    );
    let snapshots: Vec<Value> = sqlx::query_scalar("SELECT form_snapshot FROM marker_form_submission_model WHERE marker_id = $1 ORDER BY create_at, id").bind(&marker).fetch_all(&pool).await.unwrap();
    assert_eq!(snapshots[0]["form_schema"]["fields"][0]["label"], "値");
    assert_eq!(
        snapshots[1]["form_schema"]["fields"][0]["label"],
        "対象独自の値"
    );
    for (table, column, target_id) in [
        ("marker_form_submission_model", "marker_id", marker.clone()),
        ("shape_form_submission_model", "shape_id", shape.clone()),
    ] {
        let rows: Vec<(Value, Value, Value)> = sqlx::query_as(&format!(
            "SELECT source_form, form_snapshot, submitted_values FROM {table} WHERE {column} = $1"
        ))
        .bind(&target_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        for (stored_source, snapshot, values) in rows {
            assert_eq!(stored_source, source.clone().unwrap());
            assert_eq!(snapshot["form_schema"]["fields"][0]["type"], "number");
            assert!(values["amount"].is_number());
            assert!(snapshot.get("password_hash").is_none());
        }
    }
    assert_eq!(
        delete_common_form_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Path(id.clone())
        )
        .await
        .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(
        list_common_forms_handler(Extension(owner.clone()), Extension(pool.clone()))
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        get_common_form_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Path(id.clone())
        )
        .await
        .is_err()
    );
    let new_marker = insert_marker(&pool, &owner, &layer).await;
    assert!(
        update_marker_form_config_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Path(new_marker.clone()),
            Json(config(source.clone(), "値"))
        )
        .await
        .is_err()
    );
    // Previously applied copies remain editable and accept answers after the template is deleted.
    let _ = update_shape_form_config_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(shape.clone()),
        Json(config(source, "値")),
    )
    .await
    .unwrap();
    assert_eq!(
        post_shape_form(&app, &shape_public, json!({"values":{"amount":"9"}})).await,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM marker_form_submission_model WHERE marker_id = $1"
        )
        .bind(&marker)
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
}

#[tokio::test]
async fn concurrent_definition_changes_reject_posts_and_versions_are_atomic() {
    use geocode_web_single::handler::marker_forms::*;
    let (pool, path) = common::file_test_pool().await;
    let owner = common::create_test_user(&pool, "form-race").await;
    let layer = common::master_layer_id(&pool, &owner).await;
    let marker = insert_marker(&pool, &owner, &layer).await;
    let shape = insert_shape(&pool, &owner, &layer).await;
    let config = |label: &str| {
        serde_json::from_value::<MarkerFormConfigUpdate>(json!({
            "enabled":true,"form_title":"競合確認","form_schema":{"fields":[
                {"id":"amount","label":label,"type":"number"}
            ]}
        }))
        .unwrap()
    };
    let form = create_common_form_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Json(CommonFormUpdate {
            expected_managed_count: None,
            expected_applied_count: None,
            version: None,
            config: config("値"),
        }),
    )
    .await
    .unwrap()
    .0;
    let (a, b) = tokio::join!(
        update_common_form_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Path(form.id.clone()),
            Json(CommonFormUpdate {
                expected_managed_count: None,
                expected_applied_count: None,
                version: Some(1),
                config: config("変更A")
            })
        ),
        update_common_form_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Path(form.id.clone()),
            Json(CommonFormUpdate {
                expected_managed_count: None,
                expected_applied_count: None,
                version: Some(1),
                config: config("変更B")
            })
        )
    );
    assert!(matches!(
        (a, b),
        (Ok(_), Err(geocode_web_single::error::AppError::Conflict))
            | (Err(geocode_web_single::error::AppError::Conflict), Ok(_))
    ));
    let app = Router::new()
        .route(
            "/forms/{public_id}",
            get(public_marker_form_get_handler).post(submit_marker_form_handler),
        )
        .route(
            "/shape-forms/{public_id}",
            get(public_shape_form_get_handler).post(submit_shape_form_handler),
        )
        .layer(Extension(pool.clone()));
    for (kind, target) in [("marker", &marker), ("shape", &shape)] {
        let public_path = if kind == "marker" {
            update_marker_form_config_handler(
                Extension(owner.clone()),
                Extension(pool.clone()),
                Path(target.clone()),
                Json(config("変更前")),
            )
            .await
            .unwrap()
            .0
            .public_path
            .unwrap()
        } else {
            update_shape_form_config_handler(
                Extension(owner.clone()),
                Extension(pool.clone()),
                Path(target.clone()),
                Json(config("変更前")),
            )
            .await
            .unwrap()
            .0
            .public_path
            .unwrap()
        };
        let (content_type, body) = multipart_body(&json!({"values":{"amount":"12"}}), None);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let stream = futures_util::stream::once(async move {
            started_tx.send(()).unwrap();
            resume_rx.await.unwrap();
            Ok::<_, std::io::Error>(body)
        });
        let request = Request::builder()
            .method("POST")
            .uri(public_path)
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from_stream(stream))
            .unwrap();
        let task = tokio::spawn(app.clone().oneshot(request));
        tokio::time::timeout(std::time::Duration::from_secs(5), started_rx)
            .await
            .unwrap()
            .unwrap();
        if kind == "marker" {
            let _ = update_marker_form_config_handler(
                Extension(owner.clone()),
                Extension(pool.clone()),
                Path(target.clone()),
                Json(config("変更後")),
            )
            .await
            .unwrap();
        } else {
            let _ = update_shape_form_config_handler(
                Extension(owner.clone()),
                Extension(pool.clone()),
                Path(target.clone()),
                Json(config("変更後")),
            )
            .await
            .unwrap();
        }
        resume_tx.send(()).unwrap();
        assert_eq!(task.await.unwrap().unwrap().status(), StatusCode::CONFLICT);
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {kind}_form_submission_model"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0);
    }
    common::close_file_test_pool(pool, path).await;
}

async fn owner_request(
    app: &Router,
    user: Option<Uuid>,
    kind: &str,
    id: Uuid,
    submission: Option<Value>,
    image: Option<&[u8]>,
) -> (StatusCode, Value) {
    let (method, path, body, content_type) = if let Some(submission) = submission {
        let (ct, body) = multipart_body(&submission, image);
        (
            "POST",
            format!("/{kind}/{id}/form/submissions"),
            Body::from(body),
            ct,
        )
    } else {
        (
            "GET",
            format!("/{kind}/{id}/form/input"),
            Body::empty(),
            "application/json".into(),
        )
    };
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, content_type);
    if let Some(user) = user {
        request = request.header(
            "cookie",
            format!(
                "access_token={}",
                geocode_web_single::auth::create_token(&user.to_string(), 30, "access_token", 0)
                    .unwrap()
            ),
        );
    }
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn owner_inputs_work_with_private_forms_preserve_objects_and_are_searchable() {
    let pool = common::test_pool().await;
    let user = owner_test_user(&pool, "owner-input").await;
    let other = owner_test_user(&pool, "other-input").await;
    let layer = owner_test_layer(&pool, &user).await;
    let marker = owner_test_marker(&pool, user, layer).await;
    let shape = owner_test_shape(&pool, user, layer).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        build_tera_extension().unwrap(),
        None,
    );
    let schema:MarkerFormSchema=serde_json::from_value(json!({"fields":[
        {"id":"n","label":"年数","type":"number","required":true},
        {"id":"d","label":"日付","type":"date"},{"id":"flag","label":"確認","type":"checkbox"},
        {"id":"material","label":"材質","type":"select","choices":["GX","塩ビ"]},
        {"id":"text","label":"備考","type":"textarea"},{"id":"radio","label":"選択","type":"radio","choices":["A","B"]},
        {"id":"photo","label":"画像","type":"image"}]})).unwrap();
    for (kind, id) in [("marker", marker), ("shape", shape)] {
        assert_eq!(
            owner_request(&app, Some(user), kind, id, None, None)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let payload = MarkerFormConfigUpdate {
            source_form: None,
            enabled: false,
            form_title: "所有者入力".into(),
            form_description: "説明".into(),
            form_schema: schema.clone(),
            password_mode: "set".into(),
            password: Some("private-password".into()),
        };
        if kind == "marker" {
            let _ = update_marker_form_config_handler(
                Extension(user.to_string()),
                Extension(pool.clone()),
                Path(id.to_string()),
                Json(payload),
            )
            .await
            .unwrap();
        } else {
            let _ = update_shape_form_config_handler(
                Extension(user.to_string()),
                Extension(pool.clone()),
                Path(id.to_string()),
                Json(payload),
            )
            .await
            .unwrap();
        }
        for actor in [None, Some(other)] {
            let expected = if actor.is_none() {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::NOT_FOUND
            };
            assert_eq!(
                owner_request(&app, actor, kind, id, None, None).await.0,
                expected
            );
            assert_eq!(
                owner_request(
                    &app,
                    actor,
                    kind,
                    id,
                    Some(json!({"values":{"n":"20"}})),
                    None
                )
                .await
                .0,
                expected
            );
        }
        let (status, input) = owner_request(&app, Some(user), kind, id, None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(input["values"], json!({}));
        assert!(!input.to_string().contains("private-password"));
        assert!(input.get("password_hash").is_none());
        let public_id: String = sqlx::query_scalar(&format!(
            "SELECT public_id FROM {kind}_form_config_model WHERE {kind}_id=$1"
        ))
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        let public_path = if kind == "marker" {
            format!("/forms/{public_id}")
        } else {
            format!("/shape-forms/{public_id}")
        };
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&public_path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        let mut values = json!({"n":"0","d":"2020-04-01","flag":false,"material":"GX","text":" =SUM(1)","radio":"A"});
        let missing = owner_request(
            &app,
            Some(user),
            kind,
            id,
            Some(json!({"values":values})),
            None,
        )
        .await;
        assert_eq!(missing.0, StatusCode::CONFLICT);
        values["n"] = json!("invalid");
        assert_eq!(
            owner_request(
                &app,
                Some(user),
                kind,
                id,
                Some(json!({"config_token":input["config_token"],"values":values})),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        values["n"] = json!("0");
        let image = std::fs::read("icons/icon.png").unwrap();
        let (status, saved) = owner_request(
            &app,
            Some(user),
            kind,
            id,
            Some(json!({"config_token":input["config_token"],"values":values})),
            Some(&image),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(saved["object"]["id"], id.to_string());
        assert_eq!(saved["object"]["layer_id"], layer.to_string());
        if kind == "marker" {
            assert_eq!(saved["object"]["marker_name"], "投稿先");
            assert_eq!(saved["object"]["latitude"], 35.0);
            assert!(
                saved["object"]["detail"]
                    .as_str()
                    .unwrap()
                    .starts_with("既存本文")
            );
        } else {
            assert_eq!(saved["object"]["name"], "巡回経路");
            assert_eq!(
                saved["object"]["geojson"]["geometry"]["coordinates"],
                json!([[139.0, 35.0], [139.1, 35.1]])
            );
            assert_eq!(
                saved["object"]["geojson"]["properties"]["style"],
                json!({"weight":4})
            );
            assert!(
                saved["object"]["geojson"]["properties"]["memo"]
                    .as_str()
                    .unwrap()
                    .starts_with("既存メモ")
            );
        }
        let (submitted,snapshot):(Value,Value)=sqlx::query_as(&format!("SELECT submitted_values,form_snapshot FROM {kind}_form_submission_model WHERE {kind}_id=$1")).bind(id.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(submitted["n"], 0);
        assert_eq!(submitted["flag"], false);
        assert_eq!(snapshot["form_title"], "所有者入力");
        assert!(submitted["photo"].is_object());
        let latest = owner_request(&app, Some(user), kind, id, None, None)
            .await
            .1;
        assert_eq!(latest["values"]["n"], "0");
        assert_eq!(latest["values"]["flag"], false);
        assert!(latest["values"].get("photo").is_none());
        // 同じトークンでの次回回答も履歴追記。過去の回答・画像は残す。
        values["n"] = json!("20");
        assert_eq!(
            owner_request(
                &app,
                Some(user),
                kind,
                id,
                Some(json!({"config_token":latest["config_token"],"values":values})),
                None
            )
            .await
            .0,
            StatusCode::OK
        );
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {kind}_form_submission_model WHERE {kind}_id=$1"
        ))
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 2);
        let q=serde_json::from_value(json!({"mode":"latest","target_type":kind,"target_id":id,"individual_only":true,"conditions":[{"field_id":"n","field_type":"number","op":"gte","value":"20"}]})).unwrap();
        let results = geocode_web_single::handler::form_answers::search_answers_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(q),
        )
        .await
        .unwrap();
        assert_eq!(results.0.total, 1);
        // 表示後の設定変更は保存させず、履歴・本文を変更しない。
        sqlx::query(&format!(
            "UPDATE {kind}_form_config_model SET form_description='変更' WHERE {kind}_id=$1"
        ))
        .bind(id.to_string())
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            owner_request(
                &app,
                Some(user),
                kind,
                id,
                Some(json!({"config_token":latest["config_token"],"values":values})),
                None
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {kind}_form_submission_model WHERE {kind}_id=$1"
        ))
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 2);
    }
}

#[tokio::test]
async fn owner_prefill_uses_only_latest_same_form_and_matching_definitions() {
    let pool = common::test_pool().await;
    let user = owner_test_user(&pool, "prefill-owner").await;
    let layer = owner_test_layer(&pool, &user).await;
    let marker = owner_test_marker(&pool, user, layer).await;
    let schema:MarkerFormSchema=serde_json::from_value(json!({"fields":[{"id":"n","type":"number","label":"数値"},{"id":"flag","type":"checkbox","label":"確認"},{"id":"new","type":"text","label":"新規"}]})).unwrap();
    let _ = update_marker_form_config_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Path(marker.to_string()),
        Json(MarkerFormConfigUpdate {
            source_form: None,
            enabled: false,
            form_title: "設定".into(),
            form_description: String::new(),
            form_schema: schema.clone(),
            password_mode: "keep".into(),
            password: None,
        }),
    )
    .await
    .unwrap();
    let form = Uuid::new_v4();
    sqlx::query("UPDATE marker_form_config_model SET source_form=$1 WHERE marker_id=$2")
        .bind(json!({"id":form,"version":2}))
        .bind(marker.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let snapshot = json!({"form_schema":{"fields":[{"id":"n","type":"number","label":"旧数値"},{"id":"flag","type":"text","label":"旧確認"}]}});
    for (seconds, source, values, definition) in [
        (
            30,
            Some(json!({"id":form,"version":1})),
            json!({"n":1,"flag":true,"new":"過去の値"}),
            Some(json!({"form_schema":schema})),
        ),
        (
            20,
            Some(json!({"id":form,"version":1})),
            json!({"n":9007199254740993i64,"flag":"true"}),
            Some(snapshot),
        ),
        (
            10,
            Some(json!({"id":Uuid::new_v4(),"version":1})),
            json!({"n":999}),
            Some(json!({"form_schema":schema})),
        ),
    ] {
        // UTC の固定日時を保存し、実行日時やローカル時刻の解釈に依存させない。
        let created_at = chrono::DateTime::parse_from_rfc3339("2020-01-01T00:00:00Z")
            .unwrap()
            .naive_utc()
            - chrono::Duration::seconds(seconds);
        sqlx::query("INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown,source_form,form_snapshot) VALUES($1,$2,$3,$4,'',$5,$6)")
        .bind(Uuid::new_v4().to_string()).bind(marker.to_string()).bind(created_at).bind(values).bind(source).bind(definition).execute(&pool).await.unwrap();
    }
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        build_tera_extension().unwrap(),
        None,
    );
    let (_, input) = owner_request(&app, Some(user), "marker", marker, None, None).await;
    assert_eq!(input["values"], json!({"n":"9007199254740993"}));
    let (status,saved)=owner_request(&app,Some(user),"marker",marker,Some(json!({"config_token":input["config_token"],"values":{"n":"9007199254740995","flag":false,"new":""}})),None).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (_, input) = owner_request(&app, Some(user), "marker", marker, None, None).await;
    assert_eq!(input["values"]["n"], "9007199254740995");

    let created_at = chrono::DateTime::parse_from_rfc3339("2020-01-01T00:00:00Z")
        .unwrap()
        .naive_utc();
    sqlx::query("INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown,source_form) VALUES($1,$2,$3,'{\"n\":9}','','{}')")
      .bind(Uuid::new_v4().to_string()).bind(marker.to_string()).bind(created_at).execute(&pool).await.unwrap();
    sqlx::query("UPDATE marker_form_config_model SET source_form=NULL WHERE marker_id=$1")
        .bind(marker.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (_, input) = owner_request(&app, Some(user), "marker", marker, None, None).await;
    assert_eq!(input["values"], json!({})); // 定義がない既存回答を推測しない。
    pool.close().await;
}

async fn owner_test_user(pool: &SqlitePool, name: &str) -> Uuid {
    Uuid::parse_str(&common::create_test_user(pool, name).await).unwrap()
}
async fn owner_test_layer(pool: &SqlitePool, user: &Uuid) -> Uuid {
    Uuid::parse_str(&common::master_layer_id(pool, &user.to_string()).await).unwrap()
}
async fn owner_test_marker(pool: &SqlitePool, user: Uuid, layer: Uuid) -> Uuid {
    Uuid::parse_str(&insert_marker(pool, &user.to_string(), &layer.to_string()).await).unwrap()
}
async fn owner_test_shape(pool: &SqlitePool, user: Uuid, layer: Uuid) -> Uuid {
    Uuid::parse_str(&insert_shape(pool, &user.to_string(), &layer.to_string()).await).unwrap()
}
