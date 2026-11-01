#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Extension},
    http::{HeaderValue, Request, StatusCode, header},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{Column, Row, SqlitePool, TypeInfo, ValueRef};
use tower::ServiceExt;
use uuid::Uuid;

const FIXTURE: &[u8] = include_bytes!("fixtures/transfer_v3.json");

async fn create_user(pool: &SqlitePool, name: &str) -> Uuid {
    Uuid::parse_str(&common::create_test_user(pool, name).await).unwrap()
}

fn app(pool: &SqlitePool, user: Uuid) -> Router {
    Router::new()
        .route(
            "/import",
            post(geocode_web_single::handler::files::import_json_handler),
        )
        .route(
            "/export/{id}",
            get(geocode_web_single::handler::files::export_json_handler),
        )
        .layer(DefaultBodyLimit::max(21 * 1024 * 1024))
        .layer(Extension(user.to_string()))
        .layer(Extension(pool.clone()))
}

fn upload_request(bytes: &[u8], key: Option<&str>, boundary: &str) -> Request<Body> {
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"handoff.json\"\r\nContent-Type: application/json\r\n\r\n"
    ).into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut request = Request::builder().method("POST").uri("/import").header(
        header::CONTENT_TYPE,
        format!("multipart/form-data; boundary={boundary}"),
    );
    if let Some(key) = key {
        request = request.header("Idempotency-Key", key);
    }
    request.body(Body::from(body)).unwrap()
}

async fn upload(app: &Router, bytes: &[u8], key: Option<&str>) -> (StatusCode, Vec<u8>) {
    let response = app
        .clone()
        .oneshot(upload_request(bytes, key, "IMPORT"))
        .await
        .unwrap();
    (
        response.status(),
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
}

async fn receipts(pool: &SqlitePool, user: Uuid) -> i64 {
    sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM json_import_receipt_model
        WHERE user_id = $1
        "#,
    )
    .bind(user.to_string())
    .fetch_one(pool)
    .await
    .unwrap()
}

// 元の ID、関連付け、履歴、処理記録を含め、保存されたすべての行を比較する。
async fn snapshot(pool: &SqlitePool, user: Uuid) -> Vec<Vec<String>> {
    let queries = [
        r#"
        SELECT
            x.*
        FROM layer_model x
        WHERE user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM common_form_model x
        WHERE user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM common_form_revision_model x
        JOIN common_form_model f ON f.id = x.form_id
        WHERE f.user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM marker_info_model x
        WHERE user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM shape_model x
        WHERE user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM marker_form_config_model x
        JOIN marker_info_model m ON m.id = x.marker_id
        WHERE m.user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM shape_form_config_model x
        JOIN shape_model s ON s.id = x.shape_id
        WHERE s.user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM marker_form_submission_model x
        JOIN marker_info_model m ON m.id = x.marker_id
        WHERE m.user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM shape_form_submission_model x
        JOIN shape_model s ON s.id = x.shape_id
        WHERE s.user_id = $1
        "#,
        r#"
        SELECT
            x.*
        FROM json_import_receipt_model x
        WHERE user_id = $1
        "#,
    ];
    let mut result = Vec::new();
    for query in queries {
        let rows = sqlx::query(query)
            .bind(user.to_string())
            .fetch_all(pool)
            .await
            .unwrap();
        let mut records = Vec::new();
        for row in rows {
            let mut fields = std::collections::BTreeMap::new();
            for (index, column) in row.columns().iter().enumerate() {
                let raw = row.try_get_raw(index).unwrap();
                let value = if raw.is_null() {
                    Value::Null
                } else {
                    match raw.type_info().name() {
                        "INTEGER" => json!(row.get::<i64, _>(index)),
                        "BOOLEAN" => json!(row.get::<bool, _>(index)),
                        "REAL" => json!(row.get::<f64, _>(index)),
                        "BLOB" => json!(row.get::<Vec<u8>, _>(index)),
                        _ => json!(row.get::<String, _>(index)),
                    }
                };
                fields.insert(column.name(), value);
            }
            records.push(serde_json::to_string(&fields).unwrap());
        }
        records.sort();
        result.push(records);
    }
    result
}

