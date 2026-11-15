#[path = "tilegen_support/mod.rs"]
mod support;

use geocode_web_single::local_tiles::{
    LocalTiles,
    config::LocalTileConfig,
    jobs::{ImportRequest, PrecomputeRequest},
};
use serde_json::Value;
use std::{path::Path, sync::Arc, time::Duration};

async fn app(root: &Path, queue_capacity: usize) -> Arc<LocalTiles> {
    let _ = tracing_subscriber::fmt()
        .with_test_writer()
        .with_max_level(tracing::Level::WARN)
        .try_init();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let mut config = LocalTileConfig::defaults(root);
    config.background_queue_capacity = queue_capacity;
    config.workers = 1;
    LocalTiles::new(config, pool)
}

fn import_request(path: &Path) -> ImportRequest {
    ImportRequest {
        name: "Sample roads".into(),
        input_path: path.to_string_lossy().into_owned(),
        missing_nodes: "error".into(),
        request_id: None,
        ..Default::default()
    }
}

async fn terminal(app: &Arc<LocalTiles>, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let job = app.get_job_json(id).await.unwrap();
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
    .expect("local tile management job should complete")
}

#[tokio::test]
async fn import_precompute_and_resume_use_the_same_cache_without_the_original_pbf() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("input.osm.pbf");
    support::Fixture::sample().write(&input);
    let app = app(root.path(), 4).await;
    let imported = app.start_import(import_request(&input)).await.unwrap();
    let job = terminal(&app, imported["id"].as_str().unwrap()).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert!(input.exists(), "import must not remove the input PBF");
    assert_eq!(job["progress"]["report"]["metadata"]["feature_count"], 1);
    let datasets = app.datasets().await.unwrap();
    assert_eq!(datasets.len(), 1);
    let id = datasets[0]["id"].as_str().unwrap().to_owned();
    std::fs::remove_file(input).unwrap();
    let request = PrecomputeRequest {
        dataset_id: id.clone(),
        bbox: [139.6999, 35.6999, 139.7001, 35.7001],
        min_zoom: 14,
        max_zoom: 14,
        max_tiles: Some(100),
        resume_job_id: None,
        render_id: None,
    };
    let plan = app.plan_precompute(request.clone()).await.unwrap();
    assert_eq!(plan["allowed"], true);
    let count = plan["tile_count"].as_u64().unwrap();
    assert!(count > 0 && count < 100);
    let first = app.start_precompute(request.clone()).await.unwrap();
    let first_id = first["id"].as_str().unwrap();
    let first = terminal(&app, first_id).await;
    assert_eq!(first["state"], "succeeded", "{first}");
    assert_eq!(first["progress"]["completed"], count);
    let mut resume = request.clone();
    resume.resume_job_id = Some(first_id.to_owned());
    let resumed = app.start_precompute(resume.clone()).await.unwrap();
    let resumed = terminal(&app, resumed["id"].as_str().unwrap()).await;
    assert_eq!(resumed["state"], "succeeded", "{resumed}");
    assert_eq!(resumed["progress"]["reused_tiles"], count);
    let cancelled_after_success = app.cancel_job(first_id).await.unwrap();
    assert_eq!(cancelled_after_success["state"], "succeeded");
    resume.bbox[0] -= 0.001;
    assert_eq!(app.start_precompute(resume).await.unwrap_err().status, 409);
    let too_large = PrecomputeRequest {
        bbox: [139.0, 35.0, 140.0, 36.0],
        max_tiles: Some(1),
        ..request
    };
    let plan = app.plan_precompute(too_large.clone()).await.unwrap();
    assert_eq!(plan["allowed"], false);
    assert_eq!(
        app.start_precompute(too_large).await.unwrap_err().status,
        400
    );
    assert_eq!(app.list_jobs(100, 0).await.unwrap().len(), 3);
    app.shutdown().await;
}

#[tokio::test]
async fn queued_imports_are_bounded_and_cancellation_releases_waiting_capacity() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("input.osm.pbf");
    support::Fixture::sample().write(&input);
    let app = app(root.path(), 1).await;
    let held = app.import_slot.clone().acquire_owned().await.unwrap();
    let first = app.start_import(import_request(&input)).await.unwrap();
    let duplicate = app.start_import(import_request(&input)).await.unwrap();
    assert_eq!(duplicate["id"], first["id"]);
    let mut different = import_request(&input);
    different.name = "Different import".into();
    assert_eq!(app.start_import(different).await.unwrap_err().status, 503);
    let id = first["id"].as_str().unwrap();
    app.cancel_job(id).await.unwrap();
    assert_eq!(terminal(&app, id).await["state"], "cancelled");
    assert_eq!(app.background_slots.available_permits(), 1);
    assert!(app.datasets().await.unwrap().is_empty());
    drop(held);
    let next = app.start_import(import_request(&input)).await.unwrap();
    assert_eq!(
        terminal(&app, next["id"].as_str().unwrap()).await["state"],
        "succeeded"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn import_request_id_remains_idempotent_after_completion_and_rejects_changed_conditions() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("input.osm.pbf");
    support::Fixture::sample().write(&input);
    let app = app(root.path(), 1).await;
    let mut request = import_request(&input);
    request.request_id = Some(uuid::Uuid::new_v4().to_string());
    let first = app.start_import(request.clone()).await.unwrap();
    let id = first["id"].as_str().unwrap();
    assert_eq!(terminal(&app, id).await["state"], "succeeded");
    std::fs::remove_file(&input).unwrap();
    assert_eq!(
        app.start_import(request.clone()).await.unwrap()["id"],
        first["id"]
    );
    request.name = "Changed name".into();
    assert_eq!(app.start_import(request).await.unwrap_err().status, 409);
    assert_eq!(app.list_jobs(100, 0).await.unwrap().len(), 1);
    app.shutdown().await;
}

#[tokio::test]
async fn failed_import_never_registers_a_partial_database() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("broken.osm.pbf");
    std::fs::write(&input, b"this is not an OSM PBF").unwrap();
    let app = app(root.path(), 1).await;
    let job = app.start_import(import_request(&input)).await.unwrap();
    let finished = terminal(&app, job["id"].as_str().unwrap()).await;
    assert_eq!(finished["state"], "failed", "{finished}");
    assert!(finished["error"].as_str().is_some());
    assert!(app.datasets().await.unwrap().is_empty());
    assert!(input.exists());
    app.shutdown().await;
}
