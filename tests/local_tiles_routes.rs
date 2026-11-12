//! 専用管理HTTPを公開せず、共通背景定義と通常XYZでローカル地図を利用する。
#[allow(dead_code)]
mod common;
#[path = "tilegen_support/mod.rs"]
mod support;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use geocode_web_single::{
    auth::create_token,
    build_tera_extension,
    local_tiles::{LocalTiles, catalog, config::LocalTileConfig},
    router::build_router_with_local_tiles,
    tile_settings::TileSettings,
    tilegen::{
        import::{self, ImportOptions, MissingNodes},
        tile::TileId,
    },
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn request(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> axum::response::Response {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header(header::COOKIE, format!("access_token={token}"));
    }
    if body.is_some() {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    app.clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn 管理操作は非公開とし共通背景設定と世代付き_xyzだけで配信する() {
    let pool = common::test_pool().await;
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("fixture.osm.pbf");
    support::Fixture::sample().write(&input);
    let database = root.path().join("map.sqlite");
    import::run(&ImportOptions {
        input: input.clone(),
        store: database.clone(),
        work_dir: root.path().join("work"),
        missing_nodes: MissingNodes::Error,
    })
    .unwrap();
    std::fs::remove_file(input).unwrap();
    let config = LocalTileConfig::defaults(root.path());
    let service = LocalTiles::new(config.clone(), pool.clone());
    let registered = service
        .register_database("日本の道路".into(), database.clone(), false)
        .await
        .unwrap();
    let id = registered["id"].as_str().unwrap();
    let render = registered["render_id"].as_str().unwrap();
    let url = registered["url"].as_str().unwrap();
    let admin = common::create_test_admin(&pool, "xyz-admin").await;
    let reader = common::create_test_user(&pool, "xyz-reader").await;
    let token = create_token(&admin, 60, "access_token", 0).unwrap();
    let reader = create_token(&reader, 60, "access_token", 0).unwrap();
    let app = build_router_with_local_tiles(
        pool.clone(),
        build_tera_extension().unwrap(),
        None,
        Arc::new(TileSettings::from_env()),
        service.clone(),
    );
    for (method, path) in [
        ("GET", "/local-tiles"),
        ("GET", "/admin/local-tiles/datasets"),
        ("POST", "/admin/local-tiles/imports"),
    ] {
        let response = request(&app, method, path, Some(&token), Some(json!({}))).await;
        assert!(
            !response.status().is_success(),
            "廃止した管理経路が公開されています: {path}"
        );
    }
    let definition = json!({"layer_name":"local-roads","label":"日本の道路","url":url,
        "kind":"raster","style_url":null,"attribution":"© OpenStreetMap contributors",
        "include_foreign_tiles":false,"min_zoom":0,"max_zoom":22});
    assert_eq!(
        request(
            &app,
            "POST",
            "/admin/background-maps",
            None,
            Some(definition.clone())
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/admin/background-maps",
            Some(&reader),
            Some(definition.clone())
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let response = request(
        &app,
        "POST",
        "/admin/background-maps",
        Some(&token),
        Some(definition.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let background = body(response).await;
    assert_eq!(background["url"], url);
    assert_eq!(background["kind"], "raster");
    let tile = TileId::from_lon_lat(14, 139.7, 35.7).unwrap();
    let concrete = format!(
        "/local-tiles/{id}/{render}/{}/{}/{}.png",
        tile.z, tile.x, tile.y
    );
    let first = request(&app, "GET", &concrete, None, None).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()["content-type"], "image/png");
    assert_eq!(first.headers()["x-tile-cache"], "MISS");
    let png = to_bytes(first.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let second = request(&app, "GET", &concrete, None, None).await;
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(second.headers()["x-tile-cache"], "HIT");
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/local-tiles/{id}/{render}/23/0/0.png"),
            None,
            None
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(service.retire(id).await.unwrap_err().status, 409);
    sqlx::query("DELETE FROM tileserver_model WHERE id=?")
        .bind(background["id"].as_i64().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    // 移設してもデータセット・描画世代の識別と既存PNGを保持する。
    let moved = root.path().join("移設した完成DB.sqlite");
    std::fs::copy(&database, &moved).unwrap();
    assert_eq!(
        service
            .register_database("移設後".into(), moved.clone(), false)
            .await
            .unwrap()["id"],
        id
    );
    assert_eq!(
        catalog::get_dataset(&service.catalog, id)
            .await
            .unwrap()
            .unwrap()
            .database_path,
        moved.to_string_lossy()
    );
    let mut old = catalog::get_profile(&service.catalog, id, render)
        .await
        .unwrap()
        .unwrap();
    old.id = "a".repeat(64);
    old.build_id = "previous-renderer".into();
    catalog::insert_profile(&service.catalog, &old)
        .await
        .unwrap();
    let old_path = config
        .cache_path
        .join(id)
        .join(&old.id)
        .join(tile.z.to_string())
        .join(tile.x.to_string())
        .join(format!("{}.png", tile.y));
    std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
    std::fs::write(&old_path, &png).unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!(
                "/local-tiles/{id}/{}/{}/{}/{}.png",
                old.id, tile.z, tile.x, tile.y
            ),
            None,
            None
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/local-tiles/{id}/{}/0/0/0.png", old.id),
            None,
            None
        )
        .await
        .status(),
        StatusCode::GONE
    );
    service.retire(id).await.unwrap();
    assert_eq!(
        request(&app, "GET", &concrete, None, None).await.status(),
        StatusCode::GONE
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/admin/background-maps",
            Some(&token),
            Some(definition)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    service.cleanup(id, &old.id).await.unwrap();
    assert!(!old_path.exists());
    assert!(database.exists() && moved.exists());
    service.shutdown().await;
    pool.close().await;
}
