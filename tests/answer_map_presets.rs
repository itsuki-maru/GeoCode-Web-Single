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
        CreatePreset, ListQuery, PresetKind, create_preset, create_preset_tx, delete_preset,
        get_preset, list_presets, preset_action, validate_preset_tx, validate_saved_preset,
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
        ) VALUES ($1, $2, 2, '設備台帳', '', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(form.to_string())
    .bind(owner.to_string())
    .bind(schema)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO common_form_revision_model (
            form_id,
            version,
            form_schema
        ) VALUES ($1, 1, $2)
        "#,
    )
    .bind(form.to_string())
    .bind(old.clone())
    .execute(pool)
    .await
    .unwrap();
    let marker = Uuid::new_v4();
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
        ) VALUES (
            $1,
            $2,
            $3,
            '設備',
            35,
            139,
            '',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(marker.to_string())
    .bind(owner.to_string())
    .bind(layer)
    .execute(pool)
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
        ) VALUES ($1, $2, $3, '', CURRENT_TIMESTAMP, $4, $5)
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(marker.to_string())
    .bind(json!({"legacy":"過去","material":"旧材"}))
    .bind(json!({"id":form,"version":1}))
    .bind(json!({"form_title":"旧設備台帳","form_schema":old}))
    .execute(pool)
    .await
    .unwrap();
    Fixture {
        owner,
        other,
        form,
        marker,
    }
}

fn filter(form: Option<Uuid>, conditions: Value) -> Value {
    let expression = if form.is_none() && conditions == json!([]) {
        json!({"op":"all"})
    } else {
        json!({"op":"attribute","common_form_id":form,"conditions":conditions})
    };
    json!({"name":"  保存条件  ","kind":"filter","schema_version":2,
        "definition":{"type":"filter","expression":expression}})
}

