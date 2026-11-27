//! 管理DBへの接続はこのモジュールに限定し、本体のマイグレーションから独立させる。

use crate::local_tiles::config::{DatabaseReplacement, LocalTileConfig};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    fs::{self, File, OpenOptions},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, OnceCell};

#[path = "catalog_database/rebind.rs"]
pub mod rebind;

const APPLICATION_ID: i32 = 0x47574354; // 管理DBの識別子「GWCT」。
const VERSION: i32 = 1;
const SCHEMA: &str = include_str!("migrations/0001_catalog.sql");

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Writer,
    Reader,
    Control,
}

struct OpenCatalog {
    path: PathBuf,
    pool: SqlitePool,
}

#[cfg(test)]
type PrepareHook = Arc<dyn Fn() + Send + Sync>;

struct OpenRequest {
    configured_path: PathBuf,
    require_existing: bool,
    storage_roots: Vec<PathBuf>,
    app_pool: SqlitePool,
    closed: Arc<AtomicBool>,
    access: Access,
    #[cfg(test)]
    prepare_hook: Option<PrepareHook>,
}

/// 地図・描画世代・処理履歴を、本体DBとは独立して保存する管理DB。
/// 管理DBの操作へ本体DBの接続プールを誤って渡せない構成にする。
pub struct TileCatalog {
    configured_path: PathBuf,
    require_existing: bool,
    storage_roots: Vec<PathBuf>,
    app_pool: SqlitePool,
    opened: Arc<OnceCell<OpenCatalog>>,
    lifecycle: Arc<Mutex<()>>,
    closed: Arc<AtomicBool>,
    access: Access,
    #[cfg(test)]
    prepare_hook: std::sync::Mutex<Option<PrepareHook>>,
}

impl TileCatalog {
    /// 初期化は遅延させ、ルーターの構築だけで利用者のホームへ書き込まない。
    pub fn new(path: PathBuf, app_pool: SqlitePool) -> Self {
        Self {
            configured_path: path,
            require_existing: false,
            storage_roots: Vec::new(),
            app_pool,
            opened: Arc::new(OnceCell::new()),
            lifecycle: Arc::new(Mutex::new(())),
            closed: Arc::new(AtomicBool::new(false)),
            access: Access::Writer,
            #[cfg(test)]
            prepare_hook: std::sync::Mutex::new(None),
        }
    }

    /// 既存の管理DBだけを照会し、スキーマ作成、所有権の取得、ジョブ復旧は行わない。
    pub fn read_only(path: PathBuf, app_pool: SqlitePool) -> Self {
        let mut catalog = Self::new(path, app_pool);
        catalog.access = Access::Reader;
        catalog
    }

    /// 別プロセスへの取消要求用。既存の管理DBへの限定的な制御更新だけを許す。
    pub fn control(path: PathBuf, app_pool: SqlitePool) -> Self {
        let mut catalog = Self::new(path, app_pool);
        catalog.access = Access::Control;
        catalog
    }

    pub fn is_writer(&self) -> bool {
        self.access == Access::Writer
    }

    pub fn with_storage_roots(mut self, roots: impl IntoIterator<Item = PathBuf>) -> Self {
        self.storage_roots = roots.into_iter().collect();
        self
    }

    pub fn with_config(mut self, config: &LocalTileConfig) -> Self {
        self.require_existing = config.require_existing_catalog;
        self.with_storage_roots([
            config.dataset_path.clone(),
            config.cache_path.clone(),
            config.work_path.clone(),
        ])
    }

