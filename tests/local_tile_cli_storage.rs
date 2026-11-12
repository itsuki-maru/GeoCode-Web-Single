//! CLIの照会・限定取消が稼働中の生成所有者や既存データへ干渉しないことを確認する。
#[path = "tilegen_support/mod.rs"]
mod support;

use fs2::FileExt;
use geocode_web_single::{
    db::run_migrations,
    local_tiles::{
        LocalTiles,
        catalog::{self, DatasetRecord, JobRecord, TileCatalog},
        cli,
        config::LocalTileConfig,
        jobs::{ImportRequest, PrecomputeRequest},
    },
    tilegen::tile::TileId,
};
use serde_json::Value;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{fs::OpenOptions, path::Path, sync::Arc, time::Duration};

#[tokio::test]
async fn app_build_changes_keep_render_urls_cached_pngs_and_precompute_resume() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let config = LocalTileConfig::defaults(root.path());
    let input = root.path().join("identity.osm.pbf");
    support::Fixture::sample().write(&input);
    let app = LocalTiles::new(config.clone(), pool.clone());
    let accepted = app
        .start_import(ImportRequest {
            name: "描画契約の維持".into(),
            input_path: input.to_string_lossy().into_owned(),
            missing_nodes: "error".into(),
            request_id: None,
            ..Default::default()
        })
        .await
        .unwrap();
    let completed = terminal(&app, accepted["id"].as_str().unwrap()).await;
    assert_eq!(completed["state"], "succeeded");
    let id = completed["progress"]["dataset"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let profile = catalog::list_profiles(&app.catalog, &id)
        .await
        .unwrap()
        .remove(0);
    let record = catalog::get_dataset(&app.catalog, &id)
        .await
        .unwrap()
        .unwrap();
    let database_path = record.resolve_path(&config.dataset_path).unwrap();
    let original_database = std::fs::read(&database_path).unwrap();
    let tile = TileId::from_lon_lat(14, 139.7, 35.7).unwrap();
    let (original_png, hit) = app.render(&id, &profile.id, tile, false).await.unwrap();
    assert!(!hit);
    let request = PrecomputeRequest {
        dataset_id: id.clone(),
        bbox: [139.6999, 35.6999, 139.7001, 35.7001],
        min_zoom: 14,
        max_zoom: 14,
        max_tiles: Some(100),
        resume_job_id: None,
        render_id: None,
    };
    let accepted = app.start_precompute(request.clone()).await.unwrap();
    let previous_job = accepted["id"].as_str().unwrap().to_owned();
    assert_eq!(terminal(&app, &previous_job).await["state"], "succeeded");
    app.shutdown().await;

    // 描画契約・PNG・manifestは維持し、登録元のビルド来歴だけが違う状態を作る。
    let connection = rusqlite::Connection::open(&config.catalog_database_path).unwrap();
    connection
        .execute(
            "UPDATE local_tile_render_profiles SET build_id='previous-app-build' WHERE id=?",
            [&profile.id],
        )
        .unwrap();
    drop(connection);
    let restarted = LocalTiles::new(config.clone(), pool.clone());
    restarted.initialize().await.unwrap();
    let invoke = |words: &[&str]| {
        cli::parse(
            &words
                .iter()
                .map(|word| (*word).to_owned())
                .collect::<Vec<_>>(),
        )
        .unwrap()
    };
    let result = cli::execute(
        &invoke(&["url", "--dataset", &id]),
        config.clone(),
        Some(pool.clone()),
    )
    .await
    .unwrap();
    assert_eq!(result.value["render_id"], profile.id);
    assert_eq!(result.value["current_build"], false);
    assert_eq!(result.value["render_compatible"], true);
    assert!(result.value["old_generation_cache_miss_status"].is_null());
    let listed = cli::execute(
        &invoke(&["datasets", "list"]),
        config.clone(),
        Some(pool.clone()),
    )
    .await
    .unwrap();
    assert_eq!(listed.value[0]["current_profile_prepared"], true);
    assert_eq!(
        restarted.prepare_dataset(&id).await.unwrap()["render_id"],
        profile.id
    );
    let background = restarted.add_background(&id).await.unwrap();
    assert_eq!(restarted.add_background(&id).await.unwrap(), background);
    let profiles = catalog::list_profiles(&restarted.catalog, &id)
        .await
        .unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].build_id, "previous-app-build");
    let (cached_png, hit) = restarted
        .render(&id, &profile.id, tile, false)
        .await
        .unwrap();
    assert!(hit);
    assert_eq!(cached_png.as_ref(), original_png.as_ref());
    let (_, hit) = restarted
        .render(
            &id,
            &profile.id,
            TileId::new(tile.z, tile.x + 1, tile.y).unwrap(),
            false,
        )
        .await
        .unwrap();
    assert!(!hit);
    let resumed = restarted
        .start_precompute(PrecomputeRequest {
            resume_job_id: Some(previous_job.clone()),
            ..request.clone()
        })
        .await
        .unwrap();
    let resumed = terminal(&restarted, resumed["id"].as_str().unwrap()).await;
    assert_eq!(resumed["state"], "succeeded");
    assert!(resumed["progress"]["reused_tiles"].as_u64().unwrap() > 0);

    // 旧世代にだけ残る再開記録を、新方式の世代へ持ち替えて実行しない。
    let mut old_profile = profile.clone();
    old_profile.id = "f".repeat(64);
    old_profile.build_id = "legacy-app-build".into();
    old_profile.info_json = serde_json::json!({"sdk_identity":"過去の不透明なキー","style_version":"roads-v1","image_version":"rgba8-srgb-straight-opaque-v1","tile_size":256}).to_string();
    catalog::insert_profile(&restarted.catalog, &old_profile)
        .await
        .unwrap();
    let old_job_id = uuid::Uuid::new_v4().to_string();
    let mut old_job = catalog::get_job(&restarted.catalog, &previous_job)
        .await
        .unwrap()
        .unwrap();
    old_job.id = old_job_id.clone();
    old_job.state = "interrupted".into();
    catalog::insert_job(&restarted.catalog, &old_job)
        .await
        .unwrap();
    let old_manifest_path = config
        .cache_path
        .join(&id)
        .join(&old_profile.id)
        .join("_jobs")
        .join(&old_job_id)
        .join("manifest.json");
    std::fs::create_dir_all(old_manifest_path.parent().unwrap()).unwrap();
    let previous_manifest_path = config
        .cache_path
        .join(&id)
        .join(&profile.id)
        .join("_jobs")
        .join(&previous_job)
        .join("manifest.json");
    let mut old_manifest: Value =
        serde_json::from_slice(&std::fs::read(previous_manifest_path).unwrap()).unwrap();
    old_manifest["render_id"] = serde_json::json!(old_profile.id);
    old_manifest["state"] = serde_json::json!("interrupted");
    let old_manifest = serde_json::to_vec(&old_manifest).unwrap();
    std::fs::write(&old_manifest_path, &old_manifest).unwrap();
    assert_eq!(
        restarted
            .start_precompute(PrecomputeRequest {
                resume_job_id: Some(old_job_id.clone()),
                ..request
            })
            .await
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(std::fs::read(old_manifest_path).unwrap(), old_manifest);
    assert_eq!(
        catalog::get_job(&restarted.catalog, &old_job_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    assert_eq!(std::fs::read(database_path).unwrap(), original_database);
    restarted.shutdown().await;
    pool.close().await;
}

async fn pool(root: &Path) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(root.join("app.sqlite"))
                .create_if_missing(true),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    pool
}

fn dataset() -> DatasetRecord {
    DatasetRecord {
        id: "a".repeat(64),
        name: "照会対象".into(),
        storage_kind: "managed".into(),
        database_path: "one/data.sqlite".into(),
        dataset_key: "key".into(),
        info_json: "{}".into(),
        created_at: "2026-11-12".into(),
        retired: false,
    }
}

fn job() -> JobRecord {
    JobRecord {
        id: "existing-job".into(),
        kind: "import".into(),
        dataset_id: None,
        state: "running".into(),
        request_json: "{}".into(),
        progress_json: "{}".into(),
        error: None,
        created_at: "2026-11-12".into(),
        updated_at: "2026-11-12".into(),
        owner_id: "live-owner".into(),
    }
}

async fn terminal(app: &Arc<LocalTiles>, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let value = app.get_job_json(id).await.unwrap();
            if !matches!(
                value["state"].as_str(),
                Some("queued" | "running" | "cancelling")
            ) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("一時データのジョブが終了しませんでした")
}

#[tokio::test]
async fn missing_catalog_is_never_created_by_reader_or_control() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let path = root.path().join("未作成/catalog.sqlite");
    for catalog in [
        TileCatalog::read_only(path.clone(), pool.clone()),
        TileCatalog::control(path.clone(), pool.clone()),
    ] {
        assert!(catalog.initialize().await.is_err());
        catalog.close().await;
    }
    assert!(!path.parent().unwrap().exists());
    pool.close().await;
}

