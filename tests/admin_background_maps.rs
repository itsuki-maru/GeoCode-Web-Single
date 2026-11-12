#[allow(dead_code)]
mod common;

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Extension, Path},
    http::{Request, StatusCode},
    response::IntoResponse,
};
use geocode_web_single::{
    auth::create_token,
    error::AppError,
    handler::background_maps::{BackgroundMapInput, admin_create, admin_list, admin_update},
    model::TileServers,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;

fn definition(name: &str) -> Value {
    // 旧ラスタ要求はkind・style_urlを省略し、ズーム情報のNULLを保持する。
    json!({
        "layer_name": name, "label": name, "url": "/tile/{z}/{x}/{y}.png",
        "attribution": "<a href='https://example.test/'>旧出典</a>",
        "include_foreign_tiles": false, "min_zoom": null, "max_zoom": null,
    })
}

fn vector(name: &str) -> Value {
    let mut value = definition(name);
    value["kind"] = json!("vector");
    value["style_url"] = json!("/styles/v1.json?public=token");
    value
}

fn input(value: Value) -> Json<BackgroundMapInput> {
    Json(serde_json::from_value(value).unwrap())
}

async fn create(pool: &SqlitePool, user: &str, value: Value) -> TileServers {
    admin_create(
        Extension(user.to_owned()),
        Extension(pool.clone()),
        None,
        input(value),
    )
    .await
    .unwrap()
    .0
}

async fn rows(pool: &SqlitePool) -> Value {
    let rows = sqlx::query_as::<_, TileServers>("SELECT * FROM tileserver_model ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap();
    serde_json::to_value(rows).unwrap()
}

#[tokio::test]
async fn 旧ラスタ要求の既定値と未設定ズームを登録と編集で保持する() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "background-legacy-admin").await;
    let mut original = definition("既存ラスタ");
    original["label"] = json!("  ラスタ表示名  ");
    original["url"] = json!(" http://legacy.example.test/{z}/{x}/{-y}{r}.png ");
    let tile = create(&pool, &admin, original.clone()).await;
    assert_eq!(tile.id, 1);
    assert_eq!(tile.kind, "raster");
    assert!(tile.style_url.is_none());
    assert_eq!(tile.label, "ラスタ表示名");
    assert_eq!(tile.url, "http://legacy.example.test/{z}/{x}/{-y}{r}.png");
    assert!(tile.min_zoom.is_none() && tile.max_zoom.is_none());
    assert_eq!(
        tile.attribution,
        "<a href=\"https://example.test/\">旧出典</a>"
    );
    sqlx::query("UPDATE tileserver_model SET updated_at='2020-01-01' WHERE id=$1")
        .bind(tile.id)
        .execute(&pool)
        .await
        .unwrap();
    original["label"] = json!("変更後の表示名");
    original["style_url"] = json!("");
    let updated = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id),
        None,
        input(original),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(updated.id, tile.id);
    assert_eq!(updated.create_at, tile.create_at);
    assert!(updated.updated_at.as_str() > "2020-01-01");
    assert_eq!(updated.kind, "raster");
    assert!(updated.style_url.is_none());
    let listed = admin_list(Extension(admin.clone()), Extension(pool.clone()))
        .await
        .unwrap()
        .0;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].label, "変更後の表示名");
    assert_eq!(listed[0].url, tile.url);
    assert_eq!(listed[0].attribution, tile.attribution);
}

