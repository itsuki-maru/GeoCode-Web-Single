//! HTTPサーバーを使わないローカル地図管理。画面は照会し、書込は独立workerだけが行う。

pub mod desktop;
mod process;
mod protocol;
pub mod setup;
mod worker;

pub use worker::run_worker;

use crate::{
    init::read_env_json_readonly,
    local_tiles::{
        cli::{self, Command, Invocation},
        config::LocalTileConfig,
    },
    model::ApplicationInitSetup,
    tilegen::cancel::CancellationToken,
};
use protocol::{Operation, Receipt};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{
    ConnectOptions, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

pub struct Manager {
    config_path: PathBuf,
    executable: PathBuf,
}

impl Manager {
    pub fn new(config_path: PathBuf, executable: PathBuf) -> Self {
        Self {
            config_path,
            executable,
        }
    }

    pub async fn snapshot(&self) -> Result<Value, String> {
        if !self.config_path.is_file() {
            return Ok(json!({"configured":false,"config_path":self.config_path,
                "datasets":[],"jobs":[],"requests":[],"owner_available":true}));
        }
        let (_, config) = match load_configuration(&self.config_path) {
            Ok(value) => value,
            Err(error) => {
                return Ok(json!({"configured":false,"config_path":self.config_path,
                "error":error,"datasets":[],"jobs":[],"requests":[],"owner_available":false}));
            },
        };
        let settings = read_env_json_readonly(&self.config_path).map_err(message)?;
        let pool = match open_existing_pool(&settings.database_url, false).await {
            Ok(pool) => pool,
            Err(error) => {
                return Ok(json!({"configured":true,"config_path":self.config_path,
                "config":config_value(&config),"error":error,"datasets":[],"jobs":[],
                "requests":process::list_receipts(&config, &self.config_path)?,"owner_available":false}));
            },
        };
        let result = async {
            let status = execute_reader(Command::Status, &config, &pool).await?;
            let datasets = execute_reader(Command::DatasetsList, &config, &pool).await?;
            let mut jobs = execute_reader(Command::JobsList { limit:100, offset:0 }, &config, &pool).await?;
            let mut requests = process::list_receipts(&config, &self.config_path)?;
            overlay_interrupted_jobs(&mut jobs,&mut requests,status["owner_available"]==true);
            Ok(json!({"configured":true,"config_path":self.config_path,"config":config_value(&config),
                "owner_available":status["owner_available"],"status":status,
                "datasets":datasets,"jobs":jobs,"requests":requests}))
        }.await;
        close_pool(&pool).await;
        result
    }

    pub async fn query(&self, action: &str, payload: Value) -> Result<Value, String> {
        if action == "log" {
            let request: LogQuery = decode(payload)?;
            let (_, config) = load_configuration(&self.config_path)?;
            return process::read_log(&config, &self.config_path, &request.request_id);
        }
        let command = match action {
            "plan" => Command::Plan(decode(payload)?),
            "show" => Command::DatasetShow {
                dataset: decode::<DatasetQuery>(payload)?.dataset,
            },
            "url" => {
                let value: DatasetQuery = decode(payload)?;
                Command::Url {
                    dataset: value.dataset,
                    render: value.render,
                    base_url: None,
                }
            },
            "cancel" => Command::Cancel {
                job: decode::<JobQuery>(payload)?.job,
            },
            "job" => Command::JobShow {
                job: decode::<JobQuery>(payload)?.job,
            },
            _ => return Err("未対応の照会操作です。".into()),
        };
        let (settings, config) = load_configuration(&self.config_path)?;
        let pool = open_existing_pool(&settings.database_url, false).await?;
        let result = execute_reader(command, &config, &pool).await;
        close_pool(&pool).await;
        result
    }

    pub async fn submit(
        &self,
        action: &str,
        payload: Value,
        request_id: String,
    ) -> Result<Value, String> {
        let id = uuid::Uuid::parse_str(&request_id)
            .map_err(|_| "受付IDはUUIDで指定してください。")?
            .to_string();
        let operation = Operation::parse(action, payload, &id)?;
        let (settings, config) = load_configuration(&self.config_path)?;
        let pool = open_existing_pool(&settings.database_url, false).await?;
        let status = execute_reader(Command::Status, &config, &pool).await;
        close_pool(&pool).await;
        let status = status?;
        // 同じ受付IDの照会は排他中も可能。新規起動だけを止める。
        if let Some(receipt) =
            process::existing_request(&config, &self.config_path, &id, &operation)?
        {
            return serde_json::to_value(receipt).map_err(message);
        }
        if status["owner_available"] == false {
            return Err("別のアプリ・サーバー・CLIがローカル地図を処理中です。実処理の終了後に開始してください。".into());
        }
        let receipt: Receipt =
            process::submit(&config, &self.config_path, &self.executable, id, operation)?;
        serde_json::to_value(receipt).map_err(message)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DatasetQuery {
    dataset: String,
    #[serde(default)]
    render: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobQuery {
    job: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LogQuery {
    request_id: String,
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("入力条件が不正です: {error}"))
}

pub(crate) fn load_configuration(
    path: &Path,
) -> Result<(ApplicationInitSetup, LocalTileConfig), String> {
    if !path.is_absolute() {
        return Err("設定JSONは絶対パスで指定してください。".into());
    }
    let settings = read_env_json_readonly(&path.to_path_buf()).map_err(message)?;
    let config = LocalTileConfig::from_setup(&settings)?;
    Ok((settings, config))
}

pub(crate) async fn open_existing_pool(
    database_url: &str,
    writable: bool,
) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::from_str(database_url).map_err(message)?;
    let memory = options
        .clone()
        .filename("tile-manager-mode-probe")
        .to_url_lossy()
        .query_pairs()
        .any(|(key, value)| key == "mode" && value == "memory");
    if memory || !options.get_filename().is_file() {
        return Err(
            "セットアップ済みの本体DBが見つかりません。管理画面で初期設定を完了してください。"
                .into(),
        );
    }
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            options
                .read_only(!writable)
                .create_if_missing(false)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .map_err(message)?;
    if let Err(error) = crate::db::pool::validate_existing_schema(&pool).await {
        close_pool(&pool).await;
        return Err(error.to_string());
    }
    Ok(pool)
}

pub(crate) async fn close_pool(pool: &SqlitePool) {
    loop {
        pool.close().await;
        if pool.size() == 0 {
            break;
        }
    }
}

async fn execute_reader(
    command: Command,
    config: &LocalTileConfig,
    pool: &SqlitePool,
) -> Result<Value, String> {
    let invocation = Invocation {
        command,
        json: true,
        config_path: None,
    };
    if invocation.is_writer() {
        return Err("画面内では書込操作を実行しません。".into());
    }
    cli::execute_with_cancellation(
        &invocation,
        config.clone(),
        Some(pool.clone()),
        CancellationToken::new(),
    )
    .await
    .map(|output| output.value)
    .map_err(message)
}

fn config_value(config: &LocalTileConfig) -> Value {
    json!({"catalog_database_path":config.catalog_database_path,"dataset_path":config.dataset_path,
        "cache_path":config.cache_path,"work_path":config.work_path,"workers":config.workers,
        "precompute_max_tiles":config.precompute_max_tiles})
}
pub(crate) fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

// 表示上の中断だけを補う。管理DBの復旧・書換は次のworkerが所有権を得てから行う。
fn overlay_interrupted_jobs(jobs: &mut Value, requests: &mut [Value], owner_available: bool) {
    let Some(jobs) = jobs.as_array_mut() else {
        return;
    };
    for receipt in requests {
        if receipt["job_id"].is_null() {
            let id = receipt["id"].as_str().unwrap_or("");
            if let Some(job) = jobs
                .iter()
                .find(|job| job["id"] == id || job["request"]["request_id"] == id)
            {
                receipt["job_id"] = job["id"].clone();
            }
        }
        if owner_available && receipt["state"] == "interrupted" {
            if let Some(job) = jobs.iter_mut().find(|job| job["id"] == receipt["job_id"]) {
                if matches!(
                    job["state"].as_str(),
                    Some("queued" | "running" | "cancelling")
                ) {
                    job["catalog_state"] = job["state"].clone();
                    job["state"] = json!("interrupted");
                    job["error"] = receipt["error"].clone();
                    job["orphaned"] = json!(true);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn snapshot_without_setup_does_not_create_config_or_catalog() {
        let root = tempfile::tempdir().unwrap();
        let settings = root.path().join("missing.json");
        let manager = Manager::new(settings.clone(), root.path().join("app.exe"));
        let value = manager.snapshot().await.unwrap();
        assert_eq!(value["configured"], false);
        assert!(!settings.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
    #[tokio::test]
    async fn reject_arbitrary_cli_and_write_actions_from_gui_queries() {
        let manager = Manager::new(PathBuf::from("missing.json"), PathBuf::from("app.exe"));
        assert!(
            manager
                .query("import", json!({}))
                .await
                .unwrap_err()
                .contains("未対応")
        );
        assert!(
            manager
                .submit("cleanup", json!({}), uuid::Uuid::new_v4().to_string())
                .await
                .unwrap_err()
                .contains("未対応")
        );
    }
    #[test]
    fn overlay_interrupted_state_only_for_known_requests_without_owners() {
        let mut jobs = json!([
            {"id":"import-job","state":"running","request":{"request_id":"request-a"}},
            {"id":"request-b","state":"cancelling","request":{}},
            {"id":"other-job","state":"running","request":{}}
        ]);
        let mut requests = vec![
            json!({"id":"request-a","state":"interrupted","job_id":null,"error":"終了"}),
            json!({"id":"request-b","state":"interrupted","job_id":null,"error":"終了"}),
        ];
        overlay_interrupted_jobs(&mut jobs, &mut requests, true);
        assert_eq!(requests[0]["job_id"], "import-job");
        assert_eq!(jobs[0]["state"], "interrupted");
        assert_eq!(jobs[0]["catalog_state"], "running");
        assert_eq!(jobs[1]["state"], "interrupted");
        assert_eq!(jobs[2]["state"], "running");
    }
}
