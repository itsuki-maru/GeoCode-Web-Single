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
use std::time::Duration;
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;

// DBが分離されても候補APIの同時実行枠はプロセス内で共有されるため、ケース間を排他する。
static TEST_LOCK: Mutex<()> = Mutex::const_new(());

fn app(pool: &SqlitePool) -> Router {
    geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    )
}

async fn request(
    app: Router,
    user: Option<&str>,
    expected: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri("/ai/suggestions")
        .header("content-type", "application/json");
    if let Some(user) = user {
        request = request.header(
            "cookie",
            format!(
                "access_token={}",
                create_token(&user.to_owned(), 30, "access_token", 0).unwrap()
            ),
        );
    }
    if let Some(expected) = expected {
        request = request.header("x-ai-account-id", expected.to_string());
    }
    let response = app
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    if status.is_success() {
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    let value = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
        .unwrap();
    (status, value)
}

async fn settings(pool: &SqlitePool) -> Uuid {
    // 候補から除外する数値がメタデータに含まれても、本文の検査が誤検出しないことを保証する。
    let revision = Uuid::parse_str("90000000-9990-4900-8900-000000000900").unwrap();
    let config = AiConfig {
        enabled: true,
        max_requests_per_minute: 60,
        ..Default::default()
    };
    // 復号できない暗号文・未設定モデルでも入力例は作れる。接続確認は行わない。
    sqlx::query(
        r#"
        INSERT INTO ai_settings (
            id,
            revision,
            config,
            encrypted_api_key,
            encrypted_speech_api_key
        )
        VALUES (1, $1, $2, $3, $3)
        "#,
    )
    .bind(revision.to_string())
    .bind(sqlx::types::Json(config))
    .bind(vec![1_u8, 2, 3])
    .execute(pool)
    .await
    .unwrap();
    revision
}

async fn form(pool: &SqlitePool, user: &str, label: &str, fields: Value) -> Uuid {
    let id = Uuid::new_v4();
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
        VALUES ($1, $2, $3, '', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(id.to_string())
    .bind(user)
    .bind(label)
    .bind(json!({"fields":fields}))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO common_form_revision_model(form_id,version,form_schema) VALUES($1,1,$2)",
    )
    .bind(id.to_string())
    .bind(json!({"fields":fields}))
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn marker(pool: &SqlitePool, user: &str, layer: Uuid) -> Uuid {
    let id = Uuid::new_v4();
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
        VALUES ($1, $2, $3, 'PRIVATE_FACILITY_DO_NOT_RETURN', 35, 139, 'PRIVATE_TEXT_DO_NOT_RETURN', CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP)
        "#,
    )
    .bind(id.to_string())
    .bind(user)
    .bind(layer.to_string())
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn submission(
    pool: &SqlitePool,
    marker: Uuid,
    form: Uuid,
    label: &str,
    fields: Value,
    values: Value,
    minutes: i32,
) -> Uuid {
    let id = Uuid::new_v4();
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
        VALUES ($1, $2, $3, '', datetime('now', '-' || $4 || ' minutes'), $5, $6)
        "#,
    )
    .bind(id.to_string())
    .bind(marker.to_string())
    .bind(values)
    .bind(minutes)
    .bind(json!({"id":form,"version":1}))
    .bind(json!({"form_title":label,"form_schema":{"fields":fields}}))
    .execute(pool)
    .await
    .unwrap();
    id
}

fn body(revision: Uuid, layer: Uuid) -> Value {
    json!({"revision":revision,"context":{"layer_ids":[layer]}})
}
fn texts(value: &Value) -> Vec<&str> {
    value["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["text"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn suggestions_require_authentication_account_scope_enabled_and_current_revision() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-auth").await;
    let user = user.as_str();
    let other = common::create_test_user(&pool, "suggestions-other").await;
    let other = other.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let foreign = common::master_layer_id(&pool, &other).await;
    let foreign = Uuid::parse_str(&foreign).unwrap();
    let revision = settings(&pool).await;
    let app = app(&pool);
    assert_eq!(
        request(app.clone(), None, None, body(revision, layer))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(app.clone(), Some(user), Some(other), body(revision, layer))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(app.clone(), Some(user), Some(user), body(revision, foreign))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            app.clone(),
            Some(user),
            Some(user),
            body(Uuid::new_v4(), layer)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for ids in [
        vec![layer, layer],
        (0..65).map(|_| Uuid::new_v4()).collect(),
    ] {
        assert_eq!(
            request(
                app.clone(),
                Some(user),
                Some(user),
                json!({"revision":revision,"context":{"layer_ids":ids}})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    sqlx::query("UPDATE ai_settings SET config=json_set(config,'$.enabled',json('false'))")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(app, Some(user), Some(user), body(revision, layer))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn suggestions_use_latest_typed_values_and_do_not_expose_records_or_decrypt_keys() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-data").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([
        {"id":"state","label":"点検結果","type":"select","choices":["良好","要修繕","未使用"]},
        {"id":"years","label":"耐用年数","type":"number"},
        {"id":"built","label":"建設年月日","type":"date"}
    ]);
    let f = form(&pool, user, "施設台帳", fields.clone()).await;
    let first = marker(&pool, user, layer).await;
    submission(
        &pool,
        first,
        f,
        "施設台帳",
        fields.clone(),
        json!({"state":"未使用","years":900,"built":"1900-01-01"}),
        10,
    )
    .await;
    submission(
        &pool,
        first,
        f,
        "施設台帳",
        fields.clone(),
        json!({"state":"良好","years":20,"built":"2020-01-01"}),
        1,
    )
    .await;
    let second = marker(&pool, user, layer).await;
    submission(
        &pool,
        second,
        f,
        "施設台帳",
        fields.clone(),
        json!({"state":"要修繕","years":40,"built":"2000-01-01"}),
        1,
    )
    .await;
    let third = marker(&pool, user, layer).await;
    submission(
        &pool,
        third,
        f,
        "施設台帳",
        fields,
        json!({"state":"良好","built":"2010-01-01"}),
        1,
    )
    .await;
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let suggestions = texts(&value);
    assert_eq!(suggestions.len(), 3, "{value}");
    assert!(
        suggestions
            .iter()
            .all(|s| s.contains("施設台帳") && s.chars().count() <= 300)
    );
    assert!(suggestions.iter().any(|s| s.contains("色分け")), "{value}");
    assert!(
        suggestions
            .iter()
            .any(|s| s.contains("耐用年数") && s.contains("未入力")),
        "{value}"
    );
    assert!(!value.to_string().contains("未使用"));
    assert_eq!(value["revision"], revision.to_string());
    assert!(
        suggestions.iter().all(|text| !text.contains("900")),
        "{value}"
    );
    assert!(!value.to_string().contains("PRIVATE_"));
    assert!(!value.to_string().contains(&first.to_string()));
    assert!(!value.to_string().contains(&f.to_string()));
}

#[tokio::test]
async fn suggestions_never_connect_to_the_configured_provider() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-no-provider").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    sqlx::query("UPDATE ai_settings SET config=json_set(config,'$.baseUrl',$1)")
        .bind(origin)
        .execute(&pool)
        .await
        .unwrap();
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn numeric_boundaries_preserve_precision_and_foreign_records_are_excluded() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-precision").await;
    let user = user.as_str();
    let other = common::create_test_user(&pool, "suggestions-precision-other").await;
    let other = other.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let foreign = common::master_layer_id(&pool, &other).await;
    let foreign = Uuid::parse_str(&foreign).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"n","label":"正確な値","type":"number"}]);
    let f = form(&pool, user, "数値台帳", fields.clone()).await;
    for raw in ["9007199254740992", "9007199254740994"] {
        let m = marker(&pool, user, layer).await;
        submission(
            &pool,
            m,
            f,
            "数値台帳",
            fields.clone(),
            serde_json::from_str(&format!("{{\"n\":{raw}}}")).unwrap(),
            1,
        )
        .await;
    }
    let other_form = form(&pool, other, "FOREIGN_FORM_DO_NOT_RETURN", fields.clone()).await;
    let m = marker(&pool, other, foreign).await;
    submission(
        &pool,
        m,
        other_form,
        "FOREIGN_FORM_DO_NOT_RETURN",
        fields,
        json!({"n":-999}),
        1,
    )
    .await;
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(
        texts(&value).iter().any(|s| s.contains("9007199254740993")),
        "{value}"
    );
    assert!(!value.to_string().contains("FOREIGN"));
    assert_eq!(value["revision"], revision.to_string());
    assert!(
        texts(&value).iter().all(|text| !text.contains("-999")),
        "{value}"
    );
}