    pub async fn initialize(&self) -> Result<(), String> {
        let lifecycle = self.lifecycle.clone().lock_owned().await;
        if self.closed.load(Ordering::Acquire) {
            return Err("タイル管理DBは既に終了しています。".into());
        }
        if self.opened.get().is_some() {
            return Ok(());
        }
        let request = OpenRequest {
            configured_path: self.configured_path.clone(),
            require_existing: self.require_existing,
            storage_roots: self.storage_roots.clone(),
            app_pool: self.app_pool.clone(),
            closed: self.closed.clone(),
            access: self.access,
            #[cfg(test)]
            prepare_hook: self.prepare_hook.lock().unwrap().clone(),
        };
        let opened = self.opened.clone();
        let closed = self.closed.clone();
        // 要求のFutureが破棄されても、SQLiteの準備処理を終了処理から切り離さない。
        // このタスクが同期処理、接続プールの確立、公開、必要な接続終了まで
        // ライフサイクルの排他を保持する。
        tokio::spawn(async move {
            let _lifecycle = lifecycle;
            let value = Self::open(request).await?;
            if closed.load(Ordering::Acquire) {
                close_pool(&value.pool).await;
                return Err("タイル管理DBは終了処理中です。".into());
            }
            opened
                .set(value)
                .map_err(|_| "タイル管理DBの二重初期化を検出しました。".to_string())?;
            Ok(())
        })
        .await
        .map_err(message)?
    }

    async fn open(request: OpenRequest) -> Result<OpenCatalog, String> {
        // PRAGMAはメモリDBも含め、実際のmain接続の情報を返す。
        // SQLxがメモリDB用に合成したURIを、ディスク上のファイル名として扱わない。
        if request.require_existing {
            crate::db::pool::validate_existing_schema(&request.app_pool)
                .await
                .map_err(message)?;
        }
        let rows = sqlx::query("PRAGMA database_list")
            .fetch_all(&request.app_pool)
            .await
            .map_err(message)?;
        let app_path = rows
            .iter()
            .find(|row| row.get::<String, _>("name") == "main")
            .ok_or("本体DBの接続先を確認できません。")?
            .get::<String, _>("file");
        let path = request.configured_path;
        let roots = request.storage_roots;
        let access = request.access;
        let (path, file) = tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(hook) = request.prepare_hook {
                hook();
            }
            if request.closed.load(Ordering::Acquire) {
                return Err("タイル管理DBは終了処理中です。".into());
            }
            prepare(
                &path,
                if access == Access::Writer {
                    &roots
                } else {
                    &[]
                },
                &app_path,
                access == Access::Writer && !request.require_existing,
            )
        })
        .await
        .map_err(message)??;
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(false)
                    .read_only(access == Access::Reader)
                    .foreign_keys(true)
                    .busy_timeout(Duration::from_secs(5)),
            )
            .await
            .map_err(message)?;
        // Windowsでは接続中の置き換えを共有モードで防ぎ、識別子を得られる媒体では再照合も行う。
        if !matches!(same_open_file(&file, &path), Ok(true)) {
            close_pool(&pool).await;
            return Err(
                "タイル管理DBが初期化中に置換されました。再起動して保存先を確認してください。"
                    .into(),
            );
        }
        Ok(OpenCatalog { path, pool })
    }

    pub fn owner_lock_path(&self) -> Result<PathBuf, String> {
        let opened = self
            .opened
            .get()
            .ok_or("タイル管理DBが初期化されていません。")?;
        Ok(lock_path(&opened.path))
    }

    pub fn path(&self) -> Option<&Path> {
        self.opened.get().map(|opened| opened.path.as_path())
    }

    /// 既存のロックだけを調べ、照会のためにロックファイルは作成しない。
    pub async fn owner_available(&self) -> Result<bool, String> {
        self.initialize().await?;
        let path = self.owner_lock_path()?;
        tokio::task::spawn_blocking(move || {
            let lock = match OpenOptions::new().read(true).write(true).open(path) {
                Ok(lock) => lock,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
                Err(error) => return Err(message(error)),
            };
            match lock.try_lock_exclusive() {
                Ok(()) => Ok(true),
                Err(_) => Ok(false),
            }
        })
        .await
        .map_err(message)?
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let lifecycle = self.lifecycle.clone();
        let opened = self.opened.clone();
        // 終了処理中に呼出元が取り消されても、後始末は完了させる。
        let closing = tokio::spawn(async move {
            let _lifecycle = lifecycle.lock_owned().await;
            if let Some(opened) = opened.get() {
                close_pool(&opened.pool).await;
            }
        });
        if let Err(error) = closing.await {
            tracing::error!(%error, "Local tile catalog shutdown task failed");
        }
    }

    pub(super) async fn pool(&self) -> Result<&SqlitePool, sqlx::Error> {
        self.initialize().await.map_err(sqlx::Error::Protocol)?;
        Ok(&self
            .opened
            .get()
            .expect("initialize established the catalog")
            .pool)
    }

    pub(super) async fn write_pool(&self) -> Result<&SqlitePool, sqlx::Error> {
        if self.access != Access::Writer {
            return Err(sqlx::Error::Protocol(
                "照会・取消用のcatalogから管理情報を変更できません。".into(),
            ));
        }
        self.pool().await
    }

    pub(super) async fn control_pool(&self) -> Result<&SqlitePool, sqlx::Error> {
        if self.access == Access::Reader {
            return Err(sqlx::Error::Protocol(
                "照会用のcatalogから取消を要求できません。".into(),
            ));
        }
        self.pool().await
    }
}

