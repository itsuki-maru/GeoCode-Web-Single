//! 実事前生成を1/2/4ワーカーで実行し、画素・最終進捗・再起動後の再利用を照合する。
#[path = "tilegen_support/mod.rs"]
mod support;

use geocode_web_single::{
    db::run_migrations,
    local_tiles::{LocalTiles, catalog, config::LocalTileConfig, jobs::PrecomputeRequest},
    tilegen::{
        dataset::{Dataset, OperationContext, RenderOptions},
        import::{self, ImportOptions, MissingNodes},
        tile::{GeoBbox, TilePlan},
    },
};
use serde_json::Value;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{fs, path::Path, sync::Arc, time::Duration};

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
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let job = app.get_job_json(id).await.unwrap();
            if !matches!(
                job["state"].as_str(),
                Some("queued" | "running" | "cancelling")
            ) {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the synthetic precompute job did not terminate")
}

fn assert_manifest(config: &LocalTileConfig, dataset: &str, render: &str, job: &Value) {
    let path = config
        .cache_path
        .join(dataset)
        .join(render)
        .join("_jobs")
        .join(job["id"].as_str().unwrap())
        .join("manifest.json");
    let manifest: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(manifest["state"], job["state"]);
    assert_eq!(manifest["dataset_id"], dataset);
    assert_eq!(manifest["render_id"], render);
    assert_eq!(manifest["completed_tiles"], job["progress"]["completed"]);
    assert_eq!(manifest["total_tiles"], job["progress"]["total"]);
    assert_eq!(manifest["reused_tiles"], job["progress"]["reused_tiles"]);
}

#[tokio::test]
async fn parallel_precompute_preserves_png_identity_progress_and_resume_with_small_queue_limits() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let input = root.path().join("input.pbf");
    support::Fixture::sample().write(&input);
    let database = root.path().join("completed.sqlite");
    import::run(&ImportOptions {
        input: input.clone(),
        store: database.clone(),
        work_dir: root.path().join("import-work"),
        missing_nodes: MissingNodes::Error,
    })
    .unwrap();
    fs::remove_file(input).unwrap();
    let original_database = fs::read(&database).unwrap();
    let dataset = Dataset::open(&database).unwrap();
    let dataset_id = dataset.info().dataset_id.clone();
    let bbox = [139.698, 35.698, 139.702, 35.702];
    let plan = TilePlan::new(
        GeoBbox::new(bbox[0], bbox[1], bbox[2], bbox[3]).unwrap(),
        16,
        17,
    )
    .unwrap();
    assert!(plan.count() >= 4 && plan.count() <= 64);
    let mut session = dataset.create_session(RenderOptions::default()).unwrap();
    let references = plan
        .iter()
        .map(|tile| {
            let png = session
                .render_png_with_context(tile, &OperationContext::default())
                .unwrap()
                .png;
            (tile, png)
        })
        .collect::<Vec<_>>();
    assert!(
        references.iter().any(|(_, png)| *png != references[0].1),
        "the matrix must include different map pixels"
    );
    let mut previous_render = None;

    for (workers, queue_capacity, max_subscribers) in
        [(1, 4, 16), (2, 4, 16), (4, 4, 16), (4, 1, 1)]
    {
        let setup = root
            .path()
            .join(format!("workers-{workers}-queue-{queue_capacity}"));
        let mut config = LocalTileConfig::defaults(&setup);
        config.workers = workers;
        config.queue_capacity = queue_capacity;
        config.max_subscribers = max_subscribers;
        let app = LocalTiles::new(config.clone(), pool.clone());
        let registered = app
            .register_database("parallel fixture".into(), database.clone(), false)
            .await
            .unwrap();
        assert_eq!(registered["id"], dataset_id);
        let render = registered["render_id"].as_str().unwrap().to_owned();
        if let Some(expected) = &previous_render {
            assert_eq!(&render, expected);
        }
        previous_render = Some(render.clone());
        let request = PrecomputeRequest {
            dataset_id: dataset_id.clone(),
            render_id: Some(render.clone()),
            bbox,
            min_zoom: 16,
            max_zoom: 17,
            max_tiles: Some(64),
            resume_job_id: None,
        };
        let accepted = app.start_precompute(request.clone()).await.unwrap();
        let id = accepted["id"].as_str().unwrap().to_owned();
        let completed = terminal(&app, &id).await;
        assert_eq!(
            completed["state"], "succeeded",
            "workers={workers}: {completed}"
        );
        assert_eq!(completed["progress"]["completed"], plan.count());
        assert_eq!(completed["progress"]["total"], plan.count());
        assert_eq!(completed["progress"]["reused_tiles"], 0);
        assert_eq!(completed["progress"]["rendered_tiles"], plan.count());
        assert_manifest(&config, &dataset_id, &render, &completed);
        for (tile, expected) in &references {
            let (bytes, hit) = app
                .render(&dataset_id, &render, *tile, false)
                .await
                .unwrap();
            assert!(hit, "every planned tile must have been published");
            assert_eq!(
                bytes.as_slice(),
                expected.as_slice(),
                "workers={workers},tile={tile}"
            );
        }
        let history = catalog::get_job(&app.catalog, &id).await.unwrap().unwrap();
        app.shutdown().await;

        let restarted = LocalTiles::new(config.clone(), pool.clone());
        let resumed = restarted
            .start_precompute(PrecomputeRequest {
                resume_job_id: Some(id.clone()),
                ..request
            })
            .await
            .unwrap();
        let resumed = terminal(&restarted, resumed["id"].as_str().unwrap()).await;
        assert_eq!(resumed["state"], "succeeded", "{resumed}");
        assert_eq!(resumed["progress"]["completed"], plan.count());
        assert_eq!(resumed["progress"]["reused_tiles"], plan.count());
        assert_eq!(resumed["progress"]["rendered_tiles"], 0);
        assert_manifest(&config, &dataset_id, &render, &resumed);
        let unchanged = catalog::get_job(&restarted.catalog, &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.request_json, history.request_json);
        assert_eq!(unchanged.progress_json, history.progress_json);
        assert_eq!(unchanged.state, history.state);
        restarted.shutdown().await;
        assert_eq!(fs::read(&database).unwrap(), original_database);
        assert!(!database.with_extension("sqlite-wal").exists());
        assert!(!database.with_extension("sqlite-shm").exists());
    }
    pool.close().await;
}

