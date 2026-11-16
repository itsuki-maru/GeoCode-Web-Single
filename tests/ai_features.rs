//! SQLiteの設定保存・認証境界・所有者制約と既存AI操作の互換性を検証する。
#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use geocode_web_single::{
    ai::{
        actions::{AiAction, execute_action},
        settings::AiConfig,
    },
    auth::create_token,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;
use uuid::Uuid;

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
    method: &str,
    uri: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(user) = user {
        builder = builder.header("x-ai-account-id", user.to_string());
        builder = builder.header(
            "cookie",
            format!(
                "access_token={}",
                create_token(&user.to_owned(), 30, "access_token", 0).unwrap()
            ),
        );
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    if status.is_success() {
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .map(|v| v.to_str().unwrap()),
            Some("no-store")
        );
    }
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn ai_routes_require_login_admin_and_enabled_state() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "ai-reader").await;
    let admin = common::create_test_admin(&pool, "ai-admin").await;
    let app = app(&pool);
    assert_eq!(
        request(&app, None, "GET", "/ai/capabilities", Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, Some(&user), "GET", "/admin/ai-settings", Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, capabilities) =
        request(&app, Some(&user), "GET", "/ai/capabilities", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        capabilities,
        json!({"enabled":false,"voice_enabled":false,"revision":null,"protocol_version":2,"write_enabled":false})
    );
    let (_, settings) = request(&app, Some(&admin), "GET", "/admin/ai-settings", Value::Null).await;
    assert_eq!(settings["enabled"], false);
    assert!(settings.get("apiKey").is_none());
    let chat = json!({"message":"学校を検索して","context":{"layer_ids":null}});
    assert_eq!(
        request(&app, Some(&user), "POST", "/ai/chat", chat).await.0,
        StatusCode::FORBIDDEN
    );
    let body =
        json!({"action":{"type":"reset"},"revision":Uuid::new_v4(),"context":{"layer_ids":null}});
    assert_eq!(
        request(&app, Some(&user), "POST", "/ai/execute", body)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn every_ai_route_requires_authentication_and_all_settings_routes_require_admin() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "ai-permissions-reader").await;
    let app = app(&pool);
    let routes = [
        ("GET", "/admin/ai-settings"),
        ("PUT", "/admin/ai-settings"),
        ("POST", "/admin/ai-settings/check"),
        ("GET", "/ai/capabilities"),
        ("POST", "/ai/chat"),
        ("POST", "/ai/suggestions"),
        ("POST", "/ai/execute"),
        ("POST", "/ai/transcribe"),
        ("POST", "/ai/assist/execute"),
        ("POST", "/ai/operations/prepare"),
        ("POST", "/ai/operations/commit"),
        ("GET", "/ai/operations/00000000-0000-0000-0000-000000000001"),
    ];
    for (method, path) in routes {
        assert_eq!(
            request(&app, None, method, path, json!({})).await.0,
            StatusCode::UNAUTHORIZED,
            "{method} {path}",
        );
        if path.starts_with("/admin/") {
            assert_eq!(
                request(&app, Some(&user), method, path, json!({})).await.0,
                StatusCode::FORBIDDEN,
                "{method} {path}",
            );
        }
    }

    for (version, locked) in [(1, false), (0, true)] {
        sqlx::query("UPDATE user_model SET auth_version=$1,is_locked=$2 WHERE id=$3")
            .bind(version)
            .bind(locked)
            .bind(&user)
            .execute(&pool)
            .await
            .unwrap();
        for (method, path) in routes {
            assert_eq!(
                request(&app, Some(&user), method, path, json!({})).await.0,
                StatusCode::UNAUTHORIZED,
                "失効・ロック済みアカウント: {method} {path}",
            );
        }
    }
}

