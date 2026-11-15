//! 公開処理のガードで実ワーカーを意図的に停止し、競合を再現可能な順序で検証する。
#![allow(clippy::await_holding_lock)]

#[path = "tilegen_support/mod.rs"]
mod support;

use anyhow::{Result, anyhow};
use geocode_web_single::{
    local_tiles::{
        config::LocalTileConfig,
        runtime::{self, DatasetHandle, Engine},
    },
    tilegen::{
        dataset::Dataset,
        import::{self, ImportOptions, MissingNodes},
        tile::TileId,
    },
};
use std::{
    fs::{self, FileTimes, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

struct Fixture {
    root: tempfile::TempDir,
    config: LocalTileConfig,
    database: PathBuf,
    handle: Arc<DatasetHandle>,
    tile: TileId,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let mut config = LocalTileConfig::defaults(root.path());
        config.workers = 1;
        config.queue_capacity = 4;
        let input = root.path().join("input.osm.pbf");
        let database = config.dataset_path.join("map.sqlite");
        support::Fixture::sample().write(&input);
        import::run(&ImportOptions {
            input,
            store: database.clone(),
            work_dir: root.path().join("fixture-import"),
            missing_nodes: MissingNodes::Error,
        })?;
        let handle = Arc::new(DatasetHandle {
            dataset: Dataset::open(&database)?,
            publication: Mutex::new(true),
        });
        Ok(Self {
            root,
            config,
            database,
            handle,
            tile: TileId::from_lon_lat(14, 139.7, 35.7)?,
        })
    }

    fn path(&self, tile: TileId) -> PathBuf {
        self.config
            .cache_path
            .join("test-profile")
            .join(tile.z.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.png", tile.y))
    }
}

fn checked<T>(result: runtime::Result<T>) -> Result<T> {
    result.map_err(|failure| anyhow!("{}: {}", failure.status, failure.message))
}

async fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "worker did not reach expected state"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn opaque_png() -> Result<Vec<u8>> {
    let mut image = tiny_skia::Pixmap::new(256, 256).unwrap();
    image.fill(tiny_skia::Color::WHITE);
    Ok(image.encode_png()?)
}

fn write_png(path: &Path) -> Result<Vec<u8>> {
    fs::create_dir_all(path.parent().unwrap())?;
    let bytes = opaque_png()?;
    fs::write(path, &bytes)?;
    Ok(bytes)
}

#[tokio::test]
async fn concurrent_miss_coalesces_and_one_departure_keeps_shared_work() -> Result<()> {
    let fixture = Fixture::new()?;
    let engine = checked(Engine::start(&fixture.config))?;
    let permit = fixture.handle.publication.lock().unwrap();
    let path = fixture.path(fixture.tile);
    let first = checked(engine.subscribe(
        "same".into(),
        fixture.handle.clone(),
        fixture.tile,
        path.clone(),
        false,
    ))?;
    until(|| engine.counts().1 == 1).await;
    let second = checked(engine.subscribe(
        "same".into(),
        fixture.handle.clone(),
        fixture.tile,
        path.clone(),
        false,
    ))?;
    assert_eq!(engine.counts().0, 0);
    drop(first);
    drop(permit);
    let png = checked(second.wait(Duration::from_secs(5)).await)?;
    until(|| engine.counts().1 == 0).await;
    assert_eq!(engine.counts().2, 1);
    assert_eq!(
        runtime::read_png(&path).map_err(|e| anyhow!(e.message))?,
        Some(png.as_ref().clone())
    );
    Ok(())
}

#[tokio::test]
async fn queue_capacity_counts_distinct_waiting_jobs() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.config.queue_capacity = 1;
    let engine = checked(Engine::start(&fixture.config))?;
    let permit = fixture.handle.publication.lock().unwrap();
    let first = checked(engine.subscribe(
        "running".into(),
        fixture.handle.clone(),
        fixture.tile,
        fixture.path(fixture.tile),
        false,
    ))?;
    until(|| engine.counts().1 == 1).await;
    let second_tile = TileId::new(14, fixture.tile.x + 1, fixture.tile.y)?;
    let queued = checked(engine.subscribe(
        "queued".into(),
        fixture.handle.clone(),
        second_tile,
        fixture.path(second_tile),
        true,
    ))?;
    let third_tile = TileId::new(14, fixture.tile.x + 2, fixture.tile.y)?;
    let failure = engine
        .subscribe(
            "overflow".into(),
            fixture.handle.clone(),
            third_tile,
            fixture.path(third_tile),
            false,
        )
        .err()
        .expect("queue must reject overflow");
    assert_eq!(failure.status, 503);
    assert_eq!(engine.counts().0, 1);
    drop(queued);
    drop(permit);
    checked(first.wait(Duration::from_secs(5)).await)?;
    until(|| engine.counts().0 == 0 && engine.counts().1 == 0).await;
    assert!(!fixture.path(second_tile).exists());
    Ok(())
}

#[tokio::test]
async fn subscriber_limit_applies_even_to_one_shared_key() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.config.max_subscribers = 2;
    let engine = checked(Engine::start(&fixture.config))?;
    let permit = fixture.handle.publication.lock().unwrap();
    let subscribe = || {
        engine.subscribe(
            "shared".into(),
            fixture.handle.clone(),
            fixture.tile,
            fixture.path(fixture.tile),
            false,
        )
    };
    let first = checked(subscribe())?;
    let second = checked(subscribe())?;
    assert_eq!(subscribe().err().expect("subscriber cap").status, 503);
    drop(first);
    let replacement = checked(subscribe())?;
    drop(permit);
    checked(second.wait(Duration::from_secs(5)).await)?;
    checked(replacement.wait(Duration::from_secs(5)).await)?;
    assert_eq!(engine.counts().2, 1);
    Ok(())
}

