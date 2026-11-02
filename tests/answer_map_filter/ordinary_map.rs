use super::{Data, common, fixture, map_csv, request};
use axum::{
    Form, Json,
    body::{Body, to_bytes},
    extract::Extension,
    http::{Request, StatusCode},
};
use geocode_web_single::{
    error::AppError,
    handler::{
        answer_map_csv,
        answer_map_filter::{MapFilterRequest, MapLayerScope, filter_targets},
        form_answers::CsvDownload,
    },
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::BTreeSet;
use tower::ServiceExt;
use uuid::Uuid;

fn scoped(f: &Data, conditions: Value) -> MapFilterRequest {
    let mut r = request(f, "latest", conditions);
    r.targets.clear();
    r.scope = Some(MapLayerScope::Layers { layer_ids: None });
    r
}

async fn layer(pool: &SqlitePool, owner: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layer_model (id,user_id,layer_name,create_at,update_at) \
         VALUES ($1,$2,'通常地図の確認用',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    )
    .bind(id.to_string())
    .bind(owner.to_string())
    .execute(pool)
    .await
    .unwrap();
    id
}

/// 全所有レイヤーの検索は従来の回答地図と一致し、分類中は最初の基準日時を維持する。
#[tokio::test]
async fn all_owned_layers_match_answer_map_and_pin_time() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let conditions = json!([{"field_id":"n","field_type":"number","op":"gte","value":"20"}]);
    let old = request(&f, "latest", conditions.clone());
    let expected = filter_targets(&pool, &f.owner.to_string(), &old)
        .await
        .unwrap();
    let mut r = scoped(&f, conditions);
    let actual = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&actual).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    let before = chrono::Utc::now();
    r.query.as_of = None;
    let first = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert!(before <= first.as_of && first.as_of <= chrono::Utc::now());

    // 基準日時の後に一致する回答が追加されても、同じ分類処理には混ぜない。
    sqlx::query(
        "INSERT INTO marker_form_submission_model \
         (id,marker_id,submitted_values,rendered_markdown,create_at,source_form,form_snapshot) \
         SELECT $1,marker_id,json_set(submitted_values,'$.n',50),'',$2,source_form,form_snapshot \
         FROM marker_form_submission_model WHERE marker_id=$3 ORDER BY create_at DESC LIMIT 1",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(chrono::Utc::now().naive_utc())
    .bind(f.ids[1].to_string())
    .execute(&pool)
    .await
    .unwrap();
    r.query.as_of = Some(first.as_of);
    let pinned = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert_eq!(pinned.as_of, first.as_of);
    assert_eq!(pinned.targets, first.targets);
    r.query.as_of = None;
    let refreshed = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert!(refreshed.targets.contains(&format!("marker:{}", f.ids[1])));
    assert_eq!(refreshed.target_count, first.target_count + 1);
}

/// レイヤーと部分再判定の積集合を使い、同じUUIDのマーカー・図形も別々に扱う。
#[tokio::test]
async fn selected_layers_intersect_partial_targets_and_enforce_ownership() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let selected = layer(&pool, f.owner).await;
    for table in ["marker_info_model", "shape_model"] {
        sqlx::query(&format!("UPDATE {table} SET layer_id=$1 WHERE id=$2"))
            .bind(selected.to_string())
            .bind(f.ids[0].to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut r = scoped(&f, json!([]));
    r.common_form_id = None;
    r.scope = Some(MapLayerScope::Layers {
        layer_ids: Some(vec![selected]),
    });
    let expected = BTreeSet::from([
        format!("marker:{}", f.ids[0]),
        format!("shape:{}", f.ids[0]),
    ]);
    let result = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert_eq!(
        result.targets.into_iter().collect::<BTreeSet<_>>(),
        expected
    );
    r.targets = vec![format!("marker:{}", f.ids[1])];
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        0
    );
    r.targets = vec![format!("shape:{}", f.ids[0])];
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .targets,
        r.targets
    );
    r.targets = vec![f.targets.last().unwrap().clone()];
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        0
    );
    r.targets.clear();
    r.scope = Some(MapLayerScope::Layers {
        layer_ids: Some(vec![]),
    });
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        0
    );
    let master =
        Uuid::parse_str(&common::master_layer_id(&pool, &f.owner.to_string()).await).unwrap();
    r.scope = Some(MapLayerScope::Layers {
        layer_ids: Some(vec![selected, master]),
    });
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        5
    );
    let foreign: String =
        sqlx::query_scalar("SELECT id FROM layer_model WHERE user_id<>$1 LIMIT 1")
            .bind(f.owner.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
    for denied in [Uuid::parse_str(&foreign).unwrap(), Uuid::new_v4()] {
        r.scope = Some(MapLayerScope::Layers {
            layer_ids: Some(vec![selected, denied]),
        });
        assert!(matches!(
            filter_targets(&pool, &f.owner.to_string(), &r).await,
            Err(AppError::NotFound)
        ));
    }
}

