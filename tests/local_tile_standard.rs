//! 新旧完成DBの共存と、CLI・通常XYZ・再開の一連の経路を一時データで確認する。

#[path = "standard_tile_fixture/mod.rs"]
mod fixture;
use fixture::write_inputs;

use std::{path::Path, sync::Arc, time::Duration};

use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::get,
};
use geocode_web_single::{
    db::run_migrations,
    local_tiles::{
        LocalTiles, catalog, cli,
        config::LocalTileConfig,
        jobs::{ImportRequest, PrecomputeRequest},
    },
    tilegen::{cancel::CancellationToken, tile::TileId},
};
use serde_json::Value;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use tower::ServiceExt;

async fn pool(root: &Path) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(root.join("app.sqlite"))
                .create_if_missing(true)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    pool
}

async fn terminal(app: &Arc<LocalTiles>, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let job = app.get_job_json(id).await.unwrap();
            if !matches!(
                job["state"].as_str(),
                Some("queued" | "running" | "cancelling")
            ) {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("一時データのジョブが終了しませんでした")
}

async fn command(
    config: &LocalTileConfig,
    pool: &SqlitePool,
    args: Vec<String>,
) -> cli::CommandOutput {
    let invocation = cli::parse(&args).unwrap();
    cli::execute_with_cancellation(
        &invocation,
        config.clone(),
        Some(pool.clone()),
        CancellationToken::new(),
    )
    .await
    .unwrap()
}

fn argument_pairs(command: &[&str], dataset: &str, render: &str) -> Vec<String> {
    let mut result = command.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    result.extend([
        "--dataset".into(),
        dataset.into(),
        "--render".into(),
        render.into(),
    ]);
    result
}

async fn xyz(app: &Arc<LocalTiles>, id: &str, render: &str, tile: TileId) -> (String, Vec<u8>) {
    let router = Router::new()
        .route(
            "/local-tiles/{dataset}/{profile}/{z}/{x}/{y}",
            get(geocode_web_single::handler::local_tiles::tile),
        )
        .layer(Extension(app.clone()));
    let response = router
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/local-tiles/{id}/{render}/{}/{}/{}.png",
                    tile.z, tile.x, tile.y
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(
        response.headers()["cache-control"],
        "public, max-age=604800, immutable"
    );
    let cache = response.headers()["x-tile-cache"]
        .to_str()
        .unwrap()
        .to_owned();
    (
        cache,
        to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
}

#[tokio::test]
async fn 新旧形式の共存と地形配信をコマンド切替と再開の後も維持する() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let mut config = LocalTileConfig::defaults(root.path());
    config.workers = 1;
    let input = root.path().join("map.pbf");
    let dem = root.path().join("dem.xml");
    write_inputs(&input, &dem);
    let app = LocalTiles::new(config.clone(), pool.clone());
    let old_request = ImportRequest {
        name: "従来道路".into(),
        input_path: input.to_string_lossy().into_owned(),
        ..Default::default()
    };
    let accepted = app.start_import(old_request).await.unwrap();
    let old_job = terminal(&app, accepted["id"].as_str().unwrap()).await;
    assert_eq!(old_job["state"], "succeeded", "{old_job}");
    let old_id = old_job["progress"]["dataset"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let old_profile = catalog::list_profiles(&app.catalog, &old_id)
        .await
        .unwrap()
        .remove(0);
    let old_record = catalog::get_dataset(&app.catalog, &old_id)
        .await
        .unwrap()
        .unwrap();
    let old_path = old_record.resolve_path(&config.dataset_path).unwrap();
    let old_bytes = std::fs::read(&old_path).unwrap();
    let old_tile = TileId::from_lon_lat(14, 139.7, 35.7).unwrap();
    let (_, old_png) = xyz(&app, &old_id, &old_profile.id, old_tile).await;
    let standard_request = ImportRequest {
        name: "地物と地形".into(),
        input_path: input.to_string_lossy().into_owned(),
        features: "standard-v1".into(),
        elevation_input: Some(dem.to_string_lossy().into_owned()),
        request_id: Some(uuid::Uuid::new_v4().to_string()),
        ..Default::default()
    };
    let accepted = app.start_import(standard_request.clone()).await.unwrap();
    let standard_import_id = accepted["id"].as_str().unwrap().to_owned();
    let imported = terminal(&app, &standard_import_id).await;
    assert_eq!(imported["state"], "succeeded", "{imported}");
    let id = imported["progress"]["dataset"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(id, old_id);
    let profile = catalog::list_profiles(&app.catalog, &id)
        .await
        .unwrap()
        .remove(0);
    assert_ne!(profile.id, old_profile.id);
    let record = catalog::get_dataset(&app.catalog, &id)
        .await
        .unwrap()
        .unwrap();
    let db = rusqlite::Connection::open_with_flags(
        record.resolve_path(&config.dataset_path).unwrap(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let extra: String = db
        .query_row(
            "SELECT value FROM metadata WHERE key='standard_document'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let extra: Value = serde_json::from_str(&extra).unwrap();
    assert_eq!(extra["counts"]["building"], 1);
    assert!(extra["elevation"]["contour_features"].as_u64().unwrap() > 0);
    assert!(extra["elevation"]["cells"].as_u64().unwrap() > 0);
    drop(db);
    let tile = TileId::from_lon_lat(16, 139.7, 35.7).unwrap();
    let (state, png) = xyz(&app, &id, &profile.id, tile).await;
    assert_eq!(state, "MISS");
    let (state, second) = xyz(&app, &id, &profile.id, tile).await;
    assert_eq!(state, "HIT");
    assert_eq!(png, second);
    let image = image::load_from_memory(&png).unwrap().to_rgba8();
    assert_eq!(image.dimensions(), (256, 256));
    assert!(image.pixels().any(|pixel| *pixel != *image.get_pixel(0, 0)));
    assert_eq!(app.datasets().await.unwrap().len(), 2);
    app.shutdown().await;

    let url = command(&config, &pool, argument_pairs(&["url"], &id, &profile.id)).await;
    assert_eq!(url.value["kind"], "raster");
    assert!(
        url.value["attribution"]
            .as_str()
            .unwrap()
            .contains("国土地理院")
    );
    let background = command(
        &config,
        &pool,
        argument_pairs(&["background", "add"], &id, &profile.id),
    )
    .await;
    let row: (String, String, String) =
        sqlx::query_as("SELECT kind,url,attribution FROM tileserver_model WHERE id=?")
            .bind(background.value["id"].as_i64().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.0, "raster");
    assert_eq!(row.1, url.value["relative_url"].as_str().unwrap());
    assert!(row.2.contains("OpenStreetMap") && row.2.contains("国土地理院"));
    assert!(row.2.chars().count() <= 255);
    let app = LocalTiles::new(config.clone(), pool.clone());
    let request = PrecomputeRequest {
        dataset_id: id.clone(),
        bbox: [139.6999, 35.6999, 139.7001, 35.7001],
        min_zoom: 16,
        max_zoom: 16,
        max_tiles: Some(100),
        render_id: Some(profile.id.clone()),
        ..Default::default()
    };
    let plan = app.plan_precompute(request.clone()).await.unwrap();
    assert_eq!(plan["render_id"], profile.id);
    let accepted = app.start_precompute(request).await.unwrap();
    let precompute_id = accepted["id"].as_str().unwrap().to_owned();
    let completed = terminal(&app, &precompute_id).await;
    assert_eq!(completed["state"], "succeeded", "{completed}");
    assert_eq!(completed["progress"]["completed"], plan["total_tiles"]);
    let original_history = catalog::get_job(&app.catalog, &standard_import_id)
        .await
        .unwrap()
        .unwrap();
    app.shutdown().await;
    std::fs::remove_file(&input).unwrap();
    std::fs::remove_file(&dem).unwrap();

    let resumed = command(
        &config,
        &pool,
        vec![
            "precompute".into(),
            "resume".into(),
            "--job".into(),
            precompute_id,
        ],
    )
    .await;
    assert_eq!(resumed.value["state"], "succeeded", "{}", resumed.value);
    assert_eq!(
        resumed.value["progress"]["reused_tiles"],
        plan["total_tiles"]
    );
    let app = LocalTiles::new(config.clone(), pool.clone());
    app.initialize().await.unwrap();
    let (state, again) = xyz(&app, &id, &profile.id, tile).await;
    assert_eq!(state, "HIT");
    assert_eq!(again, png);
    let new_tile = TileId::from_lon_lat(17, 139.7, 35.7).unwrap();
    assert_eq!(xyz(&app, &id, &profile.id, new_tile).await.0, "MISS");
    let (_, old_again) = xyz(&app, &old_id, &old_profile.id, old_tile).await;
    assert_eq!(old_again, old_png);
    assert_eq!(std::fs::read(&old_path).unwrap(), old_bytes);
    let history = catalog::get_job(&app.catalog, &standard_import_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(history.request_json, original_history.request_json);
    assert_eq!(history.progress_json, original_history.progress_json);
    assert_eq!(
        app.start_import(standard_request).await.unwrap()["id"],
        standard_import_id
    );
    let app_tile_tables:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'standard_%' OR name LIKE 'local_tile_%'").fetch_one(&pool).await.unwrap();
    assert_eq!(app_tile_tables, 0);
    let catalog_db = rusqlite::Connection::open_with_flags(
        &config.catalog_database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let version: i64 = catalog_db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1);
    drop(catalog_db);
    app.shutdown().await;
    pool.close().await;
}

#[tokio::test]
async fn 不正な標高入力の原因と終了時診断を再起動後も履歴に残す() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let mut config = LocalTileConfig::defaults(root.path());
    config.workers = 1;
    let input = root.path().join("map.pbf");
    let dem = root.path().join("bad-dem.xml");
    write_inputs(&input, &dem);
    std::fs::write(&dem, b"<Dataset><DEM></Dataset>").unwrap();
    let input_before = std::fs::read(&input).unwrap();
    let dem_before = std::fs::read(&dem).unwrap();
    let app = LocalTiles::new(config.clone(), pool.clone());
    let request = ImportRequest {
        name: "不正DEMの診断確認".into(),
        input_path: input.to_string_lossy().into_owned(),
        features: "standard-v1".into(),
        elevation_input: Some(dem.to_string_lossy().into_owned()),
        request_id: Some(uuid::Uuid::new_v4().to_string()),
        ..Default::default()
    };
    let accepted = app.start_import(request).await.unwrap();
    let job_id = accepted["id"].as_str().unwrap();
    let request_before = catalog::get_job(&app.catalog, job_id)
        .await
        .unwrap()
        .unwrap()
        .request_json;
    let failed = terminal(&app, job_id).await;
    assert_eq!(failed["state"], "failed", "{failed}");
    assert!(failed["dataset_id"].is_null());
    let error = failed["error"].as_str().unwrap();
    assert!(error.contains("bad-dem.xml"), "{error}");
    assert!(error.contains("expected `</DEM>`"), "{error}");
    assert_eq!(failed["progress"]["stage"], "Validating");
    assert!(
        failed["progress"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["level"] == "Error"
                && diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("bad-dem.xml")
                        && message.contains("expected `</DEM>`"))),
        "{failed}"
    );
    let work = config.work_path.join(job_id);
    let dataset = config.dataset_path.join(job_id);
    assert_eq!(
        failed["progress"]["work_path"],
        work.to_string_lossy().as_ref()
    );
    assert!(!work.exists());
    assert!(!dataset.join("data.sqlite").exists());
    assert!(app.datasets().await.unwrap().is_empty());
    app.shutdown().await;

    let shown = command(
        &config,
        &pool,
        vec!["jobs".into(), "show".into(), "--job".into(), job_id.into()],
    )
    .await;
    assert_eq!(shown.value["error"], failed["error"]);
    assert_eq!(shown.value["progress"], failed["progress"]);
    assert_eq!(
        shown.value["request"],
        serde_json::from_str::<Value>(&request_before).unwrap()
    );
    assert_eq!(std::fs::read(&input).unwrap(), input_before);
    assert_eq!(std::fs::read(&dem).unwrap(), dem_before);
    assert!(!work.exists());
    pool.close().await;
}