#[tokio::test]
async fn oversized_legacy_numeric_tokens_are_excluded_without_affecting_other_examples() {
    let _serial = TEST_LOCK.lock().await;
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "suggestions-legacy-numbers").await;
    let layer = Uuid::parse_str(&common::master_layer_id(&pool, &user).await).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([
        {"id":"n","label":"不正数値","type":"number"},
        {"id":"flag","label":"有効","type":"checkbox"}
    ]);
    let f = form(&pool, &user, "旧登録台帳", fields.clone()).await;
    for raw in [
        "1e2147483647".to_owned(),
        "1e-2147483648".to_owned(),
        "1e99999999999999999999999999999".to_owned(),
        "1".repeat(101),
        format!("0.{}", "1".repeat(101)),
    ] {
        let m = marker(&pool, &user, layer).await;
        let values = serde_json::from_str(&format!("{{\"n\":{raw},\"flag\":false}}")).unwrap();
        submission(&pool, m, f, "旧登録台帳", fields.clone(), values, 1).await;
    }
    let (status, value) =
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(texts(&value).len(), 1, "{value}");
    assert!(texts(&value)[0].contains("いいえ"), "{value}");
    assert!(!texts(&value)[0].contains("不正数値"), "{value}");
}

#[tokio::test]
async fn unused_choices_missing_definitions_ambiguous_names_and_empty_layers_do_not_invent_examples()
 {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-no-invention").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"state","label":"状態","type":"select","choices":["登録なし"]}]);
    let f = form(&pool, user, "同名台帳", fields.clone()).await;
    form(&pool, user, "同名台帳", fields.clone()).await;
    let m = marker(&pool, user, layer).await;
    submission(
        &pool,
        m,
        f,
        "同名台帳",
        fields,
        json!({"state":"登録なし"}),
        1,
    )
    .await;
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty());
    sqlx::query("UPDATE common_form_model SET form_title='独立台帳' WHERE id=$1")
        .bind(f.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE marker_form_submission_model SET form_snapshot=NULL WHERE marker_id=$1")
        .bind(m.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty());
    sqlx::query("DELETE FROM marker_form_submission_model WHERE marker_id=$1")
        .bind(m.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (_, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(value["reason"], "empty");
}

#[tokio::test]
async fn empty_does_not_mean_missing_or_absent_and_unsafe_labels_are_omitted() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-empty-semantics").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"state","label":"未入力確認","type":"text"},{"id":"unsafe","label":"悪い\nラベル","type":"text"}]);
    let f = form(&pool, user, "入力台帳", fields.clone()).await;
    let m = marker(&pool, user, layer).await;
    submission(&pool, m, f, "入力台帳", fields.clone(), json!({}), 1).await;
    let other = marker(&pool, user, layer).await;
    submission(&pool, other, f, "入力台帳", json!([]), json!({}), 1).await;
    marker(&pool, user, layer).await;
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(
        texts(&value),
        vec!["「入力台帳」フォームの「未入力確認」が未入力の地図オブジェクトを抽出して"]
    );
    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET form_snapshot = json_set(form_snapshot, '$.form_schema.fields', json('[]'))
        WHERE marker_id = $1
        "#,
    )
    .bind(m.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let (_, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert!(
        texts(&value).is_empty(),
        "項目欠落・無登録を未入力の候補に含めない: {value}"
    );
}

#[tokio::test]
async fn invalid_dates_and_values_outside_posted_choices_are_not_suggested() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-invalid-values").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([
        {"id":"date","label":"記録日","type":"date"},
        {"id":"state","label":"状態","type":"select","choices":["定義だけの選択肢"]},
        {"id":"number","label":"数値","type":"number"}
    ]);
    let f = form(&pool, user, "検証台帳", fields.clone()).await;
    for values in [
        json!({"date":"2020-02-30","state":"不正な保存値","number":"文字列"}),
        json!({"date":"2025-99-99","state":"不正な保存値","number":true}),
    ] {
        let m = marker(&pool, user, layer).await;
        submission(&pool, m, f, "検証台帳", fields.clone(), values, 1).await;
    }
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty(), "{value}");
}

