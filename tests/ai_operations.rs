//! 確認済み永続操作の認可・改ざん防止・再送を、隔離DB上で検証する。
#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use geocode_web_single::{ai::settings::AiConfig, auth::create_token};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;

// 同時2要求のテストが、別テストの全体同時実行枠を消費しないようにする。
static TEST_LOCK: Mutex<()> = Mutex::const_new(());

fn app(pool: &SqlitePool) -> Router {
    geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    )
}

async fn request(
    app: &Router,
    user: Option<&str>,
    actor: Option<&str>,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(user) = user {
        builder = builder.header(
            "cookie",
            format!(
                "access_token={}",
                create_token(&user.to_owned(), 30, "access_token", 0).unwrap()
            ),
        );
    }
    if let Some(actor) = actor {
        builder = builder.header("x-ai-account-id", actor.to_string());
    }
    let body = if method == "GET" {
        Body::empty()
    } else {
        builder = builder.header("content-type", "application/json");
        Body::from(body.to_string())
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store", "{path}");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn setup(pool: &SqlitePool, name: &str) -> (Router, String, Uuid) {
    let user = common::create_test_user(pool, name).await;
    let revision = Uuid::new_v4();
    let config = AiConfig {
        enabled: true,
        write_enabled: true,
        model: "test-model".into(),
        max_requests_per_minute: 60,
        ..Default::default()
    };
    sqlx::query("INSERT INTO ai_settings(id,revision,config) VALUES(1,$1,$2)")
        .bind(revision.to_string())
        .bind(sqlx::types::Json(config))
        .execute(pool)
        .await
        .unwrap();
    (app(pool), user, revision)
}

fn prepare(id: Uuid, revision: Uuid, name: &str) -> Value {
    json!({
        "operation_id":id,"protocol_version":2,"revision":revision,
        "action":{"type":"create_layer","name":name},
        "context":{"layer_ids":null},"state":{}
    })
}

fn commit(id: Uuid, revision: Uuid) -> Value {
    json!({"operation_id":id,"protocol_version":2,"revision":revision,"context":{"layer_ids":null}})
}

async fn layer_count(pool: &SqlitePool, user: &str, name: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM layer_model WHERE user_id=$1 AND layer_name=$2")
        .bind(&user)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn confirmed_layer_creation_is_exactly_once_and_remains_queryable_when_disabled() {
    // 複数接続のWAL DBで同じ操作IDの同時確定を検証する。
    let (pool, path) = common::file_test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let (app, user, revision) = setup(&pool, "operation-retry").await;
    let id = Uuid::new_v4();
    let mut body = prepare(id, revision, "調査 & 台帳");
    body["state"] = json!({"filter":{"type":"filter","expression":{"op":"text","query1":"UNUSED-STATE-SECRET"}}});
    let (status, preview) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/prepare",
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["status"], "prepared");
    assert_eq!(preview["summary"]["name"], "調査 & 台帳");
    assert_eq!(layer_count(&pool, &user, "調査 & 台帳").await, 0);
    let payload: Value = sqlx::query_scalar("SELECT payload FROM ai_operation_model WHERE id=$1")
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!payload.to_string().contains("UNUSED-STATE-SECRET"));
    let (first, second) = tokio::join!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/commit",
            commit(id, revision)
        ),
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/commit",
            commit(id, revision)
        )
    );
    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    assert_eq!(second.0, StatusCode::OK, "{}", second.1);
    assert_eq!(first.1, second.1);
    assert_eq!(layer_count(&pool, &user, "調査 & 台帳").await, 1);
    sqlx::query(
        r#"
        UPDATE ai_settings
        SET config = json_set(config, '$.enabled', json('false')), revision = $1
        WHERE id = 1
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .execute(&pool)
    .await
    .unwrap();
    let (status, repeated) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/commit",
        commit(id, revision),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(repeated, first.1);
    let (status, prepared_again) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/prepare",
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(prepared_again, first.1);
    let (status, result) = request(
        &app,
        Some(&user),
        Some(&user),
        "GET",
        &format!("/ai/operations/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result, first.1);
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn operation_ids_are_owner_scoped_and_confirmation_payloads_cannot_be_changed() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let (app, user, revision) = setup(&pool, "operation-owner").await;
    let other = common::create_test_user(&pool, "operation-other").await;
    let id = Uuid::new_v4();
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/prepare",
            prepare(id, revision, "元の名称")
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, _) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/prepare",
        prepare(id, revision, "差替名称"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    for (method, path, body) in [
        ("GET", format!("/ai/operations/{id}"), Value::Null),
        ("POST", "/ai/operations/commit".into(), commit(id, revision)),
        (
            "POST",
            "/ai/operations/prepare".into(),
            prepare(id, revision, "元の名称"),
        ),
    ] {
        assert_eq!(
            request(&app, Some(&other), Some(&other), method, &path, body)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    let mut changed = commit(id, revision);
    changed["name"] = json!("差替名称");
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/commit",
            changed
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut changed = commit(id, revision);
    changed["context"] = json!({"layer_ids":[]});
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/commit",
            changed
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(layer_count(&pool, &user, "元の名称").await, 0);
    assert_eq!(layer_count(&pool, &user, "差替名称").await, 0);
}

#[tokio::test]
async fn operations_require_login_matching_actor_protocol_and_explicit_write_permission() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let (app, user, revision) = setup(&pool, "operation-auth").await;
    let id = Uuid::new_v4();
    let body = prepare(id, revision, "保護対象");
    for (method, path, body) in [
        ("POST", "/ai/operations/prepare".to_owned(), body.clone()),
        (
            "POST",
            "/ai/operations/commit".to_owned(),
            commit(id, revision),
        ),
        ("GET", format!("/ai/operations/{id}"), Value::Null),
    ] {
        assert_eq!(
            request(&app, None, None, method, &path, body.clone())
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &app,
                Some(&user),
                Some(&Uuid::new_v4().to_string()),
                method,
                &path,
                body
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    let mut old_protocol = body.clone();
    old_protocol["protocol_version"] = json!(1);
    let mut unknown = body.clone();
    unknown["action"] = json!({"type":"delete_layer","name":"保護対象"});
    for forbidden in [old_protocol, unknown] {
        let (status, error) = request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/prepare",
            forbidden,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(error["code"], "ai_operation_not_allowed");
        assert_eq!(error["error"], "要求された操作は許可されていません。");
    }
    sqlx::query("UPDATE ai_settings SET config=json_remove(config,'$.writeEnabled') WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    let (status, error) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/prepare",
        body,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["error"], "要求された操作は許可されていません。");
    assert_eq!(layer_count(&pool, &user, "保護対象").await, 0);
}

#[tokio::test]
async fn policy_changes_expiration_and_foreign_scope_prevent_uncommitted_writes() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let (app, user, revision) = setup(&pool, "operation-policy").await;
    let other = common::create_test_user(&pool, "operation-foreign").await;
    let foreign_layer = common::master_layer_id(&pool, &other).await;
    let id = Uuid::new_v4();
    let mut foreign = prepare(id, revision, "作成しない");
    foreign["context"] = json!({"layer_ids":[foreign_layer]});
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/prepare",
            foreign
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/prepare",
            prepare(id, revision, "作成しない")
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query(
        "UPDATE ai_settings SET config=json_set(config,'$.writeEnabled',json('false')) WHERE id=1",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/commit",
            commit(id, revision)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query(
        r#"
        UPDATE ai_settings
        SET config = json_set(config, '$.writeEnabled', json('true')), revision = $1
        WHERE id = 1
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/commit",
            commit(id, revision)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE ai_settings SET revision=$1 WHERE id=1")
        .bind(revision.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE ai_operation_model SET expires_at=datetime('now','-1 second') WHERE id=$1")
        .bind(id.to_string())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/commit",
            commit(id, revision)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, view) = request(
        &app,
        Some(&user),
        Some(&user),
        "GET",
        &format!("/ai/operations/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(view["status"], "expired");
    assert_eq!(layer_count(&pool, &user, "作成しない").await, 0);
}

#[tokio::test]
async fn saving_uses_the_confirmed_complete_definition_and_never_accepts_write_actions() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let (app, user, revision) = setup(&pool, "operation-save").await;
    let id = Uuid::new_v4();
    let definition = json!({"type":"filter","expression":{"op":"or","children":[{"op":"text","query1":"避難 所"},{"op":"not","child":{"op":"text","query1":"廃止"}}]}});
    let canonical = serde_json::to_value(
        serde_json::from_value::<geocode_web_single::ai::actions::AiAction>(definition.clone())
            .unwrap(),
    )
    .unwrap();
    let body = json!({
        "operation_id":id,"protocol_version":2,"revision":revision,"context":{"layer_ids":null},
        "action":{"type":"save_preset","name":"防災条件","kind":"filter"},"state":{"filter":definition}
    });
    let (status, preview) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/prepare",
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["summary"]["definition"], canonical);
    let (status, saved) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/commit",
        commit(id, revision),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let stored: (i32, Value, String) = sqlx::query_as(
        r#"
        SELECT
            schema_version,
            definition,
            user_id
        FROM answer_map_saved_condition_model
        WHERE id = $1
        "#,
    )
    .bind(saved["result"]["id"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, (2, canonical, user.clone()));
    let mut malicious = body;
    malicious["operation_id"] = json!(Uuid::new_v4());
    malicious["state"]["filter"] = json!({"type":"create_layer","name":"迂回作成"});
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/prepare",
            malicious
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(layer_count(&pool, &user, "迂回作成").await, 0);
}

#[tokio::test]
async fn deleted_forms_are_revalidated_at_confirmation_without_saving_a_stale_definition() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let (app, user, revision) = setup(&pool, "operation-fields").await;
    let form = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO common_form_model (
            id,
            user_id,
            form_title,
            form_description,
            form_schema,
            create_at,
            update_at
        )
        VALUES ($1, $2, '台帳', '', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(form.to_string())
    .bind(&user)
    .bind(json!({"fields":[{"id":"age","label":"耐用年数","type":"number"}]}))
    .execute(&pool)
    .await
    .unwrap();
    let id = Uuid::new_v4();
    let body = json!({
        "operation_id":id,"protocol_version":2,"revision":revision,"context":{"layer_ids":null},
        "action":{"type":"save_preset","name":"古いフォーム条件","kind":"filter"},
        "state":{"filter":{"type":"filter","expression":{"op":"attribute","common_form_id":form,"conditions":[{"field_id":"age","field_type":"number","op":"gte","value":"10"}]}}}
    });
    let (status, view) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/prepare",
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    sqlx::query("DELETE FROM common_form_model WHERE id=$1")
        .bind(form.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (status, error) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/operations/commit",
        commit(id, revision),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{error}");
    let saved: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM answer_map_saved_condition_model WHERE user_id=$1",
    )
    .bind(&user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(saved, 0);
}
