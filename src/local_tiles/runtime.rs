use super::config::LocalTileConfig;
use crate::tilegen::cancel::CancellationToken;
use crate::tilegen::dataset::{
    Dataset, ErrorKind, OperationContext, RenderError, RenderOptions, RenderSession, TileId,
};
use crate::tilegen::identity::{self, RenderContract};
use fs2::FileExt;
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::watch;

#[derive(Debug, Clone)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}
impl Failure {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    pub fn unavailable() -> Self {
        Self::new(
            503,
            "ローカル地図の生成を利用できません。local-tiles statusで状態を確認してください。",
        )
    }
    pub fn internal(error: impl std::fmt::Display + std::fmt::Debug) -> Self {
        tracing::error!(error = ?error, message = %error, "Local tile operation failed");
        Self::new(
            500,
            "ローカル地図の処理に失敗しました。CLIの状態表示またはログを確認してください。",
        )
    }
}
pub type Result<T> = std::result::Result<T, Failure>;
type RenderResult = Result<Arc<Vec<u8>>>;

pub struct DatasetHandle {
    pub dataset: Dataset,
    pub publication: Mutex<bool>,
}
pub struct RenderTask {
    key: String,
    accepted: Instant,
    pub context: OperationContext,
    dataset: Arc<DatasetHandle>,
    options: RenderOptions,
    contract: RenderContract,
    tile: TileId,
    path: PathBuf,
    subscribers: AtomicUsize,
    result: watch::Sender<Option<RenderResult>>,
}
pub struct Subscription {
    task: Arc<RenderTask>,
    receiver: watch::Receiver<Option<RenderResult>>,
    total: Arc<AtomicUsize>,
    shared: Arc<Shared>,
}
impl Subscription {
    pub async fn wait(mut self, timeout: Duration) -> RenderResult {
        tokio::time::timeout(timeout, async {
            loop {
                if let Some(result) = self.receiver.borrow_and_update().clone() {
                    return result;
                }
                self.receiver
                    .changed()
                    .await
                    .map_err(|_| Failure::unavailable())?;
            }
        })
        .await
        .map_err(|_| Failure::new(504, "タイルの待機期限を超過しました。"))?
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        // 購読者数の最後の減算から取消までの間に、新しい購読者を受け付けない。
        // Engine::subscribeと同じロックを保持して保護する。
        let _queue = self.shared.queue.lock().unwrap();
        self.total.fetch_sub(1, Ordering::AcqRel);
        if self.task.subscribers.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.task.context.cancellation_token().cancel();
        }
    }
}
#[derive(Default)]
struct Queue {
    foreground: VecDeque<Arc<RenderTask>>,
    background: VecDeque<Arc<RenderTask>>,
    inflight: HashMap<String, Arc<RenderTask>>,
    closing: bool,
}
struct Shared {
    queue: Mutex<Queue>,
    ready: Condvar,
    running: AtomicUsize,
    subscribers: Arc<AtomicUsize>,
    closing: AtomicBool,
    generated: AtomicUsize,
}
pub struct Engine {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
    _locks: Vec<File>,
    capacity: usize,
    max_subscribers: usize,
    deadline: Duration,
}

pub fn lock_directory(path: &Path) -> Result<File> {
    let file = lock_owner_directory(path)?;
    let path = fs::canonicalize(path).map_err(Failure::internal)?;
    // PNGと完成DBの公開には、同一ファイルシステム上で既存ファイルを上書きしない操作が必要となる。
    let source = tempfile::NamedTempFile::new_in(&path).map_err(Failure::internal)?;
    let destination = path.join(format!(".publish-probe-{}", uuid::Uuid::new_v4()));
    fs::hard_link(source.path(), &destination).map_err(|error| {
        tracing::warn!(%error, "Tile storage does not support atomic no-clobber publication");
        Failure::new(
            503,
            "保存先で安全なファイル公開を利用できません。別の保存先を指定してください。",
        )
    })?;
    fs::remove_file(destination).map_err(Failure::internal)?;
    Ok(file)
}

fn lock_owner_directory(path: &Path) -> Result<File> {
    fs::create_dir_all(path).map_err(Failure::internal)?;
    let path = fs::canonicalize(path).map_err(Failure::internal)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.join(".geocode-tile-owner.lock"))
        .map_err(Failure::internal)?;
    file.try_lock_exclusive()
        .map_err(|_| Failure::new(503, "同じタイル保存先を別のプロセスが使用しています。"))?;
    Ok(file)
}