#[tokio::test]
async fn oversized_latest_population_falls_back_without_returning_samples() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-limit").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"state","label":"状態","type":"checkbox"}]);
    let f = form(&pool, user, "大量台帳", fields.clone()).await;
    sqlx::query(
        r#"
        WITH RECURSIVE numbers(i) AS (
            SELECT 1
            UNION ALL
            SELECT i + 1
            FROM numbers
            WHERE i < 50001
        )
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
        SELECT
            printf('10000000-0000-4000-8000-%012d', i),
            $1,
            $2,
            'PRIVATE_LARGE_RECORD',
            35,
            139,
            '',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        FROM numbers
        "#,
    )
    .bind(user)
    .bind(layer.to_string())
    .execute(&pool)
    .await
    .unwrap();
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
        SELECT
            id,
            id,
            '{"state":true}',
            '',
            datetime('now', '-1 minute'),
            $2,
            $3
        FROM marker_info_model
        WHERE user_id = $1
        "#,
    )
    .bind(user)
    .bind(json!({"id":f,"version":1}))
    .bind(json!({"form_title":"大量台帳","form_schema":{"fields":fields}}))
    .execute(&pool)
    .await
    .unwrap();
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty());
    assert!(
        matches!(value["reason"].as_str(), Some("limit" | "timeout")),
        "{value}"
    );
    assert!(!value.to_string().contains("PRIVATE_LARGE_RECORD"));
}

