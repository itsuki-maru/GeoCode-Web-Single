use super::{
    close_pool, load_configuration, message, open_existing_pool,
    process::{self, Paths},
    protocol::{self, Operation, Receipt, Request},
};
use crate::local_tiles::{LocalTiles, catalog, jobs::PrecomputeRequest};
use fs2::FileExt;
use serde_json::Value;
use std::sync::Arc;
use std::{path::Path, time::Duration};

/// mainの早期分岐から呼び、Tauri・CONFIG・HTTPルーターを構築しない。
pub fn run_worker(request_path: &Path) -> i32 {
    let result = (|| {
        let runtime = tokio::runtime::Runtime::new().map_err(message)?;
        runtime.block_on(execute_request(request_path))
    })();
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("タイル生成プロセス: {error}");
            1
        },
    }
}

async fn execute_request(path: &Path) -> Result<i32, String> {
    protocol::absolute(path)?;
    let request: Request = protocol::read_json(path)?;
    if request.version != 1
        || uuid::Uuid::parse_str(&request.id)
            .map(|id| id.to_string())
            .ok()
            .as_deref()
            != Some(request.id.as_str())
    {
        return Err("未対応または不正な管理受付です。".into());
    }
    protocol::absolute(&request.config_path)?;
    protocol::absolute(&request.executable)?;
    let executable = std::env::current_exe()
        .map_err(message)?
        .canonicalize()
        .map_err(message)?;
    if executable != request.executable
        || protocol::file_hash(&executable)? != request.executable_sha256
    {
        return Err("受付時と生成用exeが異なります。管理画面から新しく実行してください。".into());
    }
    if protocol::file_hash(&request.config_path)? != request.config_sha256 {
        return Err(
            "受付後に設定JSONが変更されました。管理画面から条件を確認してください。".into(),
        );
    }
    let (settings, config) = load_configuration(&request.config_path)?;
    let root = process::request_root(&config, &request.config_path, false)?;
    let paths = Paths::new(&root, &request.id);
    if paths.request.canonicalize().map_err(message)? != path.canonicalize().map_err(message)? {
        return Err("設定された管理領域内の受付ファイルだけを実行できます。".into());
    }
    let operation = Operation::parse(
        request.operation.name(),
        serde_json::to_value(&request.operation).map_err(message)?["payload"].clone(),
        &request.id,
    )?;
    let lock = process::lock_file(&paths.lock)?;
    // GUIの受付保存と競合しても待つ。重複workerは先行workerの終了後に終端結果を見る。
    lock.lock_exclusive().map_err(message)?;
    let mut receipt: Receipt = protocol::read_json(&paths.receipt)?;
    if receipt.id != request.id || receipt.action != operation.name() {
        return Err("受付と結果の識別が一致しません。".into());
    }
    if !process::active(&receipt.state) {
        return Ok(if receipt.state == "succeeded" { 0 } else { 1 });
    }
    if receipt.request_sha256.is_empty() || receipt.request_sha256 != protocol::file_hash(path)? {
        receipt.update("failed");
        receipt.error = Some("受付後に処理条件ファイルが変更されました。".into());
        protocol::atomic_json(&paths.receipt, &receipt)?;
        return Ok(1);
    }
    if receipt
        .worker_pid
        .is_some_and(|pid| pid != std::process::id())
    {
        receipt.update("interrupted");
        receipt.error =
            Some("先行した生成プロセスは終了しています。同じ受付では再実行しません。".into());
        protocol::atomic_json(&paths.receipt, &receipt)?;
        return Ok(1);
    }
    receipt.worker_pid = Some(std::process::id());
    receipt.update("running");
    protocol::atomic_json(&paths.receipt, &receipt)?;
    let result = if let Operation::Rebind(rebinding) = &operation {
        let config_path = request.config_path.clone();
        let rebinding = rebinding.clone();
        let receipt_path = paths.receipt.clone();
        let mut progress_receipt = receipt.clone();
        tokio::task::spawn_blocking(move || {
            let mut last = std::time::Instant::now() - Duration::from_secs(1);
            crate::local_tiles::catalog::rebind::execute(
                &config_path,
                rebinding,
                &crate::tilegen::cancel::CancellationToken::new(),
                &mut |stage, completed| {
                    if last.elapsed() >= Duration::from_millis(250) {
                        progress_receipt.result = Some(
                            serde_json::json!({"progress":{"stage":stage,"completed":completed}}),
                        );
                        protocol::atomic_json(&receipt_path, &progress_receipt)?;
                        last = std::time::Instant::now();
                    }
                    Ok(())
                },
            )
        })
        .await
        .map_err(message)?
    } else {
        async {
            let pool = open_existing_pool(
                &settings.database_url,
                matches!(operation, Operation::Background(_)),
            )
            .await?;
            let service = LocalTiles::new(config, pool.clone());
            let result = async {
                service.ensure_writer().await.map_err(failure)?;
                execute_operation(&service, &operation, &request.id, &paths, &mut receipt).await
            }
            .await;
            // 子process自身だけが処理回収と排他解放を所有する。画面の閉鎖とは独立。
            service.shutdown().await;
            close_pool(&pool).await;
            result
        }
        .await
    };
    let code = match result {
        Ok(value) => {
            let state = value
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("succeeded");
            receipt.update(state);
            receipt.error = value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned);
            receipt.result = Some(value);
            if receipt.state == "succeeded" {
                0
            } else if receipt.state == "cancelled" {
                130
            } else {
                1
            }
        },
        Err(error) => {
            receipt.update("failed");
            receipt.error = Some(error);
            1
        },
    };
    protocol::atomic_json(&paths.receipt, &receipt)?;
    drop(lock);
    Ok(code)
}