fn coloring(form: Uuid) -> Value {
    json!({"name":"色分け","kind":"coloring","schema_version":2,"definition":{"type":"color",
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

    // 保存操作は元の登録・地図検索を変更しない。既存のHTTPルートから同じ登録を得られる。
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
        json!([{"field_id":"n","field_type":"number","op":"between","value":value,"upper":"9007199254740993.00000000000000000002","ignored":"reject"}]),
    );
    assert!(matches!(
        save(&pool, f.owner, input.clone()).await,
        Err(AppError::Validation(_))
    ));
    input["definition"]["expression"]["conditions"][0]
        .as_object_mut()
        .unwrap()
        .remove("ignored");
    let first = save(&pool, f.owner, input.clone()).await.unwrap();
    let second = save(&pool, f.owner, input.clone()).await.unwrap();
    assert_ne!(first["id"], second["id"]);
    assert_eq!(first["name"], "保存条件");
    assert_eq!(
        first["definition"]["expression"]["conditions"][0]["value"],
        value
    );
    assert!(
        first["definition"]["expression"]["conditions"][0]
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
        ("schema_version", json!(1)),
        ("schema_version", json!(3)),
    ] {
        let mut input = base.clone();
        input[key] = value;
        assert!(matches!(
            save(&pool, f.owner, input).await,
            Err(AppError::Validation(_))
        ));
    }
    let invalid_conditions = vec![
        json!({"field_id":"missing","field_type":"text","op":"eq","value":"x"}),
        json!({"field_id":"n","field_type":"text","op":"eq","value":"x"}),
        json!({"field_id":"photo","field_type":"image","op":"contains","value":"x"}),
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
    for path in ["empty", "many", "duplicate", "color", "label"] {
        let mut input = coloring(f.form);
        let rule = input["definition"]["rules"][0].clone();
        match path {
            "empty" => input["definition"]["rules"] = json!([]),
            "many" => input["definition"]["rules"] = json!(vec![rule.clone(); 11]),
            "duplicate" => input["definition"]["rules"] = json!([rule.clone(), rule]),
            "color" => input["definition"]["rules"][0]["color"] = json!("red"),
            "label" => input["definition"]["rules"][0]["label"] = json!(""),
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

/// 画像の3条件をversion 2で保存し、通常地図で再実行できる。
#[tokio::test]
async fn image_presence_presets_keep_the_portable_format_and_execute() {
    use geocode_web_single::handler::answer_map_filter::{MapFilterRequest, filter_targets};
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    sqlx::query(
        r#"
        INSERT
            OR IGNORE INTO common_form_revision_model (
            form_id,
            version,
            form_schema
        )
        SELECT
            id,
            version,
            form_schema
        FROM common_form_model
        WHERE id = $1
        "#,
    )
    .bind(f.form.to_string())
    .execute(&pool)
    .await
    .unwrap();
    for op in ["filled", "empty", "missing"] {
        let condition = json!({"field_id":"photo","field_type":"image","op":op});
        for kind in ["filter", "coloring"] {
            let mut input = filter(Some(f.form), json!([condition.clone()]));
            if kind == "coloring" {
                input = coloring(f.form);
                input["definition"]["rules"][0]["conditions"] = json!([condition.clone()]);
            }
            let saved = save(&pool, f.owner, input).await.unwrap();
            assert_eq!(saved["schema_version"], 2);
            assert_eq!(saved["kind"], kind);
            assert_eq!(saved["display"]["fields"][0]["label"], "画像");
            let (conditions, form) = if kind == "filter" {
                let expression = &saved["definition"]["expression"];
                (&expression["conditions"], &expression["common_form_id"])
            } else {
                (
                    &saved["definition"]["rules"][0]["conditions"],
                    &saved["definition"]["common_form_id"],
                )
            };
            assert_eq!(conditions[0]["op"], op);
            assert!(conditions[0]["value"].is_null() && conditions[0]["upper"].is_null());
            let r: MapFilterRequest = serde_json::from_value(json!({
                "query":{"mode":"latest"},"scope":{"kind":"layers","layer_ids":null},
                "common_form_id":form,"conditions":conditions
            }))
            .unwrap();
            let result = filter_targets(&pool, &f.owner.to_string(), &r)
                .await
                .unwrap();
            assert_eq!(result.target_count, usize::from(op == "missing"));
        }
    }
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
                {"field_id":"text","field_type":"text","op":"contains","value":"  点検  "},
                {"field_id":"n","field_type":"number","op":"missing"}
            ]),
        );
        let saved = save(&pool, f.owner, input).await.unwrap();
        let conditions = &saved["definition"]["expression"]["conditions"];
        assert_eq!(conditions[0]["value"], raw);
        assert_eq!(conditions[0]["upper"], raw);
        assert_eq!(conditions[1]["value"], "  点検  ");
        assert!(conditions[1]["upper"].is_null());
        assert!(conditions[2]["value"].is_null());
        assert!(conditions[2]["upper"].is_null());
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
    colors["definition"]["rules"][0]["label"] = json!("🚧".repeat(100));
    colors["definition"]["rules"][0]["conditions"][0]["value"] = json!(50);
    let saved = save(&pool, f.owner, colors.clone()).await.unwrap();
    assert_eq!(
        saved["definition"]["rules"][0]["conditions"][0]["value"],
        "50"
    );
    colors["definition"]["rules"][0]["label"] = json!("🚧".repeat(101));
    assert!(matches!(
        save(&pool, f.owner, colors.clone()).await,
        Err(AppError::Validation(_))
    ));
    colors["definition"]["rules"][0]["label"] = json!("分類");
    colors["definition"]["rules"][0]["id"] = json!("a".repeat(41));
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
    sqlx::query(
        r#"
        UPDATE common_form_model
        SET
            deleted = true
        WHERE id = $1
        "#,
    )
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
    sqlx::query(
        r#"
        UPDATE common_form_model
        SET
            form_title = '名称変更',
            form_schema = '{"fields":[]}'
        WHERE id = $1
        "#,
    )
    .bind(f.form.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let list = list_presets(&pool, &f.owner.to_string(), ListQuery::default())
        .await
        .unwrap();
    assert_eq!(
        list.items[0].display.form_label.as_deref(),
        Some("設備台帳")
    );
    sqlx::query(
        r#"
        DELETE FROM common_form_model
        WHERE id = $1
        "#,
    )
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        },
        ListQuery {
            page: None,
            page_size: Some(0),
            ..Default::default()
        },
        ListQuery {
            page: None,
            page_size: Some(101),
            ..Default::default()
        },
        ListQuery {
            page: Some(i64::MAX),
            page_size: Some(100),
            ..Default::default()
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
    sqlx::query(
        r#"
        DELETE FROM user_model
        WHERE id = $1
        "#,
    )
    .bind(f.owner.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let remaining: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM answer_map_saved_condition_model
        "#,
    )
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
        ) VALUES (
            $1,
            $2,
            $3,
            '範囲外の設備',
            35,
            139,
            '保持する本文',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(second.to_string())
    .bind(f.owner.to_string())
    .bind(layer)
    .execute(&pool)
    .await
    .unwrap();
    for (marker, years) in [
        (f.marker, "50.00000000000000000001"),
        (second, "49.99999999999999999999"),
    ] {
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
            ) VALUES ($1, $2, $3, '', CURRENT_TIMESTAMP, $4, $5)
            "#,
        )
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
        let (conditions, form) = if saved["kind"] == "coloring" {
            (
                &definition["rules"][0]["conditions"],
                &definition["common_form_id"],
            )
        } else {
            let expression = &definition["expression"];
            (&expression["conditions"], &expression["common_form_id"])
        };
        let (status, matched, _) = http(
            &app,
            "POST",
            "/form-answers/map-filter",
            Some(f.owner),
            Some(json!({
                "query":{"mode":"history","as_of":chrono::Utc::now()},
                "targets":[format!("marker:{}",f.marker),format!("marker:{second}")],
                "common_form_id":form, "conditions":conditions
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(matched["targets"], json!([format!("marker:{}", f.marker)]));
        assert_eq!(matched["answer_count"], 1);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM marker_form_submission_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT
                detail
            FROM marker_info_model
            WHERE id = $1
            "#,
        )
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
                ..Default::default()
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

fn ai_filter(form: Uuid) -> Value {
    json!({"name":"AI complex","kind":"filter","schema_version":2,"definition":{
        "type":"filter","expression":{"op":"or","children":[
            {"op":"text","query1":"  点検  ","query2":""},
            {"op":"not","child":{"op":"attribute","common_form_id":form,"conditions":[
                {"field_id":"n","field_type":"number","op":"gte","value":"9007199254740993.00000000000000000001"}
            ]}}
        ]}
    }})
}

#[tokio::test]
async fn ai_definitions_round_trip_without_losing_expression_semantics() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let input = ai_filter(f.form);
    let saved = save(&pool, f.owner, input.clone()).await.unwrap();
    assert_eq!(
        saved["definition"]["expression"]["children"][0]["query1"],
        "  点検  "
    );
    assert_eq!(
        saved["definition"]["expression"]["children"][1]["child"]["conditions"][0]["value"],
        "9007199254740993.00000000000000000001"
    );
    let id = Uuid::parse_str(saved["id"].as_str().unwrap()).unwrap();
    let preset = get_preset(&pool, &f.owner.to_string(), &id.to_string())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(preset_action(&preset).unwrap()).unwrap(),
        saved["definition"]
    );
    assert_eq!(
        serde_json::to_value(
            validate_saved_preset(&pool, &f.owner.to_string(), &preset)
                .await
                .unwrap()
        )
        .unwrap(),
        saved["definition"]
    );
    assert!(matches!(
        get_preset(&pool, &f.other.to_string(), &id.to_string()).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        validate_saved_preset(&pool, &f.other.to_string(), &preset).await,
        Err(AppError::NotFound)
    ));

    // 条件なしの全件分類も保存できる。
    let colors = json!({"name":"全件分類","kind":"coloring","schema_version":2,"definition":{
        "type":"color","common_form_id":f.form,"rules":[{"id":"all","label":"すべて","color":"#123456","conditions":[]}]
    }});
    assert_eq!(
        save(&pool, f.owner, colors).await.unwrap()["definition"]["rules"][0]["conditions"],
        json!([])
    );
}

#[tokio::test]
async fn all_list_and_id_paths_exclude_existing_v1_and_keep_filters_and_pagination() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    save(&pool, f.owner, filter(None, json!([]))).await.unwrap();
    save(&pool, f.owner, coloring(f.form)).await.unwrap();
    for _ in 0..2 {
        save(&pool, f.owner, ai_filter(f.form)).await.unwrap();
    }
    let mut other = ai_filter(f.form);
    other["definition"] = json!({"type":"filter","expression":{"op":"all"}});
    save(&pool, f.other, other).await.unwrap();
    let retired = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO answer_map_saved_condition_model
         (id,user_id,kind,name,schema_version,definition,display,create_at)
         VALUES ($1,$2,'filter','retired',1,$3,$4,CURRENT_TIMESTAMP)",
    )
    .bind(&retired)
    .bind(f.owner.to_string())
    .bind(json!({"common_form_id":null,"conditions":[]}))
    .bind(json!({"form_label":null,"fields":[]}))
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        get_preset(&pool, &f.owner.to_string(), &retired).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        delete_preset(&pool, &f.owner.to_string(), &retired).await,
        Err(AppError::NotFound)
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT schema_version FROM answer_map_saved_condition_model WHERE id = $1"
        )
        .bind(&retired)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let page = list_presets(&pool, &f.owner.to_string(), ListQuery::default())
        .await
        .unwrap();
    assert_eq!(page.total, 4);
    assert!(page.items.iter().all(|item| item.schema_version == 2));
    let retired_page = list_presets(
        &pool,
        &f.owner.to_string(),
        ListQuery {
            versions: Some("1".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(retired_page.total, 0);
    let combined = list_presets(
        &pool,
        &f.owner.to_string(),
        ListQuery {
            versions: Some("1,2".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(combined.total, 4);
    let filtered = list_presets(
        &pool,
        &f.owner.to_string(),
        ListQuery {
            versions: Some("1,2".into()),
            kind: Some(PresetKind::Filter),
            name: Some("AI complex".into()),
            page: Some(2),
            page_size: Some(1),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (filtered.total, filtered.items.len(), filtered.page),
        (2, 1, 2)
    );
    let mismatched = list_presets(
        &pool,
        &f.owner.to_string(),
        ListQuery {
            versions: Some("2".into()),
            kind: Some(PresetKind::Coloring),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(mismatched.total, 1);
    let absent = list_presets(
        &pool,
        &f.owner.to_string(),
        ListQuery {
            versions: Some("1,2".into()),
            name: Some("' OR true --".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(absent.total, 0);
    for versions in ["", "0", "1,3", "2,", "invalid"] {
        assert!(matches!(
            list_presets(
                &pool,
                &f.owner.to_string(),
                ListQuery {
                    versions: Some(versions.into()),
                    ..Default::default()
                }
            )
            .await,
            Err(AppError::Validation(_))
        ));
    }
}

#[tokio::test]
async fn ai_presets_reject_non_display_operations_foreign_forms_and_invalid_fields() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    for definition in [
        json!({"type":"create_layer","name":"forbidden"}),
        json!({"type":"reset"}),
        json!({"type":"focus","latitude":35,"longitude":139,"zoom":10}),
        json!({"type":"filter","expression":{"op":"all"},"url":"https://example.invalid"}),
        json!({"type":"filter","expression":{"op":"attribute","common_form_id":f.form,
            "conditions":[{"field_id":"unknown","field_type":"number","op":"eq","value":"1"}]}}),
        json!({"type":"filter","expression":{"op":"attribute","common_form_id":f.form,
            "conditions":[{"field_id":"material","field_type":"select","op":"in","value":["not-a-choice"]}]}}),
        json!({"type":"filter","expression":{"op":"text","query1":"x".repeat(128 * 1024)}}),
    ] {
        let input =
            json!({"name":"bad","kind":"filter","schema_version":2,"definition":definition});
        assert!(matches!(
            save(&pool, f.owner, input).await,
            Err(AppError::Validation(_))
        ));
    }
    assert!(matches!(
        save(&pool, f.other, ai_filter(f.form)).await,
        Err(AppError::NotFound)
    ));
    let mut mismatch = ai_filter(f.form);
    mismatch["kind"] = json!("coloring");
    assert!(matches!(
        save(&pool, f.owner, mismatch).await,
        Err(AppError::Validation(_))
    ));

    let saved = save(&pool, f.owner, ai_filter(f.form)).await.unwrap();
    let id = Uuid::parse_str(saved["id"].as_str().unwrap()).unwrap();
    let preset = get_preset(&pool, &f.owner.to_string(), &id.to_string())
        .await
        .unwrap();
    sqlx::query("UPDATE answer_map_saved_condition_model SET definition=$2 WHERE id=$1")
        .bind(id.to_string())
        .bind(
            json!({"type":"filter","expression":{"op":"attribute","common_form_id":f.form,
            "conditions":[{"field_id":"unknown","field_type":"number","op":"eq","value":"1"}]}}),
        )
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        validate_saved_preset(&pool, &f.owner.to_string(), &preset).await,
        Err(AppError::Validation(_))
    ));
}

#[tokio::test]
async fn prepared_preset_validation_does_not_insert_and_caller_transaction_controls_creation() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let input: CreatePreset = serde_json::from_value(ai_filter(f.form)).unwrap();
    // 公開APIで照合関数を登録した同一接続から、呼び出し元管理のtxへ渡す。
    list_presets(&pool, &f.owner.to_string(), ListQuery::default())
        .await
        .unwrap();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    validate_preset_tx(&mut tx, &f.owner.to_string(), &input)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM answer_map_saved_condition_model")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let saved = create_preset_tx(&mut tx, &f.owner.to_string(), input)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(matches!(
        get_preset(&pool, &f.owner.to_string(), &saved.id).await,
        Err(AppError::NotFound)
    ));
}

#[tokio::test]
async fn v2_numeric_json_literals_remain_exact_strings_through_http_storage_listing_and_apply() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let low = "9007199254740993.00000000000000000001";
    let high = "9007199254740993.00000000000000000002";
    let number_low: Value = serde_json::from_str(low).unwrap();
    let number_high: Value = serde_json::from_str(high).unwrap();
    let input = json!({
        "name":"precise-v2","kind":"filter","schema_version":2,"definition":{
            "type":"filter","expression":{"op":"or","children":[
                {"op":"text","query1":"  点検  ","query2":""},
                {"op":"attribute","common_form_id":f.form,"conditions":[
                    {"field_id":"n","field_type":"number","op":"between",
                     "value":number_low,"upper":number_high}
                ]}
            ]}
        }
    });
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let (status, saved, _) = http(
        &app,
        "POST",
        "/form-answers/map-presets",
        Some(f.owner),
        Some(input),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let condition = &saved["definition"]["expression"]["children"][1]["conditions"][0];
    assert_eq!(condition["value"], low);
    assert_eq!(condition["upper"], high);
    assert_eq!(
        saved["definition"]["expression"]["children"][0]["query1"],
        "  点検  "
    );
    let (_, listed, _) = http(
        &app,
        "GET",
        "/form-answers/map-presets?versions=1,2",
        Some(f.owner),
        None,
    )
    .await;
    assert_eq!(listed["items"][0]["definition"], saved["definition"]);
    let id = Uuid::parse_str(saved["id"].as_str().unwrap()).unwrap();
    let stored = get_preset(&pool, &f.owner.to_string(), &id.to_string())
        .await
        .unwrap();
    let action = validate_saved_preset(&pool, &f.owner.to_string(), &stored)
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(action).unwrap(), saved["definition"]);
    let raw: Value =
        sqlx::query_scalar("SELECT definition FROM answer_map_saved_condition_model WHERE id=$1")
            .bind(id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(raw, saved["definition"]);

    let colors = json!({
        "name":"precise-colors-v2","kind":"coloring","schema_version":2,"definition":{
            "type":"color","common_form_id":f.form,"rules":[
                {"id":"older","label":" 高年数 ","color":"#123456","conditions":[
                    {"field_id":"n","field_type":"number","op":"gte","value":number_low}
                ]},
                {"id":"rest","label":"その他","color":"#654321","conditions":[]}
            ]
        }
    });
    let saved = save(&pool, f.owner, colors).await.unwrap();
    assert_eq!(
        saved["definition"]["rules"][0]["conditions"][0]["value"],
        low
    );
    assert_eq!(saved["definition"]["rules"][0]["id"], "older");
    assert_eq!(saved["definition"]["rules"][0]["label"], " 高年数 ");
    assert_eq!(saved["definition"]["rules"][1]["id"], "rest");
}

#[tokio::test]
async fn preset_text_fragments_match_database_like() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let path = "/form-answers/map-presets/text-fold";
    let pairs = [
        ("I", "i"),
        ("Ａ", "ａ"),
        ("ΟΣ", "ς"),
        ("I\u{0307}", "i"),
        ("K", "k"),
    ];
    let fragments: Vec<_> = pairs.iter().flat_map(|(a, b)| [*a, *b]).collect();
    let payload = json!({ "fragments": fragments });
    assert_eq!(
        http(&app, "POST", path, None, Some(payload.clone()))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, data, cache) = http(&app, "POST", path, Some(f.owner), Some(payload)).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert_eq!(cache.as_deref(), Some("no-store"));
    for (i, (haystack, needle)) in pairs.iter().enumerate() {
        let expected = sqlx::query_scalar::<_, bool>("SELECT $1 LIKE '%' || $2 || '%'")
            .bind(haystack)
            .bind(needle)
            .fetch_one(&pool)
            .await
            .unwrap();
        let folded = data[2 * i].as_str().unwrap();
        assert_eq!(folded.contains(data[2 * i + 1].as_str().unwrap()), expected);
    }
    let oversized = json!({ "fragments": vec!["I"; 2049] });
    assert_eq!(
        http(&app, "POST", path, Some(f.owner), Some(oversized))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn evaluates_display_conditions_without_ai_and_enforces_ownership() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let path = "/form-answers/map-presets/evaluate";
    let layer = common::master_layer_id(&pool, &f.owner.to_string()).await;
    let request = json!({"context":{"layer_ids":[layer]},"definition":{"type":"filter","expression":{"op":"text","query1":"設備"}}});
    let (status, evaluated, _) =
        http(&app, "POST", path, Some(f.owner), Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK, "{evaluated}");
    assert_eq!(
        evaluated["definition"],
        json!({
            "type": "filter", "expression": { "op": "text", "query1": "設備", "query2": "" }
        })
    );
    assert_eq!(
        evaluated["targets"],
        json!([format!("marker:{}", f.marker)])
    );
    assert_eq!(
        http(&app, "POST", path, None, Some(request.clone()))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        http(&app, "POST", path, Some(f.other), Some(request.clone()))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let mut reset = request.clone();
    reset["definition"] = json!({"type":"reset"});
    assert_eq!(
        http(&app, "POST", path, Some(f.owner), Some(reset)).await.1,
        json!({"type":"reset"})
    );
    let mut focus = request;
    focus["definition"] = json!({"type":"focus","latitude":1,"longitude":1});
    assert_eq!(
        http(&app, "POST", path, Some(f.owner), Some(focus)).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn prepared_map_data_projects_owned_loaded_rows_and_historical_fields() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let path = "/form-answers/map-presets/data";
    let target = format!("marker:{}", f.marker);
    let request = json!({"targets":[target],"forms":{f.form.to_string():["n","flag","photo","text","legacy"]}});
    let at = chrono::Utc::now() - chrono::Duration::minutes(1);
    // フィクスチャの旧版登録を、大きな数値を持つ現行版より前にする。
    sqlx::query("UPDATE marker_form_submission_model SET create_at = $1 WHERE marker_id = $2")
        .bind((at - chrono::Duration::minutes(1)).naive_utc())
        .bind(f.marker.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO marker_form_submission_model
        (id,marker_id,submitted_values,rendered_markdown,create_at,source_form,form_snapshot)
        SELECT $1,$2,$3,'',$4,$5,json_object('form_schema',json(form_schema))
        FROM common_form_model WHERE id=$6"#)
        .bind(Uuid::new_v4().to_string()).bind(f.marker.to_string())
        .bind(r#"{"n":12345678901234567890.123450000,"flag":false,"photo":"private-photo-path","ignored":"not requested"}"#)
        .bind(at.naive_utc()).bind(json!({"id":f.form})).bind(f.form.to_string())
        .execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO marker_form_submission_model \
        (id,marker_id,submitted_values,rendered_markdown,create_at) VALUES ($1,$2,'{}','',$3)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(f.marker.to_string())
    .bind(at.naive_utc())
    .execute(&pool)
    .await
    .unwrap();
    let (status, latest, cache) =
        http(&app, "POST", path, Some(f.owner), Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK, "{latest}");
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert_eq!(latest["rows"].as_array().unwrap().len(), 1);
    let row = &latest["rows"][0];
    assert_eq!(row["target"], target);
    assert_eq!(row["form_id"], f.form.to_string());
    assert_eq!(
        row["fields"],
        json!({
            "n":{"type":"number","value":"12345678901234567890.123450000"},
            "flag":{"type":"checkbox","value":false},
            "photo":{"type":"image","value":true},
            "text":{"type":"text","value":null}
        })
    );
    let mut history = request.clone();
    history["query"] = json!({"mode":"history","as_of":latest["as_of"]});
    let (status, data, _) = http(&app, "POST", path, Some(f.owner), Some(history.clone())).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    let rows = data["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .any(|row| row["fields"]["legacy"] == json!({"type":"text","value":"過去"}))
    );
    assert!(
        rows.iter()
            .any(|row| row["form_id"].is_null() && row["fields"] == json!({}))
    );
    history["query"]["mode"] = json!("latest");
    assert_eq!(
        http(&app, "POST", path, Some(f.owner), Some(history.clone()))
            .await
            .1["rows"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    history["query"]["as_of"] = json!(at - chrono::Duration::seconds(1));
    assert_eq!(
        http(&app, "POST", path, Some(f.owner), Some(history.clone()))
            .await
            .1["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    history["forms"] = json!({});
    assert_eq!(
        http(&app, "POST", path, Some(f.other), Some(history))
            .await
            .1["rows"],
        json!([])
    );
    let mut empty = request.clone();
    empty["targets"] = json!([]);
    assert_eq!(
        http(&app, "POST", path, Some(f.owner), Some(empty)).await.1["rows"],
        json!([])
    );
    let mut wrong_layer = request.clone();
    wrong_layer["layer_ids"] = json!([common::master_layer_id(&pool, &f.other.to_string()).await]);
    let account_changed = Request::post(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::COOKIE,
            format!(
                "access_token={}",
                geocode_web_single::auth::create_token(&f.owner.to_string(), 30, "access_token", 0)
                    .unwrap()
            ),
        )
        .header("x-ai-account-id", f.other.to_string())
        .body(Body::from(request.to_string()))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(account_changed).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        http(&app, "POST", path, Some(f.owner), Some(wrong_layer))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        http(&app, "POST", path, Some(f.other), Some(request.clone()))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        http(&app, "POST", path, None, Some(request)).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn prepared_map_data_paginates_history_within_one_target() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let path = "/form-answers/map-presets/data";
    let at = chrono::Utc::now();
    sqlx::query(
        "INSERT INTO marker_form_submission_model \
        (id,marker_id,submitted_values,rendered_markdown,create_at) \
        SELECT printf('%08x-0000-4000-8000-%012x', n, n),$1,'{}','',$2 \
         FROM (WITH RECURSIVE seq(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM seq WHERE n<2048) SELECT n FROM seq)",
    )
    .bind(f.marker.to_string())
    .bind(at.naive_utc())
    .execute(&pool)
    .await
    .unwrap();
    let mut request = json!({"targets":[format!("marker:{}", f.marker)], "forms":{}, "query":{"mode":"history","as_of":at}});
    let (status, first, _) = http(&app, "POST", path, Some(f.owner), Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let rows = first["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2048);
    let last = rows.last().unwrap();
    assert_eq!(
        first["next_cursor"],
        json!({"target":last["target"],"id":last["id"]})
    );
    request["cursor"] = first["next_cursor"].clone();
    let (status, second, _) = http(&app, "POST", path, Some(f.owner), Some(request)).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["rows"].as_array().unwrap().len(), 1);
    assert!(second["next_cursor"].is_null());
    assert!(rows.iter().all(|r| r["id"] != second["rows"][0]["id"]));
}

#[tokio::test]
async fn projected_text_size_limits_history_pages_without_losing_rows() {
    let pool = common::test_pool().await;
    let f = fixture(&pool).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let at = chrono::Utc::now();
    sqlx::query(r#"
        INSERT INTO marker_form_submission_model
            (id, marker_id, submitted_values, rendered_markdown, create_at, source_form, form_snapshot)
        SELECT printf('%08x-0000-4000-8000-%012x', n, n), $1, $4,
            '', $2, $3, '{"form_schema":{"fields":[{"id":"text","type":"text"}]}}'
        FROM (WITH RECURSIVE seq(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM seq WHERE n<600) SELECT n FROM seq)"#)
        .bind(f.marker.to_string()).bind(at.naive_utc()).bind(json!({"id":f.form})).bind(json!({"text":"a".repeat(4000)})).execute(&pool).await.unwrap();
    let mut request = json!({"targets":[format!("marker:{}",f.marker)],"forms":{f.form.to_string():["text"]},
        "query":{"mode":"history","as_of":at}});
    let mut ids = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let (status, page, _) = http(
            &app,
            "POST",
            "/form-answers/map-presets/data",
            Some(f.owner),
            Some(request.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        pages += 1;
        for row in page["rows"].as_array().unwrap() {
            assert!(ids.insert(row["id"].as_str().unwrap().to_owned()));
        }
        request["cursor"] = page["next_cursor"].clone();
        if request["cursor"].is_null() {
            break;
        }
    }
    assert_eq!(ids.len(), 601);
    assert_eq!(pages, 2);
}