impl Engine {
    pub fn start(config: &LocalTileConfig) -> Result<Self> {
        let locks = vec![
            lock_directory(&config.cache_path)?,
            lock_owner_directory(&config.work_path)?,
        ];
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::default()),
            ready: Condvar::new(),
            running: AtomicUsize::new(0),
            subscribers: Arc::new(AtomicUsize::new(0)),
            closing: AtomicBool::new(false),
            generated: AtomicUsize::new(0),
        });
        let mut threads = Vec::new();
        for index in 0..config.workers {
            let worker = shared.clone();
            match std::thread::Builder::new()
                .name(format!("local-tile-{index}"))
                .spawn(move || worker_loop(worker))
            {
                Ok(thread) => threads.push(thread),
                Err(error) => {
                    shared.closing.store(true, Ordering::Release);
                    shared.queue.lock().unwrap().closing = true;
                    shared.ready.notify_all();
                    for thread in threads {
                        let _ = thread.join();
                    }
                    return Err(Failure::internal(error));
                },
            }
        }
        Ok(Self {
            shared,
            threads,
            _locks: locks,
            capacity: config.queue_capacity,
            max_subscribers: config.max_subscribers,
            deadline: Duration::from_secs(config.job_timeout_seconds),
        })
    }
    pub fn subscribe(
        &self,
        key: String,
        dataset: Arc<DatasetHandle>,
        tile: TileId,
        path: PathBuf,
        background: bool,
    ) -> Result<Subscription> {
        self.subscribe_with_options(
            key,
            dataset,
            tile,
            path,
            background,
            RenderOptions::default(),
        )
    }

    /// 同じDBの異なる描画世代を、設定を固定した別タスクとして受け付ける。
    pub fn subscribe_with_options(
        &self,
        key: String,
        dataset: Arc<DatasetHandle>,
        tile: TileId,
        path: PathBuf,
        background: bool,
        options: RenderOptions,
    ) -> Result<Subscription> {
        let contract = dataset
            .dataset
            .render_contract_for(&options)
            .map_err(render_failure)?;
        let mut queue = self.shared.queue.lock().unwrap();
        if queue.closing {
            return Err(Failure::unavailable());
        }
        if self.shared.subscribers.load(Ordering::Acquire) >= self.max_subscribers {
            return Err(Failure::new(503, "タイルの待機要求上限に達しました。"));
        }
        let task = if let Some(task) = queue.inflight.get(&key).cloned() {
            if task.contract != contract
                || task.tile != tile
                || task.dataset.dataset.info().dataset_id != dataset.dataset.info().dataset_id
                || task.path != path
            {
                return Err(Failure::internal(
                    "同じ待機キーに異なる描画内容が指定されました。",
                ));
            }
            if task.context.check().is_err() {
                return Err(Failure::new(
                    503,
                    "直前のタイル生成を終了処理中です。少し待って再試行してください。",
                ));
            }
            if !background {
                if let Some(index) = queue.background.iter().position(|item| item.key == key) {
                    queue.background.remove(index);
                    queue.foreground.push_back(task.clone());
                }
            }
            task
        } else {
            if queue.foreground.len() + queue.background.len() >= self.capacity {
                return Err(Failure::new(503, "タイルの生成待機上限に達しました。"));
            }
            let (result, _) = watch::channel(None);
            let task = Arc::new(RenderTask {
                key: key.clone(),
                accepted: Instant::now(),
                dataset,
                options,
                contract,
                tile,
                path,
                context: OperationContext::new(CancellationToken::new())
                    .with_deadline(Instant::now() + self.deadline),
                subscribers: AtomicUsize::new(0),
                result,
            });
            queue.inflight.insert(key, task.clone());
            if background {
                queue.background.push_back(task.clone());
            } else {
                queue.foreground.push_back(task.clone());
            }
            self.shared.ready.notify_one();
            task
        };
        task.subscribers.fetch_add(1, Ordering::AcqRel);
        self.shared.subscribers.fetch_add(1, Ordering::AcqRel);
        Ok(Subscription {
            receiver: task.result.subscribe(),
            task,
            total: self.shared.subscribers.clone(),
            shared: self.shared.clone(),
        })
    }
    pub fn counts(&self) -> (usize, usize, usize) {
        let queue = self.shared.queue.lock().unwrap();
        (
            queue.foreground.len() + queue.background.len(),
            self.shared.running.load(Ordering::Acquire),
            self.shared.generated.load(Ordering::Acquire),
        )
    }
    pub fn stop(&self) {
        self.shared.closing.store(true, Ordering::Release);
        let mut queue = self.shared.queue.lock().unwrap();
        queue.closing = true;
        for task in queue.inflight.values() {
            task.context.cancellation_token().cancel();
        }
        self.shared.ready.notify_all();
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        self.stop();
        for thread in self.threads.drain(..) {
            if thread.join().is_err() {
                tracing::error!("Tile worker panicked");
            }
        }
    }
}

type WorkerSession = Option<(Arc<DatasetHandle>, String, RenderSession)>;

