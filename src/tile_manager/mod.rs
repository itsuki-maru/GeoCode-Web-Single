//! HTTPサーバーを使わないローカル地図管理。地図・道路網の生成は独立workerが行う。

pub mod desktop;
mod process;
mod protocol;
mod routing;
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
    sync::{Arc, Mutex},
    time::Duration,
};

pub struct Manager {
    config_path: PathBuf,
    executable: PathBuf,
    route_search: Mutex<Option<(uuid::Uuid, CancellationToken)>>,
    route_search_slot: Arc<tokio::sync::Mutex<()>>,
}

impl Manager {
    pub fn new(config_path: PathBuf, executable: PathBuf) -> Self {
        Self {
            config_path,
            executable,
            route_search: Mutex::new(None),
            route_search_slot: Arc::default(),
        }
    }

    pub async fn snapshot(&self) -> Result<Value, String> {
        if !self.config_path.is_file() {
            return Ok(json!({"configured":false,"config_path":self.config_path,
                "datasets":[],"jobs":[],"requests":[],"routing":{"datasets":[],"jobs":[]},"owner_available":true}));
        }
        if crate::local_tiles::catalog::rebind::relocation::pending_path(&self.config_path)
            .try_exists()
            .map_err(message)?
        {
            return Ok(json!({"configured":true,"config_path":self.config_path,
                "error":"保存先の変更が中断しています。「データの保存先」で再開してください。","relocation_pending":true,
                "datasets":[],"jobs":[],"requests":[],"routing":{"datasets":[],"jobs":[]},"owner_available":false}));
        }
        let (settings, config) = match load_configuration(&self.config_path) {
            Ok(value) => value,
            Err(error) => {
                return Ok(json!({"configured":false,"config_path":self.config_path,
                    "error":error,"datasets":[],"jobs":[],"requests":[],"routing":{"datasets":[],"jobs":[]},"owner_available":false}));
            },
        };
        let route_snapshot = |requests: &[Value], jobs: &mut Value| {
            let mut routing = routing::snapshot(&config, requests, jobs);
            routing["http"] = json!(settings.local_routing_http);
            routing["allowed_origins"] = json!(settings.osrm_allowed_origins);
            routing
        };
        let pool = match open_existing_pool(&settings.database_url, false).await {
            Ok(pool) => pool,
            Err(error) => {
                let requests =
                    process::list_receipts(&config, &self.config_path).unwrap_or_default();
                let mut jobs = json!([]);
                let routing = route_snapshot(&requests, &mut jobs);
                return Ok(json!({"configured":true,"config_path":self.config_path,
                "config":config_value(&config),"error":error,"datasets":[],"jobs":jobs,
                "requests":requests,"routing":routing,"owner_available":false}));
            },
        };
        let result: Result<Value,String> = async {
            let status = execute_reader(Command::Status, &config, &pool).await?;
            let datasets = execute_reader(Command::DatasetsList, &config, &pool).await?;
            let mut jobs = execute_reader(Command::JobsList { limit:100, offset:0 }, &config, &pool).await?;
            let mut requests = process::list_receipts(&config, &self.config_path)?;
            overlay_interrupted_jobs(&mut jobs,&mut requests,status["owner_available"]==true);
            let routing = route_snapshot(&requests, &mut jobs);
            Ok(json!({"configured":true,"config_path":self.config_path,"config":config_value(&config),
                "owner_available":status["owner_available"],"status":status,
                "datasets":datasets,"jobs":jobs,"requests":requests,"routing":routing}))
        }.await;
        close_pool(&pool).await;
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let requests =
                    process::list_receipts(&config, &self.config_path).unwrap_or_default();
                let mut jobs = json!([]);
                let routing = route_snapshot(&requests, &mut jobs);
                Ok(
                    json!({"configured":true,"config_path":self.config_path,"config":config_value(&config),"error":error,
                    "datasets":[],"jobs":jobs,"requests":requests,"routing":routing,"owner_available":false}),
                )
            },
        }
    }

    pub async fn query(&self, action: &str, payload: Value) -> Result<Value, String> {
        if action == "route_search" {
            let query = decode::<routing::Search>(payload)?;
            let (_, config) = load_configuration(&self.config_path)?;
            let id = query.search_id.unwrap_or_else(uuid::Uuid::new_v4);
            let token = CancellationToken::new();
            {
                let mut active = self.route_search.lock().unwrap();
                if active.as_ref().is_some_and(|(current, _)| *current == id) {
                    return Err("同じ検索を実行中です。".into());
                }
                if let Some((_, previous)) = active.replace((id, token.clone())) {
                    previous.cancel();
                }
            }
            let slot = self.route_search_slot.clone().lock_owned().await;
            let result = tokio::task::spawn_blocking(move || {
                let _slot = slot;
                routing::search(&config, query, token)
            })
            .await;
            self.route_search
                .lock()
                .unwrap()
                .take_if(|(current, _)| *current == id);
            return result
                .map_err(message)?
                .map_err(|error| format!("{error:#}"));
        }
        if action == "route_search_cancel" {
            let request = decode::<SearchCancel>(payload)?;
            let active = self.route_search.lock().unwrap();
            let cancel = active.as_ref().filter(|(id, _)| *id == request.search_id);
            if let Some((_, token)) = cancel {
                token.cancel();
            }
            return Ok(json!({"cancel_requested":cancel.is_some()}));
        }
        if action == "rebind_inspect" || action == "rebind_plan" {
            use crate::local_tiles::catalog::rebind;
            let request = if action == "rebind_inspect" {
                let _: EmptyQuery = decode(payload)?;
                rebind::Request::Inspect
            } else {
                let options: RebindPlanQuery = decode(payload)?;
                rebind::Request::Plan {
                    source_database: options.source_database,
                    proof: options.proof,
                }
            };
            return rebind::run(self.config_path.clone(), request, CancellationToken::new()).await;
        }
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
        if let Command::Cancel { job } | Command::JobShow { job } = &command {
            if let Some(result) =
                routing::job_query(&config, &self.config_path, job, action == "cancel")?
            {
                return Ok(result);
            }
        }
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
        if matches!(&operation, Operation::Rebind(_)) {
            if let Some(receipt) =
                process::existing_request(&config, &self.config_path, &id, &operation)?
            {
                return serde_json::to_value(receipt).map_err(message);
            }
            crate::local_tiles::catalog::rebind::run(
                self.config_path.clone(),
                crate::local_tiles::catalog::rebind::Request::Inspect,
                CancellationToken::new(),
            )
            .await?;
            return serde_json::to_value(process::submit(
                &config,
                &self.config_path,
                &self.executable,
                id,
                operation,
            )?)
            .map_err(message);
        }
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
struct EmptyQuery {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RebindPlanQuery {
    source_database: Option<PathBuf>,
    proof: Option<PathBuf>,
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
struct SearchCancel {
    search_id: uuid::Uuid,
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
        return Err(format!(
            "本体DBを開けません。ドライブを接続するか、「データの保存先」で本体DBを選んでください。 {}",
            options.get_filename().display()
        ));
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
    async fn cancel_only_the_search_selected_by_the_window() {
        let manager = Manager::new(PathBuf::from("unused"), PathBuf::from("unused"));
        let current = uuid::Uuid::new_v4();
        let token = CancellationToken::new();
        *manager.route_search.lock().unwrap() = Some((current, token.clone()));
        let old = json!({"search_id":uuid::Uuid::new_v4()});
        assert_eq!(
            manager.query("route_search_cancel", old).await.unwrap()["cancel_requested"],
            false
        );
        assert!(!token.is_cancelled());
        assert_eq!(
            manager
                .query("route_search_cancel", json!({"search_id":current}))
                .await
                .unwrap()["cancel_requested"],
            true
        );
        assert!(token.is_cancelled());
    }
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