fn message(error: impl std::fmt::Display) -> String {
    format!("タイル管理DB: {error}")
}

/// SQLx 0.8では最後の許可待ちの間に、待機キューの最終回収後の接続が返却され、
/// close()の完了後もsize > 0になる場合がある。
/// 接続終了を繰り返して返却分を回収し、SQLiteワーカーの終了を待ってから
/// 管理DBのライフサイクルと所有権の排他を解放する。
async fn close_pool(pool: &SqlitePool) {
    loop {
        pool.close().await;
        if pool.size() == 0 {
            break;
        }
    }
}

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".owner.lock");
    PathBuf::from(name)
}

#[derive(Debug)]
struct FileIdentity {
    id: String,
    links: u64,
}

/// 同一操作中だけ必要なファイル情報。外部媒体ではファイル番号を取得できないことがある。
#[cfg(windows)]
fn handle_identity(file: &File) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO, FileIdInfo, GetFileInformationByHandle,
            GetFileInformationByHandleEx,
        },
    };
    let handle = HANDLE(file.as_raw_handle());
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) }.is_err() {
        // 一部の媒体では通常のファイル操作ができてもハンドルの追加情報を返さない。
        return Ok(FileIdentity {
            id: String::new(),
            links: 0,
        });
    }
    let mut identifier = FILE_ID_INFO::default();
    let extended = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut identifier as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    let id = if extended.is_ok() && identifier.FileId.Identifier.iter().any(|v| *v != 0) {
        let value: String = identifier
            .FileId
            .Identifier
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect();
        format!("windows:{}:{value}", identifier.VolumeSerialNumber)
    } else if info.nFileIndexHigh != 0 || info.nFileIndexLow != 0 {
        format!(
            "win32:{}:{:08x}{:08x}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        )
    } else {
        String::new()
    };
    Ok(FileIdentity {
        id,
        links: info.nNumberOfLinks.into(),
    })
}

#[cfg(unix)]
fn handle_identity(file: &File) -> Result<FileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(message)?;
    Ok(FileIdentity {
        id: format!("unix:{}:{}", metadata.dev(), metadata.ino()),
        links: metadata.nlink(),
    })
}

// 旧版の署名付き移設記録を検証するときだけ、識別子を必須とする。
fn file_identity(path: &Path) -> Result<FileIdentity, String> {
    let info = handle_identity(&File::open(path).map_err(message)?)?;
    if info.id.is_empty() {
        return Err("この媒体では旧版の移設記録に必要なファイル識別子を取得できません。".into());
    }
    Ok(info)
}