#[tokio::test]
async fn ベクタとラスタの編集で背景_id_と作成日時を保持する() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "background-vector-admin").await;
    create(&pool, &admin, definition("既定ラスタ")).await;
    let mut value = vector("新しいベクタ");
    value["url"] = json!("https://{s}.raster.example.test/{z}/{x}/{y}{r}.png");
    value["min_zoom"] = json!(0);
    value["max_zoom"] = json!(22);
    value["include_foreign_tiles"] = json!(true);
    let tile = create(&pool, &admin, value.clone()).await;
    assert_eq!(tile.id, 2);
    assert_eq!(tile.kind, "vector");
    assert_eq!(
        tile.style_url.as_deref(),
        Some("/styles/v1.json?public=token")
    );
    assert_eq!(tile.min_zoom, Some(0));
    assert_eq!(tile.max_zoom, Some(22));
    value["style_url"] = json!("https://style.example.test/v2.json?key=public");
    let edited = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id),
        None,
        input(value.clone()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(edited.id, tile.id);
    assert_eq!(edited.create_at, tile.create_at);
    assert_eq!(
        edited.style_url,
        Some(value["style_url"].as_str().unwrap().into())
    );
    value["kind"] = json!("raster");
    value["style_url"] = Value::Null;
    let raster = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id),
        None,
        input(value),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(raster.id, tile.id);
    assert_eq!(raster.create_at, tile.create_at);
    assert_eq!(raster.kind, "raster");
    assert!(raster.style_url.is_none());
    assert_eq!(raster.url, tile.url);
    let listed = admin_list(Extension(admin.clone()), Extension(pool.clone()))
        .await
        .unwrap()
        .0;
    assert_eq!(listed.iter().map(|row| row.id).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(listed[0].kind, "raster");
}

#[tokio::test]
async fn 有効な管理者だけが背景設定を取得更新できる() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "background-authorized-admin").await;
    create(&pool, &admin, definition("保護されたラスタ")).await;
    let user = common::create_test_user(&pool, "background-normal-user").await;
    let locked = common::create_test_admin(&pool, "background-locked-admin").await;
    sqlx::query("UPDATE user_model SET is_locked=true WHERE id=$1")
        .bind(&locked)
        .execute(&pool)
        .await
        .unwrap();
    let before = rows(&pool).await;
    for actor in [user, locked, uuid::Uuid::new_v4().to_string()] {
        assert!(matches!(
            admin_list(Extension(actor.clone()), Extension(pool.clone())).await,
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            admin_create(
                Extension(actor.clone()),
                Extension(pool.clone()),
                None,
                input(definition("不許可"))
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            admin_update(
                Extension(actor.clone()),
                Extension(pool.clone()),
                Path(1),
                None,
                input(definition("不許可"))
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
    }
    assert_eq!(rows(&pool).await, before);
}

#[tokio::test]
async fn 不正入力と既定背景のベクタ化で保存済み設定を変更しない() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "background-validation-admin").await;
    create(&pool, &admin, definition("既定背景")).await;
    let tile = create(&pool, &admin, definition("編集する背景")).await;
    let before = rows(&pool).await;
    let mut cases = Vec::new();
    for (field, bad) in [
        ("layer_name", json!("  ")),
        ("label", json!("")),
        ("label", json!("あ".repeat(256))),
        ("attribution", json!("出".repeat(256))),
        ("attribution", json!("bad\u{0000}credit")),
        ("url", json!("")),
        ("url", json!(format!("/{}", "a".repeat(255)))),
        (
            "url",
            json!("https://user:password@private.example.test/x.png"),
        ),
        ("url", json!("//private.example.test/x.png")),
        ("url", json!("javascript:alert(1)")),
        ("url", json!("/tiles/{unknown}.png")),
        ("url", json!("/tiles/x.png#fragment")),
        ("url", json!("/tiles/x.png\n")),
        ("kind", json!("unknown")),
        ("min_zoom", json!(-1)),
        ("max_zoom", json!(23)),
        ("min_zoom", json!(19)),
        ("max_zoom", json!(4)),
        ("style_url", json!("/styles/for-raster.json")),
    ] {
        let mut value = definition("編集する背景");
        value[field] = bad;
        cases.push(value);
    }
    for style in [
        Value::Null,
        json!(""),
        json!(" /styles/v1.json"),
        json!("/styles/v1.json "),
        json!("https://private.example.test/v1.json "),
        json!("http://private.example.test/v1.json?key=private"),
        json!("https://user:password@private.example.test/v1.json"),
        json!("//private.example.test/v1.json"),
        json!("/styles/v1.json#fragment"),
        json!("/styles/\n.json"),
        json!(format!("/{}", "あ".repeat(1366))),
    ] {
        let mut value = vector("編集する背景");
        value["style_url"] = style;
        cases.push(value);
    }
    for value in cases {
        let error = admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Path(tile.id),
            None,
            input(value),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 20000).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(!text.contains("private.example") && !text.contains("password"));
        assert_eq!(rows(&pool).await, before);
    }
    assert!(matches!(
        admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Path(1),
            None,
            input(vector("既定背景"))
        )
        .await,
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Path(9999),
            None,
            input(definition("存在しない"))
        )
        .await,
        Err(AppError::NotFound)
    ));
    assert_eq!(rows(&pool).await, before);
}

