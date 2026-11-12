use super::{
    catalog::{self, DatasetRecord, ProfileRecord, TileCatalog},
    config::LocalTileConfig,
    profile,
    runtime::{self, DatasetHandle, Engine, Failure, Result},
};
use crate::tilegen::{
    cancel::CancellationToken,
    dataset::Dataset,
    identity::{self, RenderContract},
    render_spec::RenderSpec,
    tile::TileId,
};
use fs2::FileExt;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;

pub struct LocalTiles {
    pub config: LocalTileConfig,
    pub(crate) app_pool: SqlitePool,
    pub catalog: Arc<TileCatalog>,
    pub owner_id: String,
    pub closing: AtomicBool,
    pub cancellations: Mutex<HashMap<String, CancellationToken>>,
    pub background_slots: Arc<Semaphore>,
    pub import_slot: Arc<Semaphore>,
    pub precompute_slot: Arc<Semaphore>,
    pub tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub admission: tokio::sync::Mutex<()>,
    engine: Mutex<Option<Engine>>,
    owner_lock: Mutex<Option<File>>,
    dataset_lock: Mutex<Option<File>>,
    loaded: Mutex<HashMap<String, Arc<DatasetHandle>>>,
    retired_ids: Mutex<HashSet<String>>,
    activation: Arc<tokio::sync::Mutex<()>>,
    shutdown_gate: tokio::sync::Mutex<()>,
    cache_scan: Mutex<Option<(u64, bool, String)>>,
    #[cfg(test)]
    activation_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    fail_retirement_fence_release: AtomicBool,
    #[cfg(test)]
    pub(super) import_worker_hook: Mutex<Option<Arc<dyn Fn(&CancellationToken) + Send + Sync>>>,
    #[cfg(test)]
    generation_error: Mutex<Option<String>>,
}

impl LocalTiles {
    pub fn new(config: LocalTileConfig, pool: SqlitePool) -> Arc<Self> {
        let catalog = Arc::new(
            TileCatalog::new(config.catalog_database_path.clone(), pool.clone())
                .with_storage_roots([
                    config.dataset_path.clone(),
                    config.cache_path.clone(),
                    config.work_path.clone(),
                ]),
        );
        Self::with_catalog(config, pool, catalog)
    }

    /// CLIの照会では所有権の取得、スキーマ作成、描画世代の追加を行わない。
    pub fn reader(config: LocalTileConfig, pool: SqlitePool) -> Arc<Self> {
        let catalog = Arc::new(
            TileCatalog::read_only(config.catalog_database_path.clone(), pool.clone())
                .with_storage_roots([
                    config.dataset_path.clone(),
                    config.cache_path.clone(),
                    config.work_path.clone(),
                ]),
        );
        Self::with_catalog(config, pool, catalog)
    }

