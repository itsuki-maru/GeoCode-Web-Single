//! タイル実行基盤を共用する、本体管理の取り込み・事前生成ジョブ。

use super::{
    LocalTiles,
    catalog::{self, JobRecord},
    profile,
    runtime::{Failure, Result},
    service::{catalog_failure, execution_diagnostics},
};
use crate::tilegen::{
    cancel::CancellationToken,
    import::{self, ImportOptions, MissingNodes},
    operation::OperationContext,
    tile::{GeoBbox, TilePlan},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::sync::OwnedSemaphorePermit;

fn missing_nodes_default() -> String {
    "error".into()
}
fn features_default() -> String {
    "roads-v1".into()
}
fn is_default_features(value: &str) -> bool {
    value == "roads-v1"
}
fn is_default_error(value: &str) -> bool {
    value == "error"
}
fn elevation_datum_policy_default() -> String {
    "strict".into()
}
fn is_default_elevation_datum_policy(value: &str) -> bool {
    value == "strict"
}
fn contour_data_default() -> String {
    "on".into()
}
fn is_default_contour_data(value: &str) -> bool {
    value == "on"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRequest {
    pub name: String,
    pub input_path: String,
    #[serde(default = "missing_nodes_default")]
    pub missing_nodes: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(
        default = "features_default",
        skip_serializing_if = "is_default_features"
    )]
    pub features: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevation_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landmask_input: Option<String>,
    #[serde(
        default = "missing_nodes_default",
        skip_serializing_if = "is_default_error"
    )]
    pub invalid_areas: String,
    #[serde(
        default = "elevation_datum_policy_default",
        skip_serializing_if = "is_default_elevation_datum_policy"
    )]
    pub elevation_datum_policy: String,
    #[serde(
        default = "contour_data_default",
        skip_serializing_if = "is_default_contour_data"
    )]
    pub contour_data: String,
}