#[tokio::test]
async fn reader_keeps_owner_jobs_unchanged_and_control_only_requests_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let path = root.path().join("catalog.sqlite");
    let writer = TileCatalog::new(path.clone(), pool.clone());
    catalog::insert_dataset(&writer, &dataset()).await.unwrap();
    catalog::insert_job(&writer, &job()).await.unwrap();
    let owner = OpenOptions::new()
        .read(true)
        .write(true)
        .open(writer.owner_lock_path().unwrap())
        .unwrap();
    owner.try_lock_exclusive().unwrap();
    let reader = TileCatalog::read_only(path.clone(), pool.clone());
    assert_eq!(catalog::list_datasets(&reader).await.unwrap().len(), 1);
    assert!(!reader.owner_available().await.unwrap());
    assert_eq!(
        catalog::get_job(&reader, "existing-job")
            .await
            .unwrap()
            .unwrap()
            .state,
        "running"
    );
    assert!(catalog::insert_dataset(&reader, &dataset()).await.is_err());
    assert!(
        catalog::request_job_cancel(&reader, "existing-job")
            .await
            .is_err()
    );
    let control = TileCatalog::control(path, pool.clone());
    assert!(catalog::insert_dataset(&control, &dataset()).await.is_err());
    assert!(
        catalog::request_job_cancel(&control, "existing-job")
            .await
            .unwrap()
    );
    // 進捗保存と取消の順序がどちらでも、cancellingをrunningへ戻さない。
    catalog::update_job(
        &writer,
        "existing-job",
        "running",
        "{\"completed\":1}",
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        catalog::get_job(&reader, "existing-job")
            .await
            .unwrap()
            .unwrap()
            .state,
        "cancelling"
    );
    catalog::update_job(&writer, "existing-job", "succeeded", "{}", None)
        .await
        .unwrap();
    assert!(
        !catalog::request_job_cancel(&control, "existing-job")
            .await
            .unwrap()
    );
    assert!(
        !catalog::update_job(&writer, "existing-job", "running", "{}", None)
            .await
            .unwrap()
    );
    assert_eq!(
        catalog::get_job(&reader, "existing-job")
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    control.close().await;
    reader.close().await;
    writer.close().await;
    drop(owner);
    pool.close().await;
}