    fn with_catalog(
        config: LocalTileConfig,
        pool: SqlitePool,
        catalog: Arc<TileCatalog>,
    ) -> Arc<Self> {
        let background_capacity = config.background_queue_capacity;
        Arc::new(Self {
            config,
            app_pool: pool,
            catalog,
            owner_id: uuid::Uuid::new_v4().simple().to_string(),
            closing: AtomicBool::new(false),
            cancellations: Mutex::new(HashMap::new()),
            background_slots: Arc::new(Semaphore::new(background_capacity)),
            import_slot: Arc::new(Semaphore::new(1)),
            precompute_slot: Arc::new(Semaphore::new(1)),
            tasks: Mutex::new(Vec::new()),
            engine: Mutex::new(None),
            owner_lock: Mutex::new(None),
            dataset_lock: Mutex::new(None),
            loaded: Mutex::new(HashMap::new()),
            activation: Arc::new(tokio::sync::Mutex::new(())),
            shutdown_gate: tokio::sync::Mutex::new(()),
            admission: tokio::sync::Mutex::new(()),
            cache_scan: Mutex::new(None),
            retired_ids: Mutex::new(HashSet::new()),
            #[cfg(test)]
            activation_hook: Mutex::new(None),
            #[cfg(test)]
            fail_retirement_fence_release: AtomicBool::new(false),
            #[cfg(test)]
            import_worker_hook: Mutex::new(None),
            #[cfg(test)]
            generation_error: Mutex::new(None),
        })
    }
    /// 要求の受付前に独立した管理DBへ接続する。既存データや中断ジョブがある場合は、
    /// 公開・復旧の準備を完了するために所有権が必要となる。
    pub async fn initialize(self: &Arc<Self>) -> Result<()> {
        self.catalog.initialize().await.map_err(catalog_failure)?;
        if !catalog::list_datasets(&self.catalog)
            .await
            .map_err(catalog_failure)?
            .is_empty()
            || !catalog::active_job_owners(&self.catalog)
                .await
                .map_err(catalog_failure)?
                .is_empty()
        {
            self.ensure_writer().await?;
        }
        Ok(())
    }
    /// 呼出側は参照の保存が完了するまで、本体DBの書込排他を保持する。
    pub async fn validate_background_url(&self, url: &str) -> Result<()> {
        // ブラウザーは相対URLを要求する前に、符号化されたドットも含むドット区間を正規化する。
        // このような別名で、正規のローカルタイルURLを保存する検証処理や
        // 参照検索を迂回できないようにする。
        if url.starts_with('/') && !url.starts_with("/local-tiles/") {
            let normalized =
                reqwest::Url::parse("https://geocode.invalid/").and_then(|base| base.join(url));
            if normalized.is_ok_and(|normalized| normalized.path().starts_with("/local-tiles/")) {
                return Err(Failure::new(
                    400,
                    "ローカル地図の登録済みタイルURLを省略せず指定してください。",
                ));
            }
        }
        let Some(path) = url.strip_prefix("/local-tiles/") else {
            return Ok(());
        };
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() != 5
            || !valid_id(parts[0])
            || !valid_id(parts[1])
            || parts[2..] != ["{z}", "{x}", "{y}.png"]
        {
            return Err(Failure::new(
                400,
                "ローカル地図の登録済みタイルURLを指定してください。",
            ));
        }
        if !catalog::active_profile(&self.catalog, parts[0], parts[1])
            .await
            .map_err(|error| {
                tracing::warn!(%error, "Local tile catalog unavailable during reference validation");
                Failure::unavailable()
            })?
        {
            return Err(Failure::new(
                400,
                "利用可能なローカル地図の世代を指定してください。",
            ));
        }
        Ok(())
    }
    pub async fn ensure_writer(self: &Arc<Self>) -> Result<()> {
        if !self.catalog.is_writer() {
            return Err(Failure::new(
                503,
                "照会用の処理からローカル地図を変更できません。",
            ));
        }
        if self.closing.load(Ordering::Acquire) {
            return Err(Failure::unavailable());
        }
        let activation = self.activation.clone().lock_owned().await;
        if self.closing.load(Ordering::Acquire) {
            return Err(Failure::unavailable());
        }
        if self.engine.lock().unwrap().is_some() {
            return Ok(());
        }
        self.catalog.initialize().await.map_err(catalog_failure)?;
        let service = self.clone();
        let _activation = tokio::task::spawn_blocking(move || {
            let lock_path = service
                .catalog
                .owner_lock_path()
                .map_err(Failure::internal)?;
            if let Some(parent) = lock_path.parent() {
                fs::create_dir_all(parent).map_err(Failure::internal)?;
            }
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(lock_path)
                .map_err(Failure::internal)?;
            lock.try_lock_exclusive().map_err(|_| {
                Failure::new(
                    503,
                    "別のアプリプロセスがローカル地図の生成を管理しています。",
                )
            })?;
            let engine = Engine::start(&service.config)?;
            #[cfg(test)]
            if let Some(hook) = service.activation_hook.lock().unwrap().as_ref() {
                hook();
            }
            let mut slot = service.engine.lock().unwrap();
            if service.closing.load(Ordering::Acquire) {
                return Err(Failure::unavailable());
            }
            *service.owner_lock.lock().unwrap() = Some(lock);
            *slot = Some(engine);
            Ok(activation)
        })
        .await
        .map_err(Failure::internal)??;
        // 管理DB全体のOSロックを取得したことで、各ジョブの以前の所有者が不在だと確認できる。
        for owner in catalog::active_job_owners(&self.catalog)
            .await
            .map_err(catalog_failure)?
        {
            if owner != self.owner_id {
                catalog::interrupt_jobs_for_owner(&self.catalog, &owner)
                    .await
                    .map_err(catalog_failure)?;
            }
        }
        Ok(())
    }
    pub async fn prepare_import_storage(self: &Arc<Self>) -> Result<()> {
        self.ensure_writer().await?;
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut lock = service.dataset_lock.lock().unwrap();
            if lock.is_none() {
                *lock = Some(runtime::lock_directory(&service.config.dataset_path)?);
            }
            Ok(())
        })
        .await
        .map_err(Failure::internal)?
    }
    pub async fn status(self: &Arc<Self>) -> Value {
        let generation_error = self
            .ensure_generation_allowed()
            .err()
            .map(|failure| failure.message);
        let activation_error = if generation_error.is_none() {
            self.ensure_writer()
                .await
                .err()
                .map(|failure| failure.message)
        } else {
            None
        };
        let (queued, running, generated, owner) = {
            let engine = self.engine.lock().unwrap();
            let (q, r, g) = engine.as_ref().map_or((0, 0, 0), Engine::counts);
            (q, r, g, engine.is_some())
        };
        let available =
            owner && generation_error.is_none() && !self.closing.load(Ordering::Acquire);
        let message = if let Some(reason) = generation_error {
            format!("{reason} 保存済みPNGの配信と照会は利用できます。")
        } else if let Some(reason) = activation_error {
            reason
        } else if self.closing.load(Ordering::Acquire) {
            "アプリケーションの終了中です。".into()
        } else {
            "生成機能を利用できます。".into()
        };
        let scan = self.cache_scan.lock().unwrap().clone();
        json!({"paths":{"datasets":self.config.dataset_path,"cache":self.config.cache_path,"work":self.config.work_path},"catalog_database_path":self.config.catalog_database_path,
            "owner":owner,"available":available,"message":message,"execution":execution_diagnostics(),
            "workers":self.config.workers,"queue_capacity":self.config.queue_capacity,"queued":queued,"running":running,"generated":generated,
            "cache_bytes":scan.as_ref().map(|s|s.0),"cache_bytes_complete":scan.as_ref().map(|s|s.1),"cache_scan_at":scan.as_ref().map(|s|&s.2)})
    }
    pub async fn scan_storage(self: &Arc<Self>) -> Result<Value> {
        let root = self.config.cache_path.clone();
        let service = self.clone();
        let (bytes, complete) = tokio::task::spawn_blocking(move || {
            let start = std::time::Instant::now();
            let mut pending = vec![root];
            let mut bytes = 0_u64;
            let mut visited = 0;
            while let Some(path) = pending.pop() {
                let entries = match fs::read_dir(&path) {
                    Ok(entries) => entries,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(Failure::internal(e)),
                };
                for entry in entries {
                    if service.closing.load(Ordering::Acquire)
                        || visited >= 100_000
                        || start.elapsed() > Duration::from_secs(2)
                    {
                        return Ok((bytes, false));
                    }
                    let entry = entry.map_err(Failure::internal)?;
                    visited += 1;
                    let meta = fs::symlink_metadata(entry.path()).map_err(Failure::internal)?;
                    if meta.file_type().is_symlink() {
                        continue;
                    }
                    if meta.is_dir() {
                        pending.push(entry.path());
                    } else if entry.path().extension().is_some_and(|e| e == "png") {
                        bytes = bytes.saturating_add(meta.len());
                    }
                }
            }
            Ok((bytes, true))
        })
        .await
        .map_err(Failure::internal)??;
        let at = chrono::Utc::now().to_rfc3339();
        *self.cache_scan.lock().unwrap() = Some((bytes, complete, at.clone()));
        Ok(json!({"cache_bytes":bytes,"complete":complete,"scanned_at":at}))
    }
    pub(super) fn ensure_generation_allowed(&self) -> Result<()> {
        #[cfg(test)]
        if let Some(reason) = self.generation_error.lock().unwrap().as_ref() {
            return Err(Failure::new(503, reason.clone()));
        }
        crate::tilegen::execution::ensure_generation_allowed()
            .or_else(|_| crate::tilegen::execution::ensure_standard_generation_allowed())
            .or_else(|_| crate::tilegen::execution::ensure_osm_generation_allowed())
            .map_err(|reason| Failure::new(503, reason))
    }
    pub(super) fn ensure_dataset_generation_allowed(&self, dataset: &Dataset) -> Result<()> {
        let contract = dataset
            .render_contract_for(&Default::default())
            .map_err(runtime::render_failure)?;
        self.ensure_contract_generation_allowed(&contract)
    }
    pub(super) fn ensure_contract_generation_allowed(
        &self,
        contract: &RenderContract,
    ) -> Result<()> {
        self.ensure_generation_allowed()?;
        if contract.render_spec.is_some() {
            crate::tilegen::execution::ensure_osm_generation_allowed()
                .map_err(|e| Failure::new(503, e))?;
        } else if contract.schema_version == 2 {
            crate::tilegen::execution::ensure_standard_generation_allowed()
                .map_err(|e| Failure::new(503, e))?;
        } else if contract.schema_version == 1 {
            crate::tilegen::execution::ensure_generation_allowed()
                .map_err(|e| Failure::new(503, e))?;
        } else {
            return Err(Failure::new(
                503,
                "この描画契約の生成認定を確認できません。",
            ));
        }
        Ok(())
    }

    pub async fn register_database(
        self: &Arc<Self>,
        name: String,
        path: PathBuf,
        managed: bool,
    ) -> Result<Value> {
        self.ensure_generation_allowed()?;
        if !managed || self.engine.lock().unwrap().is_none() {
            self.ensure_writer().await?;
        }
        let _admission = self.admission.lock().await;
        if name.trim().is_empty()
            || name.chars().count() > 120
            || name.chars().any(char::is_control)
            || !path.is_absolute()
        {
            return Err(Failure::new(
                400,
                "表示名（120文字以内）とサーバー上のDB絶対パスを指定してください。",
            ));
        }
        let open_path = path.clone();
        let dataset = tokio::task::spawn_blocking(move || Dataset::open(open_path))
            .await
            .map_err(Failure::internal)?
            .map_err(|error| {
                tracing::warn!(error=?error,"Invalid local dataset registration");
                Failure::new(400, "完成した互換形式の地図DBを指定してください。")
            })?;
        let id = dataset.info().dataset_id.clone();
        self.ensure_dataset_generation_allowed(&dataset)?;
        let profile = profile_record(&id, &dataset)?;
        let database_path = if managed {
            path.strip_prefix(&self.config.dataset_path)
                .map_err(Failure::internal)?
                .to_string_lossy()
                .into_owned()
        } else {
            path.to_string_lossy().into_owned()
        };
        if let Some(mut existing) = catalog::get_dataset(&self.catalog, &id)
            .await
            .map_err(catalog_failure)?
        {
            if existing.retired {
                return Err(Failure::new(409, "このデータセットは利用停止済みです。"));
            }
            catalog::insert_profile(&self.catalog, &profile)
                .await
                .map_err(catalog_failure)?;
            existing.database_path = database_path;
            existing.storage_kind = if managed { "managed" } else { "external" }.into();
            existing.name = name.trim().into();
            catalog::update_dataset_location(
                &self.catalog,
                &id,
                &existing.database_path,
                &existing.storage_kind,
                &existing.name,
            )
            .await
            .map_err(catalog_failure)?;
            let previous = self.loaded.lock().unwrap().insert(
                id,
                Arc::new(DatasetHandle {
                    dataset,
                    publication: Mutex::new(true),
                }),
            );
            if let Some(previous) = previous {
                *previous.publication.lock().unwrap() = false;
            }
            return Ok(dataset_json(&existing, &profile.id));
        }
        let record = DatasetRecord {
            id: id.clone(),
            name: name.trim().into(),
            storage_kind: if managed { "managed" } else { "external" }.into(),
            database_path,
            dataset_key: id.clone(),
            info_json: dataset_info(&dataset).to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            retired: false,
        };
        catalog::insert_dataset_with_profile(&self.catalog, &record, &profile)
            .await
            .map_err(catalog_failure)?;
        self.loaded.lock().unwrap().insert(
            id,
            Arc::new(DatasetHandle {
                dataset,
                publication: Mutex::new(true),
            }),
        );
        Ok(dataset_json(&record, &profile.id))
    }
    pub(super) async fn load_dataset(
        self: &Arc<Self>,
        record: &DatasetRecord,
    ) -> Result<Arc<DatasetHandle>> {
        if let Some(handle) = self.loaded.lock().unwrap().get(&record.id) {
            return Ok(handle.clone());
        }
        let path = record
            .resolve_path(&self.config.dataset_path)
            .map_err(|e| Failure::new(503, e))?;
        let dataset = tokio::task::spawn_blocking(move || Dataset::open(path))
            .await
            .map_err(Failure::internal)?
            .map_err(runtime::render_failure)?;
        if dataset.info().dataset_id != record.dataset_key {
            return Err(Failure::new(
                503,
                "登録後にDBが置き換わっています。新しいデータセットとして登録してください。",
            ));
        }
        let mut loaded = self.loaded.lock().unwrap();
        let allowed = !record.retired && !self.retired_ids.lock().unwrap().contains(&record.id);
        Ok(loaded
            .entry(record.id.clone())
            .or_insert_with(|| {
                Arc::new(DatasetHandle {
                    dataset,
                    publication: Mutex::new(allowed),
                })
            })
            .clone())
    }

    /// 既存完成DBの登録を保ったまま、現在の描画版を明示的に準備する。
    pub async fn prepare_dataset(self: &Arc<Self>, id: &str) -> Result<Value> {
        self.prepare_dataset_with_spec(id, None).await
    }

    /// 描画内容を固定した世代を追加し、既存世代の設定や保存済みPNGを保持する。
    pub async fn prepare_dataset_with_spec(
        self: &Arc<Self>,
        id: &str,
        spec: Option<RenderSpec>,
    ) -> Result<Value> {
        self.ensure_generation_allowed()?;
        self.ensure_writer().await?;
        let _admission = self.admission.lock().await;
        let record = catalog::get_dataset(&self.catalog, id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "データセットが見つかりません。"))?;
        if record.retired {
            return Err(Failure::new(
                410,
                "このデータセットは利用停止されています。",
            ));
        }
        let dataset = self.load_dataset(&record).await?;
        let profile = profile::record_with_spec(id, &dataset.dataset, spec)?;
        let (_, contract) = profile::resolve(&profile, &dataset.dataset)?;
        self.ensure_contract_generation_allowed(&contract)?;
        catalog::insert_profile(&self.catalog, &profile)
            .await
            .map_err(catalog_failure)?;
        Ok(dataset_json(&record, &profile.id))
    }
    pub async fn datasets(self: &Arc<Self>) -> Result<Vec<Value>> {
        let mut values = Vec::new();
        for record in catalog::list_datasets(&self.catalog)
            .await
            .map_err(catalog_failure)?
        {
            let profiles = catalog::list_profiles(&self.catalog, &record.id)
                .await
                .map_err(catalog_failure)?;
            let expected = default_profile_id(&record);
            let profile = profiles
                .iter()
                .find(|p| expected.as_deref() == Some(p.id.as_str()) && profile::is_compatible(p));
            let mut value = dataset_json(&record, profile.as_ref().map_or("", |p| p.id.as_str()));
            value["current_profile_prepared"] = json!(!record.retired && profile.is_some());
            value["profiles"] = json!(profiles);
            value["execution"] = execution_diagnostics();
            // 接続・世代追加はせず、登録先の消失だけは従来どおり行単位で知らせる。
            let error = if record.retired {
                None
            } else {
                match record.resolve_path(&self.config.dataset_path) {
                    Ok(path) => match tokio::fs::metadata(path).await {
                        Ok(metadata) if metadata.is_file() => None,
                        _ => Some("登録された完成DBが見つかりません。".to_owned()),
                    },
                    Err(message) => Some(message),
                }
            };
            value["error"] = json!(error);
            values.push(value);
        }
        Ok(values)
    }
    pub async fn render(
        self: &Arc<Self>,
        dataset_id: &str,
        render_id: &str,
        tile: TileId,
        background: bool,
    ) -> Result<(Arc<Vec<u8>>, bool)> {
        if !valid_id(dataset_id) || !valid_id(render_id) {
            return Err(Failure::new(404, "地図が見つかりません。"));
        }
        let record = catalog::get_dataset(&self.catalog, dataset_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "地図が見つかりません。"))?;
        let profile = catalog::get_profile(&self.catalog, dataset_id, render_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "地図世代が見つかりません。"))?;
        if record.retired || profile.retired {
            return Err(Failure::new(410, "この地図は利用を終了しました。"));
        }
        let path = self
            .config
            .cache_path
            .join(dataset_id)
            .join(render_id)
            .join(tile.z.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.png", tile.y));
        let read_path = path.clone();
        if let Some(bytes) = tokio::task::spawn_blocking(move || runtime::read_png(&read_path))
            .await
            .map_err(Failure::internal)??
        {
            return Ok((Arc::new(bytes), true));
        }
        if !profile::is_compatible(&profile) {
            return Err(Failure::new(
                410,
                "旧描画版の未生成タイルは利用できません。現在の背景を登録してください。",
            ));
        }
        self.ensure_generation_allowed()?;
        self.ensure_writer().await?;
        // キャッシュ読取中に所有権が変わっている場合がある。新しい所有者は、
        // 以前の所有者が利用停止を確定する前に読み取った登録情報を使って
        // 生成してはならない。
        let record = catalog::get_dataset(&self.catalog, dataset_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "地図が見つかりません。"))?;
        if record.retired
            || !catalog::active_profile(&self.catalog, dataset_id, render_id)
                .await
                .map_err(catalog_failure)?
        {
            return Err(Failure::new(410, "この地図は利用を終了しました。"));
        }
        let dataset = self.load_dataset(&record).await?;
        let (options, contract) = profile::resolve(&profile, &dataset.dataset)?;
        self.ensure_contract_generation_allowed(&contract)?;
        let key = format!(
            "{render_id}:{}",
            identity::tile_cache_key(dataset_id, &contract, tile.z, tile.x, tile.y)
        );
        let subscription = self
            .engine
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(Failure::unavailable)?
            .subscribe_with_options(key, dataset, tile, path, background, options)?;
        let timeout = if background {
            self.config.job_timeout_seconds
        } else {
            self.config.http_timeout_seconds
        };
        Ok((
            subscription.wait(Duration::from_secs(timeout)).await?,
            false,
        ))
    }
    async fn ensure_unreferenced(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        dataset_id: &str,
    ) -> Result<()> {
        let prefix = format!("/local-tiles/{dataset_id}/");
        let backgrounds: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM tileserver_model WHERE instr(url,?)>0)",
        )
        .bind(&prefix)
        .fetch_one(&mut **tx)
        .await
        .map_err(Failure::internal)?;
        let shares: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM temporary_urls WHERE instr(COALESCE(map_snapshot,''),?)>0)")
            .bind(&prefix).fetch_one(&mut **tx).await.map_err(Failure::internal)?;
        if backgrounds || shares {
            return Err(Failure::new(
                409,
                "背景地図または保存済み共有が参照しています。参照を解除してから操作してください。",
            ));
        }
        Ok(())
    }
    fn revoke_publication(&self, id: &str) {
        self.retired_ids.lock().unwrap().insert(id.into());
        if let Some(handle) = self.loaded.lock().unwrap().get(id) {
            *handle.publication.lock().unwrap() = false;
        }
    }
    pub async fn retire(self: &Arc<Self>, id: &str) -> Result<Value> {
        self.ensure_writer().await?;
        let _admission = self.admission.lock().await;
        let mut transaction = self
            .app_pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(Failure::internal)?;
        self.ensure_unreferenced(&mut transaction, id).await?;
        let record = catalog::get_dataset(&self.catalog, id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "対象の地図が見つかりません。"))?;
        // 利用停止の確定前に、進行中の公開処理が終わるのを待つ。
        // DBへの書込待機中は、同期的な公開ロックを保持しない。
        self.revoke_publication(id);
        if !record.retired {
            if let Err(error) = catalog::retire_dataset(&self.catalog, id).await {
                // コミットエラー時は成否が不明な場合がある。利用停止が未確定であることを
                // 管理DBで確認できた場合だけ、公開を再び有効にする。
                if catalog::get_dataset(&self.catalog, id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|current| !current.retired)
                {
                    self.retired_ids.lock().unwrap().remove(id);
                    if let Some(handle) = self.loaded.lock().unwrap().get(id) {
                        *handle.publication.lock().unwrap() = true;
                    }
                }
                return Err(Failure::internal(error));
            }
        }
        // 管理DBのコミット結果を最終判断とする。本体側の書込排他の解放に失敗しても、
        // データセットを再び公開可能にしてはならない。
        #[cfg(test)]
        if self
            .fail_retirement_fence_release
            .swap(false, Ordering::AcqRel)
        {
            return Err(Failure::new(
                500,
                "simulated app write fence release failure",
            ));
        }
        transaction.commit().await.map_err(Failure::internal)?;
        Ok(json!({"retired":true}))
    }
    pub async fn cleanup(self: &Arc<Self>, id: &str, render_id: &str) -> Result<Value> {
        self.ensure_writer().await?;
        let _admission = self.admission.lock().await;
        if !valid_id(id) || !valid_id(render_id) {
            return Err(Failure::new(400, "地図世代の指定が不正です。"));
        }
        let mut transaction = self
            .app_pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(Failure::internal)?;
        let record = catalog::get_dataset(&self.catalog, id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "対象が見つかりません。"))?;
        if !record.retired {
            return Err(Failure::new(409, "利用中のデータセットは清掃できません。"));
        }
        self.ensure_unreferenced(&mut transaction, id).await?;
        let profile = catalog::get_profile(&self.catalog, id, render_id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "対象世代が見つかりません。"))?;
        if !profile.retired {
            return Err(Failure::new(409, "利用中の描画世代は清掃できません。"));
        }
        if catalog::has_active_jobs(&self.catalog, id)
            .await
            .map_err(catalog_failure)?
        {
            return Err(Failure::new(
                409,
                "この地図のジョブが終了するまで待ってください。",
            ));
        }
        transaction.commit().await.map_err(Failure::internal)?;
        let root = self.config.cache_path.clone();
        let target = root.join(id).join(render_id);
        tokio::task::spawn_blocking(move || remove_owned_tree(&root, &target))
            .await
            .map_err(Failure::internal)??;
        Ok(json!({"cleaned":true}))
    }
    pub async fn add_background(self: &Arc<Self>, id: &str) -> Result<Value> {
        self.add_background_with_render(id, None).await
    }
    pub async fn add_background_with_render(
        self: &Arc<Self>,
        id: &str,
        render: Option<&str>,
    ) -> Result<Value> {
        self.add_background_with_options(id, render, None).await
    }

    pub async fn add_background_with_options(
        self: &Arc<Self>,
        id: &str,
        render: Option<&str>,
        name: Option<&str>,
    ) -> Result<Value> {
        if name.is_some_and(|name| {
            name.trim().is_empty()
                || name.chars().count() > 120
                || name.chars().any(char::is_control)
        }) {
            return Err(Failure::new(
                400,
                "背景の表示名は制御文字を含まない1〜120文字で指定してください。",
            ));
        }
        self.ensure_generation_allowed()?;
        self.ensure_writer().await?;
        let _admission = self.admission.lock().await;
        let record = catalog::get_dataset(&self.catalog, id)
            .await
            .map_err(catalog_failure)?
            .ok_or_else(|| Failure::new(404, "地図が見つかりません。"))?;
        if record.retired {
            return Err(Failure::new(410, "この地図は利用停止済みです。"));
        }
        let dataset = self.load_dataset(&record).await?;
        let profile = if let Some(render) = render {
            catalog::get_profile(&self.catalog, id, render)
                .await
                .map_err(catalog_failure)?
                .ok_or_else(|| {
                    Failure::new(
                        404,
                        "指定した描画世代が未準備です。datasets prepareを実行してください。",
                    )
                })?
        } else {
            profile_record(id, &dataset.dataset)?
        };
        let (_, contract) = profile::resolve(&profile, &dataset.dataset)?;
        self.ensure_contract_generation_allowed(&contract)?;
        if render.is_none() {
            catalog::insert_profile(&self.catalog, &profile)
                .await
                .map_err(catalog_failure)?;
        }
        let url = tile_url(id, &profile.id);
        let mut transaction = self
            .app_pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(Failure::internal)?;
        self.validate_background_url(&url).await?;
        if let Some(existing) =
            sqlx::query_scalar::<_, i64>("SELECT id FROM tileserver_model WHERE url=?")
                .bind(&url)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(Failure::internal)?
        {
            return Ok(json!({"id":existing}));
        }
        let maximum: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(id),0) FROM tileserver_model")
            .fetch_one(&mut *transaction)
            .await
            .map_err(Failure::internal)?;
        let background_id = maximum.checked_add(1).ok_or_else(Failure::unavailable)?;
        let attribution = attribution_html(&dataset_info(&dataset.dataset)["attribution"])?;
        sqlx::query("INSERT INTO tileserver_model (id,layer_name,label,url,attribution,include_foreign_tiles,min_zoom,max_zoom,kind,style_url,create_at,updated_at) VALUES (?,?,?,?,?,FALSE,0,22,'raster',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            .bind(background_id).bind(format!("local_{id}_{}",&profile.id[..12])).bind(name.map(str::trim).unwrap_or(&record.name)).bind(url).bind(attribution).execute(&mut *transaction).await.map_err(Failure::internal)?;
        transaction.commit().await.map_err(Failure::internal)?;
        Ok(json!({"id":background_id}))
    }
    pub async fn shutdown(self: &Arc<Self>) {
        let _shutdown = self.shutdown_gate.lock().await;
        self.closing.store(true, Ordering::Release);
        // 呼出元から切り離された同期初期化の完了を待ってから、排他を解放する。
        // ジョブ終了処理も受付・有効化の排他を使う場合があるため、ジョブの回収中は保持しない。
        {
            let _activation = self.activation.lock().await;
        }
        for token in self.cancellations.lock().unwrap().values() {
            token.cancel();
        }
        if let Some(engine) = self.engine.lock().unwrap().as_ref() {
            engine.stop();
        }
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for task in tasks {
            if let Err(error) = task.await {
                tracing::error!(%error,"Tile management job stopped unexpectedly");
            }
        }
        self.catalog.close().await;
        let service = self.clone();
        let _ = tokio::task::spawn_blocking(move || {
            drop(service.engine.lock().unwrap().take());
            drop(service.dataset_lock.lock().unwrap().take());
            drop(service.owner_lock.lock().unwrap().take());
        })
        .await;
    }
}
pub(crate) fn catalog_failure(error: impl std::fmt::Display) -> Failure {
    tracing::warn!(%error, "Local tile catalog unavailable");
    Failure::new(
        503,
        "ローカル地図の管理DBを利用できません。保存先と設定を確認してください。",
    )
}
pub(crate) fn references_local_tiles(url: &str) -> bool {
    url.starts_with('/')
        && (url.starts_with("/local-tiles/")
            || reqwest::Url::parse("https://geocode.invalid/")
                .and_then(|base| base.join(url))
                .is_ok_and(|normalized| normalized.path().starts_with("/local-tiles/")))
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn tile_url(id: &str, profile: &str) -> String {
    format!("/local-tiles/{id}/{profile}/{{z}}/{{x}}/{{y}}.png")
}
pub fn profile_record(id: &str, dataset: &Dataset) -> Result<ProfileRecord> {
    profile::record(id, dataset)
}

/// 登録情報から既定世代を求め、列挙順によって別の描画設定を選ばないようにする。
pub(super) fn default_profile_id(record: &DatasetRecord) -> Option<String> {
    let info: Value = serde_json::from_str(&record.info_json).ok()?;
    let schema = u32::try_from(info["schema_version"].as_u64()?).ok()?;
    let geometry = u32::try_from(info["geometry_version"].as_u64()?).ok()?;
    RenderContract::for_format(schema, geometry)
        .map(|contract| identity::render_id(&record.id, &contract))
}

pub(super) fn execution_diagnostics() -> Value {
    let status = crate::tilegen::execution::execution_status();
    let standard = crate::tilegen::execution::standard_execution_status();
    let osm = crate::tilegen::execution::osm_execution_status();
    json!({"verified": status.verified, "reason": status.reason,
        "compiler":status.compiler,"target":status.target,
        "dependency_fingerprint":status.dependency_fingerprint,
        "standard":{"verified":standard.verified,"reason":standard.reason,"dependency_fingerprint":standard.dependency_fingerprint},
        "osm":{"verified":osm.verified,"reason":osm.reason,"dependency_fingerprint":osm.dependency_fingerprint}})
}
fn dataset_info(dataset: &Dataset) -> Value {
    let info = dataset.info();
    json!({"dataset_id":info.dataset_id,"schema_version":info.schema_version,"geometry_version":info.geometry_version,
        "importer_version":info.importer_version,"source_sha256":info.source_sha256,"source_bytes":info.source_bytes,
        "feature_count":info.feature_count,"source_timestamp":info.source_timestamp,
        "details":info.extension,
        "attribution":{"text":info.attribution.text,"copyright_url":info.attribution.copyright_url,"data_license":info.attribution.data_license,"source_timestamp":info.attribution.source_timestamp,"additional":info.attribution.additional}})
}

/// CLI出力と共通背景登録で同じ出典を使い、保存可能な長さだけを受け付ける。
pub(super) fn attribution_html(source: &Value) -> Result<String> {
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let link = |text: &str, url: &str| match reqwest::Url::parse(url) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {
            format!("<a href=\"{}\">{}</a>", escape(url.as_str()), escape(text))
        },
        _ => escape(text),
    };
    let mut value = link(
        source["text"].as_str().unwrap_or(""),
        source["copyright_url"].as_str().unwrap_or(""),
    );
    if let Some(extra) = source["additional"].as_array() {
        if extra.len() > 4 {
            return Err(Failure::new(400, "出典の件数が上限を超えています。"));
        }
        for item in extra {
            value.push_str(" / ");
            value.push_str(&link(
                item[0].as_str().unwrap_or(""),
                item[1].as_str().unwrap_or(""),
            ));
        }
    }
    if value.chars().count() > 255 {
        return Err(Failure::new(
            400,
            "出典が背景地図の保存上限を超えています。",
        ));
    }
    Ok(value)
}
fn dataset_json(record: &DatasetRecord, profile: &str) -> Value {
    json!({"id":record.id,"name":record.name,"dataset_key":record.dataset_key,"retired":record.retired,
        "storage_kind":record.storage_kind,"database_path":record.database_path,"created_at":record.created_at,
        "info":serde_json::from_str::<Value>(&record.info_json).unwrap_or(Value::Null),"render_id":profile,"url":tile_url(&record.id,profile)})
}
fn remove_owned_tree(root: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        return Ok(());
    }
    let relative = target
        .strip_prefix(root)
        .map_err(Failure::internal)?
        .to_path_buf();
    let root = root.canonicalize().map_err(Failure::internal)?;
    let target = target.canonicalize().map_err(Failure::internal)?;
    if target == root || target != root.join(relative) {
        return Err(Failure::new(
            409,
            "リンクされた保存先や保存先の外側は清掃できません。",
        ));
    }
    fn check(path: &Path) -> std::io::Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                return Err(std::io::Error::other("linked cache entry"));
            }
            if meta.is_dir() {
                check(&entry.path())?;
            }
        }
        Ok(())
    }
    check(&target).map_err(Failure::internal)?;
    fs::remove_dir_all(target).map_err(Failure::internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn registered_service() -> (tempfile::TempDir, Arc<LocalTiles>, String) {
        let root = tempfile::tempdir().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.path().join("app.sqlite"))
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePool::connect_with(options).await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let input = root.path().join("sample.osm.pbf");
        crate::tilegen::test_support::Fixture::sample().write(&input);
        let database = root.path().join("source.sqlite");
        crate::tilegen::import::run(&crate::tilegen::import::ImportOptions {
            input,
            store: database.clone(),
            work_dir: root.path().join("staging"),
            missing_nodes: crate::tilegen::import::MissingNodes::Error,
        })
        .unwrap();
        let app = LocalTiles::new(LocalTileConfig::defaults(root.path()), pool);
        let registered = app
            .register_database("sample".into(), database, false)
            .await
            .unwrap();
        let id = registered["id"].as_str().unwrap().to_owned();
        (root, app, id)
    }

    #[tokio::test]
    async fn 未認定構成でも保存_pngと照会を維持し新規生成を拒否する() {
        let (_root, app, id) = registered_service().await;
        let profile = catalog::list_profiles(&app.catalog, &id)
            .await
            .unwrap()
            .remove(0);
        let tile = TileId::from_lon_lat(14, 139.7, 35.7).unwrap();
        let (original, hit) = app.render(&id, &profile.id, tile, false).await.unwrap();
        assert!(!hit);
        *app.generation_error.lock().unwrap() = Some("検証用の未認定構成".into());
        let status = app.status().await;
        assert_eq!(status["available"], false);
        assert!(status["message"].as_str().unwrap().contains("未認定"));
        assert!(status["message"].as_str().unwrap().contains("保存済みPNG"));
        let (cached, hit) = app.render(&id, &profile.id, tile, false).await.unwrap();
        assert!(hit);
        assert_eq!(cached.as_ref(), original.as_ref());
        let missing = TileId::new(tile.z, tile.x + 1, tile.y).unwrap();
        let failure = app
            .render(&id, &profile.id, missing, false)
            .await
            .unwrap_err();
        assert_eq!(failure.status, 503);
        assert!(failure.message.contains("未認定"));
        assert_eq!(app.prepare_dataset(&id).await.unwrap_err().status, 503);
        assert_eq!(app.add_background(&id).await.unwrap_err().status, 503);
        let request = super::super::jobs::PrecomputeRequest {
            dataset_id: id.clone(),
            bbox: [139.6999, 35.6999, 139.7001, 35.7001],
            min_zoom: 14,
            max_zoom: 14,
            max_tiles: Some(100),
            resume_job_id: None,
            render_id: None,
        };
        assert_eq!(
            app.plan_precompute_readonly(request.clone()).await.unwrap()["allowed"],
            true
        );
        assert_eq!(app.start_precompute(request).await.unwrap_err().status, 503);
        assert_eq!(
            app.datasets().await.unwrap()[0]["current_profile_prepared"],
            true
        );
        assert_eq!(
            catalog::list_profiles(&app.catalog, &id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            catalog::list_jobs(&app.catalog, 100, 0)
                .await
                .unwrap()
                .is_empty()
        );
        app.shutdown().await;
        app.app_pool.close().await;
    }

    #[tokio::test]
    async fn retirement_waits_for_an_independent_app_write_then_sees_its_reference() {
        let (_root, app, id) = registered_service().await;
        let profile = catalog::list_profiles(&app.catalog, &id)
            .await
            .unwrap()
            .remove(0);
        let mut reference = app.app_pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let retiring = app.clone();
        let retired_id = id.clone();
        let mut task = tokio::spawn(async move { retiring.retire(&retired_id).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut task)
                .await
                .is_err()
        );
        let url = tile_url(&id, &profile.id);
        app.validate_background_url(&url).await.unwrap();
        sqlx::query("INSERT INTO tileserver_model (id,layer_name,label,url,attribution,include_foreign_tiles,min_zoom,max_zoom,kind,style_url,create_at,updated_at) VALUES (999,'race','race',?,'',FALSE,0,22,'raster',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            .bind(url).execute(&mut *reference).await.unwrap();
        reference.commit().await.unwrap();
        assert_eq!(task.await.unwrap().unwrap_err().status, 409);
        assert!(
            !catalog::get_dataset(&app.catalog, &id)
                .await
                .unwrap()
                .unwrap()
                .retired
        );
        app.shutdown().await;
        app.app_pool.close().await;
    }

    #[tokio::test]
    async fn committed_catalog_retirement_survives_app_fence_release_failure() {
        let (_root, app, id) = registered_service().await;
        let profile = catalog::list_profiles(&app.catalog, &id)
            .await
            .unwrap()
            .remove(0);
        app.fail_retirement_fence_release
            .store(true, Ordering::Release);
        assert_eq!(app.retire(&id).await.unwrap_err().status, 500);
        assert!(
            catalog::get_dataset(&app.catalog, &id)
                .await
                .unwrap()
                .unwrap()
                .retired
        );
        assert!(
            !*app
                .loaded
                .lock()
                .unwrap()
                .get(&id)
                .unwrap()
                .publication
                .lock()
                .unwrap()
        );
        assert_eq!(
            app.validate_background_url(&tile_url(&id, &profile.id))
                .await
                .unwrap_err()
                .status,
            400
        );
        app.retire(&id).await.unwrap();
        assert_eq!(
            app.render(&id, &profile.id, TileId::new(0, 0, 0).unwrap(), false)
                .await
                .unwrap_err()
                .status,
            410
        );
        app.shutdown().await;
        app.app_pool.close().await;
    }

    #[tokio::test]
    async fn a_profile_created_from_a_stale_active_read_inherits_retirement() {
        let (_root, app, id) = registered_service().await;
        let mut stale_profile = catalog::list_profiles(&app.catalog, &id)
            .await
            .unwrap()
            .remove(0);
        stale_profile.id = "c".repeat(64);
        stale_profile.build_id = "new-renderer-generation".into();
        assert!(!stale_profile.retired);
        app.retire(&id).await.unwrap();
        // datasets()が以前の有効状態を読み込む一方、別タスクで利用停止が完了する場合の
        // 処理順序をそのまま再現する。
        catalog::insert_profile(&app.catalog, &stale_profile)
            .await
            .unwrap();
        let stored = catalog::get_profile(&app.catalog, &id, &stale_profile.id)
            .await
            .unwrap()
            .unwrap();
        assert!(stored.retired);
        app.cleanup(&id, &stored.id).await.unwrap();
        app.shutdown().await;
        app.app_pool.close().await;
    }

    #[tokio::test]
    async fn normalized_relative_aliases_cannot_bypass_local_reference_validation() {
        let root = tempfile::tempdir().unwrap();
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        let app = LocalTiles::new(LocalTileConfig::defaults(root.path()), pool);
        let canonical = tile_url(&"a".repeat(64), &"b".repeat(64));
        for alias in [
            format!("/other/..{canonical}"),
            format!("/other/%2e%2e{canonical}"),
            canonical.replace(&"a".repeat(64), &"%61".repeat(64)),
            format!("{canonical}?extra=1"),
        ] {
            assert!(references_local_tiles(&alias), "{alias}");
            assert_eq!(
                app.validate_background_url(&alias)
                    .await
                    .unwrap_err()
                    .status,
                400,
                "{alias}"
            );
        }
        // 外部サーバーが独立して同じパス形式を公開する場合もある。
        let external = format!("https://tiles.example.test{canonical}");
        assert!(!references_local_tiles(&external));
        app.validate_background_url(&external).await.unwrap();
        assert!(!app.config.catalog_database_path.exists());
        app.shutdown().await;
        app.app_pool.close().await;
    }

    #[tokio::test]
    async fn file_catalog_uses_its_real_path_for_the_owner_lock() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("app カタログ.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&database)
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        let app = LocalTiles::new(LocalTileConfig::defaults(root.path()), pool);
        app.ensure_writer().await.unwrap();
        assert!(app.catalog.owner_lock_path().unwrap().is_file());
        assert_ne!(
            app.catalog.owner_lock_path().unwrap(),
            database.with_extension("local-tiles.lock")
        );
        assert!(!app.config.work_path.join("catalog-owner.lock").exists());
        app.shutdown().await;
        app.app_pool.close().await;
    }

    #[tokio::test]
    async fn aborted_activation_is_joined_before_shutdown_releases_storage() {
        let root = tempfile::tempdir().unwrap();
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        let app = LocalTiles::new(LocalTileConfig::defaults(root.path()), pool);
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(std::sync::Barrier::new(2));
        let signal = entered.clone();
        let gate = release.clone();
        *app.activation_hook.lock().unwrap() = Some(Arc::new(move || {
            signal.notify_one();
            gate.wait();
        }));
        let activating = app.clone();
        let activation = tokio::spawn(async move { activating.ensure_writer().await });
        tokio::time::timeout(Duration::from_secs(30), entered.notified())
            .await
            .unwrap();
        activation.abort();
        let _ = activation.await;
        let stopping = app.clone();
        let mut shutdown = tokio::spawn(async move { stopping.shutdown().await });
        while !app.closing.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        let waited = tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
            .await
            .is_err();
        release.wait();
        if waited {
            tokio::time::timeout(Duration::from_secs(5), shutdown)
                .await
                .unwrap()
                .unwrap();
        }
        assert!(
            waited,
            "shutdown must wait for a detached blocking activation"
        );
        assert!(app.engine.lock().unwrap().is_none());
        assert!(app.owner_lock.lock().unwrap().is_none());
        assert!(
            app.catalog.owner_lock_path().unwrap().is_file(),
            "the owner lock must derive from the configured catalog path"
        );
    }

    #[tokio::test]
    async fn reregistering_a_database_revokes_the_previous_publication_handle() {
        let root = tempfile::tempdir().unwrap();
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let input = root.path().join("sample.osm.pbf");
        crate::tilegen::test_support::Fixture::sample().write(&input);
        let original = root.path().join("original.sqlite");
        crate::tilegen::import::run(&crate::tilegen::import::ImportOptions {
            input,
            store: original.clone(),
            work_dir: root.path().join("staging"),
            missing_nodes: crate::tilegen::import::MissingNodes::Error,
        })
        .unwrap();
        let moved = root.path().join("moved.sqlite");
        fs::copy(&original, &moved).unwrap();
        let app = LocalTiles::new(LocalTileConfig::defaults(root.path()), pool);
        let registered = app
            .register_database("original".into(), original, false)
            .await
            .unwrap();
        let id = registered["id"].as_str().unwrap();
        let previous = app.loaded.lock().unwrap().get(id).unwrap().clone();
        app.register_database("moved".into(), moved.clone(), false)
            .await
            .unwrap();
        assert!(!*previous.publication.lock().unwrap());
        fs::remove_file(moved).unwrap();
        let rows = app.datasets().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0]["error"].is_string(),
            "a missing DB is a per-row error"
        );
        app.retire(id).await.unwrap();
        assert!(
            !*app
                .loaded
                .lock()
                .unwrap()
                .get(id)
                .unwrap()
                .publication
                .lock()
                .unwrap()
        );
        app.shutdown().await;
    }
}