fn open_catalog_file(path: &Path) -> Result<File, String> {
    if !fs::metadata(path).map_err(message)?.is_file() {
        return Err(format!(
            "タイル管理DBの保存先が通常のファイルではありません。「データの保存先」で選び直してください。 {}",
            path.display()
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        options.share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0);
    }
    let file = options.open(path).map_err(message)?;
    if handle_identity(&file)?.links > 1 {
        return Err(
            "タイル管理DBのhard linkを使用できません。独立したファイルを指定してください。".into(),
        );
    }
    Ok(file)
}

fn same_open_file(file: &File, path: &Path) -> Result<bool, String> {
    let previous = handle_identity(file)?;
    let current = handle_identity(&open_catalog_file(path)?)?;
    Ok(previous.id.is_empty() || current.id.is_empty() || previous.id == current.id)
}

pub(crate) fn missing_catalog_message(path: &Path) -> String {
    format!(
        "タイル管理DBが見つからないか、空です。ドライブを接続するか「データの保存先」で選び直してください。 {}",
        path.display()
    )
}

/// パスを作成せずに既存のリンクを解決する。親階層だけが存在する場合も扱う。
fn physical_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path.canonicalize().map_err(message);
    }
    if path.symlink_metadata().is_ok() {
        return Err(
            "保存先にリンク先が存在しないリンクがあります。保存先を確認してください。".into(),
        );
    }
    let parent = path
        .parent()
        .ok_or("保存先の親ディレクトリがありません。")?;
    let name = path.file_name().ok_or("保存先のファイル名がありません。")?;
    Ok(physical_path(parent)?.join(name))
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.into_owned()
    }
}

impl DatabaseReplacement {
    /// 旧版の移設記録で指定された本体DB・管理DBを照合する。
    fn matches(&self, database_path: &Path, catalog_path: &Path, catalog_file_id: &str) -> bool {
        path_key(&self.database_path) == path_key(database_path)
            && path_key(&self.catalog_path) == path_key(catalog_path)
            && self.catalog_file_id == catalog_file_id
    }
}

fn same_or_below(path: &Path, root: &Path) -> bool {
    let path = path_key(path);
    let root = path_key(root);
    path == root
        || path.starts_with(
            &(root.trim_end_matches(['/', '\\']).to_string() + std::path::MAIN_SEPARATOR_STR),
        )
}

fn validate_filename(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("タイル管理DBには絶対ファイルパスを指定してください。".into());
    }
    for component in path.components() {
        match component {
            Component::ParentDir | Component::CurDir => {
                return Err("タイル管理DBのパスに . や .. は使用できません。".into());
            },
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or("タイル管理DBのパスを文字列として解釈できません。")?;
                if name.contains('\0') {
                    return Err("タイル管理DBのパスが不正です。".into());
                }
                #[cfg(windows)]
                {
                    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                    if name.contains(':')
                        || name.ends_with(['.', ' '])
                        || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
                        || (stem.len() == 4
                            && (stem.starts_with("COM") || stem.starts_with("LPT"))
                            && stem.as_bytes()[3].is_ascii_digit())
                    {
                        return Err("タイル管理DBのパスにWindowsの予約名・代替データストリームは使用できません。".into());
                    }
                }
            },
            _ => {},
        }
    }
    Ok(())
}

/// 明示的な新規作成だけが使う。通常の起動時には選択済みの保存先を作成しない。
pub(crate) fn create_empty_catalog(
    catalog: &Path,
    roots: &[PathBuf],
    app: &Path,
) -> Result<(), String> {
    validate_filename(catalog)?;
    let path = physical_path(catalog)?;
    let app = app.canonicalize().map_err(message)?;
    if path_key(&path) == path_key(&app) {
        return Err("本体DBとタイル管理DBには別のファイルを指定してください。".into());
    }
    for root in roots {
        let root = physical_path(root)?;
        if same_or_below(&path, &root) || same_or_below(&root, &path) {
            return Err("タイル管理DBとタイルの保存先が重なっています。".into());
        }
    }
    let parent = path
        .parent()
        .ok_or("タイル管理DBの親ディレクトリがありません。")?;
    if path.try_exists().map_err(message)? {
        return Err(format!(
            "タイル管理DBの保存先に既存のファイルがあります。 {}",
            path.display()
        ));
    }
    fs::create_dir_all(parent).map_err(message)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path(&path))
        .map_err(message)?;
    lock.try_lock_exclusive()
        .map_err(|_| "ほかの処理がタイル管理DBを使用しています。".to_string())?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::symlink_metadata(Path::new(&sidecar)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(message(error)),
            Ok(_) => {
                return Err(
                    "SQLiteの関連ファイルが残っています。元の管理DBの場所を確認してください。"
                        .into(),
                );
            },
        }
    }
    // 新規DBを同じファイルシステムで完成させ、競合して先に作られたDBも上書きしない。
    let staging = tempfile::tempdir_in(parent).map_err(message)?;
    let fresh = tempfile::NamedTempFile::new_in(staging.path())
        .map_err(message)?
        .into_temp_path();
    let app = app
        .to_str()
        .ok_or("本体DBのパスを文字列として解釈できません。")?;
    let (_, file) = prepare(&fresh, roots, app, true)?;
    drop(file);
    File::options()
        .write(true)
        .open(&fresh)
        .and_then(|file| file.sync_all())
        .map_err(message)?;
    fresh.persist_noclobber(&path).map_err(message)?;
    Ok(())
}