#[tokio::test]
async fn successful_replay_keeps_every_record_and_later_edits() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "replay").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4().to_string();
    let first = upload(&app, FIXTURE, Some(&key)).await;
    assert_eq!(first.0, StatusCode::OK);
    let before = snapshot(&pool, user).await;
    // マルチパートの区切りを変えても、元の JSON ファイルのハッシュは変わらない。
    let replay = app
        .clone()
        .oneshot(upload_request(FIXTURE, Some(&key), "OTHER"))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(replay.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        first.1
    );
    assert_eq!(snapshot(&pool, user).await, before);
    sqlx::query(
        r#"
        UPDATE marker_info_model
        SET
            detail = 'edited after import'
        WHERE user_id = $1
        "#,
    )
    .bind(user.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let edited = snapshot(&pool, user).await;
    assert_eq!(upload(&app, FIXTURE, Some(&key)).await, first);
    assert_eq!(snapshot(&pool, user).await, edited);
    assert_eq!(receipts(&pool, user).await, 1);
}

#[tokio::test]
async fn raw_file_changes_conflict_without_mutating_the_successful_import() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "raw-conflict").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4().to_string();
    assert_eq!(upload(&app, FIXTURE, Some(&key)).await.0, StatusCode::OK);
    let before = snapshot(&pool, user).await;
    let mut changed = FIXTURE.to_vec();
    changed.push(b' '); // JSON としての意味は同じだが、元のバイト列は異なる。
    let response = upload(&app, &changed, Some(&key)).await;
    assert_eq!(response.0, StatusCode::CONFLICT);
    assert!(serde_json::from_slice::<Value>(&response.1).unwrap()["error"].is_string());
    assert_eq!(snapshot(&pool, user).await, before);
}

#[tokio::test]
async fn operation_keys_are_scoped_to_the_owner_and_new_keys_create_new_copies() {
    let pool = common::test_pool().await;
    let first = create_user(&pool, "key-first").await;
    let second = create_user(&pool, "key-second").await;
    let key = Uuid::new_v4().to_string();
    assert_eq!(
        upload(&app(&pool, first), FIXTURE, Some(&key)).await.0,
        StatusCode::OK
    );
    let first_rows = snapshot(&pool, first).await;
    assert_eq!(
        upload(&app(&pool, second), FIXTURE, Some(&key)).await.0,
        StatusCode::OK
    );
    assert_eq!(snapshot(&pool, first).await, first_rows);
    assert_ne!(snapshot(&pool, second).await, first_rows);
    assert_eq!(receipts(&pool, first).await, 1);
    assert_eq!(receipts(&pool, second).await, 1);
    let new_key = Uuid::new_v4().to_string();
    assert_eq!(
        upload(&app(&pool, first), FIXTURE, Some(&new_key)).await.0,
        StatusCode::OK
    );
    let markers: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM marker_info_model
        WHERE user_id = $1
        "#,
    )
    .bind(first.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(markers, 6);
    assert_eq!(receipts(&pool, first).await, 2);
}