#[tokio::test]
async fn external_cancel_reaches_a_queued_owner_without_taking_ownership() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let config = LocalTileConfig::defaults(root.path());
    let input = root.path().join("input.osm.pbf");
    support::Fixture::sample().write(&input);
    let app = LocalTiles::new(config.clone(), pool.clone());
    let held = app.import_slot.clone().acquire_owned().await.unwrap();
    let accepted = app
        .start_import(ImportRequest {
            name: "取消対象".into(),
            input_path: input.to_string_lossy().into_owned(),
            missing_nodes: "error".into(),
            request_id: None,
            ..Default::default()
        })
        .await
        .unwrap();
    let id = accepted["id"].as_str().unwrap();
    let control = TileCatalog::control(config.catalog_database_path.clone(), pool.clone());
    assert!(!control.owner_available().await.unwrap());
    catalog::request_job_cancel(&control, id).await.unwrap();
    assert_eq!(terminal(&app, id).await["state"], "cancelled");
    assert!(!config.dataset_path.join(id).exists());
    assert!(input.exists());
    drop(held);
    control.close().await;
    app.shutdown().await;
    pool.close().await;
}

#[tokio::test]
async fn readonly_plan_never_creates_missing_profile_and_prepare_preserves_old_generation() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let config = LocalTileConfig::defaults(root.path());
    let input = root.path().join("input.osm.pbf");
    support::Fixture::sample().write(&input);
    let app = LocalTiles::new(config.clone(), pool.clone());
    let imported = app
        .start_import(ImportRequest {
            name: "世代準備".into(),
            input_path: input.to_string_lossy().into_owned(),
            missing_nodes: "error".into(),
            request_id: None,
            ..Default::default()
        })
        .await
        .unwrap();
    let done = terminal(&app, imported["id"].as_str().unwrap()).await;
    assert_eq!(done["state"], "succeeded");
    let id = done["progress"]["dataset"]["id"].as_str().unwrap();
    let connection = rusqlite::Connection::open(&config.catalog_database_path).unwrap();
    connection
        .execute(
            "UPDATE local_tile_render_profiles SET id=?,build_id='old-build' WHERE dataset_id=?",
            (&"f".repeat(64), id),
        )
        .unwrap();
    drop(connection);
    let reader = LocalTiles::reader(config.clone(), pool.clone());
    let request = PrecomputeRequest {
        dataset_id: id.into(),
        bbox: [139.6999, 35.6999, 139.7001, 35.7001],
        min_zoom: 14,
        max_zoom: 14,
        max_tiles: Some(100),
        resume_job_id: None,
        render_id: None,
    };
    assert_eq!(
        reader
            .plan_precompute_readonly(request.clone())
            .await
            .unwrap_err()
            .status,
        404
    );
    assert_eq!(
        catalog::list_profiles(&reader.catalog, id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(!reader.catalog.owner_available().await.unwrap());
    app.prepare_dataset(id).await.unwrap();
    assert_eq!(
        catalog::list_profiles(&reader.catalog, id)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        reader.plan_precompute_readonly(request).await.unwrap()["allowed"],
        true
    );
    assert_eq!(reader.list_jobs(100, 0).await.unwrap().len(), 1);
    reader.shutdown().await;
    app.shutdown().await;
    pool.close().await;
}