fn worker_loop(shared: Arc<Shared>) {
    let mut session: WorkerSession = None;
    loop {
        let task = {
            let mut queue = shared.queue.lock().unwrap();
            loop {
                if let Some(task) = queue
                    .foreground
                    .pop_front()
                    .or_else(|| queue.background.pop_front())
                {
                    shared.running.fetch_add(1, Ordering::AcqRel);
                    break task;
                }
                if queue.closing {
                    return;
                }
                queue = shared.ready.wait(queue).unwrap();
            }
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            generate(&task, &shared, &mut session)
        }))
        .unwrap_or_else(|_| {
            session = None;
            Err(Failure::internal("tile worker panic"))
        });
        {
            let mut queue = shared.queue.lock().unwrap();
            queue.inflight.remove(&task.key);
            shared.running.fetch_sub(1, Ordering::AcqRel);
        }
        task.result.send_replace(Some(result));
    }
}
fn generate(task: &RenderTask, shared: &Shared, session: &mut WorkerSession) -> RenderResult {
    let queue_time = task.accepted.elapsed();
    task.context.check().map_err(operation_failure)?;
    if let Some(png) = read_png(&task.path)? {
        return Ok(Arc::new(png));
    }
    // 破損したキャッシュは書込所有者だけが削除する。公開配信・非所有者による読取では
    // 書き込まず、その後の公開でも既存ファイルを上書きせず安全に作成できるようにする。
    match fs::remove_file(&task.path) {
        Ok(()) => tracing::warn!("Invalid local PNG cache entry removed by writer"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(Failure::internal(error)),
    }
    if session.as_ref().is_none_or(|(handle, identity, _)| {
        !Arc::ptr_eq(handle, &task.dataset) || identity != &task.contract.id()
    }) {
        *session = Some((
            task.dataset.clone(),
            task.contract.id(),
            task.dataset
                .dataset
                .create_session(task.options)
                .map_err(render_failure)?,
        ));
    }
    let started = Instant::now();
    let rendered = session
        .as_mut()
        .unwrap()
        .2
        .render_png_with_context(task.tile, &task.context)
        .map_err(render_failure)?;
    let permitted = task.dataset.publication.lock().unwrap();
    if !*permitted || shared.closing.load(Ordering::Acquire) {
        return Err(Failure::new(410, "この地図世代は利用を終了しました。"));
    }
    task.context.check().map_err(operation_failure)?;
    task.dataset.dataset.cache_key(task.tile).map_err(|error| {
        tracing::warn!(error=?error, "Dataset changed before PNG publication");
        Failure::new(503, "公開前に地図DBの変更を検出しました。")
    })?;
    let expected_key = identity::tile_cache_key(
        &task.dataset.dataset.info().dataset_id,
        &task.contract,
        task.tile.z,
        task.tile.x,
        task.tile.y,
    );
    if expected_key != rendered.cache_key {
        return Err(Failure::internal(
            "rendered PNG belongs to another dataset generation",
        ));
    }
    let publication_started = Instant::now();
    publish_png(&task.path, &rendered.png, &task.context)?;
    shared.generated.fetch_add(1, Ordering::AcqRel);
    tracing::debug!(
        tile=%task.tile,
        queue_ms=queue_time.as_millis(),
        elapsed_ms=started.elapsed().as_millis(),
        generation_ms=rendered.elapsed.as_millis(),
        search_ms=rendered.stats.search_time.as_millis(),
        draw_ms=rendered.stats.draw_time.as_millis(),
        encode_ms=rendered.encode_time.as_millis(),
        publication_ms=publication_started.elapsed().as_millis(),
        candidates=rendered.stats.candidate_count,
        bytes=rendered.png.len(),
        "Local tile published"
    );
    Ok(Arc::new(rendered.png))
}
pub(crate) fn render_failure(error: RenderError) -> Failure {
    tracing::warn!(kind=?error.kind(), error=?error, "Local tile render failed");
    match error.kind() {
        ErrorKind::Cancelled => Failure::new(499, "タイル生成を取り消しました。"),
        ErrorKind::DeadlineExceeded => Failure::new(504, "タイル生成の期限を超過しました。"),
        ErrorKind::InvalidDataset | ErrorKind::DatasetChanged => {
            Failure::new(503, "地図DBを利用できません。")
        },
        ErrorKind::InvalidTile => Failure::new(404, "地図タイルが見つかりません。"),
        _ => Failure::internal(error),
    }
}

fn operation_failure(error: anyhow::Error) -> Failure {
    if crate::tilegen::operation::is_deadline_exceeded(&error) {
        Failure::new(504, "タイル生成の期限を超過しました。")
    } else if crate::tilegen::cancel::is_interrupted(&error) {
        Failure::new(499, "タイル生成を取り消しました。")
    } else {
        Failure::internal(error)
    }
}

/// 所有権のないプロセスからの呼出しも含め、上限付きの読取専用処理とする。
pub fn read_png(path: &Path) -> Result<Option<Vec<u8>>> {
    const MAX_PNG_BYTES: u64 = 4 * 1024 * 1024;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Failure::internal(error)),
    };
    let metadata = file.metadata().map_err(Failure::internal)?;
    if !metadata.is_file() || metadata.len() > MAX_PNG_BYTES {
        tracing::warn!("Invalid local PNG cache size");
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PNG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(Failure::internal)?;
    if bytes.len() as u64 <= MAX_PNG_BYTES
        && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.get(16..24) == Some(&[0, 0, 1, 0, 0, 0, 1, 0])
        && image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .is_ok_and(|image| image.to_rgba8().pixels().all(|pixel| pixel.0[3] == 255))
    {
        return Ok(Some(bytes));
    }
    tracing::warn!("Invalid local PNG cache entry ignored");
    Ok(None)
}
fn publish_png(path: &Path, bytes: &[u8], context: &OperationContext) -> Result<()> {
    let parent = path.parent().ok_or_else(Failure::unavailable)?;
    fs::create_dir_all(parent).map_err(Failure::internal)?;
    // Windowsでは正規化により長いパス用の接頭辞が付く。深い保存先でも
    // tempfileによるOSの公開APIを使えるよう、両方のパスを同じ形式にする。
    let parent = fs::canonicalize(parent).map_err(Failure::internal)?;
    let target = parent.join(path.file_name().ok_or_else(Failure::unavailable)?);
    let mut temp = tempfile::NamedTempFile::new_in(&parent).map_err(Failure::internal)?;
    temp.write_all(bytes).map_err(Failure::internal)?;
    temp.as_file().sync_all().map_err(Failure::internal)?;
    context.check().map_err(operation_failure)?;
    match temp.persist_noclobber(&target) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => read_png(&target)?
            .ok_or_else(Failure::unavailable)
            .map(|_| ()),
        Err(error) => Err(Failure::internal(error.error)),
    }
}

