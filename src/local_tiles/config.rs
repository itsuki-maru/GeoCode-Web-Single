//! ローカルタイルの保存先と実行上限の設定。

use crate::model::ApplicationInitSetup;
use std::{
    env,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct LocalTileConfig {
    pub catalog_database_path: PathBuf,
    pub dataset_path: PathBuf,
    pub cache_path: PathBuf,
    pub work_path: PathBuf,
    pub workers: usize,
    pub queue_capacity: usize,
    pub max_subscribers: usize,
    pub background_queue_capacity: usize,
    pub job_timeout_seconds: u64,
    pub http_timeout_seconds: u64,
    pub precompute_max_tiles: u64,
}

impl LocalTileConfig {
    pub fn defaults(setup_dir: &Path) -> Self {
        let tiles = setup_dir.join("tiles");
        Self {
            catalog_database_path: tiles.join("catalog.sqlite"),
            dataset_path: tiles.join("datasets"),
            cache_path: tiles.join("png"),
            work_path: tiles.join("work"),
            workers: 2,
            queue_capacity: 128,
            max_subscribers: 256,
            background_queue_capacity: 4,
            job_timeout_seconds: 120,
            http_timeout_seconds: 60,
            precompute_max_tiles: 1_000_000,
        }
    }

    pub fn from_env() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("タイル設定: ホームディレクトリを取得できません。")?;
        let defaults = Self::defaults(&home.join(".geocode-web-single"));
        let read = |name: &str, fallback: String| env::var(name).unwrap_or(fallback);
        Self::parse(
            &read(
                "TILE_CATALOG_DATABASE_PATH",
                defaults
                    .catalog_database_path
                    .to_string_lossy()
                    .into_owned(),
            ),
            &read(
                "TILE_DATASET_PATH",
                defaults.dataset_path.to_string_lossy().into_owned(),
            ),
            &read(
                "TILE_CACHE_PATH",
                defaults.cache_path.to_string_lossy().into_owned(),
            ),
            &read(
                "TILE_WORK_PATH",
                defaults.work_path.to_string_lossy().into_owned(),
            ),
            &read("LOCAL_TILE_WORKERS", defaults.workers.to_string()),
            &read(
                "LOCAL_TILE_QUEUE_CAPACITY",
                defaults.queue_capacity.to_string(),
            ),
            &read(
                "LOCAL_TILE_MAX_SUBSCRIBERS",
                defaults.max_subscribers.to_string(),
            ),
            &read(
                "LOCAL_TILE_BACKGROUND_QUEUE_CAPACITY",
                defaults.background_queue_capacity.to_string(),
            ),
            &read(
                "LOCAL_TILE_JOB_TIMEOUT_SECONDS",
                defaults.job_timeout_seconds.to_string(),
            ),
            &read(
                "LOCAL_TILE_HTTP_TIMEOUT_SECONDS",
                defaults.http_timeout_seconds.to_string(),
            ),
            &read(
                "LOCAL_TILE_PRECOMPUTE_MAX_TILES",
                defaults.precompute_max_tiles.to_string(),
            ),
        )
    }

    pub fn from_setup(setup: &ApplicationInitSetup) -> Result<Self, String> {
        Self::parse(
            &setup.tile_catalog_database_path,
            &setup.tile_dataset_path,
            &setup.tile_cache_path,
            &setup.tile_work_path,
            &setup.local_tile_workers,
            &setup.local_tile_queue_capacity,
            &setup.local_tile_max_subscribers,
            &setup.local_tile_background_queue_capacity,
            &setup.local_tile_job_timeout_seconds,
            &setup.local_tile_http_timeout_seconds,
            &setup.local_tile_precompute_max_tiles,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn parse(
        catalog: &str,
        dataset: &str,
        cache: &str,
        work: &str,
        workers: &str,
        queue: &str,
        subscribers: &str,
        background: &str,
        job_timeout: &str,
        http_timeout: &str,
        max_tiles: &str,
    ) -> Result<Self, String> {
        fn absolute_path(name: &str, value: &str) -> Result<PathBuf, String> {
            let path = PathBuf::from(value);
            if value.trim().is_empty() || value.contains('\0') || !path.is_absolute() {
                return Err(format!(
                    "{name}には空でない絶対パスを指定してください（~の省略表記は使用できません）。"
                ));
            }
            Ok(path)
        }
        fn positive(name: &str, value: &str, maximum: u64) -> Result<u64, String> {
            value
                .parse::<u64>()
                .ok()
                .filter(|n| *n > 0 && *n <= maximum)
                .ok_or_else(|| format!("{name}には1〜{maximum}の整数文字列を指定してください。"))
        }
        let catalog_database_path = absolute_path("tile_catalog_database_path", catalog)?;
        if catalog_database_path.file_name().is_none()
            || catalog_database_path.is_dir()
            || catalog.ends_with(['/', '\\'])
        {
            return Err(
                "tile_catalog_database_pathにはDBファイルの絶対パスを指定してください。".into(),
            );
        }
        let dataset_path = absolute_path("tile_dataset_path", dataset)?;
        let cache_path = absolute_path("tile_cache_path", cache)?;
        let work_path = absolute_path("tile_work_path", work)?;
        let roots = [
            ("tile_dataset_path", normalized_path(&dataset_path)),
            ("tile_cache_path", normalized_path(&cache_path)),
            ("tile_work_path", normalized_path(&work_path)),
        ];
        let catalog_root = normalized_path(&catalog_database_path);
        for (name, root) in &roots {
            if catalog_root.starts_with(root) || root.starts_with(&catalog_root) {
                return Err(format!(
                    "tile_catalog_database_pathと{name}は同じ場所や親子のパスにできません。DBファイルと保存領域を分けてください。"
                ));
            }
        }
        for (index, (name, root)) in roots.iter().enumerate() {
            for (other_name, other_root) in &roots[index + 1..] {
                if root.starts_with(other_root) || other_root.starts_with(root) {
                    return Err(format!(
                        "{name}と{other_name}は同じ場所や親子のディレクトリにできません。別の保存先を指定してください。"
                    ));
                }
            }
        }
        Ok(Self {
            catalog_database_path,
            dataset_path,
            cache_path,
            work_path,
            workers: positive("local_tile_workers", workers, 64)? as usize,
            queue_capacity: positive("local_tile_queue_capacity", queue, 65_536)? as usize,
            max_subscribers: positive("local_tile_max_subscribers", subscribers, 65_536)? as usize,
            background_queue_capacity: positive(
                "local_tile_background_queue_capacity",
                background,
                1024,
            )? as usize,
            job_timeout_seconds: positive("local_tile_job_timeout_seconds", job_timeout, 86_400)?,
            http_timeout_seconds: positive(
                "local_tile_http_timeout_seconds",
                http_timeout,
                86_400,
            )?,
            precompute_max_tiles: positive(
                "local_tile_precompute_max_tiles",
                max_tiles,
                100_000_000,
            )?,
        })
    }
}

/// 未作成のパスも、作成やディスクの接続を要求せず、文字列表現で比較する。
fn normalized_path(path: &Path) -> Vec<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                #[cfg(windows)]
                let key = match prefix.kind() {
                    std::path::Prefix::Disk(drive) | std::path::Prefix::VerbatimDisk(drive) => {
                        format!("{}:", char::from(drive.to_ascii_lowercase()))
                    },
                    std::path::Prefix::UNC(server, share)
                    | std::path::Prefix::VerbatimUNC(server, share) => {
                        format!(
                            "//{}/{}",
                            server.to_string_lossy().to_lowercase(),
                            share.to_string_lossy().to_lowercase()
                        )
                    },
                    _ => prefix.as_os_str().to_string_lossy().to_lowercase(),
                };
                #[cfg(not(windows))]
                let key = prefix.as_os_str().to_string_lossy().into_owned();
                parts.push(key);
            },
            Component::RootDir => parts.push("/".into()),
            Component::ParentDir => {
                if parts.last().is_some_and(|part| part != "/") {
                    parts.pop();
                }
            },
            Component::CurDir => {},
            Component::Normal(name) => {
                let value = name.to_string_lossy();
                parts.push(if cfg!(windows) {
                    value.trim_end_matches(['.', ' ']).to_lowercase()
                } else {
                    value.into_owned()
                });
            },
        }
    }
    parts
}

