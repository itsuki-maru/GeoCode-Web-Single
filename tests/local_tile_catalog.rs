use anyhow::{Context, Result};
use fs2::FileExt;
use geocode_web_single::local_tiles::catalog::{
    self, DatasetRecord, JobRecord, ProfileRecord, TileCatalog,
};
use rusqlite::Connection;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    fs::{self, OpenOptions},
    path::Path,
    sync::Arc,
};

async fn app_pool(path: &Path) -> Result<SqlitePool> {
    Ok(SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true),
        )
        .await?)
}

fn dataset(id: &str) -> DatasetRecord {
    DatasetRecord {
        id: id.into(),
        name: "日本語の地図".into(),
        storage_kind: "managed".into(),
        database_path: "one/data.sqlite".into(),
        dataset_key: "dataset-key".into(),
        info_json: "{\"name\":\"地図\"}".into(),
        created_at: "2026-11-12T00:00:00Z".into(),
        retired: false,
    }
}

fn profile(dataset_id: &str) -> ProfileRecord {
    ProfileRecord {
        id: "render-one".into(),
        dataset_id: dataset_id.into(),
        build_id: "build-one".into(),
        info_json: "{}".into(),
        retired: false,
    }
}

#[tokio::test]
async fn separate_catalog_preserves_data_and_reopens_without_touching_app_schema() -> Result<()> {
    let root = tempfile::tempdir()?;
    let app_path = root.path().join("app.sqlite");
    let pool = app_pool(&app_path).await?;
    sqlx::query("CREATE TABLE app_data(id INTEGER PRIMARY KEY, value TEXT)")
        .execute(&pool)
        .await?;
    sqlx::query("INSERT INTO app_data VALUES (1,'original')")
        .execute(&pool)
        .await?;
    let path = root.path().join("日本語 空白/長い保存先/catalog.sqlite");
    let cat = TileCatalog::new(path.clone(), pool.clone());
    assert!(
        !path.exists(),
        "constructing a router must not create the catalog"
    );
    cat.initialize().await.map_err(anyhow::Error::msg)?;
    catalog::insert_dataset_with_profile(&cat, &dataset("one"), &profile("one")).await?;
    assert!(catalog::active_profile(&cat, "one", "render-one").await?);
    assert_eq!(
        cat.owner_lock_path()
            .map_err(anyhow::Error::msg)?
            .file_name()
            .unwrap(),
        "catalog.sqlite.owner.lock"
    );
    let tile_tables: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'local_tile_%'")
            .fetch_one(&pool)
            .await?;
    assert_eq!(tile_tables, 0);
    let app_value: String = sqlx::query_scalar("SELECT value FROM app_data WHERE id=1")
        .fetch_one(&pool)
        .await?;
    assert_eq!(app_value, "original");
    cat.close().await;
    // 通常のファイルサイズ・更新時刻の変化では、不変のファイルIDを無効化しない。
    sqlx::query("INSERT INTO app_data VALUES (2,'changed')")
        .execute(&pool)
        .await?;
    let reopened = TileCatalog::new(path.clone(), pool.clone());
    reopened.initialize().await.map_err(anyhow::Error::msg)?;
    let record = catalog::get_dataset(&reopened, "one").await?.unwrap();
    assert_eq!(record.name, "日本語の地図");
    assert_eq!(record.info_json, dataset("one").info_json);
    let connection =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    assert_eq!(
        connection.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))?,
        1
    );
    assert_eq!(
        connection.query_row("PRAGMA application_id", [], |r| r.get::<_, i32>(0))?,
        0x47574354
    );
    assert_eq!(
        connection.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))?,
        "wal"
    );
    drop(connection);
    reopened.close().await;
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn catalog_keeps_generations_atomic_and_only_interrupts_verified_owner() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = app_pool(&root.path().join("app.sqlite")).await?;
    let cat = TileCatalog::new(root.path().join("catalog.sqlite"), pool.clone());
    catalog::insert_dataset_with_profile(&cat, &dataset("one"), &profile("one")).await?;
    let mut bad = profile("not-registered");
    assert!(
        catalog::insert_dataset_with_profile(&cat, &dataset("two"), &bad)
            .await
            .is_err()
    );
    assert!(catalog::get_dataset(&cat, "two").await?.is_none());
    bad.dataset_id = "one".into();
    bad.info_json = "invalid JSON".into();
    assert!(catalog::insert_profile(&cat, &bad).await.is_err());
    for (id, owner) in [("orphan", "owner-gone"), ("live", "owner-alive")] {
        catalog::insert_job(
            &cat,
            &JobRecord {
                id: id.into(),
                kind: "precompute".into(),
                dataset_id: Some("one".into()),
                state: "running".into(),
                request_json: "{}".into(),
                progress_json: "{}".into(),
                error: None,
                created_at: "2026-11-12T00:00:00Z".into(),
                updated_at: "2026-11-12T00:00:00Z".into(),
                owner_id: owner.into(),
            },
        )
        .await?;
    }
    assert_eq!(catalog::total_jobs(&cat).await?, 2);
    assert!(catalog::has_active_jobs(&cat, "one").await?);
    assert_eq!(
        catalog::interrupt_jobs_for_owner(&cat, "owner-gone").await?,
        1
    );
    assert_eq!(
        catalog::get_job(&cat, "orphan").await?.unwrap().state,
        "interrupted"
    );
    assert_eq!(
        catalog::get_job(&cat, "live").await?.unwrap().state,
        "running"
    );
    catalog::update_job(&cat, "live", "succeeded", "{\"tiles\":1}", None).await?;
    assert!(!catalog::request_job_cancel(&cat, "live").await?);
    assert!(catalog::active_job_owners(&cat).await?.is_empty());
    assert!(catalog::retire_dataset(&cat, "one").await?);
    assert!(!catalog::retire_dataset(&cat, "one").await?);
    assert!(!catalog::active_profile(&cat, "one", "render-one").await?);
    assert!(
        catalog::get_profile(&cat, "one", "render-one")
            .await?
            .unwrap()
            .retired
    );
    cat.close().await;
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn unrelated_corrupt_and_future_databases_are_rejected_without_conversion() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = app_pool(&root.path().join("app.sqlite")).await?;
    let foreign = root.path().join("foreign.sqlite");
    let connection = Connection::open(&foreign)?;
    // LIKEパターンの「_」はワイルドカードとなる。この正当な利用者テーブルを、
    // sqlite_*の内部テーブルと誤認してスキーマ検査から除外しない。
    connection.execute_batch(
        "CREATE TABLE sqlitex_data(value TEXT); INSERT INTO sqlitex_data VALUES ('keep');",
    )?;
    drop(connection);
    let before = fs::read(&foreign)?;
    let cat = TileCatalog::new(foreign.clone(), pool.clone());
    assert!(cat.initialize().await.is_err());
    assert_eq!(fs::read(&foreign)?, before);
    assert!(!foreign.with_extension("sqlite.owner.lock").exists());
    let corrupt = root.path().join("corrupt.sqlite");
    fs::write(&corrupt, b"this is not a SQLite database")?;
    let cat = TileCatalog::new(corrupt.clone(), pool.clone());
    assert!(cat.initialize().await.is_err());
    assert_eq!(fs::read(&corrupt)?, b"this is not a SQLite database");
    let future = root.path().join("future.sqlite");
    let cat = TileCatalog::new(future.clone(), pool.clone());
    cat.initialize().await.map_err(anyhow::Error::msg)?;
    cat.close().await;
    let connection = Connection::open(&future)?;
    connection.pragma_update(None, "user_version", 99)?;
    drop(connection);
    let cat = TileCatalog::new(future.clone(), pool.clone());
    assert!(cat.initialize().await.unwrap_err().contains("99"));
    let connection = Connection::open(&future)?;
    assert_eq!(
        connection.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))?,
        99
    );
    drop(connection);
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn forged_or_modified_catalog_schema_is_rejected() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = app_pool(&root.path().join("app.sqlite")).await?;
    for (name, change) in [
        (
            "trigger.sqlite",
            "CREATE TRIGGER unexpected AFTER INSERT ON local_tile_jobs BEGIN SELECT 1; END;",
        ),
        (
            "checksum.sqlite",
            "UPDATE tile_catalog_schema SET checksum='changed';",
        ),
    ] {
        let path = root.path().join(name);
        let cat = TileCatalog::new(path.clone(), pool.clone());
        cat.initialize().await.map_err(anyhow::Error::msg)?;
        cat.close().await;
        let connection = Connection::open(&path)?;
        connection.execute_batch(change)?;
        drop(connection);
        let cat = TileCatalog::new(path, pool.clone());
        assert!(cat.initialize().await.is_err());
    }
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn app_database_and_hardlink_aliases_cannot_be_used_as_catalog() -> Result<()> {
    let root = tempfile::tempdir()?;
    let app_path = root.path().join("app.sqlite");
    let pool = app_pool(&app_path).await?;
    sqlx::query("CREATE TABLE only_app(value TEXT)")
        .execute(&pool)
        .await?;
    let cat = TileCatalog::new(app_path.clone(), pool.clone());
    assert!(cat.initialize().await.is_err());
    let alias = root.path().join("app-alias.sqlite");
    fs::hard_link(&app_path, &alias)?;
    let cat = TileCatalog::new(alias.clone(), pool.clone());
    assert!(cat.initialize().await.is_err());
    pool.close().await;
    fs::remove_file(&alias)?;
    let pool = app_pool(&app_path).await?;
    let path = root.path().join("catalog.sqlite");
    let cat = TileCatalog::new(path.clone(), pool.clone());
    cat.initialize().await.map_err(anyhow::Error::msg)?;
    cat.close().await;
    let alias = root.path().join("catalog-alias.sqlite");
    fs::hard_link(&path, &alias)?;
    for target in [path, alias] {
        let cat = TileCatalog::new(target, pool.clone());
        assert!(cat.initialize().await.unwrap_err().contains("hard link"));
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'local_tile_%'"
        )
        .fetch_one(&pool)
        .await?,
        0
    );
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn another_app_database_is_rejected_but_catalog_can_move_independently() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = app_pool(&root.path().join("app.sqlite")).await?;
    let path = root.path().join("catalog.sqlite");
    let cat = TileCatalog::new(path.clone(), pool.clone());
    catalog::insert_dataset(&cat, &dataset("one")).await?;
    cat.close().await;
    let other = app_pool(&root.path().join("another-app.sqlite")).await?;
    let invalid = TileCatalog::new(path.clone(), other.clone());
    assert!(
        invalid
            .initialize()
            .await
            .unwrap_err()
            .contains("別の本体DB")
    );
    other.close().await;
    let moved = root.path().join("other disk catalog.sqlite");
    fs::rename(&path, &moved).with_context(|| {
        format!(
            "closed catalog rename failed: {} -> {}",
            path.display(),
            moved.display()
        )
    })?;
    let reopened = TileCatalog::new(moved, pool.clone());
    assert_eq!(catalog::list_datasets(&reopened).await?.len(), 1);
    reopened.close().await;
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn catalog_creation_uses_same_owner_lock_but_existing_schema_allows_readers() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = app_pool(&root.path().join("app.sqlite")).await?;
    let path = root.path().join("catalog.sqlite");
    let lock_path = root.path().join("catalog.sqlite.owner.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    lock.try_lock_exclusive()?;
    let cat = TileCatalog::new(path.clone(), pool.clone());
    assert!(cat.initialize().await.is_err());
    assert!(!path.exists());
    drop(lock);
    cat.initialize().await.map_err(anyhow::Error::msg)?;
    catalog::insert_dataset(&cat, &dataset("one")).await?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(cat.owner_lock_path().map_err(anyhow::Error::msg)?)?;
    lock.try_lock_exclusive()?;
    let reader = TileCatalog::new(path, pool.clone());
    assert_eq!(catalog::list_datasets(&reader).await?.len(), 1);
    reader.close().await;
    drop(lock);
    cat.close().await;
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn closed_catalog_never_opens_lazily_or_reopens_after_shutdown() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = app_pool(&root.path().join("app.sqlite")).await?;
    let path = root.path().join("never-created.sqlite");
    let cat = TileCatalog::new(path.clone(), pool.clone());
    cat.close().await;
    assert!(catalog::list_datasets(&cat).await.is_err());
    assert!(!path.exists());
    let raced = Arc::new(TileCatalog::new(
        root.path().join("raced.sqlite"),
        pool.clone(),
    ));
    let opening = {
        let cat = raced.clone();
        tokio::spawn(async move { cat.initialize().await })
    };
    tokio::task::yield_now().await;
    raced.close().await;
    let _ = opening.await?;
    assert!(raced.initialize().await.is_err());
    assert!(catalog::list_datasets(&raced).await.is_err());
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn protected_storage_roots_and_unavailable_parent_do_not_get_catalog_files() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = app_pool(&root.path().join("app.sqlite")).await?;
    let datasets = root.path().join("datasets");
    let path = datasets.join("nested/catalog.sqlite");
    let cat = TileCatalog::new(path.clone(), pool.clone()).with_storage_roots([datasets.clone()]);
    assert!(cat.initialize().await.is_err());
    assert!(!datasets.exists());
    let obstruction = root.path().join("not-a-directory");
    fs::write(&obstruction, b"keep")?;
    let cat = TileCatalog::new(obstruction.join("catalog.sqlite"), pool.clone());
    assert!(cat.initialize().await.is_err());
    assert_eq!(fs::read(&obstruction)?, b"keep");
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn independent_in_memory_app_pools_are_never_interpreted_as_files() -> Result<()> {
    let root = tempfile::tempdir()?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await?;
    let other = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await?;
    let path = root.path().join("catalog.sqlite");
    let cat = TileCatalog::new(path.clone(), pool.clone());
    cat.initialize().await.map_err(anyhow::Error::msg)?;
    let same_pool = TileCatalog::new(path.clone(), pool.clone());
    same_pool.initialize().await.map_err(anyhow::Error::msg)?;
    let different_pool = TileCatalog::new(path, other.clone());
    assert!(different_pool.initialize().await.is_err());
    cat.close().await;
    same_pool.close().await;
    pool.close().await;
    other.close().await;
    Ok(())
}

#[tokio::test]
async fn identical_memory_option_names_do_not_rebind_a_saved_catalog() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("catalog.sqlite");
    let options = || SqliteConnectOptions::new().in_memory(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options())
        .await?;
    let cat = TileCatalog::new(path.clone(), pool.clone());
    cat.initialize().await.map_err(anyhow::Error::msg)?;
    cat.close().await;
    pool.close().await;
    drop(cat);
    drop(pool);
    let replacement = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options())
        .await?;
    let invalid = TileCatalog::new(path, replacement.clone());
    assert!(
        invalid
            .initialize()
            .await
            .unwrap_err()
            .contains("別の本体DB")
    );
    replacement.close().await;
    Ok(())
}
