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
    request_with_expected_account(app, user, actor, method, path, body).await
}

async fn request_with_expected_account(
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
    let body = if status == StatusCode::NO_CONTENT && bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
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

// 別タブでCookieが切り替わっても、画面Aの下書きを利用者Bへ保存・一覧表示・削除しない。
#[tokio::test]
async fn manual_preset_crud_checks_optional_actor_before_accessing_cookie_account() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let original_user = common::create_test_user(&pool, "preset-original-actor").await;
    let cookie_user = common::create_test_user(&pool, "preset-cookie-actor").await;
    let app = app(&pool);
    let original_header = original_user.to_string();
    let cookie_header = cookie_user.to_string();
    let base = "/form-answers/map-presets";
    let definition = json!({"type":"filter","expression":{
        "op":"text","query1":"Cookie利用者だけの非公開条件","query2":""
    }});
    let all_filter = json!({
        "name":"Cookie利用者だけの非公開条件1","kind":"filter","schema_version":2,
        "definition":{"type":"filter","expression":{"op":"all"}}
    });
    let text_filter = json!({
        "name":"Cookie利用者だけの非公開条件2","kind":"filter","schema_version":2,
        "definition":definition
    });
    // AIが未設定でも、正しいヘッダーを付けた利用者の明示保存は従来どおり利用できる。
    let mut saved_ids = vec![];
    for body in [all_filter.clone(), text_filter.clone()] {
        let (status, saved) = request_with_expected_account(
            &app,
            Some(&cookie_user),
            Some(&cookie_header),
            "POST",
            base,
            body,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{saved}");
        saved_ids.push(saved["id"].as_str().unwrap().to_owned());
    }
    let original_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM answer_map_saved_condition_model WHERE user_id=$1",
    )
    .bind(&cookie_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(original_count, 2);
    let delete_path = format!("{base}/{}", saved_ids[0]);

    for expected_actor in [original_header.as_str(), "not-the-cookie-account", ""] {
        for (method, path, body) in [
            ("POST", base.to_string(), text_filter.clone()),
            ("GET", format!("{base}?versions=1,2"), Value::Null),
            ("DELETE", delete_path.clone(), Value::Null),
        ] {
            let (status, error) = request_with_expected_account(
                &app,
                Some(&cookie_user),
                Some(expected_actor),
                method,
                &path,
                body,
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "{method}: {error}");
            assert_eq!(error, json!({"error":"ai_account_changed"}));
            assert!(!error.to_string().contains("Cookie利用者だけの非公開条件"));
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM answer_map_saved_condition_model WHERE user_id=$1",
            )
            .bind(&cookie_user)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, original_count, "拒否した要求ごとに行を変更しない");
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM answer_map_saved_condition_model WHERE user_id=$1",
        )
        .bind(&cookie_user)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            count, original_count,
            "拒否した保存・削除では行を変更しない"
        );
    }
    // 一致するアカウントヘッダーを付けた場合も、省略した場合もversion 2を取得できる。
    for expected_actor in [Some(cookie_header.as_str()), None] {
        let (status, list) = request_with_expected_account(
            &app,
            Some(&cookie_user),
            expected_actor,
            "GET",
            &format!("{base}?versions=1,2"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["total"], original_count);
        assert_eq!(
            list["items"].as_array().unwrap().len(),
            original_count as usize
        );
    }
    for body in [all_filter, text_filter] {
        let (status, saved) =
            request_with_expected_account(&app, Some(&cookie_user), None, "POST", base, body).await;
        assert_eq!(status, StatusCode::CREATED, "{saved}");
        assert_eq!(
            request_with_expected_account(
                &app,
                Some(&cookie_user),
                None,
                "DELETE",
                &format!("{base}/{}", saved["id"].as_str().unwrap()),
                Value::Null,
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
    }
    for id in saved_ids {
        assert_eq!(
            request_with_expected_account(
                &app,
                Some(&cookie_user),
                Some(&cookie_header),
                "DELETE",
                &format!("{base}/{id}"),
                Value::Null,
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
    }
    let final_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM answer_map_saved_condition_model WHERE user_id=$1",
    )
    .bind(&cookie_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(final_count, 0);
}

async fn edited_form(pool: &SqlitePool, owner: &str, title: &str) -> Uuid {
    let form = Uuid::new_v4();
    let schema = json!({"fields":[
        {"id":"n","label":"精密数値","type":"number"},
        {"id":"state","label":"材質","type":"select","choices":["現行材"]}
    ]});
    let historic = json!({"fields":[
        {"id":"state","label":"旧材質","type":"select","choices":["旧材"]}
    ]});
    sqlx::query(
        r#"
        INSERT INTO common_form_model (
            id,
            user_id,
            version,
            form_title,
            form_description,
            form_schema,
            create_at,
            update_at
        ) VALUES ($1, $2, 2, $3, '', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(form.to_string())
    .bind(owner)
    .bind(title)
    .bind(schema.clone())
    .execute(pool)
    .await
    .unwrap();
    for (version, schema) in [(1, historic), (2, schema)] {
        sqlx::query(
            r#"
            INSERT INTO common_form_revision_model (
                form_id,
                version,
                form_schema
            ) VALUES ($1, $2, $3)
            "#,
        )
        .bind(form.to_string())
        .bind(version)
        .bind(schema)
        .execute(pool)
        .await
        .unwrap();
    }
    form
}

fn edited_filter(form: Uuid, condition: Value) -> Value {
    json!({"type":"filter","expression":{
        "op":"attribute","common_form_id":form,"conditions":[condition]
    }})
}

fn edited_coloring(form: Uuid, condition: Value) -> Value {
    json!({"type":"color","common_form_id":form,"rules":[{
        "id":"edited-rule","label":"分類","color":"#112233","conditions":[condition]
    }]})
}

fn edited_execution(revision: Uuid, action: Value) -> Value {
    json!({
        "protocol_version":2,"revision":revision,
        "context":{"layer_ids":null},"action":action
    })
}

// 編集後の定義も、保存条件と同じ検証を通す。LLM接続・APIキー・永続操作は不要。
#[tokio::test]
async fn edited_definitions_validate_current_and_historic_fields_before_local_execution() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let (app, user, revision) = setup(&pool, "edited-definition-owner").await;
    let other = common::create_test_user(&pool, "edited-definition-other").await;
    let first = edited_form(&pool, &user, "編集用フォーム").await;
    let second = edited_form(&pool, &user, "別の編集用フォーム").await;
    let foreign = edited_form(&pool, &other, "他者の非公開フォーム").await;
    let mut config = AiConfig {
        enabled: true,
        write_enabled: false,
        // providerへ接続する実装へ変わった場合は、外部通信前に失敗する接続先。
        base_url: "local-execution-must-not-call-provider".into(),
        model: "test-model".into(),
        max_requests_per_minute: 60,
        ..Default::default()
    };
    sqlx::query("UPDATE ai_settings SET config=$1 WHERE id=1")
        .bind(sqlx::types::Json(config.clone()))
        .execute(&pool)
        .await
        .unwrap();
    let historic = json!({
        "field_id":"state","field_type":"select","op":"in","value":["旧材"],"upper":null
    });
    let numeric = json!({
        "field_id":"n","field_type":"number","op":"gte",
        "value":"9007199254740993.000000000001","upper":null
    });
    let compound = json!({"type":"filter","expression":{"op":"and","children":[
        {"op":"or","children":[
            {"op":"attribute","common_form_id":first,"conditions":[historic.clone()]},
            {"op":"attribute","common_form_id":second,"conditions":[numeric]}
        ]},
        {"op":"not","child":{"op":"text","query1":"廃止","query2":""}}
    ]}});
    // OR・NOT・複数フォーム・過去の選択肢・精密数値を変換せず実行できる。
    for action in [compound.clone(), edited_coloring(first, historic.clone())] {
        let (status, result) = request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/assist/execute",
            edited_execution(revision, action.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["definition"], action);
        assert_eq!(result["target_count"], 0);
    }

    let bad_conditions = [
        json!({"field_id":"state","field_type":"select","op":"in","value":["存在しない材質"],"upper":null}),
        json!({"field_id":"state","field_type":"text","op":"eq","value":"現行材","upper":null}),
        json!({"field_id":"unknown","field_type":"number","op":"gte","value":"1","upper":null}),
        // f64では同じ値になる逆転範囲も、DB版ごとの厳密な十進数比較で拒否する。
        json!({"field_id":"n","field_type":"number","op":"between",
            "value":"9007199254740993.000000000002","upper":"9007199254740993.000000000001"}),
    ];
    for condition in bad_conditions {
        for action in [
            edited_filter(first, condition.clone()),
            edited_coloring(first, condition),
        ] {
            let (status, error) = request(
                &app,
                Some(&user),
                Some(&user),
                "POST",
                "/ai/assist/execute",
                edited_execution(revision, action),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        }
    }
    // 部分的に実行可能でも、複合式中の不正な選択肢を無視して適用しない。
    let mut invalid_compound = compound.clone();
    invalid_compound["expression"]["children"][0]["children"][0]["conditions"][0]["value"] =
        json!(["存在しない材質"]);
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/assist/execute",
            edited_execution(revision, invalid_compound)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for form in [foreign, Uuid::new_v4()] {
        for action in [
            edited_filter(form, historic.clone()),
            edited_coloring(form, historic.clone()),
        ] {
            let (status, error) = request(
                &app,
                Some(&user),
                Some(&user),
                "POST",
                "/ai/assist/execute",
                edited_execution(revision, action),
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{error}");
            assert!(!error.to_string().contains("他者の非公開フォーム"));
        }
    }

    // 編集後の直接実行でも、既存の設定版・アカウント・レイヤー境界を維持する。
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/assist/execute",
            edited_execution(Uuid::new_v4(), compound.clone())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&other),
            "POST",
            "/ai/assist/execute",
            edited_execution(revision, compound.clone())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let foreign_layer = common::master_layer_id(&pool, &other).await;
    let mut foreign_scope = edited_execution(revision, compound.clone());
    foreign_scope["context"]["layer_ids"] = json!([foreign_layer]);
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/assist/execute",
            foreign_scope
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // 名前を付けた手動保存は既存APIを使い、AIチャットの自動保存だけwriteEnabledで制限する。
    let (status, saved) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/form-answers/map-presets",
        json!({"name":"編集して別名保存","kind":"filter","schema_version":2,"definition":compound}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    assert_eq!(saved["schema_version"], 2);
    assert_eq!(saved["definition"], compound);
    let automatic = json!({
        "operation_id":Uuid::new_v4(),"protocol_version":2,"revision":revision,
        "context":{"layer_ids":null},
        "action":{"type":"save_preset","name":"自動では保存しない","kind":"filter"},
        "state":{"filter":compound}
    });
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/operations/prepare",
            automatic
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, reapplied) = request(
        &app,
        Some(&user),
        Some(&user),
        "POST",
        "/ai/assist/execute",
        edited_execution(
            revision,
            json!({"type":"apply_preset","preset_id":saved["id"]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reapplied}");
    assert_eq!(reapplied["definition"], compound);
    let operations: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_operation_model")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(operations, 0);

    config.enabled = false;
    sqlx::query("UPDATE ai_settings SET config=$1 WHERE id=1")
        .bind(sqlx::types::Json(config))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Some(&user),
            Some(&user),
            "POST",
            "/ai/assist/execute",
            edited_execution(revision, compound)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