#[tokio::test]
async fn 既定ラスタ欠落と重複識別名を拒否し旧行を保持する() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "background-constraints-admin").await;
    assert!(matches!(
        admin_create(
            Extension(admin.clone()),
            Extension(pool.clone()),
            None,
            input(vector("先行ベクタ"))
        )
        .await,
        Err(AppError::Validation(_))
    ));
    assert_eq!(rows(&pool).await, json!([]));
    let first = create(&pool, &admin, definition("同じ背景名")).await;
    let second = create(&pool, &admin, definition("別の背景名")).await;
    assert_eq!(first.id, 1);
    let before = rows(&pool).await;
    assert!(matches!(
        admin_create(
            Extension(admin.clone()),
            Extension(pool.clone()),
            None,
            input(definition("同じ背景名"))
        )
        .await,
        Err(AppError::Conflict)
    ));
    assert!(matches!(
        admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Path(second.id),
            None,
            input(definition("同じ背景名"))
        )
        .await,
        Err(AppError::Conflict)
    ));
    assert_eq!(rows(&pool).await, before);
    // 手入力された旧データの重複識別名も、IDを維持して編集できる。
    sqlx::query("UPDATE tileserver_model SET layer_name=$1 WHERE id=$2")
        .bind(&first.layer_name)
        .bind(second.id)
        .execute(&pool)
        .await
        .unwrap();
    let mut renamed_label = definition("同じ背景名");
    renamed_label["label"] = json!("旧重複の表示名を編集");
    let updated = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(second.id),
        None,
        input(renamed_label),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(updated.id, second.id);
    assert_eq!(updated.label, "旧重複の表示名を編集");
    sqlx::query("DELETE FROM tileserver_model WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Path(second.id),
            None,
            input(vector("同じ背景名"))
        )
        .await,
        Err(AppError::Validation(_))
    ));
}