/// 初期設定の再試行では、先に公開済みの正しいカタログをそのまま利用できる。
pub(crate) fn initialize_setup_catalog(
    settings: &crate::model::ApplicationInitSetup,
) -> Result<(), String> {
    let config = LocalTileConfig::from_setup(settings)?;
    let roots = [config.dataset_path, config.cache_path, config.work_path];
    let path = &config.catalog_database_path;
    let app = &settings.sqlite_database_path;
    if path.try_exists().map_err(message)? {
        prepare(
            path,
            &roots,
            app.to_str().ok_or("本体DBのパスを読み取れません。")?,
            false,
        )?;
        return Ok(());
    }
    create_empty_catalog(path, &roots, app)
}

fn prepare(
    configured: &Path,
    roots: &[PathBuf],
    app_path: &str,
    allow_create: bool,
) -> Result<(PathBuf, File), String> {
    validate_filename(configured)?;
    if !allow_create && !configured.try_exists().map_err(message)? {
        return Err(missing_catalog_message(configured));
    }
    let path = physical_path(configured)?;
    // 照会・取消は生成保存先を操作しない。別ディスクの障害でも既存履歴を読めるようにする。
    for root in roots {
        let root = physical_path(root)?;
        if same_or_below(&path, &root) || same_or_below(&root, &path) {
            return Err(
                "タイル管理DBを完成DB・PNG・作業ディレクトリと重なる場所には保存できません。"
                    .into(),
            );
        }
    }
    let app_path = if app_path.is_empty() {
        PathBuf::new()
    } else {
        let actual = Path::new(app_path).canonicalize().map_err(message)?;
        if path_key(&actual) == path_key(&path) {
            return Err("本体DBとタイル管理DBには別のファイルを指定してください。".into());
        }
        actual
    };
    if path.try_exists().map_err(message)? {
        let file = open_catalog_file(&path)?;
        if matches!(inspect(&path)?, Existing::Catalog) {
            return Ok((path, file));
        }
    }
    if !allow_create {
        return Err(missing_catalog_message(&path));
    }
    fs::create_dir_all(path.parent().ok_or("タイル管理DBの親がありません。")?).map_err(message)?;
    // 新規作成とスキーマ更新の両方を、実行基盤と同じ所有者ロックで保護する。
    let owner_path = lock_path(&path);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(owner_path)
        .map_err(message)?;
    lock.try_lock_exclusive()
        .map_err(|_| "別プロセスがタイル管理DBを初期化・使用しています。".to_string())?;
    // 事前検査からロック取得までの間に、別の接続元が先に作成を終えている場合がある。
    if path.try_exists().map_err(message)? {
        let file = open_catalog_file(&path)?;
        if matches!(inspect(&path)?, Existing::Catalog) {
            return Ok((path, file));
        }
    }
    let mut connection = Connection::open(&path).map_err(message)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(message)?;
    if !empty_database(&connection)? {
        return Err(
            "タイル管理DBの初期化対象が事前検査後に変わりました。既存データは変更しません。".into(),
        );
    }
    let mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(message)?;
    if mode != "wal" {
        return Err("タイル管理DBのWALを有効にできません。".into());
    }
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(message)?;
    let file = open_catalog_file(&path)?;
    // 実際の書込接続でも再検査し、読取専用の事前検査から所有者ロック取得までの間に
    // 出現したDBを誤って初期化しない。
    if !empty_database(&tx)? {
        return Err(
            "タイル管理DBの初期化対象が事前検査後に変わりました。既存データは変更しません。".into(),
        );
    }
    tx.execute_batch(SCHEMA).map_err(message)?;
    tx.execute(
        r#"
        INSERT INTO tile_catalog_schema (version, checksum)
        VALUES (?, ?)
        "#,
        (VERSION, checksum()),
    )
    .map_err(message)?;
    // 旧版の移設CLI向けに作成時の情報を残す。通常の利用にはこの行の一致を要求しない。
    let app_id = if app_path.as_os_str().is_empty() {
        String::new()
    } else {
        handle_identity(&File::open(&app_path).map_err(message)?)?.id
    };
    tx.execute(
        r#"
        INSERT INTO tile_catalog_binding (id, app_database_path, app_file_id)
        VALUES (1, ?, ?)
        "#,
        (app_path.to_string_lossy(), &app_id),
    )
    .map_err(message)?;
    tx.pragma_update(None, "application_id", APPLICATION_ID)
        .map_err(message)?;
    tx.pragma_update(None, "user_version", VERSION)
        .map_err(message)?;
    tx.commit().map_err(message)?;
    drop(connection);
    inspect(&path)?;
    Ok((path, file))
}

