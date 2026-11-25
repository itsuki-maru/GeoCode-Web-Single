//! サーバを起動せず、新規の設定と本体DBを準備する。
//!
//! 新しい本体DBは一時ファイルで準備し、管理DBも確認してから設定を公開する。
//! DB公開と設定公開の間で停止した場合は、receiptと内容hashが一致する自作DBだけを
//! 次回の初期設定で回収する。設定が存在する場合は復旧も上書きも行わない。

use crate::init::{SetupForm, build_env_settings, validate_setup_form};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::{Builder, NamedTempFile};
use uuid::Uuid;

const PENDING_FILE: &str = ".tile-manager-setup.pending.json";
const LOCK_FILE: &str = ".tile-manager-setup.lock";

#[derive(Serialize, Deserialize)]
struct PendingSetup {
    version: u32,
    request_id: Uuid,
    config_path: PathBuf,
    database_path: PathBuf,
    database_sha256: String,
}

pub async fn initialize(config_path: &Path, form: SetupForm) -> Result<(), String> {
    initialize_setup(config_path, form, false).await
}

/// 通常アプリの初期設定は、保存済みの互換本体DBがあれば復元したデータを引き継ぐ。
pub async fn initialize_desktop(config_path: &Path, form: SetupForm) -> Result<(), String> {
    initialize_setup(config_path, form, true).await
}

async fn initialize_setup(
    config_path: &Path,
    form: SetupForm,
    accept_existing: bool,
) -> Result<(), String> {
    if !config_path.is_absolute() || config_path.file_name().is_none() {
        return Err("初期設定には設定JSONの絶対パスを指定してください。".into());
    }
    // 不正入力だけで保存先やlockを作らない。
    validate_setup_form(&form)?;
    reject_existing_config(config_path)?;
    let parent = config_path.parent().ok_or("設定の保存先がありません。")?;
    fs::create_dir_all(parent).map_err(message)?;
    let parent = fs::canonicalize(parent).map_err(message)?;
    let config_path = parent.join(config_path.file_name().unwrap());
    let lock_path = parent.join(LOCK_FILE);
    reject_symlink(&lock_path)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(message)?;
    FileExt::try_lock_exclusive(&lock).map_err(|_| {
        "別の初期設定処理が実行中です。完了してから再試行してください。".to_string()
    })?;
    reject_existing_config(&config_path)?;

    let settings = build_env_settings(&parent, form)?;
    let database = settings.sqlite_database_path.clone();
    recover_unpublished_setup(&parent, &config_path, &database)?;
    let mut staging_config = Builder::new()
        .prefix(".tile-manager-config-")
        .tempfile_in(&parent)
        .map_err(message)?;
    serde_json::to_writer_pretty(staging_config.as_file_mut(), &settings).map_err(message)?;
    staging_config.write_all(b"\n").map_err(message)?;
    staging_config.as_file().sync_all().map_err(message)?;

    if entry_exists(&database)? {
        if accept_existing {
            let pool = crate::db::pool::setup_database_pool_with_settings(&settings)
                .await
                .map_err(message)?;
            close_pool(&pool).await;
            crate::local_tiles::catalog::initialize_setup_catalog(&settings)?;
            fs::create_dir_all(&settings.image_file_path).map_err(message)?;
            staging_config
                .persist_noclobber(&config_path)
                .map_err(message)?
                .sync_all()
                .map_err(message)?;
            return Ok(());
        }
        return Err(format!(
            "既存の本体DBを初期設定で上書きしません。対応する設定JSONを指定してください: {}",
            database.display()
        ));
    }

    let staging_database = Builder::new()
        .prefix(".tile-manager-db-")
        .suffix(".sqlite.tmp")
        .tempfile_in(&parent)
        .map_err(message)?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(staging_database.path())
                .create_if_missing(false)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Delete)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .map_err(message)?;
    let prepared = async {
        crate::db::run_migrations(&pool).await.map_err(message)?;
        crate::db::seed::check_and_insert_initial_data_with_settings(&pool, &settings)
            .await
            .map_err(message)?;
        crate::db::pool::validate_existing_schema(&pool)
            .await
            .map_err(message)
    }
    .await;
    close_pool(&pool).await;
    prepared?;
    staging_database.as_file().sync_all().map_err(message)?;
    fs::create_dir_all(&settings.image_file_path).map_err(message)?;

    let pending = PendingSetup {
        version: 1,
        request_id: Uuid::new_v4(),
        config_path: config_path.clone(),
        database_path: database.clone(),
        database_sha256: file_hash(staging_database.path())?,
    };
    save_pending(&parent, &pending)?;
    // persist_noclobberは、検査直後に他者が作ったファイルも上書きしない。
    let published_database = staging_database
        .persist_noclobber(&database)
        .map_err(|error| format!("本体DBを公開できません: {}", error.error))?;
    published_database.sync_all().map_err(message)?;
    drop(published_database);
    crate::local_tiles::catalog::initialize_setup_catalog(&settings)?;
    let published_config = staging_config
        .persist_noclobber(&config_path)
        .map_err(|error| format!("設定JSONを公開できません: {}", error.error))?;
    published_config.sync_all().map_err(message)?;
    drop(published_config);
    if let Err(error) = fs::remove_file(parent.join(PENDING_FILE)) {
        tracing::warn!(%error, "初期設定は完了しましたが一時受付記録を削除できませんでした");
    }
    drop(lock);
    Ok(())
}

