#[allow(dead_code)]
mod common;
use geocode_web_single::handler::answer_map_filter::{MapFilterRequest, filter_targets};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

async fn map_csv(pool: &SqlitePool, user: Uuid, r: &MapFilterRequest) -> String {
    use axum::{Form, Json, body::to_bytes, extract::Extension};
    use geocode_web_single::handler::{answer_map_csv, form_answers::CsvDownload};
    let copy = serde_json::from_value(serde_json::to_value(r).unwrap()).unwrap();
    let check = answer_map_csv::check_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(copy),
    )
    .await
    .unwrap();
    let count: Value =
        serde_json::from_slice(&to_bytes(check.into_body(), 10000).await.unwrap()).unwrap();
    let response = answer_map_csv::download_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Form(CsvDownload {
            query: serde_json::to_string(r).unwrap(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        response.headers()["content-disposition"],
        "attachment; filename=geocode-answer-map.csv"
    );
    assert_eq!(response.headers()["cache-control"], "no-store");
    let csv = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(csv.starts_with('\u{feff}'));
    assert_eq!(
        csv.matches("\r\n").count() as i64 - 1,
        count["count"].as_i64().unwrap()
    );
    csv
}

#[tokio::test]
async fn map_csv_matches_applied_conditions_visible_targets_and_existing_csv() {
    let pool = common::test_pool().await;
    use axum::{Json, body::to_bytes, extract::Extension};
    let f = fixture(&pool).await;
    let conditions = json!([
        {"field_id":"d","field_type":"date","op":"between","value":"2020-04-01","upper":"2025-03-31"},
        {"field_id":"n","field_type":"number","op":"gte","value":"20"}
    ]);
    for (mode, count) in [("history", 3), ("latest", 1)] {
        let mut r = request(&f, mode, conditions.clone());
        let csv = map_csv(&pool, f.owner, &r).await;
        assert_eq!(csv.matches("\r\n").count() - 1, count);
        assert!(!csv.contains("他人"));
        assert!(!csv.contains(&f.ids[0].to_string())); // 日付と年数が別回答に一致しても採用しない
        r.targets = vec![format!("marker:{}", f.ids[2])];
        let csv = map_csv(&pool, f.owner, &r).await;
        assert_eq!(
            csv.matches("\r\n").count() - 1,
            if mode == "history" { 2 } else { 1 }
        );
        assert!(!csv.contains(&f.ids[1].to_string()));
        r.query.common_form_id = Some(f.form.to_string());
        r.query.conditions = serde_json::from_value(
            json!([{"field_id":"n","field_type":"number","op":"gte","value":"999"}]),
        )
        .unwrap();
        assert_eq!(map_csv(&pool, f.owner, &r).await.matches("\r\n").count(), 1);
    }
    let mut r = request(&f, "history", json!([]));
    r.common_form_id = None;
    let csv = map_csv(&pool, f.owner, &r).await;
    let response = geocode_web_single::handler::form_answers::export_answers_handler(
        Extension(f.owner.to_string()),
        Extension(pool.clone()),
        Json(r.query),
    )
    .await
    .unwrap();
    let original = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert_eq!(csv, original); // 列順・値・順序を含め既存CSVと完全一致

    // 一覧10条件と地図10条件は別枠で検証し、合計20条件でも同一回答へ適用する。
    let condition = json!({"field_id":"n","field_type":"number","op":"gte","value":"20"});
    let mut r = request(&f, "history", Value::Array(vec![condition.clone(); 10]));
    r.query.common_form_id = Some(f.form.to_string());
    r.query.conditions = serde_json::from_value(Value::Array(vec![condition; 10])).unwrap();
    assert_eq!(map_csv(&pool, f.owner, &r).await.matches("\r\n").count(), 7);
}

#[tokio::test]
async fn map_csv_preserves_missing_definitions_and_one_read_snapshot() {
    let (pool, temp_path) = common::file_test_pool().await;
    use axum::{Form, body::to_bytes, extract::Extension};
    use geocode_web_single::handler::{answer_map_csv, form_answers::CsvDownload};
    let f = fixture(&pool).await;
    sqlx::query("DELETE FROM common_form_model WHERE id=$1")
        .bind(f.form.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"UPDATE marker_form_submission_model SET form_snapshot=json_set(form_snapshot,'$.form_schema.fields',json((SELECT json_group_array(json(value)) FROM json_each(form_snapshot,'$.form_schema.fields') WHERE value->>'id'<>'n'))),
        submitted_values=json_remove(submitted_values,'$.n') WHERE marker_id=$1"#).bind(f.ids[0].to_string()).execute(&pool).await.unwrap();
    let mut r = request(
        &f,
        "history",
        json!([{"field_id":"n","field_type":"number","op":"missing"}]),
    );
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .answer_count,
        2
    );
    r.targets = vec![format!("marker:{}", f.ids[0])];
    // 200件の境界を越えて、後続チャンクも同じスナップショットを読む。
    sqlx::query(r#"WITH RECURSIVE series(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM series WHERE i<205) INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown,source_form) SELECT printf('%08x-0000-4000-8000-%012x',i,i),$1,'2026-10-01 00:00:00','{}','',json_object('id',$2) FROM series"#)
        .bind(f.ids[0].to_string()).bind(f.form.to_string()).execute(&pool).await.unwrap();
    let response = answer_map_csv::download_handler(
        Extension(f.owner.to_string()),
        Extension(pool.clone()),
        Form(CsvDownload {
            query: serde_json::to_string(&r).unwrap(),
        }),
    )
    .await
    .unwrap();
    // 出力用トランザクション確定後の追加回答と定義は列にも行にも混入しない。
    sqlx::query(r#"INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown,source_form,form_snapshot)
      VALUES($1,$2,'2026-10-02 00:00:00','{"new":"added"}','',json_object('id',$3),
      '{"form_schema":{"fields":[{"id":"new","type":"text","label":"new-column"}]}}')"#)
      .bind(Uuid::new_v4().to_string()).bind(f.ids[0].to_string()).bind(f.form.to_string()).execute(&pool).await.unwrap();
    let csv = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert_eq!(csv.matches("\r\n").count(), 208);
    assert!(!csv.contains("new-column"));
    common::close_file_test_pool(pool, temp_path).await;
}

#[tokio::test]
async fn map_csv_enforces_answer_and_field_limits() {
    let pool = common::test_pool().await;
    use axum::{Json, extract::Extension};
    use geocode_web_single::handler::answer_map_csv;
    let f = fixture(&pool).await;
    sqlx::query(r#"WITH RECURSIVE series(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM series WHERE i<10001) INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown) SELECT printf('%08x-0000-4000-8000-%012x',i,i),$1,'2026-10-01 00:00:00','{}','' FROM series"#)
        .bind(f.ids[0].to_string()).execute(&pool).await.unwrap();
    let mut r = request(&f, "history", json!([]));
    r.common_form_id = None;
    r.targets = vec![format!("marker:{}", f.ids[0])];
    assert!(
        answer_map_csv::check_handler(
            Extension(f.owner.to_string()),
            Extension(pool.clone()),
            Json(r)
        )
        .await
        .is_err()
    );
    sqlx::query("DELETE FROM marker_form_submission_model WHERE marker_id=$1")
        .bind(f.ids[0].to_string())
        .execute(&pool)
        .await
        .unwrap();
    let fields: Vec<_> = (0..201)
        .map(|i| json!({"id":format!("f{i}"),"label":format!("f{i}"),"type":"number"}))
        .collect();
    sqlx::query(r#"INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown,form_snapshot)
        VALUES($1,$2,'2026-10-01 00:00:00','{}','',$3)"#).bind(Uuid::new_v4().to_string()).bind(f.ids[0].to_string()).bind(json!({"form_schema":{"fields":fields}})).execute(&pool).await.unwrap();
    let mut r = request(&f, "history", json!([]));
    r.common_form_id = None;
    r.targets = vec![format!("marker:{}", f.ids[0])];
    assert!(
        answer_map_csv::check_handler(
            Extension(f.owner.to_string()),
            Extension(pool.clone()),
            Json(r)
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn filter_endpoint_is_authenticated_and_results_are_not_cached() {
    let pool = common::test_pool().await;
    use axum::{
        Json,
        body::Body,
        extract::Extension,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    common::init_test_env();
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    for route in ["/form-answers/map-filter", "/form-answers/map-csv-check"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(route)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let f = fixture(&pool).await;
    let r = request(&f, "history", json!([]));
    let response = geocode_web_single::handler::answer_map_filter::filter_handler(
        Extension(f.owner.to_string()),
        Extension(pool),
        Json(r),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
}

struct Data {
    owner: Uuid,
    form: Uuid,
    targets: Vec<String>,
    ids: Vec<Uuid>,
}
async fn fixture(pool: &SqlitePool) -> Data {
    let owner = test_user(pool, "filter-owner").await;
    let other = test_user(pool, "filter-other").await;
    let layer = test_master(pool, &owner).await;
    let other_layer = test_master(pool, &other).await;
    let form = Uuid::new_v4();
    let schema = json!({"fields":[{"id":"d","label":"建設年月日","type":"date"},{"id":"n","label":"耐用年数","type":"number"},
        {"id":"name","label":"名称","type":"text"},{"id":"flag","label":"確認","type":"checkbox"},
        {"id":"material","label":"材質","type":"select","choices":["GX","塩ビ"]}]});
    sqlx::query(r#"INSERT INTO common_form_model(id,user_id,form_title,form_description,form_schema,create_at,update_at)
        VALUES($1,$2,'記録','',$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"#).bind(form.to_string()).bind(owner.to_string()).bind(&schema).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO common_form_revision_model(form_id,version,form_schema) VALUES($1,1,$2)",
    )
    .bind(form.to_string())
    .bind(&schema)
    .execute(pool)
    .await
    .unwrap();
    let cases = [
        ("2019-12-31", 30, "2021-01-01", 10),
        ("2020-04-01", 20, "2020-04-01", 10),
        ("2025-03-31", 30, "2025-03-31", 30),
        ("2025-04-01", 40, "2025-04-01", 40),
    ];
    let mut ids = vec![];
    let mut targets = vec![];
    for (i, (d, n, d2, n2)) in cases.iter().enumerate() {
        let id = Uuid::new_v4();
        ids.push(id);
        targets.push(format!("marker:{id}"));
        sqlx::query(r#"INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at)
            VALUES($1,$2,$3,'施設',35,139,'本文',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"#).bind(id.to_string()).bind(owner.to_string()).bind(layer.to_string()).execute(pool).await.unwrap();
        for (at, date, years) in [
            ("2026-10-01 00:00:00", d, n),
            ("2026-10-02 00:00:00", d2, n2),
        ] {
            sqlx::query(r#"INSERT INTO marker_form_submission_model(id,marker_id,submitted_values,rendered_markdown,create_at,source_form,form_snapshot)
                VALUES($1,$2,$3,'',$4,$5,$6)"#).bind(Uuid::new_v4().to_string()).bind(id.to_string())
                .bind(json!({"d":date,"n":years,"name":format!("施設{i}"),"flag":i%2==0,"material":if i%2==0 {"GX"}else{"塩ビ"}}))
                .bind(at).bind(json!({"id":form,"version":1})).bind(json!({"form_title":"記録","form_schema":schema})).execute(pool).await.unwrap();
        }
    }
    // 同じUUIDの図形は別対象。別ユーザーのIDを混ぜても取得できない。
    sqlx::query(r#"INSERT INTO shape_model(id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at)
        VALUES($1,$2,$3,'polyline','管路',$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"#).bind(ids[0].to_string()).bind(owner.to_string()).bind(layer.to_string())
        .bind(json!({"type":"LineString","coordinates":[[139,35],[140,36]]})).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO shape_form_submission_model(id,shape_id,submitted_values,rendered_markdown,create_at)
        VALUES($1,$2,'{}','', '2026-10-01 00:00:00')"#).bind(Uuid::new_v4().to_string()).bind(ids[0].to_string()).execute(pool).await.unwrap();
    targets.push(format!("shape:{}", ids[0]));
    let foreign = Uuid::new_v4();
    sqlx::query(r#"INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at)
        VALUES($1,$2,$3,'他人',35,139,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"#).bind(foreign.to_string()).bind(other.to_string()).bind(other_layer.to_string()).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO marker_form_submission_model(id,marker_id,submitted_values,rendered_markdown,create_at,source_form,form_snapshot)
        VALUES($1,$2,'{"n":99,"d":"2020-04-01"}','', '2026-10-01 00:00:00',$3,$4)"#)
        .bind(Uuid::new_v4().to_string()).bind(foreign.to_string()).bind(json!({"id":form,"version":1})).bind(json!({"form_schema":schema})).execute(pool).await.unwrap();
    targets.push(format!("marker:{foreign}"));
    Data {
        owner,
        form,
        targets,
        ids,
    }
}
fn request(f: &Data, mode: &str, conditions: Value) -> MapFilterRequest {
    serde_json::from_value(
        json!({"query":{"mode":mode,"limit":1,"as_of":"2026-10-03T00:00:00Z"},
        "targets":f.targets,"common_form_id":f.form,"conditions":conditions}),
    )
    .unwrap()
}
#[tokio::test]
async fn inclusive_dates_numbers_same_answer_and_latest() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    for (mode, counts) in [
        ("history", [(7, 4), (5, 3), (6, 4), (3, 2)]),
        ("latest", [(4, 4), (3, 3), (2, 2), (1, 1)]),
    ] {
        let date = json!({"field_id":"d","field_type":"date","op":"gte","value":"2020-04-01"});
        let range = json!({"field_id":"d","field_type":"date","op":"between","value":"2020-04-01","upper":"2025-03-31"});
        let years = json!({"field_id":"n","field_type":"number","op":"gte","value":"20"});
        for (conditions, (answers, targets)) in [
            json!([date]),
            json!([range.clone()]),
            json!([years.clone()]),
            json!([range, years]),
        ]
        .into_iter()
        .zip(counts)
        {
            let r = filter_targets(&pool, &f.owner.to_string(), &request(&f, mode, conditions))
                .await
                .unwrap();
            assert_eq!((r.answer_count, r.target_count), (answers, targets));
            assert!(r.targets.iter().all(|s| s.starts_with("marker:")));
        }
    }
    let mut r = request(&f, "history", json!([]));
    r.common_form_id = None;
    let all = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert_eq!((all.answer_count, all.target_count), (9, 5));
    assert!(all.targets.contains(&format!("shape:{}", f.ids[0])));
    r.targets = vec![format!("marker:{}", f.ids[0])];
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        1
    );
    r.targets.clear();
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        0
    );
}
#[tokio::test]
async fn original_scope_options_zero_results_and_validation() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let mut r = request(
        &f,
        "history",
        json!([{"field_id":"d","field_type":"date","op":"gte","value":"2020-04-01"}]),
    );
    r.query.common_form_id = Some(f.form.to_string());
    r.query.conditions = serde_json::from_value(
        json!([{"field_id":"n","field_type":"number","op":"gte","value":"30"}]),
    )
    .unwrap();
    let result = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert_eq!((result.answer_count, result.target_count), (4, 2));
    r.conditions = serde_json::from_value(
        json!([{"field_id":"n","field_type":"number","op":"gte","value":"999"}]),
    )
    .unwrap();
    let result = filter_targets(&pool, &f.owner.to_string(), &r)
        .await
        .unwrap();
    assert_eq!(result.target_count, 0);
    assert_eq!(result.forms.len(), 1);
    assert_eq!(result.fields[0].id, "d");
    r.options_only = true;
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .fields
            .len(),
        5
    );
    r.options_only = false;
    r.query.as_of = None;
    assert!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .is_err()
    );
    r.query.as_of = Some("2026-10-03T00:00:00Z".parse().unwrap());
    r.conditions=serde_json::from_value(json!([{"field_id":"d","field_type":"date","op":"between","value":"2025-03-31","upper":"2020-04-01"}])).unwrap();
    assert!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .is_err()
    );
    r.conditions.clear();
    r.targets = vec!["marker:bad".into()];
    assert!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .is_err()
    );
    r.targets = vec![format!("marker:{}", f.ids[0]); 10001];
    assert!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("重複")
    );
    r.targets = f.targets.clone();
    r.query.conditions.clear();
    r.conditions=serde_json::from_value(json!([{"field_id":"n","field_type":"number","op":"between","value":"9007199254740993.0001","upper":"9007199254740993.0000"}])).unwrap();
    assert!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .is_err()
    );
    r.conditions = serde_json::from_value(
        json!([{"field_id":"flag","field_type":"checkbox","op":"eq","value":false}]),
    )
    .unwrap();
    assert_eq!(
        filter_targets(&pool, &f.owner.to_string(), &r)
            .await
            .unwrap()
            .target_count,
        2
    );
}

async fn test_user(pool: &SqlitePool, name: &str) -> uuid::Uuid {
    uuid::Uuid::parse_str(&common::create_test_user(pool, name).await).unwrap()
}
async fn test_master(pool: &SqlitePool, user: &uuid::Uuid) -> uuid::Uuid {
    uuid::Uuid::parse_str(&common::master_layer_id(pool, &user.to_string()).await).unwrap()
}