enum Existing {
    Empty,
    Catalog,
}

fn checksum() -> String {
    format!(
        "{:x}",
        Sha256::digest(SCHEMA.replace("\r\n", "\n").as_bytes())
    )
}

type SchemaEntry = (String, String, String, Option<String>);

fn empty_database(connection: &Connection) -> Result<bool, String> {
    let id: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(message)?;
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(message)?;
    Ok(id == 0 && version == 0 && schema(connection)?.is_empty())
}

fn schema(connection: &Connection) -> Result<Vec<SchemaEntry>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT type, name, tbl_name, sql
            FROM sqlite_schema
            WHERE name NOT GLOB 'sqlite_*'
            ORDER BY type, name
            "#,
        )
        .map_err(message)?;
    statement
        .query_map([], |row| {
            let sql: Option<String> = row.get(3)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                sql.map(|sql| sql.split_whitespace().collect::<Vec<_>>().join(" ")),
            ))
        })
        .map_err(message)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(message)
}

fn inspect(path: &Path) -> Result<Existing, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(message)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(message)?;
    if empty_database(&connection)? {
        return Ok(Existing::Empty);
    }
    validate_catalog(&connection)?;
    Ok(Existing::Catalog)
}

fn validate_catalog_format(connection: &Connection) -> Result<(), String> {
    let application_id: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(message)?;
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(message)?;
    let actual_schema = schema(connection)?;
    if application_id == 0 && version == 0 && actual_schema.is_empty() {
        return Err("初期化済みのタイル管理DBがありません。".into());
    }
    if application_id != APPLICATION_ID {
        return Err("指定ファイルはタイル管理DBではありません。既存DBは変更しません。".into());
    }
    if version != VERSION {
        return Err(format!(
            "タイル管理DBの版{version}には対応していません（対応版{VERSION}）。"
        ));
    }
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(message)?;
    if journal_mode != "wal" {
        return Err("タイル管理DBのjournal modeがWALではありません。".into());
    }
    let expected = Connection::open_in_memory().map_err(message)?;
    expected.execute_batch(SCHEMA).map_err(message)?;
    if actual_schema != schema(&expected)? {
        return Err("タイル管理DBのschemaが既知の定義と一致しません。".into());
    }
    let stored_checksum: String = connection
        .query_row(
            r#"
            SELECT checksum
            FROM tile_catalog_schema
            WHERE version = ?
            "#,
            [VERSION],
            |row| row.get(0),
        )
        .map_err(message)?;
    if stored_checksum != checksum() {
        return Err("タイル管理DBのschema履歴が一致しません。".into());
    }
    Ok(())
}