async fn close_pool(pool: &SqlitePool) {
    loop {
        pool.close().await;
        if pool.size() == 0 {
            break;
        }
    }
}

fn reject_existing_config(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err("設定JSONが既に存在します。既存設定は上書きしません。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(message(error)),
    }
}

fn entry_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(message(error)),
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("初期設定の制御ファイルが通常ファイルではありません。".into())
        },
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(message(error)),
    }
}

fn save_pending(parent: &Path, pending: &PendingSetup) -> Result<(), String> {
    let mut file = NamedTempFile::new_in(parent).map_err(message)?;
    serde_json::to_writer(file.as_file_mut(), pending).map_err(message)?;
    file.as_file().sync_all().map_err(message)?;
    file.persist_noclobber(parent.join(PENDING_FILE))
        .map_err(|error| message(error.error))?;
    Ok(())
}

fn recover_unpublished_setup(parent: &Path, config: &Path, database: &Path) -> Result<(), String> {
    let pending_path = parent.join(PENDING_FILE);
    reject_symlink(&pending_path)?;
    let file = match File::open(&pending_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(message(error)),
    };
    if file.metadata().map_err(message)?.len() > 65_536 {
        return Err("初期設定の受付記録が不正です。既存DBは変更しません。".into());
    }
    let pending: PendingSetup = serde_json::from_reader(file).map_err(message)?;
    if pending.version != 1 || pending.config_path != config || pending.database_path != database {
        return Err("別の初期設定の未完了記録があります。既存DBは変更しません。".into());
    }
    reject_existing_config(config)?;
    if entry_exists(database)? {
        reject_symlink(database)?;
        if file_hash(database)? != pending.database_sha256 {
            return Err("未完了の初期設定DBが変更されています。既存DBは変更しません。".into());
        }
        fs::remove_file(database).map_err(message)?;
    }
    fs::remove_file(pending_path).map_err(message)
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut input = File::open(path).map_err(message)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let length = input.read(&mut buffer).map_err(message)?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form() -> SetupForm {
        SetupForm {
            app_title: "地図生成管理".into(),
            admin_username: "manager-admin".into(),
            admin_password: "Manager test password 2026".into(),
            failed_account_lock: "7".into(),
            next_challenge_minutes: "10".into(),
            challenge_limit_time_failed_count: "5".into(),
            access_token_exp_minutes: "30".into(),
            refresh_token_exp_minutes: "1440".into(),
        }
    }

    #[tokio::test]
    async fn initialize_database_and_admin_from_explicit_settings_at_custom_path() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("日本語 空白").join("manager.json");
        initialize(&path, form()).await.unwrap();
        let settings = crate::init::read_env_json_readonly(&path).unwrap();
        assert_eq!(settings.admin_username, "manager-admin");
        assert_eq!(settings.local_tile_workers, "4");
        assert!(Path::new(&settings.tile_catalog_database_path).is_file());
        assert!(
            !path
                .parent()
                .unwrap()
                .join("geocode-web-single.env.json")
                .exists()
        );
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&settings.sqlite_database_path)
                    .read_only(true),
            )
            .await
            .unwrap();
        crate::db::pool::validate_existing_schema(&pool)
            .await
            .unwrap();
        let row: (String, String) = sqlx::query_as(
            r#"
            SELECT username, password
            FROM user_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "manager-admin");
        assert!(bcrypt::verify("Manager test password 2026", &row.1).unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"
                SELECT count(*)
                FROM layer_model
                WHERE is_master = 1
                "#,
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"
                SELECT count(*)
                FROM tileserver_model
                "#,
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                r#"
                SELECT setting_value
                FROM application_settings
                WHERE setting_key = 'login_attempts_limit'
                "#,
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "7"
        );
        close_pool(&pool).await;
        assert!(!path.parent().unwrap().join(PENDING_FILE).exists());
        assert!(Path::new(&settings.image_file_path).is_dir());
    }

    #[tokio::test]
    async fn preserve_existing_files_and_reject_invalid_setup_before_creating_paths() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("existing.json");
        fs::write(&config, b"user configuration").unwrap();
        assert!(initialize(&config, form()).await.is_err());
        assert_eq!(fs::read(&config).unwrap(), b"user configuration");
        fs::remove_file(&config).unwrap();
        let database = root.path().join("geocode-web.sqlite");
        fs::write(&database, b"user database").unwrap();
        assert!(initialize(&config, form()).await.is_err());
        assert_eq!(fs::read(&database).unwrap(), b"user database");
        assert!(!config.exists());
        let missing = root.path().join("not-created/config.json");
        let mut invalid = form();
        invalid.failed_account_lock = "not-a-number".into();
        assert!(initialize(&missing, invalid).await.is_err());
        assert!(!missing.parent().unwrap().exists());
    }

    #[tokio::test]
    async fn recover_own_interrupted_database_publication_without_replacing_modified_data() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("manager.json");
        initialize(&config, form()).await.unwrap();
        let settings = crate::init::read_env_json_readonly(&config).unwrap();
        let parent = fs::canonicalize(root.path()).unwrap();
        let config = parent.join("manager.json");
        fs::remove_file(&config).unwrap();
        let pending = PendingSetup {
            version: 1,
            request_id: Uuid::new_v4(),
            config_path: config.clone(),
            database_path: settings.sqlite_database_path.clone(),
            database_sha256: file_hash(&settings.sqlite_database_path).unwrap(),
        };
        save_pending(&parent, &pending).unwrap();
        let mut retry = form();
        retry.admin_username = "retried-admin".into();
        initialize(&config, retry).await.unwrap();
        assert_eq!(
            crate::init::read_env_json_readonly(&config)
                .unwrap()
                .admin_username,
            "retried-admin"
        );

        fs::remove_file(&config).unwrap();
        let mut pending = pending;
        pending.database_sha256 = file_hash(&settings.sqlite_database_path).unwrap();
        save_pending(&parent, &pending).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&settings.sqlite_database_path)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        let changed = fs::read(&settings.sqlite_database_path).unwrap();
        assert!(initialize(&config, form()).await.is_err());
        assert_eq!(fs::read(&settings.sqlite_database_path).unwrap(), changed);
        assert!(!config.exists());
    }
}
