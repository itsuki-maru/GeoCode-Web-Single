#[allow(dead_code)]
mod common;
use axum::{Json, body::to_bytes, extract::Extension};
use chrono::{Duration, Utc};
use geocode_web_single::handler::form_answers::*;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

fn query(value: Value) -> AnswerQuery {
    serde_json::from_value(value).unwrap()
}
async fn search(pool: &SqlitePool, user: Uuid, value: Value) -> AnswerPage {
    search_answers_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(query(value)),
    )
    .await
    .unwrap()
    .0
}
fn schema(added: bool) -> Value {
    let mut fields = vec![
        json!({"id":"n","label":"測定値","type":"number"}),
        json!({"id":"state","label":"状態","type":"select","choices":["要対応","対応済み"]}),
        json!({"id":"flag","label":"確認","type":"checkbox"}),
        json!({"id":"date","label":"日付","type":"date"}),
        json!({"id":"note","label":"記録","type":"textarea"}),
        json!({"id":"photo","label":"写真","type":"image"}),
    ];
    if added {
        fields.push(json!({"id":"added","label":"追加項目","type":"text"}));
    }
    json!({"form_title":"投稿時フォーム","form_description":"当時の説明","form_schema":{"fields":fields}})
}

async fn marker(pool: &SqlitePool, user: Uuid, layer: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO marker_info_model (id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) VALUES($1,$2,$3,$4,35,139,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id.to_string()).bind(user.to_string()).bind(layer.to_string()).bind(name).execute(pool).await.unwrap();
    id
}