#[tokio::test]
async fn marker_and_shape_with_the_same_id_have_independent_latest_registrations() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-both-kinds").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"flag","label":"稼働中","type":"checkbox"}]);
    let f = form(&pool, user, "設備台帳", fields.clone()).await;
    let id = marker(&pool, user, layer).await;
    submission(
        &pool,
        id,
        f,
        "設備台帳",
        fields.clone(),
        json!({"flag":false}),
        10,
    )
    .await;
    submission(
        &pool,
        id,
        f,
        "設備台帳",
        fields.clone(),
        json!({"flag":true}),
        1,
    )
    .await;
    sqlx::query(r#"
        INSERT INTO shape_model (
            id,
            user_id,
            layer_id,
            shape_type,
            name,
            geojson,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, 'polygon', 'PRIVATE_SHAPE_NAME', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#)
        .bind(id.to_string()).bind(user).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[139,35],[140,35],[140,36],[139,35]]]}})).execute(&pool).await.unwrap();
    sqlx::query(
        r#"
        INSERT INTO shape_form_submission_model (
            id,
            shape_id,
            submitted_values,
            rendered_markdown,
            create_at,
            source_form,
            form_snapshot
        )
        VALUES ($1, $2, '{"flag":false}', '', datetime('now', '-1 minute'), $3, $4)
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(id.to_string())
    .bind(json!({"id":f,"version":1}))
    .bind(json!({"form_title":"設備台帳","form_schema":{"fields":fields}}))
    .execute(&pool)
    .await
    .unwrap();
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(
        texts(&value).iter().any(|s| s.contains("色分け")),
        "trueとfalseの両方を集計する: {value}"
    );
    assert!(!value.to_string().contains("PRIVATE_SHAPE_NAME"));
}