#[tokio::test]
async fn last_departure_retains_worker_slot_until_exit_and_next_request_recovers() -> Result<()> {
    let fixture = Fixture::new()?;
    let engine = checked(Engine::start(&fixture.config))?;
    let permit = fixture.handle.publication.lock().unwrap();
    let subscribe = || {
        engine.subscribe(
            "cancelled".into(),
            fixture.handle.clone(),
            fixture.tile,
            fixture.path(fixture.tile),
            false,
        )
    };
    let first = checked(subscribe())?;
    until(|| engine.counts().1 == 1).await;
    drop(first);
    assert_eq!(engine.counts().1, 1);
    assert_eq!(
        subscribe().err().expect("cancel is still draining").status,
        503
    );
    drop(permit);
    until(|| engine.counts().1 == 0).await;
    assert!(!fixture.path(fixture.tile).exists());
    checked(checked(subscribe())?.wait(Duration::from_secs(5)).await)?;
    assert!(fixture.path(fixture.tile).is_file());
    Ok(())
}

#[tokio::test]
async fn elapsed_job_deadline_never_publishes_and_fresh_context_recovers() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.config.job_timeout_seconds = 1;
    let engine = checked(Engine::start(&fixture.config))?;
    let permit = fixture.handle.publication.lock().unwrap();
    let subscription = checked(engine.subscribe(
        "deadline".into(),
        fixture.handle.clone(),
        fixture.tile,
        fixture.path(fixture.tile),
        false,
    ))?;
    until(|| engine.counts().1 == 1).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    drop(permit);
    let failure = subscription.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(failure.status, 504);
    until(|| engine.counts().1 == 0).await;
    assert!(!fixture.path(fixture.tile).exists());
    let next = checked(engine.subscribe(
        "next".into(),
        fixture.handle.clone(),
        fixture.tile,
        fixture.path(fixture.tile),
        false,
    ))?;
    checked(next.wait(Duration::from_secs(5)).await)?;
    Ok(())
}

#[test]
fn writer_ownership_is_exclusive_and_released_on_shutdown() -> Result<()> {
    let fixture = Fixture::new()?;
    let owner = checked(Engine::start(&fixture.config))?;
    assert_eq!(
        Engine::start(&fixture.config)
            .err()
            .expect("single owner")
            .status,
        503
    );
    drop(owner);
    drop(checked(Engine::start(&fixture.config))?);
    Ok(())
}