async fn execute_operation(
    service: &Arc<LocalTiles>,
    operation: &Operation,
    id: &str,
    paths: &Paths,
    receipt: &mut Receipt,
) -> Result<Value, String> {
    let accepted = match operation {
        Operation::RouteBuild(build) => {
            service.prepare_import_storage().await.map_err(failure)?;
            let config = service.config.clone();
            let paths = paths.clone();
            let build = build.clone();
            let receipt = receipt.clone();
            return tokio::task::spawn_blocking(move || {
                super::routing::build(&config, &build, &paths, receipt)
            })
            .await
            .map_err(message)?;
        },
        Operation::Import(request) => Some(
            service
                .start_import(request.clone())
                .await
                .map_err(failure)?,
        ),
        Operation::Precompute(request) => Some(
            service
                .start_precompute_with_request_id(request.clone(), id)
                .await
                .map_err(failure)?,
        ),
        Operation::Resume(request) => {
            let previous = catalog::get_job(&service.catalog, &request.job)
                .await
                .map_err(message)?
                .ok_or("再開元ジョブが見つかりません。")?;
            if previous.kind != "precompute"
                || matches!(previous.state.as_str(), "queued" | "running" | "cancelling")
            {
                return Err("停止済みの事前生成ジョブだけを再開できます。".into());
            }
            let mut options: PrecomputeRequest =
                serde_json::from_str(&previous.request_json).map_err(message)?;
            options.resume_job_id = Some(request.job.clone());
            Some(
                service
                    .start_precompute_with_request_id(options, id)
                    .await
                    .map_err(failure)?,
            )
        },
        Operation::Register(request) => {
            return service
                .register_database(request.name.clone(), request.database.clone(), false)
                .await
                .map_err(failure);
        },
        Operation::Prepare(request) => {
            return service
                .prepare_dataset_with_spec(&request.dataset, request.spec)
                .await
                .map_err(failure);
        },
        Operation::Background(request) => {
            return service
                .add_background_with_options(
                    &request.dataset,
                    request.render.as_deref(),
                    request.name.as_deref(),
                )
                .await
                .map_err(failure);
        },
        Operation::Rebind(_) => return Err("移設処理は専用の実行経路が必要です。".into()),
    };
    let accepted = accepted.ok_or("処理受付を確認できません。")?;
    let job = accepted["id"]
        .as_str()
        .ok_or("受付ジョブIDがありません。")?;
    receipt.job_id = Some(job.into());
    receipt.result = Some(accepted.clone());
    receipt.update("running");
    protocol::atomic_json(&paths.receipt, receipt)?;
    loop {
        let value = service.get_job_json(job).await.map_err(failure)?;
        if !matches!(
            value["state"].as_str(),
            Some("queued" | "running" | "cancelling")
        ) {
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn failure(error: crate::local_tiles::runtime::Failure) -> String {
    error.message
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reject_relative_or_invalid_worker_manifests_without_starting() {
        assert_eq!(run_worker(Path::new("relative.request.json")), 1);
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("bad.json");
        std::fs::write(&path, json!({"version":999}).to_string()).unwrap();
        assert_eq!(run_worker(&path), 1);
    }
}
