//! 管理DBへの接続はこのモジュールに限定し、本体のマイグレーションから独立させる。

use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, OnceCell};

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
    storage_roots: Vec<PathBuf>,
    app_pool: SqlitePool,
    closed: Arc<AtomicBool>,
    access: Access,
    #[cfg(test)]
    prepare_hook: Option<PrepareHook>,
}

/// 独立した識別情報を持ち、単一の本体DBと継続して対応付ける管理DB。
/// 管理DBの操作へ本体DBの接続プールを誤って渡せない構成にする。
pub struct TileCatalog {
    configured_path: PathBuf,
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
        let rows = sqlx::query("PRAGMA database_list")
            .fetch_all(&request.app_pool)
            .await
            .map_err(message)?;
        let app_path = rows
            .iter()
            .find(|row| row.get::<String, _>("name") == "main")
            .ok_or("本体DBの接続先を確認できません。")?
            .get::<String, _>("file");
        let memory_id = memory_binding(&request.app_pool);
        let path = request.configured_path;
        let roots = request.storage_roots;
        let access = request.access;
        let (path, identity) = tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(hook) = request.prepare_hook {
                hook();
            }
            if request.closed.load(Ordering::Acquire) {
                return Err("タイル管理DBは終了処理中です。".into());
            }
            prepare(
                &path,
                &roots,
                &app_path,
                &memory_id,
                access == Access::Writer,
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
        if file_identity(&path).map(|value| value.id) != Ok(identity) {
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

/// 接続プール設定のアドレスは実行中の検索キーに限り、永続化するIDには使わない。
/// 弱参照と新しいUUIDを組み合わせ、アドレスの再利用によって保存済みの管理DBが
/// 後から作られた無関係なメモリDBへ対応付けられることを防ぐ。
fn memory_binding(pool: &SqlitePool) -> String {
    type Entry = (Weak<SqliteConnectOptions>, String);
    static BINDINGS: OnceLock<std::sync::Mutex<HashMap<usize, Entry>>> = OnceLock::new();
    let options = pool.connect_options();
    let mut bindings = BINDINGS.get_or_init(Default::default).lock().unwrap();
    bindings.retain(|_, (weak, _)| weak.strong_count() > 0);
    bindings
        .entry(Arc::as_ptr(&options) as usize)
        .or_insert_with(|| {
            (
                Arc::downgrade(&options),
                format!("memory:{}", uuid::Uuid::new_v4()),
            )
        })
        .1
        .clone()
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

#[cfg(windows)]
fn file_identity(path: &Path) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO, FileIdInfo, GetFileInformationByHandle,
            GetFileInformationByHandleEx,
        },
    };
    let file = File::open(path).map_err(message)?;
    let handle = HANDLE(file.as_raw_handle());
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let mut identifier = FILE_ID_INFO::default();
    unsafe {
        GetFileInformationByHandle(handle, &mut information).map_err(message)?;
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut identifier as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
        .map_err(message)?;
    }
    let file_id: String = identifier
        .FileId
        .Identifier
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(FileIdentity {
        id: format!("windows:{}:{file_id}", identifier.VolumeSerialNumber),
        links: information.nNumberOfLinks.into(),
    })
}

#[cfg(unix)]
fn file_identity(path: &Path) -> Result<FileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = File::open(path)
        .and_then(|file| file.metadata())
        .map_err(message)?;
    Ok(FileIdentity {
        id: format!("unix:{}:{}", metadata.dev(), metadata.ino()),
        links: metadata.nlink(),
    })
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

fn prepare(
    configured: &Path,
    roots: &[PathBuf],
    app_path: &str,
    memory_id: &str,
    allow_create: bool,
) -> Result<(PathBuf, String), String> {
    validate_filename(configured)?;
    let path = physical_path(configured)?;
    // 照会・取消は生成保存先を操作しない。別ディスクの障害でも既存履歴を読めるようにする。
    if allow_create {
        for root in roots {
            let root = physical_path(root)?;
            if same_or_below(&path, &root) || same_or_below(&root, &path) {
                return Err(
                    "タイル管理DBを完成DB・PNG・作業ディレクトリと重なる場所には保存できません。"
                        .into(),
                );
            }
        }
    }
    let (app_path, app_id) = if app_path.is_empty() {
        (String::new(), memory_id.to_string())
    } else {
        let actual = Path::new(app_path).canonicalize().map_err(message)?;
        let identity = file_identity(&actual)?;
        if path_key(&actual) == path_key(&path) {
            return Err("本体DBとタイル管理DBには別のファイルを指定してください。".into());
        }
        if path.exists() && file_identity(&path)?.id == identity.id {
            return Err("本体DBと同一ファイルをタイル管理DBに指定できません。".into());
        }
        (
            actual
                .to_str()
                .ok_or("本体DBのパスを解釈できません。")?
                .to_string(),
            identity.id,
        )
    };
    if path.exists() {
        let identity = file_identity(&path)?;
        if identity.links != 1 {
            return Err(
                "タイル管理DBにhard linkを使用できません。独立したファイルを指定してください。"
                    .into(),
            );
        }
        match inspect(&path, &app_path, &app_id)? {
            Existing::Catalog => return Ok((path, identity.id)),
            Existing::Empty => {},
        }
    }
    if !allow_create {
        return Err(
            "初期化済みのタイル管理DBがありません。先に登録または取り込みを実行してください。"
                .into(),
        );
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
    if path.exists() {
        let identity = file_identity(&path)?;
        if identity.links != 1 || identity.id == app_id {
            return Err("タイル管理DBの保存先に同一ファイル・hard linkの競合があります。".into());
        }
        if matches!(inspect(&path, &app_path, &app_id)?, Existing::Catalog) {
            return Ok((path, identity.id));
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
    let identity = file_identity(&path)?;
    if identity.links != 1 || identity.id == app_id {
        return Err("タイル管理DBの保存先に同一ファイル・hard linkの競合があります。".into());
    }
    // 実際の書込接続でも再検査し、読取専用の事前検査から所有者ロック取得までの間に
    // 出現したDBを誤って初期化しない。
    if !empty_database(&tx)? {
        return Err(
            "タイル管理DBの初期化対象が事前検査後に変わりました。既存データは変更しません。".into(),
        );
    }
    tx.execute_batch(SCHEMA).map_err(message)?;
    tx.execute(
        "INSERT INTO tile_catalog_schema(version,checksum) VALUES (?,?)",
        (VERSION, checksum()),
    )
    .map_err(message)?;
    tx.execute(
        "INSERT INTO tile_catalog_binding(id,app_database_path,app_file_id) VALUES (1,?,?)",
        (&app_path, &app_id),
    )
    .map_err(message)?;
    tx.pragma_update(None, "application_id", APPLICATION_ID)
        .map_err(message)?;
    tx.pragma_update(None, "user_version", VERSION)
        .map_err(message)?;
    tx.commit().map_err(message)?;
    drop(connection);
    let identity = file_identity(&path)?;
    if identity.links != 1 {
        return Err("タイル管理DBのhard linkを検出しました。".into());
    }
    inspect(&path, &app_path, &app_id)?;
    Ok((path, identity.id))
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
    let mut statement = connection.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").map_err(message)?;
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

fn inspect(path: &Path, app_path: &str, app_id: &str) -> Result<Existing, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(message)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(message)?;
    let application_id: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(message)?;
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(message)?;
    let actual_schema = schema(&connection)?;
    if application_id == 0 && version == 0 && actual_schema.is_empty() {
        return Ok(Existing::Empty);
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
            "SELECT checksum FROM tile_catalog_schema WHERE version = ?",
            [VERSION],
            |row| row.get(0),
        )
        .map_err(message)?;
    if stored_checksum != checksum() {
        return Err("タイル管理DBのschema履歴が一致しません。".into());
    }
    let binding: (String, String) = connection
        .query_row(
            "SELECT app_database_path,app_file_id FROM tile_catalog_binding WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(message)?;
    if path_key(Path::new(&binding.0)) != path_key(Path::new(app_path)) || binding.1 != app_id {
        return Err("このタイル管理DBは別の本体DBに対応しています。本体DBの移設・復元時は対応付けを確認してください。".into());
    }
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
    Ok(Existing::Catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

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