#[tokio::test]
async fn failed_precompute_records_latest_reused_counts_and_resumes_after_a_storage_error() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(root.path()).await;
    let input = root.path().join("input.pbf");
    support::Fixture::sample().write(&input);
    let database = root.path().join("completed.sqlite");
    import::run(&ImportOptions {
        input,
        store: database.clone(),
        work_dir: root.path().join("import-work"),
        missing_nodes: MissingNodes::Error,
    })
    .unwrap();
    let original_database = fs::read(&database).unwrap();
    let mut config = LocalTileConfig::defaults(&root.path().join("storage-error"));
    config.workers = 2;
    // 完了済み2件の後に必ずI/Oエラーへ到達させる。速度には依存しない。
    config.queue_capacity = 1;
    config.max_subscribers = 1;
    let app = LocalTiles::new(config.clone(), pool.clone());
    let registered = app
        .register_database("storage error fixture".into(), database.clone(), false)
        .await
        .unwrap();
    let id = registered["id"].as_str().unwrap();
    let render = registered["render_id"].as_str().unwrap();
    let bbox = [139.698, 35.698, 139.702, 35.702];
    let plan = TilePlan::new(
        GeoBbox::new(bbox[0], bbox[1], bbox[2], bbox[3]).unwrap(),
        16,
        17,
    )
    .unwrap();
    let tiles = plan.iter().collect::<Vec<_>>();
    assert!(tiles.len() >= 4);
    let cache_path = |tile: geocode_web_single::tilegen::tile::TileId| {
        config
            .cache_path
            .join(id)
            .join(render)
            .join(tile.z.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.png", tile.y))
    };
    let dataset = Dataset::open(&database).unwrap();
    let mut session = dataset.create_session(RenderOptions::default()).unwrap();
    for tile in &tiles[..2] {
        let path = cache_path(*tile);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let png = session
            .render_png_with_context(*tile, &OperationContext::default())
            .unwrap();
        fs::write(path, png.png).unwrap();
    }
    // 所有する一時cache内だけに、PNGと同名の非空ディレクトリを置く。
    // reader/公開側はこれを通常PNGとして使えず、再帰削除もしてはならない。
    let blocked = cache_path(tiles[2]);
    fs::create_dir_all(&blocked).unwrap();
    let sentinel = blocked.join("keep.txt");
    fs::write(&sentinel, b"preserve existing storage").unwrap();
    let request = PrecomputeRequest {
        dataset_id: id.into(),
        render_id: Some(render.into()),
        bbox,
        min_zoom: 16,
        max_zoom: 17,
        max_tiles: Some(64),
        resume_job_id: None,
    };
    let accepted = app.start_precompute(request.clone()).await.unwrap();
    let job = accepted["id"].as_str().unwrap();
    let failed = terminal(&app, job).await;
    assert_eq!(failed["state"], "failed", "{failed}");
    assert!(
        failed["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
    );
    assert_eq!(failed["progress"]["completed"], 2);
    assert_eq!(failed["progress"]["reused_tiles"], 2);
    assert_eq!(failed["progress"]["rendered_tiles"], 0);
    assert_eq!(failed["progress"]["total"], plan.count());
    assert_manifest(&config, id, render, &failed);
    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve existing storage");
    let status = app.status().await;
    assert_eq!(status["running"], 0);
    assert_eq!(status["queued"], 0);

    fs::remove_file(&sentinel).unwrap();
    fs::remove_dir(&blocked).unwrap();
    let resumed = app
        .start_precompute(PrecomputeRequest {
            resume_job_id: Some(job.into()),
            ..request
        })
        .await
        .unwrap();
    let resumed = terminal(&app, resumed["id"].as_str().unwrap()).await;
    assert_eq!(resumed["state"], "succeeded", "{resumed}");
    assert_eq!(resumed["progress"]["completed"], plan.count());
    assert_eq!(resumed["progress"]["reused_tiles"], 2);
    assert_eq!(resumed["progress"]["rendered_tiles"], plan.count() - 2);
    assert_manifest(&config, id, render, &resumed);
    let original = app.get_job_json(job).await.unwrap();
    assert_eq!(
        original, failed,
        "resuming must preserve the failed job history"
    );
    for tile in tiles {
        let expected = session
            .render_png_with_context(tile, &OperationContext::default())
            .unwrap();
        let (actual, hit) = app.render(id, render, tile, false).await.unwrap();
        assert!(hit);
        assert_eq!(actual.as_slice(), expected.png.as_slice());
    }
    app.shutdown().await;
    assert_eq!(fs::read(database).unwrap(), original_database);
    pool.close().await;
}