impl Default for ImportRequest {
    fn default() -> Self {
        Self {
            name: String::new(),
            input_path: String::new(),
            missing_nodes: missing_nodes_default(),
            request_id: None,
            features: features_default(),
            elevation_input: None,
            landmask_input: None,
            invalid_areas: missing_nodes_default(),
            elevation_datum_policy: elevation_datum_policy_default(),
            contour_data: contour_data_default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PrecomputeRequest {
    pub dataset_id: String,
    pub bbox: [f64; 4],
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub max_tiles: Option<u64>,
    pub resume_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    dataset_id: String,
    render_id: String,
    bbox: [f64; 4],
    min_zoom: u8,
    max_zoom: u8,
    total_tiles: u64,
    completed_tiles: u64,
    reused_tiles: u64,
    state: String,
    resume_from: Option<String>,
}

struct JobAdmission {
    slot: Option<OwnedSemaphorePermit>,
    waiting: Option<OwnedSemaphorePermit>,
}

impl LocalTiles {
    pub async fn start_import(self: &Arc<Self>, mut request: ImportRequest) -> Result<Value> {
        let _admission = self.admission.lock().await;
        self.ensure_writer().await?;
        if request.name.trim().is_empty()
            || request.name.chars().count() > 120
            || request.name.chars().any(char::is_control)
        {
            return Err(Failure::new(
                400,
                "表示名は制御文字を含まない1〜120文字で指定してください。",
            ));
        }
        let missing_nodes = match request.missing_nodes.as_str() {
            "error" => MissingNodes::Error,
            "skip-way" => MissingNodes::SkipWay,
            _ => {
                return Err(Failure::new(
                    400,
                    "missing_nodesはerrorまたはskip-wayを指定してください。",
                ));
            },
        };
        if !matches!(
            request.features.as_str(),
            "roads-v1" | "standard-v1" | "standard-v2"
        ) {
            return Err(Failure::new(
                400,
                "featuresはroads-v1・standard-v1・standard-v2のいずれかを指定してください。",
            ));
        }
        let contour_data = request
            .contour_data
            .parse::<crate::tilegen::standard::model::ContourData>()
            .map_err(|error| Failure::new(400, error.to_string()))?;
        if request.features != "standard-v2"
            && contour_data != crate::tilegen::standard::model::ContourData::On
        {
            return Err(Failure::new(
                400,
                "contour_data=offにはfeatures=standard-v2が必要です。",
            ));
        }
        if !matches!(request.invalid_areas.as_str(), "error" | "skip-feature") {
            return Err(Failure::new(
                400,
                "invalid_areasはerrorまたはskip-featureを指定してください。",
            ));
        }
        let elevation_datum_policy = request
            .elevation_datum_policy
            .parse::<crate::tilegen::standard::model::ElevationDatumPolicy>()
            .map_err(|error| Failure::new(400, error.to_string()))?;
        if request.features == "roads-v1"
            && (request.elevation_input.is_some()
                || request.landmask_input.is_some()
                || request.invalid_areas != "error"
                || elevation_datum_policy
                    != crate::tilegen::standard::model::ElevationDatumPolicy::Strict)
        {
            return Err(Failure::new(
                400,
                "標高・海陸入力・面除外方針にはstandard-v1またはstandard-v2が必要です。",
            ));
        }
        if elevation_datum_policy != crate::tilegen::standard::model::ElevationDatumPolicy::Strict
            && request.elevation_input.is_none()
        {
            return Err(Failure::new(
                400,
                "測地系の混在許可には標高入力を指定してください。",
            ));
        }
        if let Some(id) = &request.request_id {
            request.request_id = Some(
                uuid::Uuid::parse_str(id)
                    .map_err(|_| Failure::new(400, "request_idはUUIDで指定してください。"))?
                    .to_string(),
            );
        }
        let request_json = serde_json::to_string(&request).map_err(Failure::internal)?;
        if let Some(request_id) = &request.request_id {
            if let Some(existing) = catalog::find_import_request(&self.catalog, request_id)
                .await
                .map_err(catalog_failure)?
            {
                if existing.request_json != request_json {
                    return Err(Failure::new(
                        409,
                        "同じrequest_idに異なる取り込み条件は指定できません。",
                    ));
                }
                return Ok(job_value(existing));
            }
        } else if let Some(existing) = catalog::find_active_import(&self.catalog, &request_json)
            .await
            .map_err(catalog_failure)?
        {
            return Ok(job_value(existing));
        }
        self.ensure_generation_allowed()?;
        if request.features == "standard-v2" {
            crate::tilegen::execution::ensure_osm_generation_allowed()
                .map_err(|message| Failure::new(503, message))?;
        } else if request.features == "standard-v1" {
            crate::tilegen::execution::ensure_standard_generation_allowed()
                .map_err(|message| Failure::new(503, message))?;
        } else {
            crate::tilegen::execution::ensure_generation_allowed()
                .map_err(|message| Failure::new(503, message))?;
        }
        let input = PathBuf::from(&request.input_path);
        if !input.is_absolute() || !tokio::fs::metadata(&input).await.is_ok_and(|m| m.is_file()) {
            return Err(Failure::new(
                400,
                "サーバー上の読み取り可能なPBFファイルを絶対パスで指定してください。",
            ));
        }
        for (label, path) in [
            ("標高", &request.elevation_input),
            ("海陸", &request.landmask_input),
        ] {
            if let Some(path) = path {
                let path = PathBuf::from(path);
                if !path.is_absolute()
                    || !tokio::fs::metadata(&path)
                        .await
                        .is_ok_and(|m| m.is_file() || (label == "標高" && m.is_dir()))
                {
                    return Err(Failure::new(
                        400,
                        format!(
                            "{label}入力には読み取り可能な対応ファイル・ディレクトリの絶対パスを指定してください。"
                        ),
                    ));
                }
            }
        }
        let admission = self.admit_job(self.import_slot.clone())?;
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        let record = new_job(&id, "import", None, &request, &self.owner_id)?;
        catalog::insert_job(&self.catalog, &record)
            .await
            .map_err(catalog_failure)?;
        self.cancellations
            .lock()
            .unwrap()
            .insert(id.clone(), token.clone());
        let app = self.clone();
        let task_id = id.clone();
        let accepted = self.spawn_background_task(async move {
            let operation = app.run_import(
                &task_id,
                request,
                input,
                missing_nodes,
                token.clone(),
                admission,
            );
            let outcome = app
                .monitor_job_cancellation(&task_id, &token, operation)
                .await;
            finish_job(&app, &task_id, outcome, &token).await;
        });
        if !accepted {
            self.cancellations.lock().unwrap().remove(&id);
            catalog::update_job(
                &self.catalog,
                &id,
                "cancelled",
                "{}",
                Some("アプリ終了中のため開始しませんでした。"),
            )
            .await
            .map_err(catalog_failure)?;
            return Err(Failure::unavailable());
        }
        Ok(job_value(record))
    }

    async fn run_import(
        self: &Arc<Self>,
        id: &str,
        request: ImportRequest,
        input: PathBuf,
        missing_nodes: MissingNodes,
        token: CancellationToken,
        admission: JobAdmission,
    ) -> Result<Value> {
        let _slot = self
            .acquire_job_slot(self.import_slot.clone(), &token, admission)
            .await?;
        self.check_job_cancelled(&token)?;
        self.prepare_import_storage().await?;
        let dataset_dir = self.config.dataset_path.join(id);
        tokio::fs::create_dir(&dataset_dir)
            .await
            .map_err(Failure::internal)?;
        let store = dataset_dir.join("data.sqlite");
        let work = self.config.work_path.join(id);
        let options = ImportOptions {
            input,
            store: store.clone(),
            work_dir: work.clone(),
            missing_nodes,
        };
        let context = OperationContext::new(token.clone());
        let standard = if matches!(request.features.as_str(), "standard-v1" | "standard-v2") {
            Some(crate::tilegen::standard::model::StandardImportOptions {
                base: options.clone(),
                elevation_input: request.elevation_input.as_ref().map(PathBuf::from),
                landmask_input: request.landmask_input.as_ref().map(PathBuf::from),
                invalid_areas: if request.invalid_areas == "skip-feature" {
                    crate::tilegen::standard::model::InvalidAreas::SkipFeature
                } else {
                    crate::tilegen::standard::model::InvalidAreas::Error
                },
                elevation_datum_policy: request
                    .elevation_datum_policy
                    .parse()
                    .map_err(|error: anyhow::Error| Failure::new(400, error.to_string()))?,
                feature_set: request
                    .features
                    .parse()
                    .map_err(|error: anyhow::Error| Failure::new(400, error.to_string()))?,
                contour_data: request
                    .contour_data
                    .parse()
                    .map_err(|error: anyhow::Error| Failure::new(400, error.to_string()))?,
            })
        } else {
            None
        };
        let monitor = context.monitor();
        #[cfg(test)]
        let worker_hook = self.import_worker_hook.lock().unwrap().clone();
        #[cfg(test)]
        let worker_token = token.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(hook) = worker_hook {
                hook(&worker_token);
            }
            if let Some(standard) = standard {
                crate::tilegen::standard::import::run_with_context(&standard, &context)
            } else {
                import::run_with_context(&options, &context)
            }
        });
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        let report = loop {
            let worker_result = tokio::select! {
                result = &mut worker => Some(result),
                _ = interval.tick() => None,
            };
            // 終了直前に追加された原因診断も、失敗状態を確定する前に保存する。
            let snapshot = monitor.snapshot();
            let progress = json!({"stage":format!("{:?}", snapshot.stage),
                "completed":snapshot.completed,"total":snapshot.total,
                "elapsed_seconds":snapshot.elapsed.as_secs_f64(),
                "work_path":work,"database_path":store,
                "diagnostics":snapshot.diagnostics.iter().map(|d| json!({"level":format!("{:?}", d.level),"message":d.message})).collect::<Vec<_>>(),
                "dropped_diagnostics":snapshot.dropped_diagnostics});
            let state = if token.is_cancelled() {
                "cancelling"
            } else {
                "running"
            };
            if let Err(error) =
                catalog::update_job(&self.catalog, id, state, &progress.to_string(), None).await
            {
                tracing::warn!(%error, job_id = id, "Could not save tile import progress");
            }
            if let Some(result) = worker_result {
                let result = result.map_err(Failure::internal)?;
                break result.map_err(|error| {
                    tracing::error!(error = %format!("{error:#}"), job_id = id, "Tile import failed");
                    if crate::tilegen::operation::is_deadline_exceeded(&error) {
                        Failure::new(504, "PBF取り込みの期限を超過しました。")
                    } else if crate::tilegen::cancel::is_interrupted(&error) {
                        Failure::new(499, "PBF取り込みを取り消しました。")
                    } else {
                        Failure::new(500, format!("PBF取り込みに失敗しました: {error:#}"))
                    }
                })?;
            }
        };
        // DBの正常公開後に取消要求が届いても、成功状態を維持する。
        let registered = self.register_database(request.name, store, true).await?;
        if let Some(dataset_id) = registered.get("id").and_then(Value::as_str) {
            catalog::set_job_dataset(&self.catalog, id, dataset_id)
                .await
                .map_err(catalog_failure)?;
        }
        Ok(json!({"stage":"Completed","dataset":registered,"report":report}))
    }

    pub async fn plan_precompute(self: &Arc<Self>, request: PrecomputeRequest) -> Result<Value> {
        let (plan, render_id, max_tiles) = self.validate_precompute(&request).await?;
        Ok(
            json!({"dataset_id":request.dataset_id,"render_id":render_id,
            "total_tiles":plan.count(),"zooms":plan.zoom_counts(),
            "tile_count":plan.count(),"allowed":plan.count()<=max_tiles,
            "max_tiles":max_tiles,"exceeds_max_tiles":plan.count()>max_tiles,
            "execution":execution_diagnostics()}),
        )
    }

    /// 枚数確認では既存の描画世代だけを読み、所有権の取得や新しい描画世代の作成を行わない。
    pub async fn plan_precompute_readonly(
        self: &Arc<Self>,
        request: PrecomputeRequest,
    ) -> Result<Value> {
        self.plan_precompute(request).await
    }

    async fn validate_precompute(
        self: &Arc<Self>,
        request: &PrecomputeRequest,
    ) -> Result<(TilePlan, String, u64)> {
        let [west, south, east, north] = request.bbox;
        let bbox = GeoBbox::new(west, south, east, north)
            .map_err(|error| Failure::new(400, error.to_string()))?;
        let plan = TilePlan::new(bbox, request.min_zoom, request.max_zoom)
            .map_err(|error| Failure::new(400, error.to_string()))?;
        let max_tiles = request
            .max_tiles
            .unwrap_or(self.config.precompute_max_tiles);
        if max_tiles == 0 || max_tiles > self.config.precompute_max_tiles {
            return Err(Failure::new(
                400,
                "生成枚数上限は設定された上限以内の正整数で指定してください。",
            ));
        }
        let dataset = catalog::get_dataset(&self.catalog, &request.dataset_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "データセットが見つかりません。"))?;
        if dataset.retired {
            return Err(Failure::new(
                410,
                "このデータセットは利用停止されています。",
            ));
        }
        let handle = self.load_dataset(&dataset).await?;
        let expected = super::service::profile_record(&dataset.id, &handle.dataset)?.id;
        let requested = request.render_id.as_deref().unwrap_or(&expected);
        let profile = catalog::get_profile(&self.catalog, &dataset.id, requested)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| {
                Failure::new(
                    404,
                    "指定した描画世代が未準備です。datasets prepareを実行してください。",
                )
            })?;
        profile::resolve(&profile, &handle.dataset)?;
        Ok((plan, profile.id, max_tiles))
    }

    pub async fn start_precompute(
        self: &Arc<Self>,
        mut request: PrecomputeRequest,
    ) -> Result<Value> {
        self.ensure_generation_allowed()?;
        let _admission = self.admission.lock().await;
        self.ensure_writer().await?;
        if request.resume_job_id.is_some() && request.render_id.is_none() {
            request.render_id = Some(self.saved_resume_render(&request).await?);
        }
        let (plan, render_id, max_tiles) = self.validate_precompute(&request).await?;
        request.render_id = Some(render_id.clone());
        let record = catalog::get_dataset(&self.catalog, &request.dataset_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "データセットが見つかりません。"))?;
        let dataset = self.load_dataset(&record).await?;
        let profile = catalog::get_profile(&self.catalog, &request.dataset_id, &render_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "描画世代が見つかりません。"))?;
        let (_, contract) = profile::resolve(&profile, &dataset.dataset)?;
        self.ensure_contract_generation_allowed(&contract)?;
        if plan.count() > max_tiles {
            return Err(Failure::new(
                400,
                "対象枚数が生成上限を超えています。範囲またはズームを減らしてください。",
            ));
        }
        if let Some(previous_id) = &request.resume_job_id {
            self.verify_resume(&request, &render_id, previous_id)
                .await?;
        }
        let admission = self.admit_job(self.precompute_slot.clone())?;
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        let record = new_job(
            &id,
            "precompute",
            Some(request.dataset_id.clone()),
            &request,
            &self.owner_id,
        )?;
        let manifest = Manifest {
            version: 1,
            dataset_id: request.dataset_id.clone(),
            render_id,
            bbox: request.bbox,
            min_zoom: request.min_zoom,
            max_zoom: request.max_zoom,
            total_tiles: plan.count(),
            completed_tiles: 0,
            reused_tiles: 0,
            state: "queued".into(),
            resume_from: request.resume_job_id.clone(),
        };
        let manifest_path = self.manifest_path(&manifest.dataset_id, &manifest.render_id, &id);
        write_manifest(&manifest_path, &manifest).await?;
        catalog::insert_job(&self.catalog, &record)
            .await
            .map_err(catalog_failure)?;
        self.cancellations
            .lock()
            .unwrap()
            .insert(id.clone(), token.clone());
        let app = self.clone();
        let task_id = id.clone();
        let accepted = self.spawn_background_task(async move {
            let operation = app.run_precompute(
                &task_id,
                plan,
                manifest_path,
                manifest,
                token.clone(),
                admission,
            );
            let outcome = app
                .monitor_job_cancellation(&task_id, &token, operation)
                .await;
            finish_job(&app, &task_id, outcome, &token).await;
        });
        if !accepted {
            self.cancellations.lock().unwrap().remove(&id);
            catalog::update_job(
                &self.catalog,
                &id,
                "cancelled",
                "{}",
                Some("アプリ終了中のため開始しませんでした。"),
            )
            .await
            .map_err(catalog_failure)?;
            return Err(Failure::unavailable());
        }
        Ok(job_value(record))
    }

    async fn verify_resume(
        self: &Arc<Self>,
        request: &PrecomputeRequest,
        render_id: &str,
        previous_id: &str,
    ) -> Result<()> {
        if uuid::Uuid::parse_str(previous_id).is_err() {
            return Err(Failure::new(400, "再開ジョブIDが不正です。"));
        }
        let previous = catalog::get_job(&self.catalog, previous_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "再開対象のジョブが見つかりません。"))?;
        if previous.kind != "precompute"
            || matches!(previous.state.as_str(), "queued" | "running" | "cancelling")
        {
            return Err(Failure::new(
                409,
                "停止済みの事前生成ジョブを指定してください。",
            ));
        }
        let path = self.manifest_path(&request.dataset_id, render_id, previous_id);
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|_| Failure::new(409, "同じデータセット・描画世代の再開記録がありません。"))?;
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|_| Failure::new(409, "再開記録が不正です。"))?;
        if manifest.version != 1
            || manifest.dataset_id != request.dataset_id
            || manifest.render_id != render_id
            || manifest.bbox != request.bbox
            || manifest.min_zoom != request.min_zoom
            || manifest.max_zoom != request.max_zoom
        {
            return Err(Failure::new(
                409,
                "再開時は元のデータセット・描画世代・範囲・ズームを指定してください。",
            ));
        }
        Ok(())
    }

    /// 旧要求JSONに世代がない場合も、保存済みmanifestからだけ再開世代を復元する。
    async fn saved_resume_render(&self, request: &PrecomputeRequest) -> Result<String> {
        let job = request
            .resume_job_id
            .as_deref()
            .ok_or_else(|| Failure::new(400, "再開ジョブIDがありません。"))?;
        if uuid::Uuid::parse_str(job).is_err() || !super::service::valid_id(&request.dataset_id) {
            return Err(Failure::new(400, "再開識別子が不正です。"));
        }
        let previous = catalog::get_job(&self.catalog, job)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "再開対象のジョブが見つかりません。"))?;
        if previous.kind != "precompute"
            || previous.dataset_id.as_deref() != Some(&request.dataset_id)
            || matches!(previous.state.as_str(), "queued" | "running" | "cancelling")
        {
            return Err(Failure::new(
                409,
                "同じデータセットの停止済み事前生成ジョブを指定してください。",
            ));
        }
        let stored: Value =
            serde_json::from_str(&previous.request_json).map_err(Failure::internal)?;
        let progress: Value =
            serde_json::from_str(&previous.progress_json).map_err(Failure::internal)?;
        let remembered = stored["render_id"]
            .as_str()
            .or_else(|| progress["render_id"].as_str());
        if let Some(render) = remembered {
            if super::service::valid_id(render) {
                return Ok(render.into());
            }
            return Err(Failure::new(409, "保存された描画世代が不正です。"));
        }
        let mut found = None;
        for profile in catalog::list_profiles(&self.catalog, &request.dataset_id)
            .await
            .map_err(catalog_failure)?
        {
            if !super::service::valid_id(&profile.id) {
                continue;
            }
            let path = self.manifest_path(&request.dataset_id, &profile.id, job);
            let Ok(bytes) = tokio::fs::read(path).await else {
                continue;
            };
            let manifest: Manifest = serde_json::from_slice(&bytes)
                .map_err(|_| Failure::new(409, "再開記録が不正です。"))?;
            if manifest.dataset_id == request.dataset_id && manifest.render_id == profile.id {
                if found.is_some() {
                    return Err(Failure::new(409, "再開世代を一意に確認できません。"));
                }
                found = Some(profile.id);
            }
        }
        found.ok_or_else(|| Failure::new(409, "保存済みの描画世代・再開記録がありません。"))
    }

    fn manifest_path(&self, dataset: &str, profile: &str, job: &str) -> PathBuf {
        self.config
            .cache_path
            .join(dataset)
            .join(profile)
            .join("_jobs")
            .join(job)
            .join("manifest.json")
    }

    async fn run_precompute(
        self: &Arc<Self>,
        id: &str,
        plan: TilePlan,
        path: PathBuf,
        mut manifest: Manifest,
        token: CancellationToken,
        admission: JobAdmission,
    ) -> Result<Value> {
        let mut last_flush = Instant::now() - Duration::from_secs(1);
        let result: Result<Value> = async {
            let _slot = self.acquire_job_slot(self.precompute_slot.clone(), &token, admission).await?;
            manifest.state = "running".into();
            for tile in plan.iter() {
                self.check_job_cancelled(&token)?;
                let result = tokio::select! {
                    result = self.render(&manifest.dataset_id, &manifest.render_id, tile, true) => result,
                    _ = wait_for_cancel(token.clone()) => Err(Failure::new(499, "事前生成を取り消しました。")),
                };
                let (_, hit) = result?;
                manifest.completed_tiles += 1;
                manifest.reused_tiles += u64::from(hit);
                if last_flush.elapsed() >= Duration::from_secs(1) {
                    write_manifest(&path, &manifest).await?;
                    catalog::update_job(&self.catalog, id, "running", &manifest_progress(&manifest).to_string(), None)
                        .await.map_err(catalog_failure)?;
                    last_flush = Instant::now();
                }
            }
            Ok(manifest_progress(&manifest))
        }.await;
        // 最後の公開が完了した場合は、その後の取消要求より成功を優先する。
        manifest.state = match &result {
            Ok(_) => "succeeded",
            Err(error) if error.status == 499 => "cancelled",
            Err(error) if error.status == 504 => "deadline_exceeded",
            Err(_) => "failed",
        }
        .into();
        if let Err(error) = write_manifest(&path, &manifest).await {
            if result.is_ok() {
                return Err(error);
            }
            tracing::warn!(message = %error.message, job_id = id, "Could not save final precompute manifest");
        }
        result
    }

    pub async fn cancel_job(self: &Arc<Self>, id: &str) -> Result<Value> {
        let mut record = catalog::get_job(&self.catalog, id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "ジョブが見つかりません。"))?;
        if matches!(record.state.as_str(), "queued" | "running" | "cancelling") {
            let token = self
                .cancellations
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| {
                    Failure::new(409, "このプロセスが所有する実行中ジョブではありません。")
                })?;
            token.cancel();
            catalog::request_job_cancel(&self.catalog, id)
                .await
                .map_err(catalog_failure)?;
            record = catalog::get_job(&self.catalog, id)
                .await
                .map_err(catalog_failure)?
                .ok_or_else(|| Failure::new(404, "ジョブが見つかりません。"))?;
        }
        Ok(job_value(record))
    }

    pub async fn list_jobs(self: &Arc<Self>, limit: i64, offset: i64) -> Result<Vec<Value>> {
        Ok(catalog::list_jobs(&self.catalog, limit, offset)
            .await
            .map_err(catalog_failure)?
            .into_iter()
            .map(job_value)
            .collect())
    }

    pub async fn get_job_json(self: &Arc<Self>, id: &str) -> Result<Value> {
        Ok(job_value(
            catalog::get_job(&self.catalog, id)
                .await
                .map_err(catalog_failure)?
                .ok_or_else(|| Failure::new(404, "ジョブが見つかりません。"))?,
        ))
    }

    /// 外部CLIの取消要求を、実処理を所有するプロセスの取消トークンへ反映する。
    async fn monitor_job_cancellation<F>(
        &self,
        id: &str,
        token: &CancellationToken,
        operation: F,
    ) -> Result<Value>
    where
        F: std::future::Future<Output = Result<Value>>,
    {
        // 管理DBの照会が待機しても、実処理のDB更新や完了回収を継続する。
        let cancellation_monitor = async {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if self.closing.load(Ordering::Acquire) {
                    token.cancel();
                }
                match catalog::get_job(&self.catalog, id).await {
                    Ok(Some(record))
                        if record.owner_id == self.owner_id && record.state == "cancelling" =>
                    {
                        token.cancel()
                    },
                    Ok(_) => {},
                    Err(error) => {
                        tracing::warn!(%error, job_id = id, "取消要求を確認できませんでした。")
                    },
                }
            }
        };
        tokio::pin!(operation);
        tokio::select! {
            biased;
            result = &mut operation => result,
            _ = cancellation_monitor => unreachable!("取消監視は実処理の完了まで継続します"),
        }
    }

    fn spawn_background_task(
        &self,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return false;
        }
        tasks.retain(|task| !task.is_finished());
        tasks.push(tokio::spawn(future));
        true
    }

    fn check_job_cancelled(&self, token: &CancellationToken) -> Result<()> {
        if token.is_cancelled() || self.closing.load(Ordering::Acquire) {
            return Err(Failure::new(499, "ジョブを取り消しました。"));
        }
        Ok(())
    }

    fn admit_job(&self, slot: Arc<tokio::sync::Semaphore>) -> Result<JobAdmission> {
        if self.closing.load(Ordering::Acquire) {
            return Err(Failure::unavailable());
        }
        if let Ok(slot) = slot.try_acquire_owned() {
            return Ok(JobAdmission {
                slot: Some(slot),
                waiting: None,
            });
        }
        let waiting = self
            .background_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Failure::new(503, "取り込み・事前生成の待機上限に達しました。"))?;
        Ok(JobAdmission {
            slot: None,
            waiting: Some(waiting),
        })
    }

    async fn acquire_job_slot(
        &self,
        slot: Arc<tokio::sync::Semaphore>,
        token: &CancellationToken,
        mut admission: JobAdmission,
    ) -> Result<OwnedSemaphorePermit> {
        self.check_job_cancelled(token)?;
        if let Some(slot) = admission.slot.take() {
            return Ok(slot);
        }
        let result = tokio::select! {
            permit = slot.acquire_owned() => permit.map_err(|_| Failure::unavailable()),
            _ = wait_for_cancel(token.clone()) => Err(Failure::new(499, "待機中のジョブを取り消しました。")),
        };
        drop(admission.waiting.take());
        result
    }
}