#[tokio::test]
async fn settings_are_revisioned_and_cloud_enable_requires_a_key() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "ai-config-admin").await;
    let app = app(&pool);
    let (_, initial) = request(&app, Some(&admin), "GET", "/admin/ai-settings", Value::Null).await;
    let mut input = initial.clone();
    input["model"] = json!("test-model");
    let (status, saved) = request(
        &app,
        Some(&admin),
        "PUT",
        "/admin/ai-settings",
        input.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert!(saved["revision"].is_string());
    assert_eq!(
        request(&app, Some(&admin), "PUT", "/admin/ai-settings", input)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let config: String = sqlx::query_scalar("SELECT config FROM ai_settings WHERE id=1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!config.to_string().contains("apiKey"));
    let mut next = saved;
    next["enabled"] = json!(true);
    next["clearApiKey"] = json!(true);
    assert_eq!(
        request(&app, Some(&admin), "PUT", "/admin/ai-settings", next)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

async fn fixture(pool: &SqlitePool) -> (String, Uuid, Uuid, Vec<Uuid>) {
    let user = common::create_test_user(pool, "ai-query-owner").await;
    let other = common::create_test_user(pool, "ai-query-other").await;
    let layer = Uuid::parse_str(&common::master_layer_id(pool, &user).await).unwrap();
    let form = Uuid::new_v4();
    let schema = json!({"fields":[{"id":"age","label":"耐用年数","type":"number"},{"id":"built","label":"建設年月日","type":"date"}]});
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
        VALUES ($1, $2, '施設台帳', '', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(form.to_string())
    .bind(&user)
    .bind(&schema)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO common_form_revision_model(form_id,version,form_schema) VALUES($1,1,$2)",
    )
    .bind(form.to_string())
    .bind(&schema)
    .execute(pool)
    .await
    .unwrap();
    let mut ids = vec![];
    for (name, years, date) in [
        ("学校", Some(10), "2010-12-31"),
        ("病院", Some(20), "2011-01-01"),
        ("公園", None, ""),
    ] {
        let id = Uuid::new_v4();
        ids.push(id);
        sqlx::query(
            r#"
            INSERT INTO marker_info_model (
                id,
                user_id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail,
                create_at,
                update_at
            )
            VALUES ($1, $2, $3, $4, 35, 139, '送信しない秘密の本文', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            "#,
        )
        .bind(id.to_string())
        .bind(&user)
        .bind(layer.to_string())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
        if let Some(years) = years {
            sqlx::query(
                r#"
                INSERT INTO marker_form_submission_model (
                    id,
                    marker_id,
                    submitted_values,
                    rendered_markdown,
                    create_at,
                    source_form,
                    form_snapshot
                )
                VALUES ($1, $2, $3, '', datetime('now', '-1 minute'), $4, $5)
                "#,
            )
            .bind(Uuid::new_v4().to_string())
            .bind(id.to_string())
            .bind(json!({"age":years,"built":date}))
            .bind(json!({"id":form,"version":1}))
            .bind(json!({"form_title":"施設台帳","form_schema":schema}))
            .execute(pool)
            .await
            .unwrap();
        }
    }
    let other_layer = common::master_layer_id(pool, &other).await;
    sqlx::query(r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        )
        VALUES ($1, $2, $3, '学校', 35, 139, 'FOREIGN_PRIVATE_RECORD_2f70', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#)
        .bind(Uuid::new_v4().to_string()).bind(&other).bind(other_layer.to_string()).execute(pool).await.unwrap();
    (user, form, layer, ids)
}

#[tokio::test]
async fn generic_queries_use_owned_data_and_have_explicit_missing_semantics() {
    let pool = common::test_pool().await;
    let (user, form, layer, ids) = fixture(&pool).await;
    let attr = json!({"op":"attribute","common_form_id":form,"conditions":[{"field_id":"built","field_type":"date","op":"lte","value":"2010-12-31"}]});
    let action: AiAction =
        serde_json::from_value(json!({"type":"filter","expression":attr})).unwrap();
    let found = execute_action(&pool, &user, None, &action).await.unwrap();
    assert_eq!(found["targets"], json!([format!("marker:{}", ids[0])]));
    let action: AiAction = serde_json::from_value(json!({"type":"filter","expression":{"op":"or","children":[attr,{"op":"text","query1":"病院","query2":""}]}})).unwrap();
    assert_eq!(
        execute_action(&pool, &user, None, &action).await.unwrap()["target_count"],
        2
    );
    let action: AiAction =
        serde_json::from_value(json!({"type":"filter","expression":{"op":"not","child":attr}}))
            .unwrap();
    let excluded = execute_action(&pool, &user, Some(vec![layer]), &action)
        .await
        .unwrap();
    assert_eq!(excluded["target_count"], 2); // 登録のない公園もNOTの母集団に含む。
    let context =
        geocode_web_single::ai::actions::context(&pool, &user, None, "施設台帳の建設年月日")
            .await
            .unwrap();
    assert_eq!(context["forms"][0]["fields"][0]["id"], "age");
    assert!(!context.to_string().contains("秘密の本文"));
    assert!(!context.to_string().contains("FOREIGN_PRIVATE_RECORD_2f70"));
    assert!(
        execute_action(&pool, &user, Some(vec![Uuid::new_v4()]), &action)
            .await
            .is_err()
    );
    let bad: AiAction = serde_json::from_value(json!({"type":"filter","expression":{"op":"attribute","common_form_id":form,"conditions":[{"field_id":"imaginary","field_type":"number","op":"gte","value":"0"}]}})).unwrap();
    assert!(execute_action(&pool, &user, None, &bad).await.is_err());
    let nonexistent: AiAction = serde_json::from_value(json!({"type":"filter","expression":{"op":"not","child":{"op":"attribute","common_form_id":Uuid::new_v4(),"conditions":[]}}})).unwrap();
    assert!(
        execute_action(&pool, &user, None, &nonexistent)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn direct_execution_cannot_read_another_users_existing_layers_or_forms() {
    let pool = common::test_pool().await;
    let (user, _, layer, _) = fixture(&pool).await;
    let other: String = sqlx::query_scalar("SELECT user_id FROM marker_info_model WHERE detail=$1")
        .bind("FOREIGN_PRIVATE_RECORD_2f70")
        .fetch_one(&pool)
        .await
        .unwrap();
    let other_layer = common::master_layer_id(&pool, &other).await;
    let other_form = Uuid::new_v4();
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
        VALUES ($1, $2, 'FOREIGN_FORM_METADATA_4f51', '', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(other_form.to_string())
    .bind(&other)
    .bind(json!({"fields":[{"id":"age","label":"秘密の年数","type":"number"}]}))
    .execute(&pool)
    .await
    .unwrap();
    let revision = Uuid::new_v4();
    let config = AiConfig {
        enabled: true,
        model: "test".into(),
        ..Default::default()
    };
    sqlx::query("INSERT INTO ai_settings(id,revision,config) VALUES(1,$1,$2)")
        .bind(revision.to_string())
        .bind(sqlx::types::Json(&config))
        .execute(&pool)
        .await
        .unwrap();
    let app = app(&pool);

    let all = json!({"type":"filter","expression":{"op":"all"}});
    let owned = json!({"action":all,"revision":revision,"context":{"layer_ids":[layer]}});
    let (status, result) = request(&app, Some(&user), "POST", "/ai/execute", owned).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["target_count"], 3);
    let foreign_scope =
        json!({"action":all,"revision":revision,"context":{"layer_ids":[other_layer]}});
    assert_eq!(
        request(&app, Some(&user), "POST", "/ai/execute", foreign_scope)
            .await
            .0,
        StatusCode::NOT_FOUND,
    );
    for action in [
        json!({"type":"filter","expression":{"op":"attribute","common_form_id":other_form,"conditions":[]}}),
        json!({"type":"color","common_form_id":other_form,"rules":[{"id":"all","label":"全件","color":"#ff0000","conditions":[]}]}),
    ] {
        let body = json!({"action":action,"revision":revision,"context":{"layer_ids":[layer]}});
        assert_eq!(
            request(&app, Some(&user), "POST", "/ai/execute", body)
                .await
                .0,
            StatusCode::NOT_FOUND,
        );
    }
    let foreign_context = geocode_web_single::ai::actions::context(
        &pool,
        &user,
        Some(vec![Uuid::parse_str(&other_layer).unwrap()]),
        "検索",
    )
    .await;
    assert!(matches!(
        foreign_context,
        Err(geocode_web_single::error::AppError::NotFound)
    ));
    let own_context =
        geocode_web_single::ai::actions::context(&pool, &user, None, "FOREIGN_FORM_METADATA_4f51")
            .await
            .unwrap();
    assert!(
        !own_context
            .to_string()
            .contains("FOREIGN_FORM_METADATA_4f51")
    );
    assert!(!own_context.to_string().contains(&other_form.to_string()));
}

#[tokio::test]
async fn analysis_context_prioritizes_a_configured_form_before_the_first_submission() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "ai-empty-layer-analysis").await;
    let layer = Uuid::parse_str(&common::master_layer_id(&pool, &user).await).unwrap();
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
        VALUES ($1, $2, '空レイヤの台帳', '', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(form.to_string())
    .bind(&user)
    .bind(json!({"fields":[{"id":"built","label":"建設年月日","type":"date"}]}))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO common_form_revision_model(form_id,version,form_schema) VALUES($1,1,$2)",
    )
    .bind(form.to_string())
    .bind(json!({"fields":[{"id":"built","label":"建設年月日","type":"date"}]}))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE layer_model SET common_form_id=$1,common_form_version=1 WHERE id=$2")
        .bind(form.to_string())
        .bind(layer.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let context = geocode_web_single::ai::actions::context(
        &pool,
        &user,
        Some(vec![layer]),
        "このレイヤの分析方法を考えて",
    )
    .await
    .unwrap();
    assert_eq!(context["forms"][0]["id"], json!(form));
    assert_eq!(context["forms"][0]["in_scope"], true);
    assert_eq!(context["forms"][0]["fields"][0]["id"], "built");
}

#[tokio::test]
async fn layer_list_sync_checks_the_original_actor_without_breaking_legacy_clients() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "ai-layer-sync-user").await;
    let other = common::create_test_user(&pool, "ai-layer-sync-cookie").await;
    let app = app(&pool);
    let token = create_token(&other, 30, "access_token", 0).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/layer/read/all")
                .header("cookie", format!("access_token={token}"))
                .header("x-ai-account-id", user.to_string())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body, json!({"error":"ai_account_changed"}));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/layer/read/all")
                .header("cookie", format!("access_token={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert!(
        body.as_object()
            .unwrap()
            .values()
            .all(|layer| layer["user_id"] == json!(other))
    );
}

#[tokio::test]
async fn color_boundaries_and_execution_revision_are_checked() {
    let pool = common::test_pool().await;
    let (user, form, _, ids) = fixture(&pool).await;
    let rules = json!([
        {"id":"older","label":"20年以上","color":"#ff0000","conditions":[{"field_id":"age","field_type":"number","op":"gte","value":"20"}]},
        {"id":"younger","label":"10年以上20年未満","color":"#00ff00","conditions":[{"field_id":"age","field_type":"number","op":"gte","value":"10"}]}
    ]);
    let action: AiAction =
        serde_json::from_value(json!({"type":"color","common_form_id":form,"rules":rules}))
            .unwrap();
    let colored = execute_action(&pool, &user, None, &action).await.unwrap();
    assert_eq!(
        colored["coloring"]["targets"][format!("marker:{}", ids[1])],
        "older"
    );
    assert_eq!(
        colored["coloring"]["targets"][format!("marker:{}", ids[0])],
        "younger"
    );
    let revision = Uuid::new_v4();
    let config = AiConfig {
        enabled: true,
        model: "test".into(),
        ..Default::default()
    };
    sqlx::query("INSERT INTO ai_settings(id,revision,config) VALUES(1,$1,$2)")
        .bind(revision.to_string())
        .bind(sqlx::types::Json(&config))
        .execute(&pool)
        .await
        .unwrap();
    let app = app(&pool);
    let body = json!({"action":action,"revision":revision,"context":{"layer_ids":null}});
    assert_eq!(
        request(&app, Some(&user), "POST", "/ai/execute", body.clone())
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE ai_settings SET revision=$1 WHERE id=1")
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, Some(&user), "POST", "/ai/execute", body.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    sqlx::query(
        "UPDATE ai_settings SET config=json_set(config,'$.enabled',json('false')) WHERE id=1",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(&app, Some(&user), "POST", "/ai/execute", body)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn microphone_is_only_enabled_on_chat_document_routes() {
    let pool = common::test_pool().await;
    common::init_test_env();
    let app = app(&pool);
    for (uri, expected) in [
        ("/index", "microphone=(self)"),
        ("/health-check", "microphone=()"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(
            response.headers()["permissions-policy"]
                .to_str()
                .unwrap()
                .contains(expected)
        );
    }
}

#[tokio::test]
async fn account_switch_or_missing_actor_header_rejects_ai_before_external_calls() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "ai-cookie-actor").await;
    let previous = common::create_test_user(&pool, "ai-screen-actor").await;
    let app = app(&pool);
    let cookie = format!(
        "access_token={}",
        create_token(&user.to_owned(), 30, "access_token", 0).unwrap()
    );
    for uri in ["/ai/chat", "/ai/execute", "/ai/transcribe"] {
        for expected in [None, Some(&previous)] {
            let mut builder = Request::builder()
                .method("POST")
                .uri(uri)
                .header("cookie", &cookie);
            if let Some(id) = expected {
                builder = builder.header("x-ai-account-id", id.to_string());
            }
            let body = if uri == "/ai/transcribe" {
                builder = builder.header(
                    "content-type",
                    "multipart/form-data; boundary=test-ai-actor",
                );
                b"--test-ai-actor\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFFxxxxWAVEtest\r\n--test-ai-actor--\r\n".to_vec()
            } else {
                builder = builder.header("content-type", "application/json");
                serde_json::to_vec(&if uri == "/ai/chat" {
                    json!({"message":"以前の会話を使って検索","history":[],"context":{"layer_ids":null}})
                } else { json!({"action":{"type":"reset"},"revision":Uuid::new_v4(),"context":{"layer_ids":null}}) }).unwrap()
            };
            let response = app
                .clone()
                .oneshot(builder.body(Body::from(body)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT, "{uri}");
            assert_eq!(response.headers()["cache-control"], "no-store");
            let error: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap())
                    .unwrap();
            assert_eq!(error, json!({"error":"ai_account_changed"}));
        }
    }
}

/// 同じ初期状態からの保存を複数接続で競合させ、後勝ちの上書きを防ぐ。
#[tokio::test]
async fn concurrent_initial_and_revisioned_settings_saves_allow_only_one_writer() {
    use geocode_web_single::{
        ai::settings::{self, AiSettingsInput},
        error::AppError,
    };
    let (pool, path) = common::file_test_pool().await;
    let admin = common::create_test_admin(&pool, "ai-revision-race-admin").await;
    let input = |revision: Option<Uuid>, model: &str| -> AiSettingsInput {
        serde_json::from_value(json!({"revision":revision,"enabled":false,"model":model})).unwrap()
    };
    let first = input(None, "first");
    let second = input(None, "second");
    let (first, second) = tokio::join!(
        settings::save(&pool, &admin, 0, &first),
        settings::save(&pool, &admin, 0, &second),
    );
    let results = [first, second];
    assert_eq!(
        results.iter().filter(|result| result.is_ok()).count(),
        1,
        "初回保存は一方だけ成功する"
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(AppError::Conflict)))
            .count(),
        1,
        "古い初期状態からの保存は競合になる"
    );
    let current = settings::load(&pool).await.unwrap();
    let first = input(current.revision, "revised-first");
    let second = input(current.revision, "revised-second");
    let (first, second) = tokio::join!(
        settings::save(&pool, &admin, 0, &first),
        settings::save(&pool, &admin, 0, &second),
    );
    let results = [first, second];
    assert_eq!(
        results.iter().filter(|result| result.is_ok()).count(),
        1,
        "同じリビジョンの更新も一方だけ成功する"
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(AppError::Conflict)))
            .count(),
        1
    );
    let stored: (String, String, String) = sqlx::query_as(
        "SELECT typeof(revision),typeof(config),updated_by FROM ai_settings WHERE id=1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, ("text".into(), "text".into(), admin));
    assert_ne!(
        settings::load(&pool).await.unwrap().revision,
        current.revision
    );
    common::close_file_test_pool(pool, path).await;
}

/// 再接続後も別々の音声・LLM鍵を復号し、接続先の改変は復号時に拒否する。
#[tokio::test]
async fn encrypted_settings_persist_as_blobs_and_fail_closed_after_endpoint_tampering() {
    use geocode_web_single::ai::settings::{self, AiSettingsInput};
    let (pool, path) = common::file_test_pool().await;
    let admin = common::create_test_admin(&pool, "ai-persisted-key-admin").await;
    let input: AiSettingsInput = serde_json::from_value(json!({
        "revision":null,"enabled":false,"model":"persisted-model",
        "apiKey":"persisted-model-secret","speechApiKey":"persisted-speech-secret"
    }))
    .unwrap();
    let saved = settings::save(&pool, &admin, 0, &input).await.unwrap();
    let storage: (String, String, String, String) = sqlx::query_as(
        r#"
        SELECT
            typeof(revision),
            typeof(config),
            typeof(encrypted_api_key),
            typeof(encrypted_speech_api_key)
        FROM ai_settings
        WHERE id = 1
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        storage,
        ("text".into(), "text".into(), "blob".into(), "blob".into())
    );
    pool.close().await;
    drop(pool);
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let loaded = settings::load(&pool).await.unwrap();
    assert_eq!(loaded.revision, saved.revision);
    assert_eq!(loaded.api_key.as_ref().unwrap(), "persisted-model-secret");
    assert_eq!(
        loaded.speech_api_key.as_ref().unwrap(),
        "persisted-speech-secret"
    );
    assert!(loaded.api_key.as_ref().unwrap().is_sensitive());
    sqlx::query(
        r#"
        UPDATE ai_settings
        SET config = json_set(config, '$.baseUrl', 'https://different.example/v1')
        WHERE id = 1
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        settings::load(&pool).await.is_err(),
        "接続先に束縛した暗号文は改変時に利用できない"
    );
    common::close_file_test_pool(pool, path).await;
}

/// 保存直前で要求を同期停止し、その間の権限・認証失効を実HTTP経路で検証する。
#[tokio::test]
async fn settings_recheck_admin_and_authentication_after_waiting_to_write() {
    use geocode_web_single::ai::settings::{self, AiSettingsInput};
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tokio::sync::Notify;

    for (case, change, expected) in [
        (
            "role",
            "UPDATE user_model SET is_superuser=false WHERE id=$1",
            StatusCode::FORBIDDEN,
        ),
        (
            "lock",
            "UPDATE user_model SET is_locked=true WHERE id=$1",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "version",
            "UPDATE user_model SET auth_version=auth_version+1 WHERE id=$1",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "deleted",
            "DELETE FROM user_model WHERE id=$1",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "active",
            "UPDATE user_model SET is_superuser=is_superuser WHERE id=$1",
            StatusCode::OK,
        ),
    ] {
        let (pool, path) = common::file_test_pool().await;
        let admin = common::create_test_admin(&pool, &format!("ai-waiting-admin-{case}")).await;
        let input: AiSettingsInput = serde_json::from_value(json!({
            "revision":null,"enabled":false,"model":"before",
            "apiKey":"initial-model-secret","speechApiKey":"initial-speech-secret"
        }))
        .unwrap();
        let saved = settings::save(&pool, &admin, 0, &input).await.unwrap();
        let before: (String, String, Vec<u8>, Vec<u8>) = sqlx::query_as(
            "SELECT revision,config,encrypted_api_key,encrypted_speech_api_key FROM ai_settings WHERE id=1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let armed = Arc::new(AtomicBool::new(false));
        let acquired = Arc::new(AtomicUsize::new(0));
        let reached_write = Arc::new(Notify::new());
        let resume_write = Arc::new(Notify::new());
        let options = pool.options().clone().min_connections(4).before_acquire({
            let armed = armed.clone();
            let acquired = acquired.clone();
            let reached_write = reached_write.clone();
            let resume_write = resume_write.clone();
            move |_, _| {
                let armed = armed.clone();
                let acquired = acquired.clone();
                let reached_write = reached_write.clone();
                let resume_write = resume_write.clone();
                Box::pin(async move {
                    // Cookie認証・管理権限・候補設定の3読取が完了してから、BEGINを待たせる。
                    if armed.load(Ordering::SeqCst) && acquired.fetch_add(1, Ordering::SeqCst) == 3
                    {
                        reached_write.notify_one();
                        tokio::time::timeout(Duration::from_secs(10), resume_write.notified())
                            .await
                            .map_err(|_| {
                                sqlx::Error::Protocol(
                                    "保存待機テストの解除期限を超えました。".into(),
                                )
                            })?;
                    }
                    Ok(true)
                })
            }
        });
        // 全接続を事前確保し、新規接続でbefore_acquireが省略される条件を除く。
        let guarded_pool = options
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .unwrap();
        let app = app(&guarded_pool);
        let mut writer = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        armed.store(true, Ordering::SeqCst);
        let pending_admin = admin.clone();
        let pending = tokio::spawn(async move {
            request(
                &app,
                Some(&pending_admin),
                "PUT",
                "/admin/ai-settings",
                json!({
                    "revision":saved.revision,"enabled":false,"model":"after",
                    "apiKey":"replacement-model-secret","speechApiKey":"replacement-speech-secret"
                }),
            )
            .await
        });
        let reached = tokio::time::timeout(Duration::from_secs(10), reached_write.notified()).await;
        if reached.is_err() {
            pending.abort();
            let _ = pending.await;
            writer.rollback().await.unwrap();
            guarded_pool.close().await;
            common::close_file_test_pool(pool, path).await;
            panic!("保存直前まで要求が到達しませんでした: {case}");
        }
        sqlx::query(change)
            .bind(&admin)
            .execute(&mut *writer)
            .await
            .unwrap();
        writer.commit().await.unwrap();
        resume_write.notify_one();
        let (status, response) = tokio::time::timeout(Duration::from_secs(10), pending)
            .await
            .expect("保存要求は有限時間で完了する")
            .unwrap();
        armed.store(false, Ordering::SeqCst);
        assert_eq!(status, expected, "{case}: {response}");
        let after: (String, String, Vec<u8>, Vec<u8>) = sqlx::query_as(
            "SELECT revision,config,encrypted_api_key,encrypted_speech_api_key FROM ai_settings WHERE id=1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        if expected == StatusCode::OK {
            assert_ne!(after.0, before.0, "有効な管理者の保存は継続できる");
            let loaded = settings::load(&pool).await.unwrap();
            assert_eq!(loaded.config.model, "after");
            assert_eq!(loaded.api_key.unwrap(), "replacement-model-secret");
            assert_eq!(loaded.speech_api_key.unwrap(), "replacement-speech-secret");
        } else {
            assert_eq!(after, before, "失効後は設定版・設定・両暗号文を変更しない");
        }
        guarded_pool.close().await;
        common::close_file_test_pool(pool, path).await;
    }
}