#[tokio::test]
async fn automatic_suggestions_have_limits_independent_from_normal_chat() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-separate-quota").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    sqlx::query("UPDATE ai_settings SET config=json_set(config,'$.maxRequestsPerMinute',1)")
        .execute(&pool)
        .await
        .unwrap();
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let normal = geocode_web_single::handler::ai::acquire_request(user, 1)
        .expect("自動候補は通常AIの上限を消費しない");
    drop(normal);
    assert!(geocode_web_single::handler::ai::acquire_request(user, 1).is_err());
    assert_eq!(
        request(app(&pool), Some(user), Some(user), body(revision, layer))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS,
        "専用枠の上限超過は通常の入力と独立して拒否する"
    );
}

#[tokio::test]
async fn posted_definition_count_is_bounded_without_changing_manual_search_or_scope() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-posted-count").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let flag = json!({"id":"flag","label":"稼働中","type":"checkbox"});
    let f = form(&pool, user, "設備台帳", json!([flag])).await;
    for index in 0..201 {
        let m = marker(&pool, user, layer).await;
        submission(
            &pool,
            m,
            f,
            "設備台帳",
            json!([flag,{"id":"extra","label":format!("過去の項目{index}"),"type":"text"}]),
            json!({"flag":true}),
            10,
        )
        .await;
    }
    let manual = geocode_web_single::handler::answer_map_filter::filter_targets(
        &pool,
        user,
        &serde_json::from_value(json!({
            "query":{"mode":"latest"},
            "scope":{"kind":"layers","layer_ids":[layer]},
            "common_form_id":f,"options_only":true
        }))
        .unwrap(),
    )
    .await
    .expect("手動検索では既存の定義上限を維持する");
    assert_eq!(manual.fields.len(), 2);
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(
        texts(&value).is_empty(),
        "投稿時定義の件数を制限する: {value}"
    );

    let other_layer = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO layer_model (
            id,
            user_id,
            layer_name,
            create_at,
            update_at
        )
        VALUES ($1, $2, '対象外', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(other_layer.to_string())
    .bind(user)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE marker_info_model SET layer_id=$1 WHERE user_id=$2")
        .bind(other_layer.to_string())
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let current = marker(&pool, user, layer).await;
    submission(
        &pool,
        current,
        f,
        "設備台帳",
        json!([flag]),
        json!({"flag":true}),
        1,
    )
    .await;
    let (_, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert!(
        !texts(&value).is_empty(),
        "対象レイヤー外の定義は数えない: {value}"
    );

    // 複数の古い登録を1対象へまとめても、最新登録だけが定義の母集団となる。
    sqlx::query("UPDATE marker_form_submission_model SET marker_id=$1 WHERE marker_id<>$1")
        .bind(current.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (_, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert!(
        !texts(&value).is_empty(),
        "最新以外の登録は数えない: {value}"
    );
}

#[tokio::test]
async fn posted_definition_bytes_are_bounded_independently_from_revision_bytes() {
    let pool = common::test_pool().await;
    let _serial = TEST_LOCK.lock().await;
    let user = common::create_test_user(&pool, "suggestions-posted-bytes").await;
    let user = user.as_str();
    let layer = common::master_layer_id(&pool, &user).await;
    let layer = Uuid::parse_str(&layer).unwrap();
    let revision = settings(&pool).await;
    let flag = json!({"id":"flag","label":"稼働中","type":"checkbox"});
    let f = form(&pool, user, "設備台帳", json!([flag])).await;
    for index in 0..30 {
        let choices: Vec<_> = (0..20)
            .map(|choice| format!("{index}-{choice}-{}", "あ".repeat(75)))
            .collect();
        let m = marker(&pool, user, layer).await;
        submission(
            &pool,
            m,
            f,
            "設備台帳",
            json!([flag,{"id":"extra","label":format!("旧選択肢{index}"),"type":"select","choices":choices}]),
            json!({"flag":true}),
            1,
        )
        .await;
    }
    let (status, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(
        texts(&value).is_empty(),
        "履歴とは独立して投稿時定義のバイト数を制限する: {value}"
    );

    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET form_snapshot = json_set(form_snapshot, '$.form_schema.fields', json($1))
        "#,
    )
    .bind(json!([flag]))
    .execute(&pool)
    .await
    .unwrap();
    let (_, value) = request(app(&pool), Some(user), Some(user), body(revision, layer)).await;
    assert!(
        !texts(&value).is_empty(),
        "同一の定義を繰り返す通常登録では候補を作成できる: {value}"
    );
}

/// 候補収集中だけを遅延させ、設定の再検証が新しいリビジョンを認識することを確かめる。
#[tokio::test]
async fn config_change_during_collection_rejects_the_old_result() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let _serial = TEST_LOCK.lock().await;
    let (pool, path) = common::file_test_pool().await;
    let user = common::create_test_user(&pool, "suggestions-revision-race").await;
    let layer = Uuid::parse_str(&common::master_layer_id(&pool, &user).await).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"flag","label":"稼働中","type":"checkbox"}]);
    let f = form(&pool, &user, "設備台帳", fields.clone()).await;
    let m = marker(&pool, &user, layer).await;
    submission(&pool, m, f, "設備台帳", fields, json!({"flag":true}), 1).await;
    let started = Arc::new(AtomicBool::new(false));
    let mut connections = vec![];
    for _ in 0..4 {
        connections.push(pool.acquire().await.unwrap());
    }
    for connection in &mut connections {
        let started = started.clone();
        connection
            .lock_handle()
            .await
            .unwrap()
            .create_collation("suggestion_gate", move |a, b| {
                started.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(150));
                a.cmp(b)
            })
            .unwrap();
    }
    drop(connections);
    sqlx::query("ALTER TABLE marker_form_submission_model RENAME TO suggestion_rows")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE VIEW marker_form_submission_model AS
        SELECT *
        FROM suggestion_rows
        WHERE id COLLATE suggestion_gate <> ''
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let task_user = user.clone();
    let router = app(&pool);
    let task = tokio::spawn(async move {
        request(
            router,
            Some(&task_user),
            Some(&task_user),
            body(revision, layer),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("候補の読み取り開始を待つ");
    sqlx::query("UPDATE ai_settings SET revision=$1")
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(task.await.unwrap().0, StatusCode::CONFLICT);
    common::close_file_test_pool(pool, path).await;
}

/// HTTP側の待機だけでなく、SQLite VMの高負荷読み取りを停止し接続設定も復元する。
#[tokio::test]
async fn sqlite_vm_timeout_restores_the_connection_and_keeps_normal_input_available() {
    let _serial = TEST_LOCK.lock().await;
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "suggestions-vm-timeout").await;
    let layer = Uuid::parse_str(&common::master_layer_id(&pool, &user).await).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"flag","label":"稼働中","type":"checkbox"}]);
    let f = form(&pool, &user, "設備台帳", fields.clone()).await;
    let m = marker(&pool, &user, layer).await;
    submission(&pool, m, f, "設備台帳", fields, json!({"flag":false}), 1).await;
    let original_busy: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE marker_form_submission_model RENAME TO suggestion_rows")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE VIEW marker_form_submission_model AS
        SELECT *
        FROM suggestion_rows
        WHERE (
            WITH RECURSIVE spin(n) AS (
                SELECT 1
                UNION ALL
                SELECT n + 1
                FROM spin
                WHERE n < 1000000000
            )
            SELECT sum(n)
            FROM spin
        ) > 0
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, value) = tokio::time::timeout(
        Duration::from_secs(8),
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)),
    )
    .await
    .expect("SQL自体を5秒で中断する");
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["reason"], "timeout");
    assert!(texts(&value).is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA busy_timeout")
            .fetch_one(&pool)
            .await
            .unwrap(),
        original_busy
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA query_only")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP VIEW marker_form_submission_model")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE suggestion_rows RENAME TO marker_form_submission_model")
        .execute(&pool)
        .await
        .unwrap();
    let (status, value) =
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(
        !texts(&value).is_empty(),
        "期限切れコールバックを次の要求へ残さない: {value}"
    );
}

