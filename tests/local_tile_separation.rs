//! 本体DBと管理DBに別々の接続プールを使い、実ファイルの分離を検証する。
#[allow(dead_code)]
mod common;
#[path = "tilegen_support/mod.rs"]
mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use geocode_web_single::{
    auth::create_token,
    build_tera_extension,
    db::run_migrations,
    local_tiles::{
        LocalTiles,
        config::LocalTileConfig,
        jobs::{ImportRequest, PrecomputeRequest},
    },
    router::build_router_with_local_tiles,
    tile_settings::TileSettings,
};
use serde_json::Value;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{path::Path, sync::Arc, time::Duration};
use tower::ServiceExt;

async fn terminal(service: &Arc<LocalTiles>, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let job = service.get_job_json(id).await.unwrap();
            if !matches!(
                job["state"].as_str().unwrap(),
                "queued" | "running" | "cancelling"
            ) {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture job should terminate")
}

async fn application_pool(path: &Path) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    pool
}

async fn assert_application_schema(pool: &SqlitePool) {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'local_tile_%'",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(
        tables.is_empty(),
        "catalog tables leaked into the application DB: {tables:?}"
    );
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(versions, (1..=25).collect::<Vec<_>>());
}

#[tokio::test]
async fn import_history_and_generations_survive_restart_in_a_separate_catalog() {
    let root = tempfile::tempdir().unwrap();
    let pool = application_pool(&root.path().join("本体.sqlite")).await;
    let config = LocalTileConfig::defaults(root.path());
    let input = root.path().join("fixture.osm.pbf");
    support::Fixture::sample().write(&input);
    let service = LocalTiles::new(config.clone(), pool.clone());
    service.initialize().await.unwrap();
    assert!(config.catalog_database_path.is_file());
    let request = ImportRequest {
        name: "Independent catalog".into(),
        input_path: input.to_string_lossy().into_owned(),
        missing_nodes: "error".into(),
        request_id: Some(uuid::Uuid::new_v4().to_string()),
        ..Default::default()
    };
    let imported = service.start_import(request.clone()).await.unwrap();
    let import_id = imported["id"].as_str().unwrap();
    let completed = terminal(&service, import_id).await;
    assert_eq!(completed["state"], "succeeded", "{completed}");
    let before = service.datasets().await.unwrap();
    let dataset_id = before[0]["id"].as_str().unwrap().to_owned();
    let precomputed = service
        .start_precompute(PrecomputeRequest {
            dataset_id,
            bbox: [139.6999, 35.6999, 139.7001, 35.7001],
            min_zoom: 14,
            max_zoom: 14,
            max_tiles: Some(100),
            resume_job_id: None,
            render_id: None,
        })
        .await
        .unwrap();
    let completed = terminal(&service, precomputed["id"].as_str().unwrap()).await;
    assert_eq!(completed["state"], "succeeded", "{completed}");
    std::fs::remove_file(input).unwrap();
    assert_application_schema(&pool).await;
    service.shutdown().await;
    drop(service);

    // 同じ本体DBファイルで再接続する。PBFや管理DBは作り直さない。
    let restarted = LocalTiles::new(config.clone(), pool.clone());
    restarted.initialize().await.unwrap();
    let after = restarted.datasets().await.unwrap();
    assert_eq!(after[0]["id"], before[0]["id"]);
    assert_eq!(after[0]["url"], before[0]["url"]);
    assert_eq!(restarted.list_jobs(100, 0).await.unwrap().len(), 2);
    assert_eq!(
        restarted.start_import(request).await.unwrap()["id"],
        imported["id"]
    );
    assert_application_schema(&pool).await;
    let catalog = rusqlite::Connection::open_with_flags(
        &config.catalog_database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let job_count: i64 = catalog
        .query_row("SELECT COUNT(*) FROM local_tile_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(job_count, 2);
    let app_tables: i64 = catalog.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('user_model','tileserver_model','schema_migrations')", [], |r| r.get(0)
    ).unwrap();
    assert_eq!(app_tables, 0);
    drop(catalog);
    restarted.shutdown().await;
    pool.close().await;
}

#[tokio::test]
async fn invalid_catalog_disables_local_maps_and_keeps_application_routes_available() {
    let root = tempfile::tempdir().unwrap();
    let pool = common::test_pool().await;
    let config = LocalTileConfig::defaults(root.path());
    std::fs::create_dir_all(config.catalog_database_path.parent().unwrap()).unwrap();
    let original = b"this is not a catalog database";
    std::fs::write(&config.catalog_database_path, original).unwrap();
    let service = LocalTiles::new(config.clone(), pool.clone());
    assert!(service.initialize().await.is_err());
    assert_eq!(service.datasets().await.unwrap_err().status, 503);
    assert_eq!(service.status().await["available"], false);
    let admin = common::create_test_admin(&pool, "catalog-failure-admin").await;
    let token = create_token(&admin, 60, "access_token", 0).unwrap();
    let app = build_router_with_local_tiles(
        pool.clone(),
        build_tera_extension().unwrap(),
        None,
        Arc::new(TileSettings::from_env()),
        service.clone(),
    );
    for (path, status) in [
        (
            "/local-tiles/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/0/0/0.png",
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        ("/admin/background-maps", StatusCode::OK),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::COOKIE, format!("access_token={token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
    }
    assert_eq!(
        std::fs::read(&config.catalog_database_path).unwrap(),
        original
    );
    assert_application_schema(&pool).await;
    service.shutdown().await;
    pool.close().await;
}