/// 検証済みのJSON設定を、既存の起動用環境変数へ反映する。
///
/// # 安全性
/// 他のスレッドが環境変数を読む可能性が生じる前の、プロセス起動時に限って呼び出す。
pub unsafe fn apply_env(setup: &ApplicationInitSetup) {
    for (name, value) in [
        (
            "TILE_CATALOG_DATABASE_PATH",
            &setup.tile_catalog_database_path,
        ),
        ("TILE_DATASET_PATH", &setup.tile_dataset_path),
        ("TILE_CACHE_PATH", &setup.tile_cache_path),
        ("TILE_WORK_PATH", &setup.tile_work_path),
        ("LOCAL_TILE_WORKERS", &setup.local_tile_workers),
        (
            "LOCAL_TILE_QUEUE_CAPACITY",
            &setup.local_tile_queue_capacity,
        ),
        (
            "LOCAL_TILE_MAX_SUBSCRIBERS",
            &setup.local_tile_max_subscribers,
        ),
        (
            "LOCAL_TILE_BACKGROUND_QUEUE_CAPACITY",
            &setup.local_tile_background_queue_capacity,
        ),
        (
            "LOCAL_TILE_JOB_TIMEOUT_SECONDS",
            &setup.local_tile_job_timeout_seconds,
        ),
        (
            "LOCAL_TILE_HTTP_TIMEOUT_SECONDS",
            &setup.local_tile_http_timeout_seconds,
        ),
        (
            "LOCAL_TILE_PRECOMPUTE_MAX_TILES",
            &setup.local_tile_precompute_max_tiles,
        ),
    ] {
        unsafe { env::set_var(name, value) };
    }
}