#[test]
fn read_only_cache_validation_preserves_invalid_and_oversized_files() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bad = root.path().join("bad.png");
    fs::write(&bad, b"incomplete PNG")?;
    assert!(checked(runtime::read_png(&bad))?.is_none());
    assert_eq!(fs::read(&bad)?, b"incomplete PNG");
    let huge = root.path().join("huge.png");
    fs::File::create(&huge)?.set_len(4 * 1024 * 1024 + 1)?;
    assert!(checked(runtime::read_png(&huge))?.is_none());
    assert!(huge.exists());
    let valid = root.path().join("valid.png");
    let expected = write_png(&valid)?;
    assert_eq!(checked(runtime::read_png(&valid))?, Some(expected));
    Ok(())
}

#[tokio::test]
async fn cache_hit_avoids_opening_or_rendering_the_database() -> Result<()> {
    let fixture = Fixture::new()?;
    let engine = checked(Engine::start(&fixture.config))?;
    let path = fixture.path(fixture.tile);
    let expected = write_png(&path)?;
    fs::remove_file(&fixture.database)?;
    let subscription = checked(engine.subscribe(
        "hit".into(),
        fixture.handle.clone(),
        fixture.tile,
        path,
        false,
    ))?;
    assert_eq!(
        checked(subscription.wait(Duration::from_secs(5)).await)?.as_ref(),
        &expected
    );
    assert_eq!(engine.counts().2, 0);
    Ok(())
}

#[tokio::test]
async fn owner_repairs_corrupt_cache_and_retired_generation_does_not_publish() -> Result<()> {
    let fixture = Fixture::new()?;
    let engine = checked(Engine::start(&fixture.config))?;
    let path = fixture.path(fixture.tile);
    fs::create_dir_all(path.parent().unwrap())?;
    fs::write(&path, b"broken")?;
    let subscription = checked(engine.subscribe(
        "repair".into(),
        fixture.handle.clone(),
        fixture.tile,
        path.clone(),
        false,
    ))?;
    checked(subscription.wait(Duration::from_secs(5)).await)?;
    assert!(checked(runtime::read_png(&path))?.is_some());
    let next_tile = TileId::new(14, fixture.tile.x + 1, fixture.tile.y)?;
    let mut permit = fixture.handle.publication.lock().unwrap();
    let stopped = checked(engine.subscribe(
        "retired".into(),
        fixture.handle.clone(),
        next_tile,
        fixture.path(next_tile),
        false,
    ))?;
    until(|| engine.counts().1 == 1).await;
    *permit = false;
    drop(permit);
    assert_eq!(
        stopped
            .wait(Duration::from_secs(5))
            .await
            .unwrap_err()
            .status,
        410
    );
    assert!(!fixture.path(next_tile).exists());
    Ok(())
}

#[tokio::test]
async fn same_dataset_id_on_another_handle_cannot_reuse_stale_session() -> Result<()> {
    let fixture = Fixture::new()?;
    let engine = checked(Engine::start(&fixture.config))?;
    let first = checked(engine.subscribe(
        "first".into(),
        fixture.handle.clone(),
        fixture.tile,
        fixture.path(fixture.tile),
        false,
    ))?;
    checked(first.wait(Duration::from_secs(5)).await)?;
    let copied = fixture.root.path().join("copied.sqlite");
    fs::copy(&fixture.database, &copied)?;
    let second_handle = Arc::new(DatasetHandle {
        dataset: Dataset::open(&copied)?,
        publication: Mutex::new(true),
    });
    assert_eq!(
        second_handle.dataset.info().dataset_id,
        fixture.handle.dataset.info().dataset_id
    );
    OpenOptions::new()
        .write(true)
        .open(&copied)?
        .set_times(FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(2)))?;
    let tile = TileId::new(14, fixture.tile.x + 1, fixture.tile.y)?;
    let second = checked(engine.subscribe(
        "second".into(),
        second_handle,
        tile,
        fixture.path(tile),
        false,
    ))?;
    assert_eq!(
        second
            .wait(Duration::from_secs(5))
            .await
            .unwrap_err()
            .status,
        503
    );
    assert!(!fixture.path(tile).exists());
    Ok(())
}

