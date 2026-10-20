#[allow(dead_code)]
mod common;
use axum::{Form, body::to_bytes, extract::Extension};
use chrono::{Duration, Utc};
use geocode_web_single::handler::{
    answer_map::{AnswerMapRequest, answer_map_handler, load_answer_map},
    form_answers::AnswerQuery,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

fn query(value: Value) -> AnswerQuery {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn matches_all_pages_deduplicates_and_preserves_owner_and_latest_rules() {
    let pool = common::test_pool().await;
    let owner = test_user(&pool, "map-owner").await;
    let other = test_user(&pool, "map-other").await;
    let layer = test_layer(&pool, &owner).await;
    let other_layer = test_layer(&pool, &other).await;
    let ids = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    for (id, user, group, name) in [
        (ids[0], owner, layer, "該当A"),
        (ids[1], owner, layer, "該当B"),
        (ids[2], owner, layer, "回答なし"),
        (ids[3], other, other_layer, "他人の対象"),
    ] {
        sqlx::query("INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) VALUES($1,$2,$3,$4,35,139,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id.to_string()).bind(user.to_string()).bind(group.to_string()).bind(name).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO shape_model(id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at) VALUES($1,$2,$3,'polyline','該当図形',$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(ids[0].to_string()).bind(owner.to_string()).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}})).execute(&pool).await.unwrap();
    let form = Uuid::new_v4();
    let at = (Utc::now() - Duration::days(1)).naive_utc();
    for (kind, target, n, offset) in [
        ("marker", ids[0], 1, 0),
        ("marker", ids[0], 9, 2),
        ("marker", ids[1], 1, 0),
        ("shape", ids[0], 1, 0),
        ("marker", ids[3], 1, 0),
    ] {
        sqlx::query(&format!("INSERT INTO {kind}_form_submission_model(id,{kind}_id,create_at,submitted_values,rendered_markdown,source_form,form_snapshot) VALUES($1,$2,$3,$4,'',$5,$6)"))
            .bind(Uuid::new_v4().to_string()).bind(target.to_string()).bind(at+Duration::seconds(offset)).bind(json!({"n":n})).bind(json!({"id":form,"version":1})).bind(json!({"form_title":"記録","form_schema":{"fields":[{"id":"n","label":"数値","type":"number"}]}})).execute(&pool).await.unwrap();
    }
    let base = json!({"common_form_id":form,"limit":1,"conditions":[{"field_id":"n","field_type":"number","op":"eq","value":"1"}]});
    let data = load_answer_map(&pool, &owner.to_string(), &query(base.clone()))
        .await
        .unwrap();
    assert_eq!(
        (
            data.answer_count,
            data.target_count,
            data.markers.len(),
            data.shapes.len()
        ),
        (3, 3, 2, 1)
    );
    assert_eq!(data.layers.len(), 1);
    let all = load_answer_map(&pool, &owner.to_string(), &query(json!({"limit":1})))
        .await
        .unwrap();
    assert_eq!((all.answer_count, all.target_count), (4, 3));
    let mut latest = base.clone();
    latest["mode"] = json!("latest");
    let data = load_answer_map(&pool, &owner.to_string(), &query(latest.clone()))
        .await
        .unwrap();
    assert_eq!((data.answer_count, data.target_count), (2, 2));
    assert_eq!(data.markers[0].id, ids[1].to_string());
    latest["as_of"] = json!((at + Duration::seconds(1)).and_utc());
    assert_eq!(
        load_answer_map(&pool, &owner.to_string(), &query(latest))
            .await
            .unwrap()
            .target_count,
        3
    );
    assert!(
        load_answer_map(
            &pool,
            &other.to_string(),
            &query(json!({"target_id":ids[0],"target_type":"marker"}))
        )
        .await
        .is_err()
    );
    let templates = geocode_web_single::build_tera_extension().unwrap();
    let response = answer_map_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Extension(templates.clone()),
        Form(AnswerMapRequest {
            analysis: None,
            query: base.to_string(),
            parent_origin: "http://localhost:5173".into(),
            request_id: "test-map".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let html = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("answerPreview"));
    assert!(html.contains("該当A"));
    assert!(!html.contains("他人の対象"));
    assert!(!html.contains("回答なし"));
    let normal = geocode_web_single::handler::map::map_another_get_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Extension(templates.clone()),
        axum::extract::Query(geocode_web_single::model::MapAnotherWindowQueryParams {
            is_cluster: Some(true),
        }),
    )
    .await
    .unwrap();
    use axum::response::IntoResponse;
    let normal = String::from_utf8(
        to_bytes(normal.into_response().into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!normal.contains("answerPreview:"));
    sqlx::query("UPDATE marker_info_model SET latitude=999 WHERE id=$1")
        .bind(ids[0].to_string())
        .execute(&pool)
        .await
        .unwrap();
    let invalid_position = answer_map_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Extension(templates.clone()),
        Form(AnswerMapRequest {
            analysis: None,
            query: json!({"target_id":ids[0],"target_type":"marker"}).to_string(),
            parent_origin: "http://localhost:5173".into(),
            request_id: "invalid-position".into(),
        }),
    )
    .await
    .unwrap();
    let html = String::from_utf8(
        to_bytes(invalid_position.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("\"targetCount\":1"));
    assert!(!html.contains("該当A"));
    let response = answer_map_handler(
        Extension(owner.to_string()),
        Extension(pool),
        Extension(templates),
        Form(AnswerMapRequest {
            analysis: None,
            query: json!({"target_name":"該当しない"}).to_string(),
            parent_origin: "http://localhost:5173".into(),
            request_id: "error-map".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 400);
    let html = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("地図に表示する対象がありません"));
    assert!(html.contains("answer-map-error"));
}

async fn test_user(pool: &SqlitePool, name: &str) -> Uuid {
    common::create_test_user(pool, name).await.parse().unwrap()
}
async fn test_layer(pool: &SqlitePool, user: &Uuid) -> Uuid {
    common::master_layer_id(pool, &user.to_string())
        .await
        .parse()
        .unwrap()
}

#[tokio::test]
async fn rejects_more_than_ten_thousand_distinct_targets_without_truncation() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "map-limits").await;
    let layer = test_layer(&pool, &user).await;
    sqlx::query(r#"
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
        INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at)
        SELECT '00000000-0000-4000-8000-'||printf('%012x',i),$1,$2,'上限確認',35,139,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM n
        "#).bind(user.to_string()).bind(layer.to_string()).execute(&pool).await.unwrap();
    sqlx::query(r#"
        INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown)
        SELECT id,id,'2026-01-01','{}','' FROM marker_info_model
        "#).execute(&pool).await.unwrap();
    let error = load_answer_map(&pool, &user.to_string(), &query(json!({})))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("10,000"), "{error:?}");
}
