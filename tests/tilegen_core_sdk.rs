#[path = "tilegen_support/mod.rs"]
mod support;

use std::{
    error::Error,
    fs::{FileTimes, OpenOptions},
    time::{Duration, SystemTime},
};

use anyhow::Result;
use geocode_web_single::tilegen::{
    dataset::{
        CancellationToken, Dataset, ErrorKind, OperationContext, RenderOptions, Stage, Status,
        TileId,
    },
    import::{self, ImportOptions, MissingNodes},
    renderer::{self, Candidate},
    store::Store,
    style::Style,
};
use tempfile::TempDir;

fn fixture(indexed: bool, policy: MissingNodes) -> Result<(TempDir, Dataset)> {
    let root = tempfile::tempdir()?;
    let input = root.path().join("input.osm.pbf");
    let store = root.path().join("map.sqlite");
    let mut fixture = support::Fixture::sample();
    fixture.ways[0]
        .tags
        .insert("highway".into(), "motorway".into());
    fixture.write(&input);
    import::run(&ImportOptions {
        input,
        store: store.clone(),
        work_dir: root.path().join("work"),
        missing_nodes: policy,
    })?;
    if !indexed {
        rusqlite::Connection::open(&store)?
            .execute_batch("DROP INDEX feature_render_attributes")?;
    }
    Ok((root, Dataset::open(store)?))
}

#[test]
fn session_reuses_connection_and_returns_owned_pixels_matching_legacy() -> Result<()> {
    let (root, dataset) = fixture(true, MissingNodes::Error)?;
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    let mut session = dataset.create_session(RenderOptions::default())?;
    let rendered = session.render(tile, &CancellationToken::new())?;
    assert_eq!(
        (rendered.image.width(), rendered.image.height()),
        (256, 256)
    );
    assert_eq!(rendered.image.stride(), 256 * 4);
    assert_eq!(rendered.image.rgba().len(), 256 * 256 * 4);
    assert!(
        rendered
            .image
            .rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| p[3] == 255)
    );
    assert!(
        rendered
            .image
            .rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .any(|p| *p != Style::BACKGROUND)
    );

    let store = Store::open(&root.path().join("map.sqlite"))?;
    let style = Style::roads_v1();
    let keys = store.query_candidates(renderer::query_rect(tile, &style), tile.z)?;
    let candidates: Vec<_> = keys
        .into_iter()
        .map(|key| Candidate {
            id: key.feature_id,
            osm_way_id: key.osm_way_id,
            attrs: key.attributes,
        })
        .collect();
    let legacy = renderer::render_tile(tile, &style, &candidates, |id| {
        store.load_geometry(id, tile.z)
    })?;
    assert_eq!(rendered.image.rgba(), legacy.data());
    assert_eq!(rendered.cache_key, dataset.cache_key(tile)?);

    let retained = rendered.image.shared_rgba();
    let empty = session.render(TileId::new(14, 0, 0)?, &CancellationToken::new())?;
    assert!(
        empty
            .image
            .rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| *p == Style::BACKGROUND)
    );
    drop(session);
    assert_eq!(retained.as_ref(), legacy.data());

    {
        let png = rendered.image.encode_png()?;
        assert_eq!(tiny_skia::Pixmap::decode_png(&png)?.data(), legacy.data());
    }
    Ok(())
}

#[test]
fn dataset_can_be_shared_while_each_worker_owns_its_session() -> Result<()> {
    fn assert_shared<T: Send + Sync>() {}
    assert_shared::<Dataset>();
    let (_root, dataset) = fixture(true, MissingNodes::Error)?;
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    std::thread::scope(|scope| -> Result<()> {
        let first = scope.spawn(|| {
            dataset
                .create_session(RenderOptions::default())?
                .render(tile, &CancellationToken::new())
        });
        let second = scope.spawn(|| {
            dataset
                .create_session(RenderOptions::default())?
                .render(tile, &CancellationToken::new())
        });
        assert_eq!(
            first.join().unwrap()?.image.rgba(),
            second.join().unwrap()?.image.rgba()
        );
        Ok(())
    })
}

