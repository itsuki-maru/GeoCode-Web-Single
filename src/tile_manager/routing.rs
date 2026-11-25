//! 経路の専用保存領域。完成DBとメタデータをディレクトリごと一度に公開する。
use super::{
    message,
    process::{self, Paths},
    protocol::{self, Receipt, RouteBuild},
};
use crate::{
    local_routing::{
        self, Coord, TravelMode,
        catalog::{GRAPH, Generation, MANIFEST, canonical_id, generation, generations, store},
    },
    local_tiles::config::LocalTileConfig,
    tilegen::cancel::CancellationToken,
};
use anyhow::{Context, Result, anyhow, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Search {
    #[serde(default)]
    pub search_id: Option<Uuid>,
    dataset: String,
    mode: TravelMode,
    start: Coord,
    end: Coord,
}

pub(super) fn snapshot(
    config: &LocalTileConfig,
    requests: &[Value],
    tile_jobs: &mut Value,
) -> Value {
    let found = store(&config.dataset_path, false)
        .and_then(|root| root.map_or_else(|| Ok(Vec::new()), |root| generations(&root)));
    let (published, error) = match found {
        Ok(generations) => (generations, None),
        Err(error) => (Vec::new(), Some(format!("{error:#}"))),
    };
    let jobs: Vec<_> = requests
        .iter()
        .filter(|r| r["action"] == "route_build")
        .map(job)
        .collect();
    if let Some(all) = tile_jobs.as_array_mut() {
        all.extend(jobs.iter().cloned());
        all.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
    }
    let mut names = HashSet::new();
    let latest: Vec<_> = published
        .into_iter()
        .filter(|item| names.insert(item.name.clone()))
        .collect();
    json!({"datasets": latest, "jobs":jobs, "error":error})
}

// 世代公開後、終了記録の確定前に停止したworkerを、照会・再送の両方で正しく扱う。
pub(super) fn recover_publication(config: &LocalTileConfig, receipt: &mut Receipt) {
    let Some(item) = store(&config.dataset_path, false)
        .ok()
        .flatten()
        .and_then(|root| generation(&root, &receipt.id).ok())
    else {
        return;
    };
    receipt.state = "succeeded".into();
    receipt.updated_at = item.created_at;
    receipt.error = None;
    let result = receipt.result.get_or_insert_with(|| json!({}));
    result["dataset_id"] = json!(item.id);
    result["state"] = json!("succeeded");
    result["progress"] = json!({"stage":"Completed","completed":item.info["edge_count"]});
}

fn job(receipt: &Value) -> Value {
    json!({"id":receipt["id"], "kind":"route_build", "state":receipt["state"],
        "request":receipt["result"]["request"], "dataset_id":receipt["result"]["dataset_id"],
        "progress":receipt["result"]["progress"], "error":receipt["error"],
        "created_at":receipt["created_at"], "updated_at":receipt["updated_at"]})
}

pub(super) fn job_query(
    config: &LocalTileConfig,
    config_path: &Path,
    id: &str,
    cancel: bool,
) -> Result<Option<Value>, String> {
    if !canonical_id(id) {
        return Ok(None);
    }
    let paths = Paths::new(&process::request_root(config, config_path, false)?, id);
    if !paths.receipt.try_exists().map_err(message)? {
        return Ok(None);
    }
    let receipt = process::read_receipt(config, &paths)?;
    if receipt.action != "route_build" {
        return Ok(None);
    }
    if receipt.id != id || receipt.job_id.as_deref() != Some(id) {
        return Err("経路構築ジョブの識別子が一致しません。".into());
    }
    let mut result = job(&serde_json::to_value(&receipt).map_err(message)?);
    if cancel && process::active(&receipt.state) {
        // プロセス間で共有する取消通知。受付JSONの更新はworkerだけが所有する。
        match fs::File::create_new(&paths.cancel) {
            Ok(_) => {},
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
            Err(error) => return Err(message(error)),
        }
        result["state"] = json!("cancelling");
    }
    Ok(Some(result))
}

pub(super) fn search(
    config: &LocalTileConfig,
    query: Search,
    token: CancellationToken,
) -> Result<Value> {
    token.check()?;
    let root = store(&config.dataset_path, false)?.context("利用できる経路データがありません。")?;
    let selected = generation(&root, &query.dataset)?;
    let result = local_routing::search_with_check(
        &root.join(selected.id).join(GRAPH),
        query.mode,
        query.start,
        query.end,
        || token.check(),
    )?;
    Ok(serde_json::to_value(result)?)
}

#[derive(Debug, thiserror::Error)]
#[error("経路データの構築を取り消しました。")]
struct Cancelled;

fn check_cancel(path: &Path) -> Result<()> {
    if path.try_exists()? {
        return Err(Cancelled.into());
    }
    Ok(())
}

pub(super) fn build(
    config: &LocalTileConfig,
    request: &RouteBuild,
    paths: &Paths,
    mut receipt: Receipt,
) -> Result<Value, String> {
    let result = build_generation(config, request, paths, &mut receipt);
    match result {
        Ok(generation) => Ok(
            json!({"state":"succeeded", "dataset_id":generation.id, "request":request,
            "progress":{"stage":"Completed","completed":generation.info["edge_count"]}}),
        ),
        Err(error) if error.is::<Cancelled>() => Ok(json!({"state":"cancelled","request":request,
            "progress":receipt.result.as_ref().map(|v| &v["progress"])})),
        Err(error) => {
            eprintln!("経路データの構築に失敗しました: {error:#}");
            Ok(
                json!({"state":"failed","error":format!("{error:#}"),"request":request,
                "progress":receipt.result.as_ref().map(|v| &v["progress"])}),
            )
        },
    }
}

fn build_generation(
    config: &LocalTileConfig,
    request: &RouteBuild,
    paths: &Paths,
    receipt: &mut Receipt,
) -> Result<Generation> {
    check_cancel(&paths.cancel)?;
    let root =
        store(&config.dataset_path, true)?.context("経路データの保存先を準備できません。")?;
    // prepare_import_storageがデータセット保存先を排他中。前回異常終了した作業用フォルダーを回収する。
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let filename = entry.file_name();
        if let Some(id) = filename
            .to_str()
            .and_then(|name| name.strip_prefix(".building-"))
            .filter(|id| canonical_id(id))
        {
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            if meta.is_dir()
                && !protocol::is_link(&meta)
                && protocol::read_json::<String>(&path.join("owner.json"))
                    .ok()
                    .as_deref()
                    == Some(id)
            {
                fs::remove_dir_all(path)?;
            }
        }
    }
    let sequence = generations(&root)?
        .first()
        .map_or(0, |g| g.sequence)
        .checked_add(1)
        .context("経路データの世代上限に達しました。")?;
    let staging = tempfile::Builder::new()
        .prefix(&format!(".building-{}", receipt.id))
        .rand_bytes(0)
        .tempdir_in(&root)?;
    protocol::atomic_json(&staging.path().join("owner.json"), &receipt.id)
        .map_err(anyhow::Error::msg)?;
    let path = staging.path().join(GRAPH);
    let progress_error: RefCell<Option<String>> = RefCell::new(None);
    let mut last_check = Instant::now();
    let mut last_write = Instant::now() - Duration::from_secs(1);
    let mut last_stage = String::new();
    let started = Instant::now();
    let mut stage_started = started;
    let mut estimate =
        crate::local_tiles::progress::Estimate::routing(fs::metadata(&request.input_path)?.len());
    let info = local_routing::build_with_progress(
        &request.input_path,
        &path,
        || {
            if let Some(error) = progress_error.take() {
                return Err(anyhow!(error));
            }
            if last_check.elapsed() >= Duration::from_millis(100) {
                check_cancel(&paths.cancel)?;
                last_check = Instant::now();
            }
            Ok(())
        },
        |stage, completed, total, scan_bytes| {
            if stage != last_stage || last_write.elapsed() >= Duration::from_millis(350) {
                if stage != last_stage {
                    stage_started = Instant::now();
                    eprintln!("{stage}: {completed}");
                }
                receipt.update("running");
                let elapsed = started.elapsed().as_secs_f64();
                let forecast = estimate.sample(
                    stage,
                    completed,
                    total,
                    scan_bytes,
                    elapsed,
                    stage_started.elapsed().as_secs_f64(),
                );
                receipt.result = Some(
                    json!({"request":request, "progress":{"stage":stage,"completed":completed,"total":total,
                        "scan_bytes":scan_bytes,"elapsed_seconds":elapsed,"sampled_at":receipt.updated_at,"estimate":forecast}}),
                );
                if let Err(error) = protocol::atomic_json(&paths.receipt, receipt) {
                    progress_error.replace(Some(error));
                }
                last_stage.clear();
                last_stage.push_str(stage);
                last_write = Instant::now();
            }
        },
    )?;
    if let Some(error) = progress_error.into_inner() {
        return Err(anyhow!(error));
    }
    let manifest = Generation {
        id: receipt.id.clone(),
        name: request.name.clone(),
        sequence,
        created_at: chrono::Utc::now().to_rfc3339(),
        info: serde_json::to_value(info)?,
    };
    fs::File::options()
        .read(true)
        .write(true)
        .open(&path)?
        .sync_all()?;
    protocol::atomic_json(&staging.path().join(MANIFEST), &manifest).map_err(anyhow::Error::msg)?;
    check_cancel(&paths.cancel)?;
    let destination = root.join(&manifest.id);
    ensure!(
        !destination.try_exists()?,
        "同じ世代の経路データが既に存在します。"
    );
    fs::rename(staging.path(), destination)?;
    let _ = staging.keep();
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_cancellation_survives_reconnect_and_prevents_publication() {
        let temp = tempfile::tempdir().unwrap();
        let config = LocalTileConfig::defaults(temp.path());
        let settings = temp.path().join("settings.json");
        fs::write(&settings, "{}").unwrap();
        let root = process::request_root(&config, &settings, true).unwrap();
        let id = Uuid::new_v4().to_string();
        let paths = Paths::new(&root, &id);
        let owner = process::lock_file(&paths.lock).unwrap();
        fs2::FileExt::lock_exclusive(&owner).unwrap();
        let mut receipt = Receipt::new(id.clone(), "route_build", paths.log.clone());
        receipt.job_id = Some(id.clone());
        let request = RouteBuild {
            name: "地域".into(),
            input_path: temp.path().join("unused.osm.pbf"),
        };
        receipt.result = Some(json!({"request":request}));
        protocol::atomic_json(&paths.receipt, &receipt).unwrap();

        for _ in 0..2 {
            assert_eq!(
                job_query(&config, &settings, &id, true).unwrap().unwrap()["state"],
                "cancelling"
            );
        }
        assert_eq!(
            job_query(&config, &settings, &id, false).unwrap().unwrap()["state"],
            "cancelling"
        );
        assert_eq!(
            build(&config, &request, &paths, receipt).unwrap()["state"],
            "cancelled"
        );
        assert!(store(&config.dataset_path, false).unwrap().is_none());
    }

    #[test]
    fn committed_generation_recovers_interrupted_receipt_and_unpublished_siblings_remain_hidden() {
        let temp = tempfile::tempdir().unwrap();
        let config = LocalTileConfig::defaults(temp.path());
        let root = store(&config.dataset_path, true).unwrap().unwrap();
        let id = Uuid::new_v4().to_string();
        let incomplete_id = Uuid::new_v4().to_string();
        let published = root.join(&id);
        fs::create_dir(&published).unwrap();
        fs::write(published.join(GRAPH), b"fixture").unwrap();
        fs::create_dir(root.join(format!(".building-{incomplete_id}"))).unwrap();
        protocol::atomic_json(
            &published.join(MANIFEST),
            &Generation {
                id: id.clone(),
                name: "地域".into(),
                sequence: 1,
                created_at: "2026-01-01T00:00:00Z".into(),
                info: json!({}),
            },
        )
        .unwrap();
        let receipt = |id: &str| {
            let paths = Paths::new(temp.path(), id);
            let mut receipt = Receipt::new(id.into(), "route_build", paths.log.clone());
            receipt.update("interrupted");
            receipt.job_id = Some(id.into());
            protocol::atomic_json(&paths.receipt, &receipt).unwrap();
            serde_json::to_value(process::read_receipt(&config, &paths).unwrap()).unwrap()
        };
        let receipts = [receipt(&id), receipt(&incomplete_id)];
        let mut jobs = json!([]);
        let status = snapshot(&config, &receipts, &mut jobs);
        assert_eq!(status["datasets"].as_array().unwrap().len(), 1);
        assert_eq!(receipts[0]["state"], "succeeded");
        assert_eq!(receipts[1]["state"], "interrupted");
        assert!(
            jobs.as_array()
                .unwrap()
                .iter()
                .any(|job| job["dataset_id"] == id && job["state"] == "succeeded")
        );
    }
}