#[tokio::test]
async fn foreground_queue_runs_before_waiting_precomputation() -> Result<()> {
    let fixture = Fixture::new()?;
    let engine = checked(Engine::start(&fixture.config))?;
    let first_permit = fixture.handle.publication.lock().unwrap();
    let background_handle = Arc::new(DatasetHandle {
        dataset: fixture.handle.dataset.clone(),
        publication: Mutex::new(true),
    });
    let foreground_handle = Arc::new(DatasetHandle {
        dataset: fixture.handle.dataset.clone(),
        publication: Mutex::new(true),
    });
    let background_permit = background_handle.publication.lock().unwrap();
    let first = checked(engine.subscribe(
        "first".into(),
        fixture.handle.clone(),
        fixture.tile,
        fixture.path(fixture.tile),
        false,
    ))?;
    until(|| engine.counts().1 == 1).await;
    let background_tile = TileId::new(14, fixture.tile.x + 1, fixture.tile.y)?;
    let background = checked(engine.subscribe(
        "background".into(),
        background_handle.clone(),
        background_tile,
        fixture.path(background_tile),
        true,
    ))?;
    let foreground_tile = TileId::new(14, fixture.tile.x + 2, fixture.tile.y)?;
    let foreground = checked(engine.subscribe(
        "foreground".into(),
        foreground_handle,
        foreground_tile,
        fixture.path(foreground_tile),
        false,
    ))?;
    drop(first_permit);
    checked(first.wait(Duration::from_secs(5)).await)?;
    // バックグラウンドワーカーは公開直前で停止しているため、ここでの成功は、
    // 待機キュー内で先行するフォアグラウンド要求を追い越さなかったことを示す。
    checked(foreground.wait(Duration::from_secs(2)).await)?;
    drop(background_permit);
    checked(background.wait(Duration::from_secs(5)).await)?;
    assert_eq!(engine.counts().2, 3);
    Ok(())
}

#[tokio::test]
async fn shutdown_stops_admission_and_prevents_late_publication() -> Result<()> {
    let fixture = Fixture::new()?;
    let engine = checked(Engine::start(&fixture.config))?;
    let permit = fixture.handle.publication.lock().unwrap();
    let pending = checked(engine.subscribe(
        "stop".into(),
        fixture.handle.clone(),
        fixture.tile,
        fixture.path(fixture.tile),
        false,
    ))?;
    until(|| engine.counts().1 == 1).await;
    engine.stop();
    assert_eq!(
        engine
            .subscribe(
                "next".into(),
                fixture.handle.clone(),
                fixture.tile,
                fixture.path(fixture.tile),
                false,
            )
            .err()
            .expect("closed admission")
            .status,
        503
    );
    drop(permit);
    assert!(matches!(
        pending
            .wait(Duration::from_secs(5))
            .await
            .unwrap_err()
            .status,
        410 | 499
    ));
    assert!(!fixture.path(fixture.tile).exists());
    drop(engine);
    Ok(())
}

#[tokio::test]
async fn png_publication_supports_deep_unicode_storage_roots() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.config.cache_path = fixture
        .root
        .path()
        .join("地図 PNG 保存先 ".repeat(8) + "終端");
    let engine = checked(Engine::start(&fixture.config))?;
    let path = fixture
        .config
        .cache_path
        .join("d".repeat(64))
        .join("r".repeat(64))
        .join(fixture.tile.z.to_string())
        .join(fixture.tile.x.to_string())
        .join(format!("{}.png", fixture.tile.y));
    assert!(path.as_os_str().len() > 260);
    let subscription = checked(engine.subscribe(
        "deep".into(),
        fixture.handle.clone(),
        fixture.tile,
        path.clone(),
        false,
    ))?;
    let rendered = checked(subscription.wait(Duration::from_secs(5)).await)?;
    assert_eq!(
        checked(runtime::read_png(&path))?,
        Some(rendered.as_ref().clone())
    );
    Ok(())
}