#[test]
fn cache_identity_ignores_path_and_optional_index_but_tracks_data_and_tile() -> Result<()> {
    let (_indexed_root, indexed) = fixture(true, MissingNodes::Error)?;
    let (_legacy_root, legacy) = fixture(false, MissingNodes::Error)?;
    let (_policy_root, policy) = fixture(true, MissingNodes::SkipWay)?;
    let tile = TileId::from_lon_lat(6, 139.7, 35.7)?;
    assert_eq!(indexed.cache_key(tile)?, legacy.cache_key(tile)?);
    assert_ne!(indexed.cache_key(tile)?, policy.cache_key(tile)?);
    assert_ne!(
        indexed.cache_key(tile)?,
        indexed.cache_key(TileId::new(6, 0, 0)?)?
    );
    let old = legacy
        .create_session(RenderOptions::default())?
        .render(tile, &CancellationToken::new())?;
    let new = indexed
        .create_session(RenderOptions::default())?
        .render(tile, &CancellationToken::new())?;
    assert_eq!(old.image.rgba(), new.image.rgba());
    Ok(())
}

#[test]
fn 旧完成dbの識別とビルド来歴を保持し描画キーから来歴を除外する() -> Result<()> {
    let (root, dataset) = fixture(true, MissingNodes::Error)?;
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    let contract_id = dataset.render_contract().id();
    let expected_pixels = dataset
        .create_session(RenderOptions::default())?
        .render(tile, &CancellationToken::new())?
        .image
        .shared_rgba();
    drop(dataset);
    let path = root.path().join("map.sqlite");
    let old_id = "a".repeat(64);
    let old_producer = format!("1.14.0+{}", "b".repeat(64));
    {
        let write = rusqlite::Connection::open(&path)?;
        let document: String = write.query_row(
            "SELECT value FROM metadata WHERE key='document'",
            [],
            |row| row.get(0),
        )?;
        let mut value: serde_json::Value = serde_json::from_str(&document)?;
        value["dataset_id"] = old_id.clone().into();
        value["importer_version"] = old_producer.clone().into();
        write.execute(
            "UPDATE metadata SET value=? WHERE key='document'",
            [serde_json::to_string(&value)?],
        )?;
    }
    let before = std::fs::read(&path)?;
    let legacy = Dataset::open(&path)?;
    assert_eq!(legacy.info().dataset_id, old_id);
    assert_eq!(legacy.info().importer_version, old_producer);
    assert_eq!(legacy.render_contract().id(), contract_id);
    let old_key = legacy.cache_key(tile)?;
    assert_eq!(
        legacy
            .create_session(RenderOptions::default())?
            .render(tile, &CancellationToken::new())?
            .image
            .rgba(),
        expected_pixels.as_ref()
    );
    drop(legacy);
    assert_eq!(std::fs::read(&path)?, before);
    {
        let write = rusqlite::Connection::open(&path)?;
        let document: String = write.query_row(
            "SELECT value FROM metadata WHERE key='document'",
            [],
            |row| row.get(0),
        )?;
        let mut value: serde_json::Value = serde_json::from_str(&document)?;
        value["importer_version"] = format!("1.14.1+{}", "c".repeat(64)).into();
        write.execute(
            "UPDATE metadata SET value=? WHERE key='document'",
            [serde_json::to_string(&value)?],
        )?;
    }
    let before = std::fs::read(&path)?;
    let another_build = Dataset::open(&path)?;
    assert_eq!(another_build.info().dataset_id, old_id);
    assert_eq!(another_build.cache_key(tile)?, old_key);
    drop(another_build);
    assert_eq!(std::fs::read(&path)?, before);
    Ok(())
}

#[test]
fn cancellation_and_invalid_tile_leave_the_session_reusable() -> Result<()> {
    let (_root, dataset) = fixture(true, MissingNodes::Error)?;
    let mut session = dataset.create_session(RenderOptions::default())?;
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        session.render(tile, &cancel).unwrap_err().kind(),
        ErrorKind::Cancelled
    );
    let invalid = TileId { z: 23, x: 0, y: 0 };
    assert_eq!(
        session
            .render(invalid, &CancellationToken::new())
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidTile
    );
    assert_eq!(
        dataset.cache_key(invalid).unwrap_err().kind(),
        ErrorKind::InvalidTile
    );
    assert!(
        !session
            .render(tile, &CancellationToken::new())?
            .image
            .rgba()
            .is_empty()
    );
    Ok(())
}