async fn wait_for_cancel(token: CancellationToken) {
    while !token.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn new_job<T: Serialize>(
    id: &str,
    kind: &str,
    dataset_id: Option<String>,
    request: &T,
    owner_id: &str,
) -> Result<JobRecord> {
    let now = chrono::Utc::now().to_rfc3339();
    Ok(JobRecord {
        id: id.into(),
        kind: kind.into(),
        dataset_id,
        state: "queued".into(),
        request_json: serde_json::to_string(request).map_err(Failure::internal)?,
        progress_json: "{}".into(),
        error: None,
        created_at: now.clone(),
        updated_at: now,
        owner_id: owner_id.into(),
    })
}

fn job_value(record: JobRecord) -> Value {
    json!({"id":record.id,"kind":record.kind,"dataset_id":record.dataset_id,"state":record.state,
        "request":serde_json::from_str::<Value>(&record.request_json).unwrap_or(Value::Null),
        "progress":serde_json::from_str::<Value>(&record.progress_json).unwrap_or(Value::Null),
        "error":record.error,"created_at":record.created_at,"updated_at":record.updated_at})
}

fn manifest_progress(manifest: &Manifest) -> Value {
    json!({"stage":"Exporting","render_id":manifest.render_id,"completed":manifest.completed_tiles,
        "total":manifest.total_tiles,"reused_tiles":manifest.reused_tiles,
        "rendered_tiles":manifest.completed_tiles-manifest.reused_tiles})
}

async fn write_manifest(path: &Path, manifest: &Manifest) -> Result<()> {
    let path = path.to_path_buf();
    let bytes = serde_json::to_vec_pretty(manifest).map_err(Failure::internal)?;
    tokio::task::spawn_blocking(move || -> Result<()> {
        let parent = path.parent().ok_or_else(Failure::unavailable)?;
        std::fs::create_dir_all(parent).map_err(Failure::internal)?;
        // canonicalizeでWindowsの長いパス用接頭辞を付け、データセット・描画世代・ジョブの
        // IDが深く入れ子になる場合も、tempfileによるOSの置換処理へ正しく渡す。
        let parent = parent.canonicalize().map_err(Failure::internal)?;
        let destination = parent.join(path.file_name().ok_or_else(Failure::unavailable)?);
        let mut temporary = tempfile::NamedTempFile::new_in(&parent).map_err(Failure::internal)?;
        temporary.write_all(&bytes).map_err(Failure::internal)?;
        temporary.as_file().sync_all().map_err(Failure::internal)?;
        temporary.persist(destination).map_err(Failure::internal)?;
        Ok(())
    })
    .await
    .map_err(Failure::internal)?
}

async fn finish_job(
    app: &LocalTiles,
    id: &str,
    outcome: Result<Value>,
    _token: &CancellationToken,
) {
    let (state, progress, error) = match outcome {
        Ok(progress) => ("succeeded", progress, None),
        Err(error) => {
            let state = if error.status == 499 {
                "cancelled"
            } else if error.status == 504 {
                "deadline_exceeded"
            } else {
                "failed"
            };
            let progress = catalog::get_job(&app.catalog, id)
                .await
                .ok()
                .flatten()
                .and_then(|record| serde_json::from_str(&record.progress_json).ok())
                .unwrap_or_else(|| json!({}));
            (state, progress, Some(error.message))
        },
    };
    if let Err(error) = catalog::update_job(
        &app.catalog,
        id,
        state,
        &progress.to_string(),
        error.as_deref(),
    )
    .await
    {
        tracing::error!(%error, job_id = id, "Could not save final local tile job status");
    }
    app.cancellations.lock().unwrap().remove(id);
}

#[cfg(test)]
mod cancellation_tests {
    use super::super::{catalog::TileCatalog, config::LocalTileConfig};
    use super::*;

    #[tokio::test]
    async fn 取消監視の管理db待機中も実処理の完了を回収する() {
        let root = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let app = LocalTiles::new(LocalTileConfig::defaults(root.path()), pool.clone());
        let catalog_pool = catalog::test_pool(&app.catalog).await.unwrap().clone();
        // 管理DBの全接続を保持し、取消監視の照会だけを確実に待機させる。
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(catalog_pool.acquire().await.unwrap());
        }
        let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();
        let token = CancellationToken::new();
        let operation = async {
            completed_rx.await.unwrap();
            Ok(json!({"completed":true}))
        };
        let mut monitored = Box::pin(app.monitor_job_cancellation("waiting", &token, operation));
        assert!(futures_util::poll!(monitored.as_mut()).is_pending());
        // 初回の監視tickを進め、照会が接続取得待ちに入ってから実処理を完了する。
        // DBの準備は実時間で済ませ、検証部分だけ仮想時計を使う。
        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(101)).await;
        assert!(futures_util::poll!(monitored.as_mut()).is_pending());
        completed_tx.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_millis(200), monitored.as_mut()).await;
        tokio::time::resume();
        drop(monitored);
        drop(held);
        app.shutdown().await;
        pool.close().await;
        assert!(result.is_ok(), "取消監視のDB待機が実処理の完了を止めました");
        assert_eq!(result.unwrap().unwrap(), json!({"completed":true}));
    }

    #[test]
    fn 追加項目が欠けた道路要求は旧形式の文字列へそのまま戻る() {
        let old = r#"{"name":"旧道路","input_path":"C:/maps/japan.pbf","missing_nodes":"error","request_id":null}"#;
        let request: ImportRequest = serde_json::from_str(old).unwrap();
        assert_eq!(request.features, "roads-v1");
        assert_eq!(request.invalid_areas, "error");
        assert_eq!(serde_json::to_string(&request).unwrap(), old);
        let mut standard = request.clone();
        standard.features = "standard-v1".into();
        standard.elevation_input = Some("D:/dem".into());
        assert_ne!(serde_json::to_string(&standard).unwrap(), old);
    }

    #[tokio::test]
    async fn 旧要求の識別子再送と識別子なし実行中要求を二重起動しない() {
        let root = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let app = LocalTiles::new(LocalTileConfig::defaults(root.path()), pool.clone());
        app.ensure_writer().await.unwrap();
        for (index, request_id) in [None, Some(uuid::Uuid::new_v4().to_string())]
            .into_iter()
            .enumerate()
        {
            let request = ImportRequest {
                name: format!("旧要求{index}"),
                input_path: root
                    .path()
                    .join(format!("未存在{index}.pbf"))
                    .to_string_lossy()
                    .into_owned(),
                request_id,
                ..Default::default()
            };
            let mut record = new_job(
                &uuid::Uuid::new_v4().to_string(),
                "import",
                None,
                &request,
                &app.owner_id,
            )
            .unwrap();
            record.state = if index == 0 { "running" } else { "succeeded" }.into();
            let source = record.request_json.clone();
            catalog::insert_job(&app.catalog, &record).await.unwrap();
            let replay = app.start_import(request).await.unwrap();
            assert_eq!(replay["id"], record.id);
            assert_eq!(
                catalog::get_job(&app.catalog, &record.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .request_json,
                source
            );
        }
        assert_eq!(catalog::total_jobs(&app.catalog).await.unwrap(), 2);
        app.shutdown().await;
        pool.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn external_cancel_reaches_native_worker_and_shutdown_waits_for_actual_completion() {
        let root = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let config = LocalTileConfig::defaults(root.path());
        let app = LocalTiles::new(config.clone(), pool.clone());
        let input = root.path().join("input.osm.pbf");
        crate::tilegen::test_support::Fixture::sample().write(&input);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (observed_tx, observed_rx) = tokio::sync::oneshot::channel();
        let entered_tx = std::sync::Mutex::new(Some(entered_tx));
        let observed_tx = std::sync::Mutex::new(Some(observed_tx));
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = std::sync::Mutex::new(release_rx);
        *app.import_worker_hook.lock().unwrap() = Some(Arc::new(move |token| {
            if let Some(entered) = entered_tx.lock().unwrap().take() {
                let _ = entered.send(());
            }
            // 同期ワーカーを止め、取消と回収の順序を実時間に依存せず検査する。
            loop {
                if token.is_cancelled() {
                    if let Some(observed) = observed_tx.lock().unwrap().take() {
                        let _ = observed.send(());
                    }
                }
                match release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_millis(5))
                {
                    Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {},
                }
            }
        }));
        let accepted = app
            .start_import(ImportRequest {
                name: "実処理取消".into(),
                input_path: input.to_string_lossy().into_owned(),
                missing_nodes: "error".into(),
                request_id: None,
                ..Default::default()
            })
            .await
            .unwrap();
        let id = accepted["id"].as_str().unwrap();
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let control = TileCatalog::control(config.catalog_database_path.clone(), pool.clone());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if catalog::get_job(&control, id).await.unwrap().unwrap().state == "running" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        catalog::request_job_cancel(&control, id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), observed_rx)
            .await
            .unwrap()
            .unwrap();
        let mut shutdown = {
            let app = app.clone();
            tokio::spawn(async move { app.shutdown().await })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut shutdown)
                .await
                .is_err(),
            "native workerの解放前にshutdownが完了してはいけません"
        );
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), shutdown)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            catalog::get_job(&control, id).await.unwrap().unwrap().state,
            "cancelled"
        );
        assert!(catalog::list_datasets(&control).await.unwrap().is_empty());
        assert!(input.exists());
        control.close().await;
        pool.close().await;
    }
}
