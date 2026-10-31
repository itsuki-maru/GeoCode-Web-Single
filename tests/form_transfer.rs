#[allow(dead_code)]
mod common;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Extension},
    http::{Request, StatusCode},
    routing::{get, post, put},
};
use geocode_web_single as project;
use serde_json::{Value, json};
use sqlx::SqlitePool as Pool;
use uuid::Uuid;

fn dbid(s: &str) -> String {
    s.to_string()
}
fn sql(s: &str) -> String {
    s.replace("::text", "")
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/transfer_v3.json")).unwrap()
}
fn app(pool: &Pool, user: &str) -> Router {
    Router::new()
        .route(
            "/answer/{kind}/{id}",
            get(project::handler::marker_forms::answer_edit_get_handler)
                .put(project::handler::marker_forms::answer_edit_update_handler),
        )
        .route(
            "/forms/{id}",
            put(project::handler::marker_forms::update_common_form_handler),
        )
        .route(
            "/input/{id}",
            get(project::handler::marker_forms::get_marker_input_handler),
        )
        .route(
            "/export/{id}",
            get(project::handler::files::export_json_handler),
        )
        .route(
            "/import",
            post(project::handler::files::import_json_handler),
        )
        .route(
            "/answers",
            post(project::handler::form_answers::search_answers_handler),
        )
        .layer(DefaultBodyLimit::max(21 * 1024 * 1024))
        .layer(Extension(dbid(user)))
        .layer(Extension(pool.clone()))
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    use tower::ServiceExt;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", content_type)
                .body(Body::from(bytes))
                .unwrap(),
        )
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
async fn upload_text(app: &Router, text: &str) -> StatusCode {
    let body = format!(
        "--TRANSFER\r\nContent-Disposition: form-data; name=\"file\"; filename=\"handoff.json\"\r\nContent-Type: application/json\r\n\r\n{text}\r\n--TRANSFER--\r\n"
    );
    let (status, bytes) = request(
        app,
        "POST",
        "/import",
        "multipart/form-data; boundary=TRANSFER",
        body.into_bytes(),
    )
    .await;
    if status != StatusCode::OK {
        eprintln!("Import {status}: {}", String::from_utf8_lossy(&bytes));
    }
    status
}
async fn upload(app: &Router, value: &Value) -> StatusCode {
    upload_text(app, &value.to_string()).await
}
async fn export(app: &Router, layer: &str, suffix: &str) -> Value {
    let (status, bytes) = request(
        app,
        "GET",
        &format!("/export/{layer}{suffix}"),
        "application/json",
        vec![],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}
async fn master(pool: &Pool, user: &str) -> String {
    sqlx::query_scalar(&sql(r#"
        SELECT id::text
        FROM layer_model
        WHERE user_id = $1 AND is_master = true
        "#))
    .bind(dbid(user))
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn count(pool: &Pool, table: &str, user: &str) -> i64 {
    sqlx::query_scalar(&format!(
        r#"
        SELECT
            count(*)
        FROM {table}
        WHERE user_id = $1
        "#,
    ))
    .bind(dbid(user))
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn named_id(pool: &Pool, table: &str, name_column: &str, name: &str, user: &str) -> String {
    sqlx::query_scalar(&sql(&format!(
        r#"
        SELECT id::text
        FROM {table}
        WHERE user_id = $1 AND {name_column} = $2
        "#
    )))
    .bind(dbid(user))
    .bind(name)
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn answers(app: &Router, query: Value) -> Value {
    let (status, bytes) = request(
        app,
        "POST",
        "/answers",
        "application/json",
        query.to_string().into_bytes(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn transfer_recreates_another_owners_forms_history_and_latest_answers() {
    let pool = common::test_pool().await;
    let owner = common::create_test_user(&pool, "transfer-source")
        .await
        .to_string();
    let recipient = common::create_test_user(&pool, "transfer-recipient")
        .await
        .to_string();
    let sender = app(&pool, &owner);
    assert_eq!(upload(&sender, &fixture()).await, StatusCode::OK);
    // Model an existing installation's public/password configuration. None of
    // these credentials may leave the source or become active on the recipient.
    let public = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        UPDATE marker_form_config_model
        SET
            enabled = true,
            password_hash = 'private-hash',
            public_id = $1
        WHERE marker_id = (
            SELECT
                id
            FROM marker_info_model
            WHERE user_id = $2
                AND marker_name = '管理対象'
        )
        "#,
    )
    .bind(dbid(&public))
    .bind(dbid(&owner))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE common_form_model
        SET
            password_hash = 'common-private-hash'
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let defaults: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM layer_model
        WHERE user_id = $1
            AND restrict_free_text = true
        "#,
    )
    .bind(dbid(&owner))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(defaults, 0, "older v3 input defaults to unrestricted");
    sqlx::query(
        r#"
        UPDATE layer_model
        SET
            restrict_free_text = true
        WHERE user_id = $1
            AND is_master = false
        "#,
    )
    .bind(dbid(&owner))
    .execute(&pool)
    .await
    .unwrap();
    let package = export(&sender, &master(&pool, &owner).await, "").await;
    assert_eq!(package["version"], 3);
    assert_eq!(package["layers"].as_array().unwrap().len(), 5);
    assert_eq!(package["common_forms"].as_array().unwrap().len(), 3);
    let text = package.to_string();
    for secret in [
        &public,
        "private-hash",
        "common-private-hash",
        "password_hash",
        "public_id",
        "enabled",
        &owner,
    ] {
        assert!(!text.contains(secret), "leaked {secret}");
    }
    let receiver = app(&pool, &recipient);
    assert_eq!(upload(&receiver, &package).await, StatusCode::OK);
    let copied = export(&receiver, &master(&pool, &recipient).await, "").await;
    let restrictions: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM layer_model
        WHERE user_id = $1
            AND restrict_free_text = true
        "#,
    )
    .bind(dbid(&recipient))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(restrictions, 4);
    assert!(
        copied["layers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["restrict_free_text"] == true)
            .count()
            >= 4
    );

    for collection in [
        "markers",
        "shapes",
        "common_forms",
        "form_configs",
        "submissions",
    ] {
        assert_eq!(
            copied[collection].as_array().unwrap().len(),
            package[collection].as_array().unwrap().len(),
            "{collection}"
        );
    }
    assert_eq!(count(&pool, "image_model", &recipient).await, 0);
    let foreign = request(
        &sender,
        "GET",
        &format!("/export/{}", master(&pool, &recipient).await),
        "application/json",
        vec![],
    )
    .await;
    assert_eq!(foreign.0, StatusCode::NOT_FOUND);
    let masters: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM layer_model
        WHERE user_id = $1
            AND is_master = true
        "#,
    )
    .bind(dbid(&recipient))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(masters, 1);
    let marker = copied["markers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["marker_name"] == "管理対象")
        .unwrap();
    assert_eq!(marker["detail"], fixture()["markers"][0]["detail"]);
    let shape = &copied["shapes"][0];
    assert_eq!(shape["geojson"], fixture()["shapes"][0]["geojson"]);
    for original in fixture()["submissions"].as_array().unwrap() {
        let copy = copied["submissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["rendered_markdown"] == original["rendered_markdown"])
            .unwrap();
        for field in ["submitted_values", "form_snapshot", "created_at"] {
            assert_eq!(copy[field], original[field], "{field}");
        }
    }
    let form = named_id(
        &pool,
        "common_form_model",
        "form_title",
        "共通フォーム",
        &recipient,
    )
    .await;
    let target = named_id(
        &pool,
        "marker_info_model",
        "marker_name",
        "管理対象",
        &recipient,
    )
    .await;
    let latest = answers(
        &receiver,
        json!({"mode":"latest","common_form_id":form,"target_type":"marker","target_id":target}),
    )
    .await;
    assert_eq!(latest["total"], 1);
    assert_eq!(latest["rows"][0]["submitted_values"]["n"], 0);
    assert_eq!(latest["rows"][0]["submitted_values"]["flag"], false);
    let old_version = answers(&receiver,json!({"mode":"latest","common_form_id":form,"target_type":"marker","target_id":target,"version":1})).await;
    assert_eq!(
        old_version["total"], 0,
        "filter must follow latest selection"
    );
    let private: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM marker_form_config_model c
        JOIN marker_info_model m ON m.id = c.marker_id
        WHERE m.user_id = $1
            AND (
            c.enabled = true
            OR c.password_hash IS NOT NULL
        )
        "#,
    )
    .bind(dbid(&recipient))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(private, 0);
    let signature = |page: Value| {
        page["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                json!([
                    row["target_type"],
                    row["target_name"],
                    row["submitted_values"],
                    row["form_snapshot"]
                ])
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        signature(answers(&sender, json!({"mode":"history"})).await),
        signature(answers(&receiver, json!({"mode":"history"})).await),
        "history priority across marker/shape tables must be preserved"
    );
    let distinct_layers: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM layer_model
        WHERE user_id = $1
            AND layer_name = '同名'
        "#,
    )
    .bind(dbid(&recipient))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(distinct_layers, 2);
    let managed: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM marker_form_config_model c
        JOIN marker_info_model m ON m.id = c.marker_id
        WHERE m.user_id = $1
            AND c.managed_layer_id = m.layer_id
        "#,
    )
    .bind(dbid(&recipient))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(managed, 1);
    let manual = copied["form_configs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["form_title"] == "手動の定義")
        .unwrap();
    assert!(manual["managed_layer_key"].is_null());
    assert_eq!(manual["source_form"]["version"], 1);
    assert_eq!(manual["form_schema"]["fields"].as_array().unwrap().len(), 2);
    let (status, bytes) = request(
        &receiver,
        "GET",
        &format!("/input/{target}"),
        "application/json",
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let input: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(input["values"]["n"], "0");
    assert_eq!(input["values"]["flag"], false);
    let update = json!({"version":2,"expected_managed_count":2,"enabled":false,"form_title":"引継ぎ後の共通フォーム","form_description":"説明","form_schema":fixture()["common_forms"][0]["form_schema"],"password_mode":"keep"});
    assert_eq!(
        request(
            &receiver,
            "PUT",
            &format!("/forms/{form}"),
            "application/json",
            update.to_string().into_bytes()
        )
        .await
        .0,
        StatusCode::OK
    );
    let updated: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM layer_model
        WHERE user_id = $1
            AND common_form_version = 3
        "#,
    )
    .bind(dbid(&recipient))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        updated, 2,
        "managed layer bindings must remain operational after transfer"
    );
    assert_eq!(upload(&receiver, &package).await, StatusCode::OK);
    assert_eq!(
        count(&pool, "marker_info_model", &recipient).await,
        6,
        "re-import creates independent objects"
    );
    // This portable export is also read by the SQLite cross-engine tests.
    std::fs::create_dir_all("target/transfer-tests").unwrap();
    std::fs::write("target/transfer-tests/sqlite-v3.json", text).unwrap();
}

#[tokio::test]
async fn transfer_scopes_exports_and_keeps_v2_and_legacy_inputs() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "transfer-legacy")
        .await
        .to_string();
    let app = app(&pool, &user);
    assert_eq!(upload(&app, &fixture()).await, StatusCode::OK);
    let layer: String = sqlx::query_scalar(&sql(r#"
        SELECT id::text
        FROM layer_model
        WHERE user_id = $1 AND common_form_id IS NOT NULL AND layer_name = '同名'
        "#))
    .bind(dbid(&user))
    .fetch_one(&pool)
    .await
    .unwrap();
    let scoped = export(&app, &layer, "").await;
    assert_eq!(scoped["layers"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["markers"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["shapes"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["submissions"].as_array().unwrap().len(), 4);
    assert_eq!(scoped["common_forms"].as_array().unwrap().len(), 2);
    let explicit = export(&app, &layer, "?version=3").await;
    assert_eq!(scoped["version"], 3);
    assert_eq!(explicit["version"], 3);
    assert_eq!(scoped["markers"], explicit["markers"]);
    for version in ["2", "1", "99"] {
        let (status, bytes) = request(
            &app,
            "GET",
            &format!("/export/{layer}?version={version}"),
            "application/json",
            vec![],
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["error"]
                .as_str()
                .unwrap()
                .contains("version 3")
        );
    }
    // A stored old export must remain readable without a v2 exporter.
    let v2: Value = serde_json::from_str(include_str!("fixtures/transfer_v2.json")).unwrap();
    let markers_before = count(&pool, "marker_info_model", &user).await;
    let shapes_before = count(&pool, "shape_model", &user).await;
    assert_eq!(upload(&app, &v2).await, StatusCode::OK);
    let mut v1 = v2.clone();
    v1["version"] = json!(1);
    assert_eq!(upload(&app, &v1).await, StatusCode::OK);
    let mut unversioned = v2.clone();
    unversioned.as_object_mut().unwrap().remove("version");
    assert_eq!(upload(&app, &unversioned).await, StatusCode::OK);
    assert_eq!(upload(&app, &v2["markers"]).await, StatusCode::OK);
    assert_eq!(
        count(&pool, "marker_info_model", &user).await,
        markers_before + 4
    );
    assert_eq!(count(&pool, "shape_model", &user).await, shapes_before + 3);
    let restored = export(&app, &master(&pool, &user).await, "").await;
    let legacy_marker = restored["markers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["marker_name"] == v2["markers"][0]["marker_name"])
        .unwrap();
    assert_eq!(legacy_marker["detail"], v2["markers"][0]["detail"]);
    assert_eq!(legacy_marker["latitude"], v2["markers"][0]["latitude"]);
    assert_eq!(legacy_marker["longitude"], v2["markers"][0]["longitude"]);
    let empty = named_id(&pool, "layer_model", "layer_name", "空管理レイヤ", &user).await;
    let empty = export(&app, &empty, "").await;
    assert_eq!(empty["layers"].as_array().unwrap().len(), 1);
    assert_eq!(empty["common_forms"].as_array().unwrap().len(), 1);
    assert!(empty["markers"].as_array().unwrap().is_empty());
    let (status, _) = request(
        &app,
        "GET",
        &format!("/export/{}", Uuid::new_v4()),
        "application/json",
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn transfer_rejects_bad_references_versions_limits_and_partial_requests() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "transfer-invalid")
        .await
        .to_string();
    let app = app(&pool, &user);
    for mutation in 0..9 {
        let mut p = fixture();
        match mutation {
            0 => p["version"] = json!(4),
            1 => p["markers"][0]["layer_key"] = json!("missing"),
            2 => p["submissions"][0]["source_form"]["version"] = json!(99),
            3 => p["layers"][1]["key"] = p["layers"][0]["key"].clone(),
            4 => p["submissions"][1]["source_order"] = p["submissions"][0]["source_order"].clone(),
            5 => p["form_configs"][0]["managed_layer_key"] = json!("l2"),
            6 => p["form_configs"][0]["password_hash"] = json!("must-not-import"),
            7 => {
                p["common_forms"][0]["revisions"][1]["form_schema"]["fields"][0]["type"] =
                    json!("text")
            },
            _ => p["form_configs"][2]["form_schema"]["fields"][0]["type"] = json!("date"),
        }
        assert_eq!(
            upload(&app, &p).await,
            StatusCode::BAD_REQUEST,
            "mutation {mutation}"
        );
        assert_eq!(count(&pool, "layer_model", &user).await, 1);
        assert_eq!(count(&pool, "common_form_model", &user).await, 0);
    }
    let mut large = fixture();
    large["markers"][0]["detail"] = json!("x".repeat(5 * 1024 * 1024));
    assert_eq!(
        upload(&app, &large).await,
        StatusCode::OK,
        "v3 accepts more than 5MiB"
    );
    let mut legacy = json!({"version":2,"markers":[]});
    legacy["padding"] = json!("x".repeat(5 * 1024 * 1024));
    assert_eq!(upload(&app, &legacy).await, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        upload_text(&app, &" ".repeat(20 * 1024 * 1024 + 1)).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let body = format!(
        "--TRANSFER\r\nContent-Disposition: form-data; name=\"a\"; filename=\"a.json\"\r\n\r\n{}\r\n--TRANSFER\r\nContent-Disposition: form-data; name=\"b\"; filename=\"b.json\"\r\n\r\n[]\r\n--TRANSFER--\r\n",
        fixture()
    );
    let before = count(&pool, "layer_model", &user).await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/import",
            "multipart/form-data; boundary=TRANSFER",
            body.into_bytes()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(count(&pool, "layer_model", &user).await, before);
}

#[tokio::test]
async fn transfer_rolls_back_all_records_on_database_failure() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "transfer-rollback")
        .await
        .to_string();
    sqlx::raw_sql(
        r#"
        CREATE TRIGGER reject_transfer_answer
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
        upload(&app(&pool, &user), &fixture()).await,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(count(&pool, "layer_model", &user).await, 1);
    assert_eq!(count(&pool, "common_form_model", &user).await, 0);
    assert_eq!(count(&pool, "marker_info_model", &user).await, 0);
}

#[tokio::test]
async fn transfer_enforces_exact_byte_boundaries_and_export_limits() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "transfer-boundaries")
        .await
        .to_string();
    let app = app(&pool, &user);
    let mut exact = fixture().to_string();
    exact.extend(std::iter::repeat_n(' ', 20 * 1024 * 1024 - exact.len()));
    assert_eq!(
        upload_text(&app, &exact).await,
        StatusCode::OK,
        "exactly 20MiB is accepted"
    );
    exact.push(' ');
    assert_eq!(
        upload_text(&app, &exact).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let mut legacy = "[]".to_string();
    legacy.extend(std::iter::repeat_n(' ', 5 * 1024 * 1024 - legacy.len()));
    assert_eq!(upload_text(&app, &legacy).await, StatusCode::OK);
    legacy.push(' ');
    assert_eq!(
        upload_text(&app, &legacy).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let target = named_id(&pool, "marker_info_model", "marker_name", "管理対象", &user).await;
    sqlx::query(
        r#"
        UPDATE marker_info_model
        SET
            detail = $1
        WHERE id = $2
        "#,
    )
    .bind("x".repeat(20 * 1024 * 1024))
    .bind(dbid(&target))
    .execute(&pool)
    .await
    .unwrap();
    let master = master(&pool, &user).await;
    for suffix in ["", "?version=3"] {
        let (status, bytes) = request(
            &app,
            "GET",
            &format!("/export/{master}{suffix}"),
            "application/json",
            vec![],
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            serde_json::from_slice::<Value>(&bytes)
                .unwrap()
                .get("error")
                .is_some(),
            "no truncated export"
        );
    }
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/export/{master}?version=99"),
            "application/json",
            vec![]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
#[ignore = "Run after PostgreSQL form_transfer tests"]
async fn postgres_export_can_be_recreated_in_sqlite() {
    let pool = common::test_pool().await;
    let package: Value = serde_json::from_slice(
        &std::fs::read("../target/transfer-tests/postgres-v3.json")
            .expect("run PostgreSQL form_transfer tests first"),
    )
    .unwrap();
    let user = common::create_test_user(&pool, "postgres-to-sqlite").await;
    let app = app(&pool, &user);
    assert_eq!(upload(&app, &package).await, StatusCode::OK);
    let copy = export(&app, &master(&pool, &user).await, "").await;
    let restricted_count = |p: &Value| {
        p["layers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["restrict_free_text"] == true)
            .count()
    };
    assert!(restricted_count(&package) > 0);
    assert_eq!(restricted_count(&copy), restricted_count(&package));

    for collection in [
        "markers",
        "shapes",
        "common_forms",
        "form_configs",
        "submissions",
    ] {
        assert_eq!(
            copy[collection].as_array().unwrap().len(),
            package[collection].as_array().unwrap().len(),
            "{collection}"
        );
    }
    for answer in package["submissions"].as_array().unwrap() {
        let copied = copy["submissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["rendered_markdown"] == answer["rendered_markdown"])
            .unwrap();
        for field in ["submitted_values", "form_snapshot", "created_at"] {
            assert_eq!(copied[field], answer[field], "{field}");
        }
    }
    assert_eq!(count(&pool, "image_model", &user).await, 0);
    std::fs::create_dir_all("target/transfer-tests").unwrap();
    std::fs::write(
        "target/transfer-tests/sqlite-cross-v3.json",
        copy.to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn transfer_preserves_latest_when_timezones_and_submicrosecond_times_collapse() {
    let pool = common::test_pool().await;
    let owner = common::create_test_user(&pool, "fine-time-source").await;
    let recipient = common::create_test_user(&pool, "fine-time-destination").await;
    let sender = app(&pool, &owner);
    assert_eq!(upload(&sender, &fixture()).await, StatusCode::OK);
    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET
            create_at = $1
        WHERE rendered_markdown = $2
        "#,
    )
    .bind("2026-10-20T12:34:56.123456900Z")
    .bind("元の回答Markdown 1")
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET
            create_at = $1
        WHERE rendered_markdown = $2
        "#,
    )
    .bind("2026-10-20T21:34:56.123456100+09:00")
    .bind("元の回答Markdown 2")
    .execute(&pool)
    .await
    .unwrap();
    let package = export(&sender, &master(&pool, &owner).await, "").await;
    let first = package["submissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["rendered_markdown"] == "元の回答Markdown 1")
        .unwrap();
    let second = package["submissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["rendered_markdown"] == "元の回答Markdown 2")
        .unwrap();
    assert_eq!(first["created_at"], second["created_at"]);
    assert!(first["source_order"].as_u64().unwrap() > second["source_order"].as_u64().unwrap());
    let receiver = app(&pool, &recipient);
    assert_eq!(upload(&receiver, &package).await, StatusCode::OK);
    for (app, user) in [(&sender, &owner), (&receiver, &recipient)] {
        let form = named_id(
            &pool,
            "common_form_model",
            "form_title",
            "共通フォーム",
            user,
        )
        .await;
        let target = named_id(&pool, "marker_info_model", "marker_name", "管理対象", user).await;
        let page = answers(app,json!({"mode":"latest","common_form_id":form,"target_type":"marker","target_id":target})).await;
        assert_eq!(page["rows"][0]["submitted_values"]["n"], 1);
    }
}

#[tokio::test]
async fn corrected_answers_and_body_bindings_survive_transfer_with_fresh_ids() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "edited-transfer")
        .await
        .to_string();
    let recipient = common::create_test_user(&pool, "edited-recipient")
        .await
        .to_string();
    let sender = app(&pool, &user);
    assert_eq!(upload(&sender, &fixture()).await, StatusCode::OK);
    let target = named_id(&pool, "marker_info_model", "marker_name", "管理対象", &user).await;
    let records: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT
            id,
            rendered_markdown
        FROM marker_form_submission_model
        WHERE marker_id = $1
        ORDER BY create_at, id
        "#,
    )
    .bind(dbid(&target))
    .fetch_all(&pool)
    .await
    .unwrap();
    let body = format!(
        "移行する自由記述\n{}",
        records.iter().map(|(_, m)| m.as_str()).collect::<String>()
    );
    sqlx::query(
        r#"
        UPDATE marker_info_model
        SET
            detail = $1
        WHERE id = $2
        "#,
    )
    .bind(&body)
    .bind(dbid(&target))
    .execute(&pool)
    .await
    .unwrap();
    let answer = records.first().unwrap().0.clone();
    let (status, bytes) = request(
        &sender,
        "GET",
        &format!("/answer/marker/{answer}"),
        "application/json",
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let edit: Value = serde_json::from_slice(&bytes).unwrap();
    let mut values = edit["values"].clone();
    values["n"] = json!("9007199254740993");
    let submission = json!({"revision":edit["revision"],"values":values});
    let body = format!(
        "--EDIT\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{submission}\r\n--EDIT--\r\n"
    );
    let (status, bytes) = request(
        &sender,
        "PUT",
        &format!("/answer/marker/{answer}"),
        "multipart/form-data; boundary=EDIT",
        body.into_bytes(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    sqlx::query(
        r#"
        UPDATE layer_model
        SET
            restrict_free_text = true
        WHERE id = (
            SELECT
                layer_id
            FROM marker_info_model
            WHERE id = $1
        )
        "#,
    )
    .bind(&target)
    .execute(&pool)
    .await
    .unwrap();
    let package = export(&sender, &master(&pool, &user).await, "").await;
    // The PostgreSQL cross-engine test consumes the edited SQLite export too.
    std::fs::create_dir_all("target/transfer-tests").unwrap();
    std::fs::write(
        "target/transfer-tests/sqlite-cross-v3.json",
        package.to_string(),
    )
    .unwrap();
    let exported = package["markers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["marker_name"] == "管理対象")
        .unwrap();
    assert!(exported["body_parts"].is_array());
    assert!(!package.to_string().contains(&answer.to_string()));
    let receiver = app(&pool, &recipient);
    assert_eq!(upload(&receiver, &package).await, StatusCode::OK);
    let copied = named_id(
        &pool,
        "marker_info_model",
        "marker_name",
        "管理対象",
        &recipient,
    )
    .await;
    let (copied_body, parts): (String, Value) = sqlx::query_as(
        r#"
        SELECT
            detail,
            form_body_parts
        FROM marker_info_model
        WHERE id = $1
        "#,
    )
    .bind(dbid(&copied))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(copied_body, exported["detail"].as_str().unwrap());
    assert!(!parts.to_string().contains(&answer.to_string()));
    let id: String = sqlx::query_scalar(
        r#"
        SELECT
            id
        FROM marker_form_submission_model
        WHERE marker_id = $1
            AND edited_at IS NOT NULL
        "#,
    )
    .bind(dbid(&copied))
    .fetch_one(&pool)
    .await
    .unwrap();
    let (_, bytes) = request(
        &receiver,
        "GET",
        &format!("/answer/marker/{id}"),
        "application/json",
        vec![],
    )
    .await;
    let edit: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(edit["body_info"]["sync_required"], false);
    assert_eq!(edit["values"]["n"].as_str(), Some("9007199254740993"));
    let mut bad = package.clone();
    let key = exported["key"].clone();
    let target = bad["markers"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|m| m["key"] == key)
        .unwrap();
    target["body_parts"][0] = json!({"type":"answer","key":"missing"});
    assert_eq!(upload(&receiver, &bad).await, StatusCode::BAD_REQUEST);
}