#[tokio::test]
async fn 手入力_id_と並行登録が既存背景_id_を再利用しない() {
    let (pool, database_path) = common::file_test_pool().await;
    let admin = common::create_test_admin(&pool, "background-id-admin").await;
    create(&pool, &admin, definition("既定背景")).await;
    sqlx::query("INSERT INTO tileserver_model (id,layer_name,label,url,attribution,create_at,updated_at) VALUES (100,'手動背景','手動背景','/legacy.png','旧出典',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
        .execute(&pool)
        .await
        .unwrap();
    let created = create(&pool, &admin, vector("採番同期ベクタ")).await;
    assert_eq!(created.id, 101);
    let (first, second) = tokio::join!(
        admin_create(
            Extension(admin.clone()),
            Extension(pool.clone()),
            None,
            input(definition("並行A"))
        ),
        admin_create(
            Extension(admin.clone()),
            Extension(pool.clone()),
            None,
            input(definition("並行B"))
        ),
    );
    let mut ids = vec![first.unwrap().0.id, second.unwrap().0.id];
    ids.sort_unstable();
    assert_eq!(ids, [102, 103]);
    let originals: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM tileserver_model WHERE id IN (1,100) ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(originals, [1, 100]);
    let next = create(&pool, &admin, definition("以降の登録")).await;
    assert_eq!(next.id, 104);
    let (first, second) = tokio::join!(
        admin_create(
            Extension(admin.clone()),
            Extension(pool.clone()),
            None,
            input(definition("並行重複"))
        ),
        admin_create(
            Extension(admin.clone()),
            Extension(pool.clone()),
            None,
            input(definition("並行重複"))
        ),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert!(matches!(first, Err(AppError::Conflict)) || matches!(second, Err(AppError::Conflict)));
    common::close_file_test_pool(pool, database_path).await;
}

#[tokio::test]
async fn 新規変更した出典を安全化し未変更の旧_html_を保持する() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "background-attribution-admin").await;
    let mut value = definition("新しい出典");
    value["attribution"] = json!(
        "<span onclick='alert(1)' style='color:red'>出典</span><script>alert(2)</script><a href='javascript:alert(3)'>危険</a><a href='https://safe.test/' target='_blank'>安全</a>"
    );
    let tile = create(&pool, &admin, value.clone()).await;
    assert!(tile.attribution.contains("<span>出典</span>"));
    assert!(tile.attribution.contains("href=\"https://safe.test/\""));
    for removed in [
        "onclick",
        "style=",
        "script",
        "alert",
        "javascript:",
        "target=",
    ] {
        assert!(!tile.attribution.contains(removed), "{removed}");
    }
    value["attribution"] = json!(
        "<svg onload='alert(1)'><text>hidden</text></svg><iframe src='https://bad.test'>hidden</iframe><br><a href='data:text/html,bad'>文字</a>"
    );
    let changed = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id),
        None,
        input(value.clone()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(changed.attribution, "<br><a>文字</a>");

    let legacy = "<span class='legacy' style='color:red'>原文</span><a href='https://safe.test/' target='_blank'>旧リンク</a>";
    sqlx::query("UPDATE tileserver_model SET attribution=$1 WHERE id=$2")
        .bind(legacy)
        .bind(tile.id)
        .execute(&pool)
        .await
        .unwrap();
    value["attribution"] = json!(legacy);
    value["label"] = json!("出典以外を編集");
    let unchanged = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id),
        None,
        input(value),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(unchanged.attribution, legacy);

    let before = rows(&pool).await;
    let mut expanded = definition("安全化後に長過ぎる出典");
    expanded["attribution"] = json!("&".repeat(52));
    assert!(matches!(
        admin_create(
            Extension(admin.clone()),
            Extension(pool.clone()),
            None,
            input(expanded.clone())
        )
        .await,
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Path(tile.id),
            None,
            input(expanded)
        )
        .await,
        Err(AppError::Validation(_))
    ));
    assert_eq!(rows(&pool).await, before);
}

#[tokio::test]
async fn 管理ルートは認証を要求し不正な_json_型を拒否する() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "background-router-admin").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let token = create_token(&admin, 60, "access_token", 0).unwrap();
    for (method, path) in [
        ("GET", "/admin/background-maps"),
        ("POST", "/admin/background-maps"),
        ("PUT", "/admin/background-maps/1"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    for (field, invalid) in [
        ("kind", Value::Null),
        ("style_url", json!(23)),
        ("min_zoom", json!(1.5)),
        ("max_zoom", json!("18")),
        ("include_foreign_tiles", json!("false")),
    ] {
        let mut value = definition("型エラー");
        value[field] = invalid;
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/admin/background-maps")
                    .header("content-type", "application/json")
                    .header("cookie", format!("access_token={token}"))
                    .body(Body::from(value.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(rows(&pool).await, json!([]));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/admin/background-maps")
                .header("content-type", "application/json")
                .header("cookie", format!("access_token={token}"))
                .body(Body::from(definition("ルート経由のラスタ").to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 10000).await.unwrap();
    let created: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(created["id"], 1);
    assert_eq!(created["kind"], "raster");
    assert!(created["style_url"].is_null());
}