/// 部分再判定でも、同じレイヤー内の別対象にだけ残る項目定義を失わない。
#[tokio::test]
async fn partial_recheck_retains_field_candidates_in_selected_layers() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    sqlx::query(
        "UPDATE marker_form_submission_model SET form_snapshot= \
         json_insert(form_snapshot,'$.form_schema.fields[#]', \
         json('{\"id\":\"historic\",\"type\":\"text\",\"label\":\"過去の追加項目\"}')) WHERE marker_id=$1",
    ).bind(f.ids[2].to_string()).execute(&pool).await.unwrap();
    let condition = json!([{"field_id":"historic","field_type":"text","op":"missing"}]);
    let mut r = scoped(&f, condition);
    r.targets = vec![format!("marker:{}", f.ids[0])];
    let result = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert_eq!(result.targets, r.targets);
    assert!(result.fields.iter().any(|field| field.id == "historic"));
    let outside = layer(&pool, f.owner).await;
    sqlx::query("UPDATE marker_info_model SET layer_id=$1 WHERE id=$2")
        .bind(outside.to_string())
        .bind(f.ids[2].to_string())
        .execute(&pool)
        .await
        .unwrap();
    let master =
        Uuid::parse_str(&common::master_layer_id(&pool, &f.owner.to_string()).await).unwrap();
    r.scope = Some(MapLayerScope::Layers {
        layer_ids: Some(vec![master]),
    });
    assert!(matches!(
        filter_targets(&pool, &f.owner.to_string(), &r).await,
        Err(AppError::Validation(_))
    ));
    r.conditions.clear();
    let result = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert!(!result.fields.iter().any(|field| field.id == "historic"));
}

/// 通常地図だけに最新回答・512件上限を適用し、レイヤー指定をCSVへ持ち込ませない。
#[tokio::test]
async fn scope_limits_and_csv_boundaries_preserve_legacy_requests() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let mut r = scoped(&f, json!([]));
    r.common_form_id = None;
    r.query.mode = "history".into();
    assert!(matches!(
        filter_targets(&pool, &f.owner.to_string(), &r).await,
        Err(AppError::Validation(_))
    ));
    r.query.mode = "latest".into();
    r.targets = vec![
        format!("marker:{}", f.ids[0]),
        format!("shape:{}", f.ids[0]),
    ];
    r.targets
        .extend((0..510).map(|_| format!("marker:{}", Uuid::new_v4())));
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        2
    );
    r.targets.push(format!("marker:{}", Uuid::new_v4()));
    assert!(
        matches!(filter_targets(&pool, &f.owner.to_string(), &r).await, Err(AppError::Validation(message)) if message.contains("512"))
    );
    r.targets.clear();
    r.query.as_of = None;
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        5
    );
    let copy = serde_json::from_value(serde_json::to_value(&r).unwrap()).unwrap();
    assert!(
        matches!(answer_map_csv::check_handler(Extension(f.owner.to_string()), Extension(pool.clone()), Json(copy)).await,
        Err(AppError::Validation(message)) if message.contains("CSV"))
    );
    assert!(
        matches!(answer_map_csv::download_handler(Extension(f.owner.to_string()), Extension(pool.clone()),
        Form(CsvDownload { query: serde_json::to_string(&r).unwrap() })).await,
        Err(AppError::Validation(message)) if message.contains("CSV"))
    );
    r.scope = None;
    assert!(matches!(
        filter_targets(&pool, &f.owner.to_string(), &r).await,
        Err(AppError::Validation(_))
    ));
}