#[tokio::test]
async fn owned_history_latest_typed_filters_and_csv_agree() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "answers-owner").await;
    let other = test_user(&pool, "answers-other").await;
    let layer = test_layer(&pool, &user).await;
    let other_layer = test_layer(&pool, &other).await;
    let a = marker(&pool, user, layer, "=対象A").await;
    let b = marker(&pool, user, layer, "対象B").await;
    let foreign = marker(&pool, other, other_layer, "他人の対象").await;
    let shape = Uuid::new_v4();
    sqlx::query("INSERT INTO shape_model(id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at) VALUES($1,$2,$3,'polyline','図形S',$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(shape.to_string()).bind(user.to_string()).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}})).execute(&pool).await.unwrap();
    let form = Uuid::new_v4();
    let second_form = Uuid::new_v4();
    for id in [form, second_form] {
        sqlx::query("INSERT INTO common_form_model(id,user_id,form_title,form_description,form_schema,create_at,update_at) VALUES($1,$2,'共通フォーム','',$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id.to_string()).bind(user.to_string()).bind(schema(true)["form_schema"].clone()).execute(&pool).await.unwrap();
        for v in [1, 2] {
            sqlx::query("INSERT INTO common_form_revision_model(form_id,version,form_schema) VALUES($1,$2,$3)").bind(id.to_string()).bind(v).bind(schema(v==2)["form_schema"].clone()).execute(&pool).await.unwrap();
        }
    }
    let base = (Utc::now() - Duration::days(1)).naive_utc();
    let tie = Uuid::new_v4();
    // 同じ回答ID・時刻でもマーカーと図形を別の行としてページングする。
    for (kind, target, id, offset, source, definition, values) in [
        (
            "marker",
            a,
            Uuid::new_v4(),
            0,
            Some(json!({"id":form,"version":1})),
            Some(schema(false)),
            json!({"n":5,"state":"要対応","flag":true,"date":"2026-01-01","note":"古い回答"}),
        ),
        (
            "marker",
            a,
            Uuid::new_v4(),
            2,
            Some(json!({"id":form,"version":2})),
            Some(schema(true)),
            json!({"n":20,"state":"対応済み","flag":true,"date":"2026-02-01","added":null,"note":"=SUM(A1)\n\"引用\""}),
        ),
        (
            "marker",
            b,
            tie,
            1,
            Some(json!({"id":form,"version":1})),
            Some(schema(false)),
            json!({"n":0,"state":"要対応","flag":false,"date":"2026-01-15","note":"%_文字","photo":{"url":"/static/images/test.jpg","filename":"写真.jpg"}}),
        ),
        (
            "shape",
            shape,
            tie,
            1,
            Some(json!({"id":form,"version":2})),
            Some(schema(true)),
            json!({"n":9,"state":"要対応","flag":true,"date":"2026-01-31","added":"あり","note":"図形"}),
        ),
        (
            "marker",
            a,
            Uuid::new_v4(),
            4,
            Some(json!({"id":second_form,"version":1})),
            Some(schema(false)),
            json!({"n":1}),
        ),
        (
            "marker",
            a,
            Uuid::new_v4(),
            5,
            None,
            None,
            json!({"n":"3","legacy":"旧回答"}),
        ),
        (
            "marker",
            foreign,
            Uuid::new_v4(),
            6,
            Some(json!({"id":form,"version":1})),
            Some(schema(false)),
            json!({"n":999,"note":"秘密"}),
        ),
    ] {
        sqlx::query(&format!("INSERT INTO {kind}_form_submission_model(id,{kind}_id,create_at,submitted_values,rendered_markdown,source_form,form_snapshot) VALUES($1,$2,$3,$4,'',$5,$6)"))
            .bind(id.to_string()).bind(target.to_string()).bind(base+Duration::seconds(offset)).bind(values).bind(source).bind(definition).execute(&pool).await.unwrap();
    }
    assert_eq!(search(&pool, user, json!({})).await.total, 6);
    assert_eq!(search(&pool, other, json!({})).await.total, 1);
    assert_eq!(search(&pool, user, json!({"mode":"latest"})).await.total, 5);
    let condition = |id: &str, typ: &str, op: &str, value: Value| json!({"field_id":id,"field_type":typ,"op":op,"value":value});
    let latest=search(&pool,user,json!({"mode":"latest","common_form_id":form,"conditions":[condition("state","select","in",json!(["要対応"]))]})).await;
    assert_eq!(latest.total, 2);
    assert!(latest.rows.iter().all(|r| r.target_id != a.to_string()));
    assert_eq!(
        search(
            &pool,
            user,
            json!({"mode":"latest","common_form_id":form,"version":1})
        )
        .await
        .total,
        1
    );
    assert_eq!(search(&pool,user,json!({"mode":"latest","common_form_id":form,"until":(base+Duration::seconds(2)).and_utc()})).await.total,2);
    for (c, expected) in [
        (condition("n", "number", "gte", json!(10)), 1),
        (condition("flag", "checkbox", "eq", json!(false)), 1),
        (condition("flag", "checkbox", "filled", Value::Null), 4),
        (condition("n", "number", "filled", Value::Null), 4),
        (condition("date", "date", "gte", json!("2026-01-31")), 2),
        (condition("added", "text", "empty", Value::Null), 1),
        (condition("added", "text", "missing", Value::Null), 2),
        (condition("photo", "image", "filled", Value::Null), 1),
        (condition("note", "textarea", "contains", json!("%_")), 1),
    ] {
        assert_eq!(
            search(
                &pool,
                user,
                json!({"common_form_id":form,"conditions":[c.clone()]})
            )
            .await
            .total,
            expected,
            "{c}"
        );
    }
    let ranged = json!({"field_id":"n","field_type":"number","op":"between","value":1,"upper":10});
    assert_eq!(
        search(
            &pool,
            user,
            json!({"common_form_id":form,"conditions":[ranged]})
        )
        .await
        .total,
        2
    );
    assert_eq!(search(&pool,user,json!({"target_type":"marker","target_id":a,"individual_only":true,"conditions":[condition("n","number","gte",json!(1))]})).await.total,0);
    assert_eq!(search(&pool,user,json!({"target_type":"marker","target_id":a,"individual_only":true,"conditions":[condition("n","unknown","contains",json!("3"))]})).await.total,1);
    assert_eq!(
        search(
            &pool,
            user,
            json!({"target_id":foreign,"target_type":"marker"})
        )
        .await
        .total,
        0
    );
    let mut first = search(&pool, user, json!({"limit":2})).await;
    let at = first.as_of;
    let mut keys = vec![];
    loop {
        keys.extend(
            first
                .rows
                .iter()
                .map(|r| (r.target_type.clone(), r.id.clone())),
        );
        let Some(cursor) = first.next_cursor else {
            break;
        };
        first = search(&pool, user, json!({"limit":2,"cursor":cursor,"as_of":at})).await;
    }
    assert_eq!(keys.len(), 6);
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), 6);
    sqlx::query("UPDATE common_form_model SET deleted=true WHERE id=$1")
        .bind(form.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let options = answer_options_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(query(json!({"common_form_id":form}))),
    )
    .await
    .unwrap()
    .0;
    assert!(
        options["forms"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == form.to_string() && f["deleted"] == true)
    );
    assert!(
        options["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == "added")
    );
    assert_eq!(options["versions"], json!([2, 1]));
    assert_eq!(
        options["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["n", "state", "flag", "date", "note", "photo", "added"]
    );
    let target_options = answer_options_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(query(json!({"target_id":b,"target_type":"marker"}))),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(
        target_options["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["n", "state", "flag", "date", "note", "photo"]
    );
    // 新版で並べ替え・削除した項目は、新版の入力順を優先し、旧項目を末尾へ残す。
    let mut revised = schema(true)["form_schema"].clone();
    let revised_fields = revised["fields"].as_array_mut().unwrap();
    revised_fields.retain(|field| field["id"] != "note");
    revised_fields.reverse();
    sqlx::query(
        "UPDATE common_form_revision_model SET form_schema=$1 WHERE form_id=$2 AND version=2",
    )
    .bind(revised)
    .bind(form.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let reordered = answer_options_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(query(json!({"common_form_id":form}))),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(
        reordered["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["added", "photo", "date", "flag", "state", "n", "note"]
    );
    let csv = export_answers_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(query(json!({"common_form_id":form,"limit":1}))),
    )
    .await
    .unwrap();
    assert_eq!(csv.headers()["content-type"], "text/csv; charset=utf-8");
    let bytes = to_bytes(csv.into_body(), usize::MAX).await.unwrap();
    let csv = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.contains("'対象A") == false);
    assert!(csv.contains("'=対象A"));
    assert!(csv.contains("'=SUM(A1)\n\"\"引用\"\""));
    assert!(csv.contains("/static/images/test.jpg"));
    assert!(csv.contains("項目なし"));
    assert!(csv.contains("未入力"));
    assert!(!csv.contains("秘密"));
    let native = download_answers_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        axum::Form(CsvDownload {
            query: json!({"common_form_id":form,"limit":1}).to_string(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        native.headers()["content-disposition"],
        "attachment; filename=geocode-answers.csv"
    );
    assert_eq!(
        to_bytes(native.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        csv.as_bytes()
    );
    assert_eq!(
        check_csv_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(query(json!({"mode":"latest","common_form_id":form})))
        )
        .await
        .unwrap()
        .0["count"],
        3
    );
    let old = answer_options_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(query(
            json!({"target_type":"marker","target_id":a,"individual_only":true}),
        )),
    )
    .await
    .unwrap()
    .0;
    assert!(
        old["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == "legacy" && f["field_type"] == "unknown")
    );
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
async fn exact_numbers_json_types_and_mixed_timestamps_are_searchable() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "answer-precision").await;
    let layer = test_layer(&pool, &user).await;
    let target = marker(&pool, user, layer, "ÄBC対象").await;
    let at = "2026-01-01 00:00:00.000001";
    for (i, raw) in [
        r#"{"n":9007199254740992,"flag":false}"#,
        r#"{"n":9007199254740993,"flag":true}"#,
        r#"{"n":"0.00000000000000000002","flag":0}"#,
        r#"{"n":true,"flag":"false"}"#,
        r#"{"n":"abc"}"#,
        r#"{"n":null}"#,
        r#"{"n":0.5}"#,
        r#"{"n":"query:1"}"#,
    ]
    .iter()
    .enumerate()
    {
        sqlx::query(
            r#"
            INSERT INTO marker_form_submission_model
                (id,marker_id,create_at,submitted_values,rendered_markdown,form_snapshot)
            VALUES ($1,$2,$3,$4,'',$5)
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(target.to_string())
        .bind(if i == 1 {
            "2026-01-01T09:00:00.000002+09:00"
        } else {
            at
        })
        .bind(raw)
        .bind(schema(false))
        .execute(&pool)
        .await
        .unwrap();
    }
    for (typ, id, op, value, expected) in [
        ("number", "n", "eq", json!("9007199254740993"), 1),
        ("number", "n", "lte", json!("0.00000000000000000002"), 1),
        ("number", "n", "eq", json!(".5"), 1),
        ("number", "n", "eq", json!(1), 0),
        ("checkbox", "flag", "eq", json!(false), 1),
    ] {
        let page = search(
            &pool,
            user,
            json!({"target_type":"marker","target_id":target,
            "conditions":[{"field_id":id,"field_type":typ,"op":op,"value":value}]}),
        )
        .await;
        assert_eq!(page.total, expected, "{typ} {op} {value}");
    }
    assert_eq!(
        search(&pool, user, json!({"target_name":"äbc"}))
            .await
            .total,
        8
    );
    assert_eq!(
        search(&pool, user, json!({"from":"2026-01-01T00:00:00.000002Z"}))
            .await
            .total,
        1
    );
    let first = search(&pool, user, json!({"limit":1})).await;
    assert_eq!(
        first.rows[0].submitted_values["n"],
        json!(9007199254740993_u64)
    );
    let second = search(
        &pool,
        user,
        json!({"limit":100,"cursor":first.next_cursor,"as_of":first.as_of}),
    )
    .await;
    assert_eq!(second.rows.len(), 7);
}

#[tokio::test]
async fn csv_is_chunked_and_retains_a_read_snapshot_during_writes() {
    let (pool, path) = common::file_test_pool().await;
    let user = test_user(&pool, "answer-stream").await;
    let layer = test_layer(&pool, &user).await;
    let target = marker(&pool, user, layer, "出力対象").await;
    sqlx::query(r#"
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<201)
        INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown)
        SELECT '00000000-0000-4000-8000-'||printf('%012x',i),$1,'2026-01-01 00:00:00','{"note":"記録"}','' FROM n
        "#).bind(target.to_string()).execute(&pool).await.unwrap();
    let q = json!({"target_type":"marker","target_id":target});
    let response = export_answers_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(query(q.clone())),
    )
    .await
    .unwrap();
    sqlx::query(r#"
        INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown)
        VALUES($1,$2,'2026-01-02 00:00:00','{"later":"後からの回答"}','')
        "#).bind(Uuid::new_v4().to_string()).bind(target.to_string()).execute(&pool).await.unwrap();
    use futures_util::StreamExt;
    let mut stream = response.into_body().into_data_stream();
    let mut chunks = vec![];
    while let Some(chunk) = stream.next().await {
        chunks.push(chunk.unwrap());
    }
    assert_eq!(chunks.len(), 3);
    let csv = String::from_utf8(chunks.iter().flat_map(|c| c.iter().copied()).collect()).unwrap();
    assert_eq!(csv.lines().count(), 202);
    assert!(!csv.contains("後からの回答"));
    assert_eq!(
        check_csv_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(query(q))
        )
        .await
        .unwrap()
        .0["count"],
        202
    );
    drop(stream);
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn csv_rejects_too_many_rows_and_columns() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "answer-limits").await;
    let layer = test_layer(&pool, &user).await;
    let target = marker(&pool, user, layer, "大量回答").await;
    sqlx::query(r#"
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
        INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown)
        SELECT '00000000-0000-4000-8000-'||printf('%012x',i),$1,'2026-01-01 00:00:00','{}','' FROM n
        "#).bind(target.to_string()).execute(&pool).await.unwrap();
    assert!(
        export_answers_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(query(json!({})))
        )
        .await
        .is_err()
    );
    let wide = marker(&pool, user, layer, "多数の項目").await;
    sqlx::query(r#"
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<201)
        INSERT INTO marker_form_submission_model(id,marker_id,create_at,submitted_values,rendered_markdown)
        SELECT '10000000-0000-4000-8000-'||printf('%012x',i),$1,'2026-01-01 00:00:00',json_object('field_'||i,'記録'),'' FROM n
        "#).bind(wide.to_string()).execute(&pool).await.unwrap();
    assert!(
        export_answers_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(query(json!({"target_type":"marker","target_id":wide})))
        )
        .await
        .is_err()
    );
    assert!(
        search_answers_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(query(json!({"target_id":target})))
        )
        .await
        .is_err()
    );
    assert!(
        search_answers_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(query(json!({"target_id":"invalid","target_type":"marker"})))
        )
        .await
        .is_err()
    );
}