#[cfg(test)]
#[path = "../tilegen/test_support.rs"]
mod fixture_support;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tilegen::import::{self, ImportOptions, MissingNodes};
    use std::sync::mpsc;

    #[test]
    fn last_subscriber_drop_shares_the_admission_critical_section() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("input.osm.pbf");
        let database = root.path().join("map.sqlite");
        super::fixture_support::Fixture::sample().write(&input);
        import::run(&ImportOptions {
            input,
            store: database.clone(),
            work_dir: root.path().join("import-work"),
            missing_nodes: MissingNodes::Error,
        })
        .unwrap();
        let config = LocalTileConfig::defaults(root.path());
        let engine = Engine::start(&config).unwrap();
        let handle = Arc::new(DatasetHandle {
            dataset: Dataset::open(database).unwrap(),
            publication: Mutex::new(true),
        });
        let publication = handle.publication.lock().unwrap();
        let subscription = engine
            .subscribe(
                "same-key".into(),
                handle.clone(),
                TileId::new(0, 0, 0).unwrap(),
                config.cache_path.join("same.png"),
                false,
            )
            .unwrap();
        let task = subscription.task.clone();
        let queue = engine.shared.queue.lock().unwrap();
        let (ready_tx, ready_rx) = mpsc::sync_channel(0);
        let (done_tx, done_rx) = mpsc::channel();
        let dropping = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            drop(subscription);
            done_tx.send(()).unwrap();
        });
        let ready = ready_rx.recv_timeout(Duration::from_secs(5));
        // 以前のアトミック変数だけを使うDropでは、受付側がこのロックを保持中でも
        // 取消が直ちに完了し、新しく参加した購読者が取り残される場合があった。
        let completed_while_locked = done_rx.recv_timeout(Duration::from_millis(200));
        let subscribers_while_locked = task.subscribers.load(Ordering::Acquire);
        let cancelled_while_locked = task.context.cancellation_token().is_cancelled();
        drop(queue);
        dropping.join().unwrap();
        let subscribers_after_drop = task.subscribers.load(Ordering::Acquire);
        let cancelled_after_drop = task.context.cancellation_token().is_cancelled();
        drop(publication);
        drop(engine);
        // ガードの解放後に検証し、退行によるpanicの巻き戻しで実行基盤のキューが
        // 使用不能になって、本来の失敗原因が隠れることを防ぐ。
        assert!(ready.is_ok());
        assert!(matches!(
            completed_while_locked,
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(subscribers_while_locked, 1);
        assert!(!cancelled_while_locked);
        assert_eq!(subscribers_after_drop, 0);
        assert!(cancelled_after_drop);
    }
}