#[test]
fn changed_dataset_is_rejected_before_creating_a_new_session() -> Result<()> {
    let (root, dataset) = fixture(true, MissingNodes::Error)?;
    let file = OpenOptions::new()
        .write(true)
        .open(root.path().join("map.sqlite"))?;
    file.set_times(
        FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000)),
    )?;
    let result = dataset.create_session(RenderOptions::default());
    assert_eq!(
        result.err().expect("changed dataset must fail").kind(),
        ErrorKind::DatasetChanged
    );
    Ok(())
}

#[test]
fn missing_geometry_is_an_error_instead_of_a_successful_background() -> Result<()> {
    let (root, _initial) = fixture(true, MissingNodes::Error)?;
    rusqlite::Connection::open(root.path().join("map.sqlite"))?
        .execute("DELETE FROM geometry_lod WHERE zoom=14", [])?;
    let dataset = Dataset::open(root.path().join("map.sqlite"))?;
    let mut session = dataset.create_session(RenderOptions::default())?;
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    let error = session.render(tile, &CancellationToken::new()).unwrap_err();
    assert!(error.source().is_some());
    Ok(())
}

#[test]
fn journal_sidecars_are_rejected_before_open_and_during_dataset_use() -> Result<()> {
    let (root, dataset) = fixture(true, MissingNodes::Error)?;
    let store = root.path().join("map.sqlite");
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = store.as_os_str().to_os_string();
        name.push(suffix);
        let sidecar = std::path::PathBuf::from(name);
        std::fs::write(&sidecar, b"incomplete external write")?;
        assert_eq!(
            Dataset::open(&store).unwrap_err().kind(),
            ErrorKind::InvalidDataset
        );
        assert_eq!(
            dataset.cache_key(tile).unwrap_err().kind(),
            ErrorKind::DatasetChanged
        );
        std::fs::remove_file(&sidecar)?;
    }
    assert!(dataset.create_session(RenderOptions::default()).is_ok());
    Ok(())
}

#[test]
fn wal_database_is_rejected_without_creating_sidecars() -> Result<()> {
    let (root, _dataset) = fixture(true, MissingNodes::Error)?;
    let store = root.path().join("map.sqlite");
    {
        let write = rusqlite::Connection::open(&store)?;
        write.execute_batch("PRAGMA journal_mode=WAL")?;
    }
    let sidecar = root.path().join("map.sqlite-wal");
    assert!(!sidecar.exists());
    assert_eq!(
        Dataset::open(&store).unwrap_err().kind(),
        ErrorKind::InvalidDataset
    );
    assert!(!sidecar.exists());
    Ok(())
}

#[test]
fn file_replacement_is_detected_even_when_size_and_mtime_match() -> Result<()> {
    let (root, dataset) = fixture(true, MissingNodes::Error)?;
    let store = root.path().join("map.sqlite");
    let original = std::fs::metadata(&store)?;
    let replacement = root.path().join("replacement.sqlite");
    std::fs::copy(&store, &replacement)?;
    OpenOptions::new()
        .write(true)
        .open(&replacement)?
        .set_times(FileTimes::new().set_modified(original.modified()?))?;
    std::fs::rename(&store, root.path().join("previous.sqlite"))?;
    std::fs::rename(&replacement, &store)?;
    assert_eq!(std::fs::metadata(&store)?.len(), original.len());
    assert_eq!(std::fs::metadata(&store)?.modified()?, original.modified()?);
    assert_eq!(
        dataset
            .create_session(RenderOptions::default())
            .err()
            .unwrap()
            .kind(),
        ErrorKind::DatasetChanged
    );
    Ok(())
}