#[tokio::test]
async fn concurrent_retries_create_only_one_copy() {
    let (pool, path) = common::file_test_pool().await;
    let user = create_user(&pool, "concurrent-retry").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4().to_string();
    let (first, second) = tokio::join!(
        upload(&app, FIXTURE, Some(&key)),
        upload(&app, FIXTURE, Some(&key))
    );
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second, first);
    let rows = snapshot(&pool, user).await;
    assert_eq!(
        rows.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![5, 3, 4, 3, 1, 3, 1, 5, 1, 1]
    );
    assert_eq!(upload(&app, FIXTURE, Some(&key)).await, first);
    assert_eq!(snapshot(&pool, user).await, rows);
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn concurrent_different_payloads_have_one_winner_and_one_conflict() {
    let (pool, path) = common::file_test_pool().await;
    let user = create_user(&pool, "concurrent-conflict").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4().to_string();
    let mut other = FIXTURE.to_vec();
    other.push(b'\n');
    let (first, second) = tokio::join!(
        upload(&app, FIXTURE, Some(&key)),
        upload(&app, &other, Some(&key))
    );
    let mut statuses = vec![first.0.as_u16(), second.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![200, 409]);
    assert_eq!(receipts(&pool, user).await, 1);
    assert_eq!(snapshot(&pool, user).await[3].len(), 3);
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn waiting_writers_recheck_the_receipt_after_begin_immediate_for_v3_and_legacy() {
    let (pool, path) = common::file_test_pool().await;
    let user = create_user(&pool, "waiting-writers").await;
    let app = app(&pool, user);
    for bytes in [
        FIXTURE.to_vec(),
        include_bytes!("fixtures/transfer_v2.json").to_vec(),
    ] {
        let key = Uuid::new_v4().to_string();
        // 両方のリクエストは WAL 経由で処理記録が未登録であることを読み取れるが、書き込みロックの取得前に
        // この独立した接続の処理を待つ必要がある。
        let blocker = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let start = |bytes: Vec<u8>| {
            let app = app.clone();
            let key = key.clone();
            tokio::spawn(async move { upload(&app, &bytes, Some(&key)).await })
        };
        let mut first = start(bytes.clone());
        let mut second = start(bytes.clone());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut first)
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut second)
                .await
                .is_err()
        );
        blocker.commit().await.unwrap();
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(first.0, StatusCode::OK);
        assert_eq!(second, first);
        let imported = snapshot(&pool, user).await;
        assert_eq!(upload(&app, &bytes, Some(&key)).await, first);
        assert_eq!(snapshot(&pool, user).await, imported);
    }
    assert_eq!(receipts(&pool, user).await, 2);
    assert_eq!(snapshot(&pool, user).await[3].len(), 4);
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn a_busy_writer_does_not_consume_the_key_and_can_retry_after_unlock() {
    let (pool, path) = common::file_test_pool().await;
    let user = create_user(&pool, "busy-retry").await;
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_millis(50));
    let requests = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .unwrap();
    let app = app(&requests, user);
    let key = Uuid::new_v4().to_string();
    let before = snapshot(&pool, user).await;
    let blocker = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    assert_eq!(
        upload(&app, FIXTURE, Some(&key)).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(snapshot(&pool, user).await, before);
    blocker.rollback().await.unwrap();
    assert_eq!(upload(&app, FIXTURE, Some(&key)).await.0, StatusCode::OK);
    assert_eq!(receipts(&pool, user).await, 1);
    requests.close().await;
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn equivalent_uuid_spellings_share_one_receipt_and_match_the_expected_owner() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "uuid-spellings").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4();
    let first = upload(&app, FIXTURE, Some(&key.to_string())).await;
    assert_eq!(first.0, StatusCode::OK);
    let before = snapshot(&pool, user).await;
    for value in [
        key.to_string().to_uppercase(),
        key.simple().to_string(),
        key.urn().to_string(),
        key.braced().to_string(),
    ] {
        let mut request = upload_request(FIXTURE, Some(&value), "UUID");
        request.headers_mut().insert(
            "X-Import-Account",
            HeaderValue::from_str(&user.to_string().to_uppercase()).unwrap(),
        );
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(snapshot(&pool, user).await, before);
    }
    let stored: String = sqlx::query_scalar(
        r#"
        SELECT
            request_id
        FROM json_import_receipt_model
        WHERE user_id = $1
        "#,
    )
    .bind(user.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, key.to_string());
}