#[tokio::test]
async fn zero_and_false_are_values_and_ambiguous_field_labels_are_omitted() {
    let _serial = TEST_LOCK.lock().await;
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "suggestions-zero-false").await;
    let layer = Uuid::parse_str(&common::master_layer_id(&pool, &user).await).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([
        {"id":"flag","label":"有効","type":"checkbox"},
        {"id":"n","label":"件数","type":"number"},
        {"id":"a","label":"同名項目","type":"text"},
        {"id":"b","label":"同名項目","type":"text"}
    ]);
    let f = form(&pool, &user, "状態台帳", fields.clone()).await;
    for n in [0, 10] {
        let m = marker(&pool, &user, layer).await;
        submission(
            &pool,
            m,
            f,
            "状態台帳",
            fields.clone(),
            json!({"flag":false,"n":n}),
            1,
        )
        .await;
    }
    let (status, value) =
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let texts = texts(&value);
    assert!(
        texts.iter().any(|v| v.contains("いいえ")),
        "falseは有効な選択値: {value}"
    );
    assert!(
        texts.iter().any(|v| v.contains("5以下")),
        "0は有効な数値: {value}"
    );
    assert!(
        texts
            .iter()
            .all(|v| !v.contains("未入力") && !v.contains("同名項目")),
        "曖昧ラベルや0/falseを未入力にしない: {value}"
    );
}