fn validate_catalog(connection: &Connection) -> Result<(), String> {
    validate_catalog_format(connection)?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(message)?;
    if check != "ok" {
        return Err("タイル管理DBの整合性検査に失敗しました。".into());
    }
    let mut fk = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(message)?;
    if fk
        .query([])
        .map_err(message)?
        .next()
        .map_err(message)?
        .is_some()
    {
        return Err("タイル管理DBの外部キーに不整合があります。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn configured_startup_verifies_existing_app_and_never_recreates_a_missing_catalog() {
        use crate::db::pool::setup_database_pool_with_settings;
        use crate::init::read_env_json;
        use crate::local_tiles::cli::{self, Command, Invocation};
        use serde_json::json;

        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_path_buf();
        fs::write(directory.join("geocode-web-single.env.json"), json!({
            "app_title":"地図", "access_token_exp_minutes":"30", "refresh_token_exp_minutes":"60",
            "secret_key":"test-secret", "admin_username":"admin", "admin_passwotd":"test-password",
            "failed_account_lock":"5", "next_challenge_minutes":"5", "challenge_limit_time_failed_count":"3"
        }).to_string()).unwrap();
        let settings = read_env_json(&directory).unwrap();
        let app = settings.sqlite_database_path.clone();
        let catalog = PathBuf::from(&settings.tile_catalog_database_path);
        assert!(setup_database_pool_with_settings(&settings).await.is_err());
        assert!(!app.exists());
        let original = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&app)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        crate::db::run_migrations(&original).await.unwrap();
        let writer = TileCatalog::new(catalog.clone(), original.clone());
        writer.initialize().await.unwrap();
        writer.close().await;
        close_pool(&original).await;
        let config = LocalTileConfig::from_setup(&settings).unwrap();
        let previous = directory.join("元の本体DB.sqlite");
        fs::rename(&app, &previous).unwrap();
        assert!(setup_database_pool_with_settings(&settings).await.is_err());
        assert!(!app.exists());
        let mut mismatched = settings.clone();
        mismatched.sqlite_database_path = directory.join("別の保存先.sqlite");
        assert!(
            setup_database_pool_with_settings(&mismatched)
                .await
                .is_err()
        );
        assert!(!mismatched.sqlite_database_path.exists());

        // 別用途のSQLiteを通常起動が自動でマイグレーションする前に拒否する。
        Connection::open(&app)
            .unwrap()
            .execute_batch("CREATE TABLE other (id INTEGER)")
            .unwrap();
        let original_bytes = fs::read(&app).unwrap();
        assert!(
            setup_database_pool_with_settings(&settings)
                .await
                .unwrap_err()
                .to_string()
                .contains("本体DBを指定")
        );
        assert_eq!(fs::read(&app).unwrap(), original_bytes);
        fs::rename(&app, directory.join("別形式.sqlite")).unwrap();
        fs::copy(&previous, &app).unwrap();
        // 対応する旧版のバックアップは、従来の通常起動でアップグレードできる。
        let old = Connection::open(&app).unwrap();
        old.execute_batch("DELETE FROM schema_migrations WHERE version >= 32")
            .unwrap();
        drop(old);
        let pool = setup_database_pool_with_settings(&settings).await.unwrap();
        crate::db::pool::validate_existing_schema(&pool)
            .await
            .unwrap();
        let reader = TileCatalog::read_only(catalog.clone(), pool.clone()).with_config(&config);
        reader.initialize().await.unwrap();
        reader.close().await;

        // 設定済みカタログの消失時は、照会を未使用とみなしたり空のDBを作ったりしない。
        fs::rename(&catalog, directory.join("移動した管理DB.sqlite")).unwrap();
        let status = Invocation {
            command: Command::Status,
            json: true,
            config_path: None,
        };
        let error = cli::execute(&status, config.clone(), Some(pool.clone()))
            .await
            .err()
            .expect("登録済みのカタログの消失を通知する");
        assert!(error.to_string().contains("データの保存先"));
        let writer = TileCatalog::new(catalog.clone(), pool.clone()).with_config(&config);
        assert!(
            writer
                .initialize()
                .await
                .unwrap_err()
                .contains("データの保存先")
        );
        assert!(!catalog.exists());
        fs::write(&catalog, []).unwrap();
        assert!(
            writer
                .initialize()
                .await
                .unwrap_err()
                .contains("データの保存先")
        );
        assert_eq!(fs::metadata(&catalog).unwrap().len(), 0);
        writer.close().await;
        close_pool(&pool).await;
        fs::rename(&app, directory.join("バックアップ.sqlite")).unwrap();
        assert!(setup_database_pool_with_settings(&settings).await.is_err());
        assert!(!app.exists());
    }

    #[tokio::test]
    async fn shutdown_drains_a_connection_returned_during_the_final_permit_wait() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("late-return.sqlite");
        let returning = Arc::new(tokio::sync::Notify::new());
        let release_return = Arc::new(tokio::sync::Notify::new());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .after_release({
                let returning = returning.clone();
                let release_return = release_return.clone();
                move |_, _| {
                    let returning = returning.clone();
                    let release_return = release_return.clone();
                    Box::pin(async move {
                        // SQLxの返却経路では既に接続終了の検査を通過しているため、
                        // この接続を待機キューへ戻す処理を遅らせる。
                        returning.notify_one();
                        release_return.notified().await;
                        Ok(true)
                    })
                }
            })
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        let mut connection = pool.acquire().await.unwrap();
        sqlx::query("CREATE TABLE data(value TEXT)")
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);
        tokio::time::timeout(Duration::from_secs(5), returning.notified())
            .await
            .unwrap();
        let closing = {
            let pool = pool.clone();
            tokio::spawn(async move { close_pool(&pool).await })
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while !pool.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            !closing.is_finished(),
            "shutdown must wait for the returning connection"
        );
        release_return.notify_one();
        tokio::time::timeout(Duration::from_secs(5), closing)
            .await
            .unwrap()
            .unwrap();
        assert!(pool.is_closed());
        assert_eq!(pool.size(), 0);
        // SQLxの終了時の接続回収では、参考値であるnum_idleは更新されない。
        // 終了を保証するのはsizeとOSのファイルハンドルである。
        // WindowsではSQLiteワーカーが残っていると、この名前変更が直ちに拒否される。
        fs::rename(path, root.path().join("moved.sqlite")).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn aborted_initializer_and_close_callers_cannot_detach_native_preparation() {
        let root = tempfile::tempdir().unwrap();
        let app_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(root.path().join("app.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        let path = root.path().join("catalog.sqlite");
        let catalog = Arc::new(TileCatalog::new(path.clone(), app_pool.clone()));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let entered_tx = std::sync::Mutex::new(Some(entered_tx));
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = std::sync::Mutex::new(release_rx);
        *catalog.prepare_hook.lock().unwrap() = Some(Arc::new(move || {
            if let Some(entered) = entered_tx.lock().unwrap().take() {
                let _ = entered.send(());
            }
            // 送信側の破棄でも失敗したテストの待機を解くことで、panic発生時に
            // 同期ワーカーがテスト実行環境を永久に待機させないようにする。
            let _ = release_rx.lock().unwrap().recv();
        }));
        let opening = {
            let catalog = catalog.clone();
            tokio::spawn(async move { catalog.initialize().await })
        };
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        opening.abort();
        assert!(opening.await.unwrap_err().is_cancelled());
        let mut closing = {
            let catalog = catalog.clone();
            tokio::spawn(async move { catalog.close().await })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(40), &mut closing)
                .await
                .is_err(),
            "close returned while the detached native preparation was blocked"
        );
        assert!(!path.exists());
        // 接続終了の呼出元を取り消しても、後始末は取り消さない。
        closing.abort();
        assert!(closing.await.unwrap_err().is_cancelled());
        let mut final_close = {
            let catalog = catalog.clone();
            tokio::spawn(async move { catalog.close().await })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(40), &mut final_close)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), final_close)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !path.exists(),
            "shutdown should cancel preparation before schema creation"
        );
        assert!(catalog.initialize().await.is_err());
        assert!(catalog.pool().await.is_err());
        app_pool.close().await;
    }
}