#[tokio::test]
async fn a_database_failure_rolls_back_receipt_and_same_key_can_retry() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "failed-retry").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4().to_string();
    let before = snapshot(&pool, user).await;
    sqlx::raw_sql(
        r#"
        CREATE TRIGGER reject_import_answer
        BEFORE INSERT ON marker_form_submission_model
        BEGIN
            SELECT RAISE(ABORT, 'test failure');
        END;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        upload(&app, FIXTURE, Some(&key)).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(snapshot(&pool, user).await, before);
    sqlx::raw_sql(
        r#"
        DROP TRIGGER reject_import_answer;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(upload(&app, FIXTURE, Some(&key)).await.0, StatusCode::OK);
    assert_eq!(receipts(&pool, user).await, 1);
}

#[tokio::test]
async fn failure_to_record_completion_rolls_back_v3_and_legacy_data() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "receipt-failure").await;
    let app = app(&pool, user);
    for bytes in [
        FIXTURE,
        include_bytes!("fixtures/transfer_v2.json").as_slice(),
    ] {
        let key = Uuid::new_v4().to_string();
        let before = snapshot(&pool, user).await;
        sqlx::raw_sql(
            r#"
            CREATE TRIGGER reject_import_receipt
            BEFORE INSERT ON json_import_receipt_model
            BEGIN
                SELECT RAISE(ABORT, 'receipt failure');
            END;
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            upload(&app, bytes, Some(&key)).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(snapshot(&pool, user).await, before);
        sqlx::raw_sql(
            r#"
            DROP TRIGGER reject_import_receipt;
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(upload(&app, bytes, Some(&key)).await.0, StatusCode::OK);
    }
    assert_eq!(receipts(&pool, user).await, 2);
}

#[tokio::test]
async fn a_discarded_success_response_can_be_retried_without_another_import() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "lost-response").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4().to_string();
    let response = app
        .clone()
        .oneshot(upload_request(FIXTURE, Some(&key), "LOST"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response); // コミットは完了するが、クライアントは成功応答を受け取らない。
    let before = snapshot(&pool, user).await;
    let response = upload(&app, FIXTURE, Some(&key)).await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&response.1).unwrap(),
        json!({"message":"Upload Ok."})
    );
    assert_eq!(snapshot(&pool, user).await, before);
}

#[tokio::test]
async fn all_json_formats_support_retries_and_no_key_preserves_legacy_behavior() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "legacy-retries").await;
    let app = app(&pool, user);
    let v2: Value = serde_json::from_str(include_str!("fixtures/transfer_v2.json")).unwrap();
    let mut v1 = v2.clone();
    v1["version"] = json!(1);
    let mut unversioned = v2.clone();
    unversioned.as_object_mut().unwrap().remove("version");
    for package in [
        serde_json::from_slice(FIXTURE).unwrap(),
        v2.clone(),
        v1,
        unversioned,
        v2["markers"].clone(),
    ] {
        let bytes = package.to_string();
        let key = Uuid::new_v4().to_string();
        assert_eq!(
            upload(&app, bytes.as_bytes(), Some(&key)).await.0,
            StatusCode::OK
        );
        let imported = snapshot(&pool, user).await;
        assert_eq!(
            upload(&app, bytes.as_bytes(), Some(&key)).await.0,
            StatusCode::OK
        );
        assert_eq!(snapshot(&pool, user).await, imported);
        assert_eq!(upload(&app, bytes.as_bytes(), None).await.0, StatusCode::OK);
        let no_key = snapshot(&pool, user).await;
        assert_ne!(no_key, imported);
        assert_eq!(no_key[9], imported[9]);
    }
    assert_eq!(receipts(&pool, user).await, 5);
}