#[test]
fn deadline_and_cancellation_are_distinct_and_do_not_poison_the_session() -> Result<()> {
    let (_root, dataset) = fixture(true, MissingNodes::Error)?;
    let mut session = dataset.create_session(RenderOptions::default())?;
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    let expired = OperationContext::default().with_deadline(std::time::Instant::now());
    assert_eq!(
        session
            .render_with_context(tile, &expired)
            .unwrap_err()
            .kind(),
        ErrorKind::DeadlineExceeded
    );
    assert_eq!(
        expired.monitor().snapshot().status,
        Status::DeadlineExceeded
    );

    let cancel = CancellationToken::new();
    let context = OperationContext::new(cancel.clone());
    cancel.cancel();
    assert_eq!(
        session
            .render_with_context(tile, &context)
            .unwrap_err()
            .kind(),
        ErrorKind::Cancelled
    );
    assert_eq!(context.monitor().snapshot().status, Status::Cancelled);

    let fresh = OperationContext::default();
    assert!(
        !session
            .render_with_context(tile, &fresh)?
            .image
            .rgba()
            .is_empty()
    );
    let finished = fresh.monitor().snapshot();
    assert_eq!(
        (finished.status, finished.stage),
        (Status::Succeeded, Stage::Completed)
    );
    assert_eq!(fresh.monitor().snapshot().elapsed, finished.elapsed);
    assert_eq!(
        session
            .render_with_context(tile, &fresh)
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidOperation
    );
    assert_eq!(fresh.monitor().snapshot().status, Status::Succeeded);
    Ok(())
}

#[test]
fn failed_operation_publishes_terminal_state_without_an_event_consumer() -> Result<()> {
    let (_root, dataset) = fixture(true, MissingNodes::Error)?;
    let mut session = dataset.create_session(RenderOptions::default())?;
    let context = OperationContext::default();
    let error = session
        .render_with_context(TileId { z: 23, x: 0, y: 0 }, &context)
        .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::InvalidTile);
    let snapshot = context.monitor().snapshot();
    assert_eq!(snapshot.status, Status::Failed);
    assert!(!snapshot.diagnostics.is_empty());
    Ok(())
}

#[test]
fn png_operation_covers_render_and_encode_under_one_context() -> Result<()> {
    let (_root, dataset) = fixture(true, MissingNodes::Error)?;
    let mut session = dataset.create_session(RenderOptions::default())?;
    let tile = TileId::from_lon_lat(14, 139.7, 35.7)?;
    let expected = session
        .render(tile, &CancellationToken::new())?
        .image
        .encode_png()?;
    let context = OperationContext::default()
        .with_deadline(std::time::Instant::now() + Duration::from_secs(30));
    let monitor = context.monitor();
    let png = session.render_png_with_context(tile, &context)?;
    assert_eq!(png.png, expected);
    assert_eq!(png.cache_key, dataset.cache_key(tile)?);
    assert!(png.elapsed >= png.stats.elapsed);
    let snapshot = monitor.snapshot();
    assert_eq!(
        (snapshot.status, snapshot.stage),
        (Status::Succeeded, Stage::Completed)
    );
    assert_eq!((snapshot.completed, snapshot.total), (1, Some(1)));
    Ok(())
}

/// 実データを明示指定して行う受入試験。通常のCIでは合成した検証用データだけを使う。
#[test]
#[ignore = "requires GEOCODE_TILEGEN_VALIDATION_DB and GEOCODE_TILEGEN_REFERENCE_PNG"]
fn regional_completed_database_matches_reference_png() -> Result<()> {
    let database_path = std::env::var_os("GEOCODE_TILEGEN_VALIDATION_DB")
        .ok_or_else(|| anyhow::anyhow!("GEOCODE_TILEGEN_VALIDATION_DB is required"))?;
    let reference_path = std::env::var_os("GEOCODE_TILEGEN_REFERENCE_PNG")
        .ok_or_else(|| anyhow::anyhow!("GEOCODE_TILEGEN_REFERENCE_PNG is required"))?;
    let dataset = Dataset::open(database_path)?;
    let mut session = dataset.create_session(RenderOptions::default())?;
    let tile = TileId::new(14, 14603, 6304)?;
    let context = OperationContext::default()
        .with_deadline(std::time::Instant::now() + Duration::from_secs(120));
    let rendered = session.render_png_with_context(tile, &context)?;
    assert_eq!(rendered.png, std::fs::read(reference_path)?);
    assert_eq!(rendered.cache_key, dataset.cache_key(tile)?);
    if let Some(output_path) = std::env::var_os("GEOCODE_TILEGEN_OUTPUT_PNG") {
        std::fs::write(output_path, &rendered.png)?;
    }
    eprintln!(
        "Miyagi 14/14603/6304: {} bytes, elapsed {:?}, encode {:?}",
        rendered.png.len(),
        rendered.elapsed,
        rendered.encode_time
    );
    Ok(())
}