#[tokio::test]
async fn revision_budgets_and_invalid_posted_arrays_only_omit_automatic_examples() {
    let _serial = TEST_LOCK.lock().await;
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "suggestions-definition-fallback").await;
    let layer = Uuid::parse_str(&common::master_layer_id(&pool, &user).await).unwrap();
    let revision = settings(&pool).await;
    let fields = json!([{"id":"flag","label":"稼働中","type":"checkbox"}]);
    let f = form(&pool, &user, "設備台帳", fields.clone()).await;
    let m = marker(&pool, &user, layer).await;
    submission(
        &pool,
        m,
        f,
        "設備台帳",
        fields.clone(),
        json!({"flag":true}),
        1,
    )
    .await;
    sqlx::query(
        r#"
        WITH RECURSIVE revisions(v) AS (
            SELECT 2
            UNION ALL
            SELECT v + 1
            FROM revisions
            WHERE v < 201
        )
        INSERT INTO common_form_revision_model (
            form_id,
            version,
            form_schema
        )
        SELECT
            $1,
            v,
            $2
        FROM revisions
        "#,
    )
    .bind(f.to_string())
    .bind(json!({"fields":fields}))
    .execute(&pool)
    .await
    .unwrap();
    let (status, value) =
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty());
    sqlx::query("DELETE FROM common_form_revision_model WHERE version>1")
        .execute(&pool)
        .await
        .unwrap();
    let large = json!({"fields":fields,"unused":"あ".repeat(40_001)});
    sqlx::query("UPDATE common_form_revision_model SET form_schema=$1")
        .bind(large)
        .execute(&pool)
        .await
        .unwrap();
    let (status, value) =
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty());
    sqlx::query("UPDATE common_form_revision_model SET form_schema=$1")
        .bind(json!({"fields":fields}))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET form_snapshot = json_set(form_snapshot, '$.form_schema.fields', json('[true]'))
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, value) =
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(texts(&value).is_empty());
    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET form_snapshot = json_set(form_snapshot, '$.form_schema.fields', json($1))
        "#,
    )
    .bind(fields)
    .execute(&pool)
    .await
    .unwrap();
    let (status, value) =
        request(app(&pool), Some(&user), Some(&user), body(revision, layer)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(!texts(&value).is_empty());
}