#[tokio::test]
async fn invalid_keys_or_invalid_files_do_not_consume_an_operation_key() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "invalid-key").await;
    let app = app(&pool, user);
    let before = snapshot(&pool, user).await;
    for key in [
        "",
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000,00000000-0000-0000-0000-000000000001",
    ] {
        assert_eq!(
            upload(&app, FIXTURE, Some(key)).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let key = Uuid::new_v4().to_string();
    let mut duplicate = upload_request(FIXTURE, Some(&key), "DUPLICATE");
    duplicate
        .headers_mut()
        .append("Idempotency-Key", HeaderValue::from_str(&key).unwrap());
    assert_eq!(
        app.clone().oneshot(duplicate).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        upload(&app, b"not JSON", Some(&key)).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid: Value = serde_json::from_slice(FIXTURE).unwrap();
    invalid["markers"][0]["layer_key"] = json!("missing");
    assert_eq!(
        upload(&app, invalid.to_string().as_bytes(), Some(&key))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&pool, user).await, before);
    assert_eq!(upload(&app, FIXTURE, Some(&key)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn browser_preflight_allows_the_idempotency_header() {
    let pool = common::test_pool().await;
    common::init_test_env();
    let app = geocode_web_single::router::build_router(
        pool,
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/file/import")
                .header(header::ORIGIN, "http://localhost:3000")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "content-type,idempotency-key,x-import-account",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_success());
    let allowed = response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .unwrap()
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    assert!(
        allowed
            .split(',')
            .any(|header| header.trim() == "idempotency-key")
    );
    assert!(
        allowed
            .split(',')
            .any(|header| header.trim() == "x-import-account")
    );
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap(),
        "http://localhost:3000"
    );
}

#[tokio::test]
async fn an_expected_account_must_match_and_invalid_account_headers_do_not_import() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "expected-account").await;
    let other = create_user(&pool, "different-account").await;
    let app = app(&pool, user);
    let before = snapshot(&pool, user).await;
    let key = Uuid::new_v4().to_string();
    let mut mismatch = upload_request(FIXTURE, Some(&key), "ACCOUNT");
    mismatch.headers_mut().insert(
        "X-Import-Account",
        HeaderValue::from_str(&other.to_string()).unwrap(),
    );
    let response = app.clone().oneshot(mismatch).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(error["error"].as_str().unwrap().contains("アカウント"));
    for value in ["", "not-a-uuid"] {
        let mut invalid = upload_request(FIXTURE, Some(&key), "ACCOUNT");
        invalid
            .headers_mut()
            .insert("X-Import-Account", HeaderValue::from_str(value).unwrap());
        assert_eq!(
            app.clone().oneshot(invalid).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }
    let mut duplicate = upload_request(FIXTURE, Some(&key), "ACCOUNT");
    for _ in 0..2 {
        duplicate.headers_mut().append(
            "X-Import-Account",
            HeaderValue::from_str(&user.to_string()).unwrap(),
        );
    }
    assert_eq!(
        app.clone().oneshot(duplicate).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&pool, user).await, before);
    let mut matching = upload_request(FIXTURE, Some(&key), "ACCOUNT");
    matching.headers_mut().insert(
        "X-Import-Account",
        HeaderValue::from_str(&user.to_string()).unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(matching).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(receipts(&pool, user).await, 1);
}

#[tokio::test]
async fn an_actual_master_binding_becomes_an_independent_managed_layer_on_import_and_replay() {
    let pool = common::test_pool().await;
    let source = create_user(&pool, "real-master-source").await;
    let recipient = create_user(&pool, "real-master-recipient").await;
    let sender = app(&pool, source);
    let receiver = app(&pool, recipient);
    assert_eq!(upload(&sender, FIXTURE, None).await.0, StatusCode::OK);
    // 転送先に既存の名前やフォームを再利用したり、変更したりしない。
    assert_eq!(upload(&receiver, FIXTURE, None).await.0, StatusCode::OK);
    let existing = snapshot(&pool, recipient).await;
    let master = common::master_layer_id(&pool, &source.to_string()).await;
    sqlx::query(
        r#"
        UPDATE layer_model
        SET
            common_form_id = (
                SELECT
                    id
                FROM common_form_model
                WHERE user_id = $1
                    AND form_title = '共通フォーム'
            ),
            common_form_version = 2
        WHERE id = $2
        "#,
    )
    .bind(source.to_string())
    .bind(master.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let marker: String = sqlx::query_scalar(
        r#"
        SELECT
            id
        FROM marker_info_model
        WHERE user_id = $1
            AND marker_name = '管理対象'
        "#,
    )
    .bind(source.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let shape: String = sqlx::query_scalar(
        r#"
        SELECT
            id
        FROM shape_model
        WHERE user_id = $1
            AND name = '管理図形'
        "#,
    )
    .bind(source.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE marker_info_model
        SET
            layer_id = $1
        WHERE id = $2
        "#,
    )
    .bind(master.to_string())
    .bind(marker.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE shape_model
        SET
            layer_id = $1
        WHERE id = $2
        "#,
    )
    .bind(master.to_string())
    .bind(shape.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE marker_form_config_model
        SET
            managed_layer_id = $1
        WHERE marker_id = $2
        "#,
    )
    .bind(master.to_string())
    .bind(marker.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE shape_form_config_model
        SET
            managed_layer_id = $1
        WHERE shape_id = $2
        "#,
    )
    .bind(master.to_string())
    .bind(shape.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let response = sender
        .oneshot(
            Request::builder()
                .uri(format!("/export/{master}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let package = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let key = Uuid::new_v4().to_string();
    assert_eq!(
        upload(&receiver, &package, Some(&key)).await.0,
        StatusCode::OK
    );
    let copied = snapshot(&pool, recipient).await;
    for (before, after) in existing.iter().zip(&copied) {
        assert!(
            before.iter().all(|row| after.contains(row)),
            "Existing rows must be unchanged"
        );
    }
    let copied_master: String = sqlx::query_scalar(
        r#"
        SELECT
            l.id
        FROM layer_model l
        JOIN marker_info_model m ON m.layer_id = l.id
        WHERE l.user_id = $1
            AND NOT l.is_master
            AND l.layer_name = (
            SELECT
                layer_name
            FROM layer_model
            WHERE id = $2
        )
            AND m.marker_name = '管理対象'
        "#,
    )
    .bind(recipient.to_string())
    .bind(master.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(
        copied_master,
        common::master_layer_id(&pool, &recipient.to_string()).await
    );
    let marker_bindings: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM marker_info_model m
        JOIN marker_form_config_model c ON c.marker_id = m.id
        JOIN layer_model l ON l.id = m.layer_id
        WHERE m.layer_id = $1
            AND c.managed_layer_id = l.id
            AND (c.source_form ->> 'id') = l.common_form_id
        "#,
    )
    .bind(copied_master.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let shape_bindings: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM shape_model s
        JOIN shape_form_config_model c ON c.shape_id = s.id
        JOIN layer_model l ON l.id = s.layer_id
        WHERE s.layer_id = $1
            AND c.managed_layer_id = l.id
            AND (c.source_form ->> 'id') = l.common_form_id
        "#,
    )
    .bind(copied_master.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((marker_bindings, shape_bindings), (1, 1));
    let answers: i64 = sqlx::query_scalar(
        r#"
        SELECT
            (
                SELECT
                    count(*)
                FROM marker_form_submission_model a
                JOIN marker_info_model m ON m.id = a.marker_id
                WHERE m.layer_id = $1
            ) + (
                SELECT
                    count(*)
                FROM shape_form_submission_model a
                JOIN shape_model s ON s.id = a.shape_id
                WHERE s.layer_id = $1
            )
        "#,
    )
    .bind(copied_master.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(answers, 4);
    assert_eq!(
        upload(&receiver, &package, Some(&key)).await.0,
        StatusCode::OK
    );
    assert_eq!(snapshot(&pool, recipient).await, copied);
}

#[tokio::test]
async fn failure_to_record_completion_also_rolls_back_all_imported_data() {
    let pool = common::test_pool().await;
    let user = create_user(&pool, "receipt-failure").await;
    let app = app(&pool, user);
    let key = Uuid::new_v4().to_string();
    let before = snapshot(&pool, user).await;
    sqlx::raw_sql(
        r#"
        CREATE TRIGGER reject_import_receipt
        BEFORE INSERT ON json_import_receipt_model
        BEGIN
            SELECT RAISE(ABORT, 'receipt failure');
        END;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        upload(&app, FIXTURE, Some(&key)).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(snapshot(&pool, user).await, before);
    sqlx::raw_sql(
        r#"
        DROP TRIGGER reject_import_receipt;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(upload(&app, FIXTURE, Some(&key)).await.0, StatusCode::OK);
    assert_eq!(receipts(&pool, user).await, 1);
}
