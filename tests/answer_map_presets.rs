#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use geocode_web_single::{
    error::AppError,
    handler::answer_map_presets::{
        CreatePreset, ListQuery, create_preset, delete_preset, list_presets,
    },
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    owner: Uuid,
    other: Uuid,
    form: Uuid,
    marker: Uuid,
}

async fn fixture(pool: &SqlitePool) -> Fixture {
    let owner = Uuid::parse_str(&common::create_test_user(pool, "preset-owner").await).unwrap();
    let other = Uuid::parse_str(&common::create_test_user(pool, "preset-other").await).unwrap();
    let layer = common::master_layer_id(pool, &owner.to_string()).await;
    let form = Uuid::new_v4();
    let schema = json!({"fields":[
        {"id":"n","type":"number","label":"耐用年数"},
        {"id":"text","type":"text","label":"名称"},
        {"id":"date","type":"date","label":"建設日"},
        {"id":"flag","type":"checkbox","label":"確認"},
        {"id":"material","type":"select","label":"材質","choices":["GX","塩ビ"]},
        {"id":"photo","type":"image","label":"画像"}
    ]});
    let old = json!({"fields":[
        {"id":"legacy","type":"text","label":"過去の項目"},
        {"id":"material","type":"select","label":"旧材質","choices":["旧材"]}
    ]});
    sqlx::query("INSERT INTO common_form_model(id,user_id,version,form_title,form_description,form_schema,create_at,update_at) VALUES($1,$2,2,'設備台帳','',$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
        .bind(form.to_string()).bind(owner.to_string()).bind(schema).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO common_form_revision_model(form_id,version,form_schema) VALUES($1,1,$2)",
    )
    .bind(form.to_string())
    .bind(old.clone())
    .execute(pool)
    .await
    .unwrap();
    let marker = Uuid::new_v4();
    sqlx::query("INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) VALUES($1,$2,$3,'設備',35,139,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
        .bind(marker.to_string()).bind(owner.to_string()).bind(layer).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO marker_form_submission_model(id,marker_id,submitted_values,rendered_markdown,create_at,source_form,form_snapshot) VALUES($1,$2,$3,'',CURRENT_TIMESTAMP,$4,$5)")
        .bind(Uuid::new_v4().to_string()).bind(marker.to_string()).bind(json!({"legacy":"過去","material":"旧材"}))
        .bind(json!({"id":form,"version":1})).bind(json!({"form_title":"旧設備台帳","form_schema":old}))
        .execute(pool).await.unwrap();
    Fixture {
        owner,
        other,
        form,
        marker,
    }
}

fn filter(form: Option<Uuid>, conditions: Value) -> Value {
    json!({"name":"  保存条件  ","kind":"filter","schema_version":1,
        "definition":{"common_form_id":form,"conditions":conditions}})
}

fn coloring(form: Uuid) -> Value {
    json!({"name":"色分け","kind":"coloring","schema_version":1,"definition":{
        "common_form_id":form,"rules":[{"id":"rule-1","label":"50年以上","color":"#f43F5e",
        "conditions":[{"field_id":"n","field_type":"number","op":"gte","value":"50"}]}]}})
}

async fn save(pool: &SqlitePool, user: Uuid, input: Value) -> Result<Value, AppError> {
    let request: CreatePreset = serde_json::from_value(input).unwrap();
    Ok(serde_json::to_value(create_preset(pool, &user.to_string(), request).await?).unwrap())
}

async fn http(
    app: &Router,
    method: &str,
    path: &str,
    user: Option<Uuid>,
    body: Option<Value>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(user) = user {
        request = request.header(
            "cookie",
            format!(
                "access_token={}",
                geocode_web_single::auth::create_token(&user.to_string(), 30, "access_token", 0)
                    .unwrap()
            ),
        );
    }
    let body = if let Some(body) = body {
        request = request.header(header::CONTENT_TYPE, "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cache = response
        .headers()
        .get(header::CACHE_CONTROL)
        .map(|value| value.to_str().unwrap().to_string());
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cache,
    )
}

#[tokio::test]
async fn authenticated_crud_is_owner_only_and_existing_map_routes_still_work() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let base = "/form-answers/map-presets";
    for method in ["GET", "POST", "DELETE"] {
        let path = if method == "DELETE" {
            format!("{base}/{}", Uuid::new_v4())
        } else {
            base.into()
        };
        assert_eq!(
            http(&app, method, &path, None, Some(filter(None, json!([]))))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (status, saved, cache) =
        http(&app, "POST", base, Some(f.owner), Some(coloring(f.form))).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert_eq!(saved["display"]["form_label"], "設備台帳");
    assert_eq!(saved["display"]["fields"][0]["label"], "耐用年数");
    assert!(saved.get("user_id").is_none());
    let id = saved["id"].as_str().unwrap();
    let (_, page, cache) = http(&app, "GET", base, Some(f.owner), None).await;
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0], saved);
    let (_, other_page, _) = http(&app, "GET", base, Some(f.other), None).await;
    assert_eq!(other_page["total"], 0);
    assert_eq!(other_page["items"], json!([]));
    let foreign = http(&app, "DELETE", &format!("{base}/{id}"), Some(f.other), None).await;
    let absent = http(
        &app,
        "DELETE",
        &format!("{base}/{}", Uuid::new_v4()),
        Some(f.other),
        None,
    )
    .await;
    assert_eq!(foreign.0, StatusCode::NOT_FOUND);
    assert_eq!(foreign.2.as_deref(), Some("no-store"));
    assert_eq!((foreign.0, foreign.1), (absent.0, absent.1));
    let invalid_page = http(&app, "GET", &format!("{base}?page=0"), Some(f.owner), None).await;
    assert_eq!(invalid_page.0, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_page.2.as_deref(), Some("no-store"));
    let mut spoofed = coloring(f.form);
    spoofed["user_id"] = json!(f.owner);
    assert_eq!(
        http(&app, "POST", base, Some(f.other), Some(spoofed))
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        http(
            &app,
            "PUT",
            &format!("{base}/{id}"),
            Some(f.owner),
            Some(coloring(f.form))
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let (status, _, cache) =
        http(&app, "DELETE", &format!("{base}/{id}"), Some(f.owner), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert_eq!(
        http(&app, "DELETE", &format!("{base}/{id}"), Some(f.owner), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // 保存操作は元の回答・地図検索を変更しない。既存のHTTPルートから同じ回答を得られる。
    let query = json!({"common_form_id":f.form,"mode":"history"});
    let (status, answers, _) = http(
        &app,
        "POST",
        "/form-answers/search",
        Some(f.owner),
        Some(query.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(answers["total"], 1);
    let (status, map, _) = http(
        &app,
        "POST",
        "/form-answers/map-filter",
        Some(f.owner),
        Some(json!({
        "query":{"common_form_id":f.form,"mode":"history","as_of":chrono::Utc::now()},
        "targets":[format!("marker:{}",f.marker)],"common_form_id":f.form,
        "conditions":[{"field_id":"legacy","field_type":"text","op":"eq","value":"過去"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(map["answer_count"], 1);
}

#[tokio::test]
async fn definitions_round_trip_precisely_without_runtime_or_unrecognized_data() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let value = "9007199254740993.00000000000000000001";
    let mut input = filter(
        Some(f.form),
        json!([{"field_id":"n","field_type":"number","op":"between","value":value,"upper":"9007199254740993.00000000000000000002","ignored":"discard"}]),
    );
    let first = save(&pool, f.owner, input.clone()).await.unwrap();
    let second = save(&pool, f.owner, input.clone()).await.unwrap();
    assert_ne!(first["id"], second["id"]);
    assert_eq!(first["name"], "保存条件");
    assert_eq!(first["definition"]["conditions"][0]["value"], value);
    assert!(
        first["definition"]["conditions"][0]
            .get("ignored")
            .is_none()
    );
    let round_trip = list_presets(&pool, &f.owner.to_string(), ListQuery::default())
        .await
        .unwrap();
    assert_eq!(round_trip.items.len(), 2);
    assert_eq!(round_trip.items[0].definition, first["definition"]);
    for extra in [
        "as_of",
        "targets",
        "query",
        "answer_count",
        "visible_targets",
    ] {
        input["definition"][extra] = json!("must not persist");
        assert!(matches!(
            save(&pool, f.owner, input.clone()).await,
            Err(AppError::Validation(_))
        ));
        input["definition"].as_object_mut().unwrap().remove(extra);
    }
    let no_form = save(&pool, f.owner, filter(None, json!([]))).await.unwrap();
    assert_eq!(no_form["display"], json!({"form_label":null,"fields":[]}));
}

#[tokio::test]
async fn rejects_invalid_names_versions_types_operators_values_and_limits() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let base = filter(Some(f.form), json!([]));
    for (key, value) in [
        ("name", json!(" \n ")),
        ("name", json!("あ".repeat(101))),
        ("schema_version", json!(2)),
    ] {
        let mut input = base.clone();
        input[key] = value;
        assert!(matches!(
            save(&pool, f.owner, input).await,
            Err(AppError::Validation(_))
        ));
    }
    let invalid_conditions = vec![
        json!({"field_id":"text","field_type":"text","op":"eq","value":""}),
        json!({"field_id":"text","field_type":"text","op":"contains","value":" \n\t "}),
        json!({"field_id":"missing","field_type":"text","op":"eq","value":"x"}),
        json!({"field_id":"n","field_type":"text","op":"eq","value":"x"}),
        json!({"field_id":"photo","field_type":"image","op":"filled"}),
        json!({"field_id":"n","field_type":"unknown","op":"empty"}),
        json!({"field_id":"n","field_type":"number","op":"contains","value":"1"}),
        json!({"field_id":"n","field_type":"number","op":"gte","value":"NaN"}),
        json!({"field_id":"n","field_type":"number","op":"gte","value":"1e-1001"}),
        // f64で等しい値に丸められても、NUMERICで逆転を拒否する。
        json!({"field_id":"n","field_type":"number","op":"between","value":"9007199254740993","upper":"9007199254740992"}),
        json!({"field_id":"date","field_type":"date","op":"eq","value":"2026-02-30"}),
        json!({"field_id":"flag","field_type":"checkbox","op":"eq","value":"true"}),
        json!({"field_id":"material","field_type":"select","op":"in","value":["未定義"]}),
    ];
    for condition in invalid_conditions {
        assert!(
            matches!(
                save(
                    &pool,
                    f.owner,
                    filter(Some(f.form), json!([condition.clone()]))
                )
                .await,
                Err(AppError::Validation(_))
            ),
            "accepted {condition}"
        );
    }
    let condition = json!({"field_id":"n","field_type":"number","op":"gte","value":"50"});
    assert!(matches!(
        save(
            &pool,
            f.owner,
            filter(Some(f.form), json!(vec![condition.clone(); 11]))
        )
        .await,
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        save(&pool, f.owner, filter(None, json!([condition]))).await,
        Err(AppError::Validation(_))
    ));
    for path in ["empty", "many", "duplicate", "color", "label", "conditions"] {
        let mut input = coloring(f.form);
        let rule = input["definition"]["rules"][0].clone();
        match path {
            "empty" => input["definition"]["rules"] = json!([]),
            "many" => input["definition"]["rules"] = json!(vec![rule.clone(); 11]),
            "duplicate" => input["definition"]["rules"] = json!([rule.clone(), rule]),
            "color" => input["definition"]["rules"][0]["color"] = json!("red"),
            "label" => input["definition"]["rules"][0]["label"] = json!("  "),
            "conditions" => input["definition"]["rules"][0]["conditions"] = json!([]),
            _ => unreachable!(),
        }
        assert!(
            matches!(
                save(&pool, f.owner, input).await,
                Err(AppError::Validation(_))
            ),
            "accepted {path}"
        );
    }
    assert_eq!(
        list_presets(&pool, &f.owner.to_string(), ListQuery::default())
            .await
            .unwrap()
            .total,
        0
    );
}

#[tokio::test]
async fn api_definitions_are_canonical_and_match_editor_and_coloring_limits() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    for raw in ["50", "9007199254740993.00000000000000000001"] {
        let number: Value = serde_json::from_str(raw).unwrap();
        let input = filter(
            Some(f.form),
            json!([
                {"field_id":"n","field_type":"number","op":"between","value":number,"upper":number},
                {"field_id":"text","field_type":"text","op":"contains","value":"  点検  ","upper":"ignored"},
                {"field_id":"n","field_type":"number","op":"missing","value":"ignored","upper":"ignored"}
            ]),
        );
        let saved = save(&pool, f.owner, input).await.unwrap();
        assert_eq!(saved["definition"]["conditions"][0]["value"], raw);
        assert_eq!(saved["definition"]["conditions"][0]["upper"], raw);
        assert_eq!(saved["definition"]["conditions"][1]["value"], "点検");
        assert!(saved["definition"]["conditions"][1]["upper"].is_null());
        assert!(saved["definition"]["conditions"][2]["value"].is_null());
        assert!(saved["definition"]["conditions"][2]["upper"].is_null());
    }
    let mut named = filter(None, json!([]));
    named["name"] = json!("🚧".repeat(100));
    assert_eq!(
        save(&pool, f.owner, named.clone()).await.unwrap()["name"],
        named["name"]
    );
    named["name"] = json!("🚧".repeat(101));
    assert!(matches!(
        save(&pool, f.owner, named).await,
        Err(AppError::Validation(_))
    ));
    let mut colors = coloring(f.form);
    colors["definition"]["rules"][0]["label"] = json!("🚧".repeat(50));
    colors["definition"]["rules"][0]["conditions"][0]["value"] = json!(50);
    let saved = save(&pool, f.owner, colors.clone()).await.unwrap();
    assert_eq!(
        saved["definition"]["rules"][0]["conditions"][0]["value"],
        "50"
    );
    colors["definition"]["rules"][0]["label"] = json!("🚧".repeat(51));
    assert!(matches!(
        save(&pool, f.owner, colors.clone()).await,
        Err(AppError::Validation(_))
    ));
    colors["definition"]["rules"][0]["label"] = json!("分類");
    colors["definition"]["rules"][0]["id"] = json!("🚧".repeat(51));
    assert!(matches!(
        save(&pool, f.owner, colors).await,
        Err(AppError::Validation(_))
    ));
}

#[tokio::test]
async fn form_ownership_and_historical_soft_deleted_definitions_are_respected() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let historical = filter(
        Some(f.form),
        json!([
        {"field_id":"legacy","field_type":"text","op":"eq","value":"過去"},
        {"field_id":"material","field_type":"select","op":"in","value":["旧材"]}]),
    );
    assert!(matches!(
        save(&pool, f.other, historical.clone()).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        save(&pool, f.owner, filter(Some(Uuid::new_v4()), json!([]))).await,
        Err(AppError::NotFound)
    ));
    sqlx::query("UPDATE common_form_model SET deleted=true WHERE id=$1")
        .bind(f.form.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let preset = save(&pool, f.owner, historical.clone()).await.unwrap();
    assert!(
        preset["display"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["label"] == "過去の項目")
    );
    assert!(
        preset["display"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["label"] == "材質")
    );
    // 保存後の定義変更によって表示用スナップショットは変化しない。
    sqlx::query("UPDATE common_form_model SET form_title='名称変更',form_schema='{\"fields\":[]}' WHERE id=$1").bind(f.form.to_string()).execute(&pool).await.unwrap();
    let list = list_presets(&pool, &f.owner.to_string(), ListQuery::default())
        .await
        .unwrap();
    assert_eq!(
        list.items[0].display.form_label.as_deref(),
        Some("設備台帳")
    );
    sqlx::query("DELETE FROM common_form_model WHERE id=$1")
        .bind(f.form.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let saved = save(&pool, f.owner, historical).await.unwrap();
    assert_eq!(saved["display"]["form_label"], "旧設備台帳");
    assert!(matches!(
        save(&pool, f.other, filter(Some(f.form), json!([]))).await,
        Err(AppError::NotFound)
    ));
}

#[tokio::test]
async fn pagination_is_stable_owner_scoped_and_account_deletion_cascades() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let one = save(&pool, f.owner, filter(None, json!([]))).await.unwrap();
    let two = save(&pool, f.owner, coloring(f.form)).await.unwrap();
    let three = save(&pool, f.owner, filter(Some(f.form), json!([])))
        .await
        .unwrap();
    save(&pool, f.other, filter(None, json!([]))).await.unwrap();
    let p1 = list_presets(
        &pool,
        &f.owner.to_string(),
        ListQuery {
            page: Some(1),
            page_size: Some(2),
        },
    )
    .await
    .unwrap();
    let p2 = list_presets(
        &pool,
        &f.owner.to_string(),
        ListQuery {
            page: Some(2),
            page_size: Some(2),
        },
    )
    .await
    .unwrap();
    assert_eq!((p1.total, p1.page, p1.page_size), (3, 1, 2));
    assert_eq!(
        serde_json::to_value(&p1.items[0]).unwrap()["id"],
        three["id"]
    );
    assert_eq!(serde_json::to_value(&p1.items[1]).unwrap()["id"], two["id"]);
    assert_eq!(serde_json::to_value(&p2.items[0]).unwrap()["id"], one["id"]);
    for query in [
        ListQuery {
            page: Some(0),
            page_size: None,
        },
        ListQuery {
            page: None,
            page_size: Some(0),
        },
        ListQuery {
            page: None,
            page_size: Some(101),
        },
        ListQuery {
            page: Some(i64::MAX),
            page_size: Some(100),
        },
    ] {
        assert!(matches!(
            list_presets(&pool, &f.owner.to_string(), query).await,
            Err(AppError::Validation(_))
        ));
    }
    let id = Uuid::parse_str(two["id"].as_str().unwrap()).unwrap();
    delete_preset(&pool, &f.owner.to_string(), &id.to_string())
        .await
        .unwrap();
    assert_eq!(
        list_presets(&pool, &f.owner.to_string(), ListQuery::default())
            .await
            .unwrap()
            .total,
        2
    );
    sqlx::query("DELETE FROM user_model WHERE id=$1")
        .bind(f.owner.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM answer_map_saved_condition_model")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, 1);
}

#[tokio::test]
async fn saved_filter_and_coloring_definitions_execute_in_the_current_owned_map_scope() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let layer = common::master_layer_id(&pool, &f.owner.to_string()).await;
    let second = Uuid::new_v4();
    sqlx::query("INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) VALUES($1,$2,$3,'範囲外の設備',35,139,'保持する本文',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
        .bind(second.to_string()).bind(f.owner.to_string()).bind(layer).execute(&pool).await.unwrap();
    for (marker, years) in [
        (f.marker, "50.00000000000000000001"),
        (second, "49.99999999999999999999"),
    ] {
        sqlx::query("INSERT INTO marker_form_submission_model(id,marker_id,submitted_values,rendered_markdown,create_at,source_form,form_snapshot) VALUES($1,$2,$3,'',CURRENT_TIMESTAMP,$4,$5)")
            .bind(Uuid::new_v4().to_string()).bind(marker.to_string()).bind(json!({"n":years}))
            .bind(json!({"id":f.form,"version":2}))
            .bind(json!({"form_title":"設備台帳","form_schema":{"fields":[{"id":"n","type":"number","label":"耐用年数"}]}}))
            .execute(&pool).await.unwrap();
    }
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let condition = json!({"field_id":"n","field_type":"number","op":"gte","value":"50"});
    for input in [filter(Some(f.form), json!([condition])), coloring(f.form)] {
        assert_eq!(
            http(
                &app,
                "POST",
                "/form-answers/map-presets",
                Some(f.owner),
                Some(input)
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }
    let (status, page, _) = http(
        &app,
        "GET",
        "/form-answers/map-presets",
        Some(f.owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    for saved in page["items"].as_array().unwrap() {
        let definition = &saved["definition"];
        let conditions = if saved["kind"] == "coloring" {
            definition["rules"][0]["conditions"].clone()
        } else {
            definition["conditions"].clone()
        };
        let (status, matched, _) = http(
            &app,
            "POST",
            "/form-answers/map-filter",
            Some(f.owner),
            Some(json!({
                "query":{"mode":"history","as_of":chrono::Utc::now()},
                "targets":[format!("marker:{}",f.marker),format!("marker:{second}")],
                "common_form_id":definition["common_form_id"], "conditions":conditions
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(matched["targets"], json!([format!("marker:{}", f.marker)]));
        assert_eq!(matched["answer_count"], 1);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM marker_form_submission_model")
            .fetch_one(&pool)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT detail FROM marker_info_model WHERE id=$1")
            .bind(second.to_string())
            .fetch_one(&pool)
            .await
            .unwrap(),
        "保持する本文"
    );
}

#[tokio::test]
async fn saved_conditions_survive_file_database_reopen_and_keep_owner_isolation() {
    let (pool, path) = common::file_test_pool().await;
    let f = fixture(&pool).await;
    let first = save(
        &pool,
        f.owner,
        filter(
            Some(f.form),
            json!([
                {"field_id":"legacy","field_type":"text","op":"eq","value":"過去"}
            ]),
        ),
    )
    .await
    .unwrap();
    let second = save(&pool, f.owner, coloring(f.form)).await.unwrap();
    pool.close().await;
    drop(pool);
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let reopened = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    geocode_web_single::db::run_migrations(&reopened)
        .await
        .unwrap();
    let app = geocode_web_single::router::build_router(
        reopened.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let (status, page, _) = http(
        &app,
        "GET",
        "/form-answers/map-presets",
        Some(f.owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["total"], 2);
    assert_eq!(page["items"], json!([second, first]));
    let (_, others, _) = http(
        &app,
        "GET",
        "/form-answers/map-presets",
        Some(f.other),
        None,
    )
    .await;
    assert_eq!(others["total"], 0);
    let id = page["items"][0]["id"].as_str().unwrap();
    assert_eq!(
        http(
            &app,
            "DELETE",
            &format!("/form-answers/map-presets/{id}"),
            Some(f.other),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        http(
            &app,
            "DELETE",
            &format!("/form-answers/map-presets/{id}"),
            Some(f.owner),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        list_presets(&reopened, &f.owner.to_string(), ListQuery::default())
            .await
            .unwrap()
            .total,
        1
    );
    drop(app);
    common::close_file_test_pool(reopened, path).await;
}

#[tokio::test]
async fn concurrent_file_database_changes_keep_total_and_page_in_the_same_snapshot() {
    let (pool, path) = common::file_test_pool().await;
    let owner = common::create_test_user(&pool, "snapshot-owner").await;
    let owner_id = Uuid::parse_str(&owner).unwrap();
    save(&pool, owner_id, filter(None, json!([])))
        .await
        .unwrap();
    let writer_pool = pool.clone();
    let writer_owner = owner.clone();
    let writer = tokio::spawn(async move {
        for _ in 0..20 {
            let saved = save(&writer_pool, owner_id, filter(None, json!([])))
                .await
                .unwrap();
            tokio::task::yield_now().await;
            delete_preset(&writer_pool, &writer_owner, saved["id"].as_str().unwrap())
                .await
                .unwrap();
        }
    });
    for _ in 0..40 {
        let page = list_presets(
            &pool,
            &owner,
            ListQuery {
                page: Some(1),
                page_size: Some(100),
            },
        )
        .await
        .unwrap();
        assert_eq!(page.total as usize, page.items.len());
        assert!((1..=2).contains(&page.total));
        tokio::task::yield_now().await;
    }
    writer.await.unwrap();
    assert_eq!(
        list_presets(&pool, &owner, ListQuery::default())
            .await
            .unwrap()
            .total,
        1
    );
    common::close_file_test_pool(pool, path).await;
}
