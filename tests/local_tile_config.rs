use geocode_web_single::{
    init::read_env_json,
    local_tiles::{catalog::DatasetRecord, config::LocalTileConfig},
};
use serde_json::json;
use std::path::{Path, PathBuf};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "geocode-local-tile-config-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn settings(&self) -> PathBuf {
        self.0.join("geocode-web-single.env.json")
    }
    fn write(&self, value: serde_json::Value) {
        std::fs::write(self.settings(), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn required_settings() -> serde_json::Value {
    json!({
        "app_title": "Tile Test", "access_token_exp_minutes": "30",
        "refresh_token_exp_minutes": "60", "secret_key": "test-secret",
        "admin_username": "admin", "admin_passwotd": "test-password",
        "failed_account_lock": "5", "next_challenge_minutes": "5",
        "challenge_limit_time_failed_count": "3"
    })
}

#[test]
fn old_json_gets_independent_tile_paths_and_does_not_rewrite_again() {
    let dir = TestDirectory::new();
    let mut original = required_settings();
    original["image_file_path"] = json!("custom-relative-image-path");
    original["upload_file_path"] = json!("custom-relative-upload-path");
    original["tile_cache_path"] = serde_json::Value::Null;
    original["tile_catalog_database_path"] = serde_json::Value::Null;
    dir.write(original);
    let before = std::fs::read(dir.settings()).unwrap();
    let setup = read_env_json(&dir.0).unwrap();
    let config = LocalTileConfig::from_setup(&setup).unwrap();
    assert_eq!(
        config.catalog_database_path,
        dir.0.join("tiles/catalog.sqlite")
    );
    assert_eq!(config.dataset_path, dir.0.join("tiles/datasets"));
    assert_eq!(config.cache_path, dir.0.join("tiles/png"));
    assert_eq!(config.work_path, dir.0.join("tiles/work"));
    assert_eq!(config.workers, 2);
    assert_eq!(config.background_queue_capacity, 4);
    assert_eq!(setup.image_file_path, "custom-relative-image-path");
    assert_eq!(setup.upload_file_path, "custom-relative-upload-path");
    assert!(
        !dir.0.join("tiles").exists(),
        "reading settings must not create stores"
    );
    assert_eq!(
        std::fs::read(dir.0.join("geocode-web-single.env.json.bak")).unwrap(),
        before
    );
    let migrated = std::fs::read(dir.settings()).unwrap();
    assert_eq!(
        read_env_json(&dir.0).unwrap().tile_cache_path,
        setup.tile_cache_path
    );
    assert_eq!(std::fs::read(dir.settings()).unwrap(), migrated);
}

#[test]
fn explicit_paths_survive_and_invalid_settings_never_get_written_back() {
    let dir = TestDirectory::new();
    let mut value = required_settings();
    let data = dir.0.join("DB 保存先");
    let png = dir.0.join("PNG only");
    let work = dir.0.join("work space");
    let catalog = dir.0.join("管理DB/catalog.sqlite");
    value["tile_catalog_database_path"] = json!(catalog);
    value["tile_dataset_path"] = json!(data);
    value["tile_cache_path"] = json!(png);
    value["tile_work_path"] = json!(work);
    value["local_tile_workers"] = json!("3");
    dir.write(value);
    let setup = read_env_json(&dir.0).unwrap();
    let config = LocalTileConfig::from_setup(&setup).unwrap();
    assert_eq!(config.catalog_database_path, catalog);
    assert_eq!(config.dataset_path, data);
    assert_eq!(config.cache_path, png);
    assert_eq!(config.work_path, work);
    assert_eq!(config.workers, 3);
    for (field, invalid) in [
        ("tile_catalog_database_path", ""),
        ("tile_catalog_database_path", "relative/catalog.sqlite"),
        ("tile_catalog_database_path", "~/catalog.sqlite"),
        ("tile_dataset_path", ""),
        ("tile_cache_path", "relative/tiles"),
        ("tile_work_path", "~/tiles"),
        ("local_tile_workers", "0"),
        ("local_tile_queue_capacity", "-1"),
        ("local_tile_max_subscribers", "invalid"),
        ("local_tile_background_queue_capacity", "0"),
        ("local_tile_http_timeout_seconds", "0"),
        ("local_tile_job_timeout_seconds", "999999999999999999999"),
        ("local_tile_precompute_max_tiles", "0"),
    ] {
        let mut invalid_value = serde_json::to_value(&setup).unwrap();
        invalid_value[field] = json!(invalid);
        dir.write(invalid_value);
        let before = std::fs::read(dir.settings()).unwrap();
        let error = read_env_json(&dir.0).unwrap_err().to_string();
        assert!(error.contains(field), "{field}: {error}");
        assert_eq!(std::fs::read(dir.settings()).unwrap(), before);
    }
}

#[test]
fn png_only_override_does_not_change_catalog_default() {
    let dir = TestDirectory::new();
    let mut value = required_settings();
    value["tile_cache_path"] = json!(dir.0.join("別ディスクのPNG"));
    dir.write(value);
    let setup = read_env_json(&dir.0).unwrap();
    assert_eq!(
        LocalTileConfig::from_setup(&setup)
            .unwrap()
            .catalog_database_path,
        dir.0.join("tiles/catalog.sqlite")
    );
}

#[test]
fn catalog_path_cannot_overlap_storage_roots_or_be_a_directory() {
    let dir = TestDirectory::new();
    dir.write(required_settings());
    let setup = read_env_json(&dir.0).unwrap();
    for path in [
        dir.0.join("tiles/datasets/catalog.sqlite"),
        dir.0.join("tiles/png/catalog.sqlite"),
        dir.0.join("tiles/work/catalog.sqlite"),
        dir.0.join("tiles/work/../datasets/catalog.sqlite"),
        dir.0.clone(),
    ] {
        let mut value = setup.clone();
        value.tile_catalog_database_path = path.to_string_lossy().into_owned();
        assert!(
            LocalTileConfig::from_setup(&value).is_err(),
            "{}",
            path.display()
        );
    }
    let mut value = setup.clone();
    value.tile_dataset_path = dir
        .0
        .join("catalog.sqlite/datasets")
        .to_string_lossy()
        .into_owned();
    value.tile_catalog_database_path = dir.0.join("catalog.sqlite").to_string_lossy().into_owned();
    assert!(LocalTileConfig::from_setup(&value).is_err());
    assert!(LocalTileConfig::from_setup(&setup).is_ok());
    assert!(!dir.0.join("tiles").exists());
}

fn dataset(id: &str) -> DatasetRecord {
    DatasetRecord {
        id: id.into(),
        name: "Test DB".into(),
        storage_kind: "managed".into(),
        database_path: "one/data.sqlite".into(),
        dataset_key: "sdk-dataset-key".into(),
        info_json: "{}".into(),
        created_at: "2026-11-12T00:00:00Z".into(),
        retired: false,
    }
}

#[test]
fn managed_paths_cannot_escape_the_configured_root() {
    let dir = TestDirectory::new();
    let mut record = dataset("one");
    assert_eq!(
        record.resolve_path(&dir.0).unwrap(),
        dir.0.join("one/data.sqlite")
    );
    for path in [
        "../escape.sqlite",
        "one/../../escape.sqlite",
        "",
        "/absolute.sqlite",
    ] {
        record.database_path = path.into();
        assert!(record.resolve_path(&dir.0).is_err(), "{path}");
    }
    record.storage_kind = "external".into();
    record.database_path = dir.0.join("external.sqlite").to_string_lossy().into_owned();
    assert_eq!(
        record.resolve_path(Path::new("unused")).unwrap(),
        dir.0.join("external.sqlite")
    );
    record.database_path = "relative.sqlite".into();
    assert!(record.resolve_path(&dir.0).is_err());
}

#[test]
fn tile_roots_reject_aliases_and_nested_directories_without_creating_them() {
    let dir = TestDirectory::new();
    dir.write(required_settings());
    let setup = read_env_json(&dir.0).unwrap();
    let common = dir.0.join("same-root");
    for alias in [
        common.clone(),
        common.join("child"),
        common.join("child/.."),
        dir.0.clone(),
    ] {
        let mut value = setup.clone();
        value.tile_dataset_path = common.to_string_lossy().into_owned();
        value.tile_cache_path = alias.to_string_lossy().into_owned();
        let error = LocalTileConfig::from_setup(&value).unwrap_err();
        assert!(
            error.contains("tile_cache_path")
                && (error.contains("tile_dataset_path")
                    || error.contains("tile_catalog_database_path")),
            "{error}"
        );
    }
    #[cfg(windows)]
    {
        let mut value = setup.clone();
        value.tile_dataset_path = common.to_string_lossy().into_owned();
        value.tile_work_path = common.to_string_lossy().to_uppercase();
        assert!(LocalTileConfig::from_setup(&value).is_err());
    }
    assert!(!common.exists());
    assert!(LocalTileConfig::from_setup(&setup).is_ok());
}
