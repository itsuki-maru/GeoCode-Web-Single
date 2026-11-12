//! 登録情報とジョブ履歴を永続化する。ファイルの管理は実行基盤が担う。

use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::path::{Component, Path, PathBuf};

#[path = "catalog_database.rs"]
mod database;
pub use database::TileCatalog;

/// 競合試験では実際の接続を保持し、製品用の制御フックを追加せず待機を作る。
#[cfg(test)]
pub(crate) async fn test_pool(catalog: &TileCatalog) -> Result<&sqlx::SqlitePool, sqlx::Error> {
    catalog.pool().await
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DatasetRecord {
    pub id: String,
    pub name: String,
    pub storage_kind: String,
    pub database_path: String,
    pub dataset_key: String,
    pub info_json: String,
    pub created_at: String,
    pub retired: bool,
}

impl DatasetRecord {
    /// 本体管理の登録情報を、現在設定されているデータセット保存先からの相対位置で解決する。
    pub fn resolve_path(&self, dataset_root: &Path) -> Result<PathBuf, String> {
        let path = Path::new(&self.database_path);
        match self.storage_kind.as_str() {
            "external" if path.is_absolute() => Ok(path.to_path_buf()),
            "managed"
                if !path.as_os_str().is_empty()
                    && path
                        .components()
                        .all(|component| matches!(component, Component::Normal(_))) =>
            {
                Ok(dataset_root.join(path))
            },
            _ => Err("登録されたタイルDBの保存先が不正です。".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ProfileRecord {
    pub id: String,
    pub dataset_id: String,
    pub build_id: String,
    pub info_json: String,
    pub retired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct JobRecord {
    pub id: String,
    pub kind: String,
    pub dataset_id: Option<String>,
    pub state: String,
    pub request_json: String,
    pub progress_json: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub owner_id: String,
}

pub async fn list_datasets(catalog: &TileCatalog) -> Result<Vec<DatasetRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as("SELECT * FROM local_tile_datasets ORDER BY created_at DESC, id")
        .fetch_all(pool)
        .await
}

pub async fn get_dataset(
    catalog: &TileCatalog,
    id: &str,
) -> Result<Option<DatasetRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as("SELECT * FROM local_tile_datasets WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn insert_dataset(
    catalog: &TileCatalog,
    value: &DatasetRecord,
) -> Result<(), sqlx::Error> {
    let pool = catalog.write_pool().await?;
    sqlx::query("INSERT INTO local_tile_datasets (id,name,storage_kind,database_path,dataset_key,info_json,created_at,retired) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&value.id).bind(&value.name).bind(&value.storage_kind).bind(&value.database_path)
        .bind(&value.dataset_key).bind(&value.info_json).bind(&value.created_at).bind(value.retired)
        .execute(pool).await?;
    Ok(())
}

pub async fn insert_profile(
    catalog: &TileCatalog,
    value: &ProfileRecord,
) -> Result<(), sqlx::Error> {
    let pool = catalog.write_pool().await?;
    // 登録情報の読み取り後、新しい描画世代を作る前にデータセットが利用停止される場合がある。
    // 同じSQL文で親の利用停止状態を引き継ぎ、利用停止済みデータセットに
    // 有効な子世代が追加されることを防ぐ。
    sqlx::query("INSERT INTO local_tile_render_profiles (id,dataset_id,build_id,info_json,retired) VALUES (?,?,?,?,? OR COALESCE((SELECT retired FROM local_tile_datasets WHERE id=?),FALSE)) ON CONFLICT(dataset_id,id) DO NOTHING")
        .bind(&value.id).bind(&value.dataset_id).bind(&value.build_id).bind(&value.info_json)
        .bind(value.retired).bind(&value.dataset_id).execute(pool).await?;
    Ok(())
}

pub async fn insert_dataset_with_profile(
    catalog: &TileCatalog,
    dataset: &DatasetRecord,
    profile: &ProfileRecord,
) -> Result<(), sqlx::Error> {
    let pool = catalog.write_pool().await?;
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO local_tile_datasets (id,name,storage_kind,database_path,dataset_key,info_json,created_at,retired) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&dataset.id).bind(&dataset.name).bind(&dataset.storage_kind).bind(&dataset.database_path)
        .bind(&dataset.dataset_key).bind(&dataset.info_json).bind(&dataset.created_at).bind(dataset.retired)
        .execute(&mut *tx).await?;
    sqlx::query("INSERT INTO local_tile_render_profiles (id,dataset_id,build_id,info_json,retired) VALUES (?,?,?,?,?)")
        .bind(&profile.id).bind(&profile.dataset_id).bind(&profile.build_id).bind(&profile.info_json)
        .bind(profile.retired || dataset.retired).execute(&mut *tx).await?;
    tx.commit().await
}

pub async fn list_profiles(
    catalog: &TileCatalog,
    dataset_id: &str,
) -> Result<Vec<ProfileRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as("SELECT * FROM local_tile_render_profiles WHERE dataset_id = ? ORDER BY id")
        .bind(dataset_id)
        .fetch_all(pool)
        .await
}

pub async fn get_profile(
    catalog: &TileCatalog,
    dataset_id: &str,
    id: &str,
) -> Result<Option<ProfileRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as("SELECT * FROM local_tile_render_profiles WHERE dataset_id = ? AND id = ?")
        .bind(dataset_id)
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn retire_dataset(catalog: &TileCatalog, id: &str) -> Result<bool, sqlx::Error> {
    let pool = catalog.write_pool().await?;
    let mut tx = pool.begin().await?;
    let changed = sqlx::query(
        "UPDATE local_tile_datasets SET retired = TRUE WHERE id = ? AND retired = FALSE",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    sqlx::query("UPDATE local_tile_render_profiles SET retired = TRUE WHERE dataset_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(changed)
}

pub async fn insert_job(catalog: &TileCatalog, value: &JobRecord) -> Result<(), sqlx::Error> {
    let pool = catalog.write_pool().await?;
    sqlx::query("INSERT INTO local_tile_jobs (id,kind,dataset_id,state,request_json,progress_json,error,created_at,updated_at,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(&value.id).bind(&value.kind).bind(&value.dataset_id).bind(&value.state)
        .bind(&value.request_json).bind(&value.progress_json).bind(&value.error)
        .bind(&value.created_at).bind(&value.updated_at).bind(&value.owner_id)
        .execute(pool).await?;
    Ok(())
}

pub async fn get_job(catalog: &TileCatalog, id: &str) -> Result<Option<JobRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as("SELECT * FROM local_tile_jobs WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn find_import_request(
    catalog: &TileCatalog,
    request_id: &str,
) -> Result<Option<JobRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as("SELECT * FROM local_tile_jobs WHERE kind = 'import' AND json_extract(request_json, '$.request_id') = ? ORDER BY created_at DESC LIMIT 1")
        .bind(request_id).fetch_optional(pool).await
}

pub async fn find_active_import(
    catalog: &TileCatalog,
    request_json: &str,
) -> Result<Option<JobRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as("SELECT * FROM local_tile_jobs WHERE kind = 'import' AND request_json = ? AND state IN ('queued','running','cancelling') ORDER BY created_at DESC LIMIT 1")
        .bind(request_json).fetch_optional(pool).await
}

pub async fn list_jobs(
    catalog: &TileCatalog,
    limit: i64,
    offset: i64,
) -> Result<Vec<JobRecord>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_as(
        "SELECT * FROM local_tile_jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(limit.clamp(1, 200))
    .bind(offset.max(0))
    .fetch_all(pool)
    .await
}

pub async fn update_job(
    catalog: &TileCatalog,
    id: &str,
    state: &str,
    progress_json: &str,
    error: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let pool = catalog.write_pool().await?;
    // 別プロセスの取消要求を進捗保存で消さず、確定済み結果も途中状態へ戻さない。
    let changed = sqlx::query("UPDATE local_tile_jobs SET state = CASE WHEN state = 'cancelling' AND ? IN ('queued','running') THEN 'cancelling' ELSE ? END, progress_json = ?, error = ?, updated_at = ? WHERE id = ? AND (state IN ('queued','running','cancelling') OR state = ?)")
        .bind(state).bind(state).bind(progress_json).bind(error).bind(chrono::Utc::now().to_rfc3339())
        .bind(id).bind(state).execute(pool).await?.rows_affected() > 0;
    Ok(changed)
}

pub async fn set_job_dataset(
    catalog: &TileCatalog,
    id: &str,
    dataset_id: &str,
) -> Result<(), sqlx::Error> {
    let pool = catalog.write_pool().await?;
    sqlx::query("UPDATE local_tile_jobs SET dataset_id = ?, updated_at = ? WHERE id = ?")
        .bind(dataset_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 正常公開が確定した最終結果を、取消で上書きしない。
pub async fn request_job_cancel(catalog: &TileCatalog, id: &str) -> Result<bool, sqlx::Error> {
    let pool = catalog.control_pool().await?;
    Ok(sqlx::query("UPDATE local_tile_jobs SET state = 'cancelling', updated_at = ? WHERE id = ? AND state IN ('queued','running','cancelling')")
        .bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(pool).await?.rows_affected() > 0)
}

/// 呼出側は、対象の所有者が既にOSのロックを保持していないことを事前に確認する。
pub async fn interrupt_jobs_for_owner(
    catalog: &TileCatalog,
    owner_id: &str,
) -> Result<u64, sqlx::Error> {
    let pool = catalog.write_pool().await?;
    Ok(sqlx::query("UPDATE local_tile_jobs SET state = 'interrupted', updated_at = ? WHERE owner_id = ? AND state IN ('queued','running','cancelling')")
        .bind(chrono::Utc::now().to_rfc3339()).bind(owner_id).execute(pool).await?.rows_affected())
}

pub async fn active_job_owners(catalog: &TileCatalog) -> Result<Vec<String>, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_scalar("SELECT DISTINCT owner_id FROM local_tile_jobs WHERE state IN ('queued','running','cancelling')")
        .fetch_all(pool).await
}

pub async fn update_dataset_location(
    catalog: &TileCatalog,
    id: &str,
    path: &str,
    storage_kind: &str,
    name: &str,
) -> Result<(), sqlx::Error> {
    let pool = catalog.write_pool().await?;
    sqlx::query(
        "UPDATE local_tile_datasets SET database_path = ?, storage_kind = ?, name = ? WHERE id = ?",
    )
    .bind(path)
    .bind(storage_kind)
    .bind(name)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn active_profile(
    catalog: &TileCatalog,
    dataset_id: &str,
    id: &str,
) -> Result<bool, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM local_tile_render_profiles p JOIN local_tile_datasets d ON d.id = p.dataset_id WHERE p.dataset_id = ? AND p.id = ? AND p.retired = 0 AND d.retired = 0)")
        .bind(dataset_id).bind(id).fetch_one(pool).await
}

pub async fn has_active_jobs(catalog: &TileCatalog, dataset_id: &str) -> Result<bool, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM local_tile_jobs WHERE dataset_id = ? AND state IN ('queued','running','cancelling'))")
        .bind(dataset_id).fetch_one(pool).await
}

pub async fn total_jobs(catalog: &TileCatalog) -> Result<i64, sqlx::Error> {
    let pool = catalog.pool().await?;
    sqlx::query_scalar("SELECT COUNT(*) FROM local_tile_jobs")
        .fetch_one(pool)
        .await
}