/// 適用済みフロントと同じJSONを認証付きルートへ送り、日時返却・省略項目・不正な範囲を確認する。
#[tokio::test]
async fn frontend_scope_payload_is_supported_by_authenticated_route() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let base = json!({"query":{"mode":"latest"},"scope":{"kind":"layers","layer_ids":null},"options_only":true});
    let send = |body: Value, authenticated: bool| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/form-answers/map-filter")
            .header("content-type", "application/json");
        if authenticated {
            let token =
                geocode_web_single::auth::create_token(&f.owner.to_string(), 30, "access_token", 0)
                    .unwrap();
            request = request.header("cookie", format!("access_token={token}"));
        }
        app.clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
    };
    assert_eq!(
        send(base.clone(), false).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let response = send(base.clone(), true).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(
        body["as_of"]
            .as_str()
            .unwrap()
            .parse::<chrono::DateTime<chrono::Utc>>()
            .is_ok()
    );
    assert_eq!(body["forms"][0]["id"], f.form.to_string());
    let response = send(
        json!({"query":{"mode":"latest","as_of":body["as_of"]},
        "scope":{"kind":"layers","layer_ids":null},"common_form_id":f.form,
        "conditions":[{"field_id":"n","field_type":"number","op":"gte","value":"20"}]}),
        true,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(result["as_of"], body["as_of"]);
    assert_eq!(result["target_count"], 2);
    for scope in [
        json!({"kind":"layers","layer_ids":["bad"]}),
        json!({"kind":"unknown"}),
        json!({"kind":"layers","layer_ids":[],"extra":true}),
    ] {
        let mut invalid = base.clone();
        invalid["scope"] = scope;
        assert_eq!(
            send(invalid, true).await.unwrap().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let mut invalid = base;
    invalid["scope"]["layer_ids"] = json!([Uuid::new_v4()]);
    assert_eq!(
        send(invalid, true).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
}

/// 画像の有無と項目なしを分け、従来のCSVでも過去の画像項目定義を使って検証する。
#[tokio::test]
async fn image_presence_works_in_both_map_scopes_and_legacy_csv() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let original: Value =
        sqlx::query_scalar("SELECT form_schema FROM common_form_model WHERE id=$1")
            .bind(f.form.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
    let photo = json!({"id":"photo","type":"image","label":"画像"});
    for (table, key) in [
        ("common_form_model", "id"),
        ("common_form_revision_model", "form_id"),
    ] {
        sqlx::query(&format!("UPDATE {table} SET form_schema=json_insert(form_schema,'$.fields[#]',json($1)) WHERE {key}=$2"))
            .bind(photo.to_string()).bind(f.form.to_string()).execute(&pool).await.unwrap();
    }
    for (id, value) in [
        (f.ids[0], json!("/image/photo.jpg")),
        (f.ids[1], Value::Null),
    ] {
        sqlx::query("UPDATE marker_form_submission_model SET form_snapshot=json_insert(form_snapshot,'$.form_schema.fields[#]',json($1)), \
            submitted_values=json_set(submitted_values,'$.photo',json($2)) WHERE marker_id=$3")
            .bind(photo.to_string()).bind(value.to_string()).bind(id.to_string()).execute(&pool).await.unwrap();
    }
    for (op, indices) in [
        ("filled", vec![0]),
        ("empty", vec![1]),
        ("missing", vec![2, 3]),
    ] {
        for ordinary in [false, true] {
            let conditions = json!([{"field_id":"photo","field_type":"image","op":op}]);
            let r = if ordinary {
                scoped(&f, conditions)
            } else {
                request(&f, "latest", conditions)
            };
            let result = filter_targets(&pool, &f.owner.to_string(), &r)
                .await
                .unwrap();
            assert!(
                result
                    .fields
                    .iter()
                    .any(|field| field.id == "photo" && field.field_type == "image")
            );
            let expected = indices
                .iter()
                .map(|&i| format!("marker:{}", f.ids[i]))
                .collect::<BTreeSet<_>>();
            assert_eq!(
                result.targets.into_iter().collect::<BTreeSet<_>>(),
                expected
            );
        }
    }
    let invalid = scoped(
        &f,
        json!([{"field_id":"photo","field_type":"image","op":"contains","value":"x"}]),
    );
    assert!(matches!(
        filter_targets(&pool, &f.owner.to_string(), &invalid).await,
        Err(AppError::Validation(_))
    ));
    for (table, key) in [
        ("common_form_model", "id"),
        ("common_form_revision_model", "form_id"),
    ] {
        sqlx::query(&format!("UPDATE {table} SET form_schema=$1 WHERE {key}=$2"))
            .bind(&original)
            .bind(f.form.to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut r = request(
        &f,
        "latest",
        json!([{"field_id":"photo","field_type":"image","op":"missing"}]),
    );
    r.targets = vec![format!("marker:{}", f.ids[2])];
    let csv = map_csv(&pool, f.owner, &r).await;
    assert_eq!(csv.matches("\r\n").count(), 2);
}
