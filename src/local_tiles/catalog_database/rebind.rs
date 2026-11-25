//! 明示的な移設操作。通常起動の対応確認や生成runtimeを経由しない。
use super::{file_identity, lock_path, path_key, validate_catalog, validate_filename};
use crate::{
    init::read_env_json_readonly,
    local_tiles::config::{DatabaseReplacement, LocalTileConfig},
    tilegen::cancel::CancellationToken,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use fs2::FileExt;
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    str::FromStr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[path = "relocation.rs"]
pub mod relocation;
#[path = "storage.rs"]
pub mod storage;

type Result<T> = std::result::Result<T, String>;
const PLAN_LIFETIME: u64 = 900;
const PROOF_LIFETIME: u64 = 7 * 86400;

pub async fn run(
    config_path: PathBuf,
    request: Request,
    cancellation: CancellationToken,
) -> Result<Value> {
    tokio::task::spawn_blocking(move || {
        let mut last = std::time::Instant::now() - Duration::from_secs(1);
        execute(
            &config_path,
            request,
            &cancellation,
            &mut |stage, completed| {
                if last.elapsed() >= Duration::from_millis(500) {
                    eprintln!("catalog rebind: {stage} ({completed})");
                    last = std::time::Instant::now();
                }
                Ok(())
            },
        )
    })
    .await
    .map_err(message)?
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Inspect,
    Prepare {
        output: PathBuf,
    },
    Plan {
        source_database: Option<PathBuf>,
        proof: Option<PathBuf>,
    },
    Apply {
        plan: Signed<Plan>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub path: PathBuf,
    pub file_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signed<T> {
    pub payload: T,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub sha256: String,
    pub rows: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub version: u32,
    pub id: String,
    pub created: u64,
    pub expires: u64,
    pub config_sha256: String,
    pub catalog: Binding,
    pub previous: Binding,
    pub target: Binding,
    pub original: Option<Binding>,
    pub application: Snapshot,
    pub catalog_contents: Snapshot,
    pub evidence: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    version: u32,
    created: u64,
    expires: u64,
    binding: Binding,
    application: Snapshot,
    catalog_contents: Snapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    plan_sha256: String,
    plan_id: String,
    previous: Binding,
    target: Binding,
    backup: PathBuf,
    state: String,
}

struct Context {
    config_path: PathBuf,
    config_sha256: String,
    catalog: Binding,
    target: Binding,
    replacement: Option<DatabaseReplacement>,
    key: Vec<u8>,
    config_pins: Vec<File>,
    _pins: Vec<File>,
}

struct Control<'a> {
    cancellation: &'a CancellationToken,
    progress: &'a mut dyn FnMut(&str, u64) -> Result<()>,
}
impl Control<'_> {
    fn tick(&mut self, stage: &str, completed: u64) -> Result<()> {
        if self.cancellation.is_cancelled() {
            return Err("移設処理を取り消しました。対応付けは変更していません。".into());
        }
        (self.progress)(stage, completed)
    }
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(message)
}
fn bytes_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(message)
}

fn sign<T: Serialize>(key: &[u8], purpose: &str, payload: T) -> Result<Signed<T>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(message)?;
    mac.update(purpose.as_bytes());
    mac.update(&[0]);
    mac.update(&encoded(&payload)?);
    Ok(Signed {
        payload,
        signature: mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect(),
    })
}
fn verify<T: Serialize>(key: &[u8], purpose: &str, signed: &Signed<T>) -> Result<()> {
    if signed.signature.len() != 64 {
        return Err("移設記録の署名が不正です。".into());
    }
    let decoded = signed
        .signature
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(message)?;
            u8::from_str_radix(text, 16).map_err(message)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(message)?;
    mac.update(purpose.as_bytes());
    mac.update(&[0]);
    mac.update(&encoded(&signed.payload)?);
    mac.verify_slice(&decoded)
        .map_err(|_| "移設記録が変更されたか、元の設定の暗号鍵と一致しません。".into())
}

pub fn read_document<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let _pins = pin(path, false)?;
    let file = File::open(path).map_err(message)?;
    if file.metadata().map_err(message)?.len() > 1024 * 1024 {
        return Err("移設記録の容量が上限を超えています。".into());
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(message)?;
    if bytes.len() > 1024 * 1024 {
        return Err("移設記録の容量が上限を超えています。".into());
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|_| "移設記録の形式が不正です。".into())
}

fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

// ファイルと親ディレクトリのrename/deleteを抑止し、検査後のパス差し替えを防ぐ。
// 本体DBは書込共有も許可しない。稼働中の通常アプリがRW接続を持つ場合も拒否する。
fn pin(path: &Path, freeze: bool) -> Result<Vec<File>> {
    validate_filename(path)?;
    pin_components(path, freeze)
}

fn pin_components(path: &Path, freeze: bool) -> Result<Vec<File>> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        use windows::{Win32::Storage::FileSystem::GetDriveTypeW, core::PCWSTR};
        match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                    let root = [drive as u16, b':' as u16, b'\\' as u16, 0];
                    if unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } == 4 {
                        return Err("ネットワークドライブの移設操作には対応していません。".into());
                    }
                },
                _ => {
                    return Err(
                        "移設操作はローカルドライブの通常ファイルだけに対応しています。".into(),
                    );
                },
            },
            _ => return Err("ローカルドライブの絶対パスを指定してください。".into()),
        }
    }
    let mut current = PathBuf::new();
    let mut files = Vec::new();
    for part in path.components() {
        current.push(part.as_os_str());
        if matches!(part, std::path::Component::Prefix(_)) {
            continue;
        }
        let meta = fs::symlink_metadata(&current).map_err(message)?;
        if is_link(&meta) {
            return Err(
                "移設対象・親ディレクトリにリンクや再解析ポイントは使用できません。".into(),
            );
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(if freeze && meta.is_file() { 1 } else { 3 });
            if meta.is_dir() {
                options.custom_flags(0x02000000);
            }
        }
        #[cfg(unix)]
        if meta.is_dir() {
            continue;
        }
        files.push(options.open(&current).map_err(|error| {
            format!(
                "移設対象を保護できません。アプリ・サーバー・生成処理を終了してください: {error}"
            )
        })?);
    }
    if path.is_file() && file_identity(path)?.links != 1 {
        return Err("移設対象のhard linkは使用できません。".into());
    }
    Ok(files)
}

fn binding(path: &Path) -> Result<Binding> {
    let actual = path.canonicalize().map_err(message)?;
    Ok(Binding {
        file_id: file_identity(&actual)?.id,
        path: actual,
    })
}
fn same(a: &Binding, b: &Binding) -> bool {
    path_key(&a.path) == path_key(&b.path) && a.file_id == b.file_id
}

fn open_readonly(path: &Path) -> Result<Connection> {
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    let shm = PathBuf::from(format!("{}-shm", path.display()));
    if wal.is_file() && fs::metadata(&wal).map_err(message)?.len() > 0 && !shm.is_file() {
        return Err(
            "WALとSHMの組合せを確認できません。正常終了した一式を保全して確認してください。".into(),
        );
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(message)?;
    unsafe {
        rusqlite::ffi::sqlite3_limit(
            conn.handle(),
            rusqlite::ffi::SQLITE_LIMIT_LENGTH,
            32 * 1024 * 1024,
        );
        rusqlite::ffi::sqlite3_limit(
            conn.handle(),
            rusqlite::ffi::SQLITE_LIMIT_SQL_LENGTH,
            2 * 1024 * 1024,
        );
        rusqlite::ffi::sqlite3_limit(conn.handle(), rusqlite::ffi::SQLITE_LIMIT_ATTACHED, 0);
    }
    conn.busy_timeout(Duration::from_secs(2)).map_err(message)?;
    conn.execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;")
        .map_err(message)?;
    Ok(conn)
}

fn signing_key(saved: &Value, settings: &crate::model::ApplicationInitSetup) -> Result<Vec<u8>> {
    let raw_key = saved["tile_settings_encryption_key"]
        .as_str()
        .filter(|v| *v == settings.tile_settings_encryption_key)
        .ok_or("保存済みのタイル設定暗号鍵が必要です。元の設定JSONを引き継いでください。")?;
    let master = STANDARD
        .decode(raw_key)
        .map_err(|_| "タイル設定暗号鍵が不正です。")?;
    if master.len() != 32 {
        return Err("タイル設定暗号鍵が不正です。".into());
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(&master).map_err(message)?;
    mac.update(b"geocode-catalog-relocation-key-v1");
    Ok(mac.finalize().into_bytes().to_vec())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenFor {
    Inspect,
    Maintenance,
}

impl Context {
    fn with_locations(
        config_path: &Path,
        purpose: OpenFor,
        paths: Option<&storage::Locations>,
    ) -> Result<Self> {
        let config_pins = pin(config_path, true)?;
        let mut pins = Vec::new();
        let config_path = config_path.canonicalize().map_err(message)?;
        let raw = fs::read(&config_path).map_err(message)?;
        let saved: Value = serde_json::from_slice(&raw).map_err(message)?;
        let mut settings = if paths.is_some() {
            crate::init::read_relocation_settings(&config_path)
        } else {
            read_env_json_readonly(&config_path)
        }
        .map_err(message)?;
        if let Some(paths) = paths {
            paths.set(&mut settings)?;
        }
        let key = signing_key(&saved, &settings)?;
        // 旧版で署名された中断記録とCLIの移設確認だけに過去の許可を使用する。
        let replacement = saved
            .get("tile_database_replacement")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let config = LocalTileConfig::from_setup(&settings)?;
        let options = SqliteConnectOptions::from_str(&settings.database_url).map_err(message)?;
        if options
            .clone()
            .filename("relocation-probe")
            .to_url_lossy()
            .query_pairs()
            .any(|(key, value)| key == "mode" && value == "memory")
        {
            return Err("メモリDBには移設操作を使用できません。".into());
        }
        let app = options.get_filename();
        if !app.is_absolute() {
            return Err("移設操作のdatabase_urlには本体DBの絶対パスが必要です。".into());
        }
        pins.extend(
            pin(app, purpose != OpenFor::Inspect)
                .map_err(|e| format!("本体DBを確認できません。 {}　{e}", app.display()))?,
        );
        let target = binding(app)?;
        if settings
            .sqlite_database_path
            .canonicalize()
            .map_err(message)?
            != target.path
        {
            return Err("database_urlとsqlite_database_pathが同じ本体DBを指していません。".into());
        }
        let catalog_path = super::physical_path(&config.catalog_database_path)?;
        let roots = [config.dataset_path, config.cache_path, config.work_path];
        for root in &roots {
            let root = super::physical_path(root)?;
            if super::same_or_below(&catalog_path, &root)
                || super::same_or_below(&root, &catalog_path)
            {
                return Err("catalogとタイル保存先が重なっています。".into());
            }
        }
        let conn = open_readonly(&target.path)?;
        crate::db::pool::validate_existing_schema_sync(&conn)?;
        let result: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(message)?;
        if result != "ok" {
            return Err("本体DBの整合性検査に失敗しました。".into());
        }
        pins.extend(pin(&config.catalog_database_path, false).map_err(|e| {
            format!(
                "タイル管理DBを確認できません。 {}　{e}",
                config.catalog_database_path.display()
            )
        })?);
        let catalog = binding(&config.catalog_database_path)?;
        if catalog.file_id == target.file_id {
            return Err("本体DBとcatalogには別のファイルが必要です。".into());
        }
        Ok(Self {
            config_path,
            config_sha256: bytes_hash(&raw),
            catalog,
            target,
            replacement,
            key,
            config_pins,
            _pins: pins,
        })
    }
    fn accepts(&self, stored: &Binding, actual: &Binding) -> bool {
        same(stored, actual)
            || (path_key(&stored.path) == path_key(&actual.path)
                && self.replacement.as_ref().is_some_and(|rule| {
                    rule.matches(&actual.path, &self.catalog.path, &self.catalog.file_id)
                }))
    }

    fn recheck(&self) -> Result<()> {
        if !same(&binding(&self.target.path)?, &self.target)
            || !same(&binding(&self.catalog.path)?, &self.catalog)
            || bytes_hash(&fs::read(&self.config_path).map_err(message)?) != self.config_sha256
        {
            return Err(
                "確認後に設定またはDBが変更されました。新しい計画を作成してください。".into(),
            );
        }
        Ok(())
    }
}

// 所有者ロックと本体DBの保護を取得した明示操作からだけ呼ぶ。通常の照会では書き込まない。
fn record_accepted_binding(ctx: &Context, expected: &Binding) -> Result<()> {
    if same(expected, &ctx.target) {
        return Ok(());
    }
    if !ctx.accepts(expected, &ctx.target) {
        return Err(
            "この本体DBとタイル管理DBの組み合わせには差し替えが許可されていません。".into(),
        );
    }
    let mut db = Connection::open_with_flags(&ctx.catalog.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(message)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(message)?;
    if stored_binding(&tx)? != *expected {
        return Err("タイル管理DBの対応先が変更されました。もう一度確認してください。".into());
    }
    ctx.recheck()?;
    let changed = tx
        .execute(
            r#"
        UPDATE tile_catalog_binding
        SET app_file_id = ?1
        WHERE id = 1 AND app_database_path = ?2 AND app_file_id = ?3
        "#,
            (
                &ctx.target.file_id,
                expected.path.to_string_lossy(),
                &expected.file_id,
            ),
        )
        .map_err(message)?;
    if changed != 1 {
        return Err("タイル管理DBの対応先を更新できませんでした。".into());
    }
    tx.commit().map_err(message)
}

// 差し替え後のカタログを単体で移動できるよう、記録した識別子を本体に反映してから証明を公開する。
// 他の読取接続が残っていた場合や、更新後に中断して再試行した場合はWALが残ることがある。
fn checkpoint_proof_catalog(ctx: &Context) -> Result<()> {
    if !ctx
        .replacement
        .as_ref()
        .is_some_and(|rule| rule.matches(&ctx.target.path, &ctx.catalog.path, &ctx.catalog.file_id))
    {
        return Ok(());
    }
    let mut wal = ctx.catalog.path.as_os_str().to_owned();
    wal.push("-wal");
    match fs::metadata(wal) {
        Ok(metadata) if metadata.len() > 0 => {},
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(message(e)),
    }
    let db = Connection::open_with_flags(&ctx.catalog.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(message)?;
    db.busy_timeout(Duration::from_secs(2)).map_err(message)?;
    let (busy, total, saved): (i64, i64, i64) = db
        .query_row("PRAGMA wal_checkpoint(FULL)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(message)?;
    if busy != 0 || saved != total {
        return Err("タイル管理DBの更新をファイルに反映できません。ほかの利用を終了してから移設前の記録を保存してください。".into());
    }
    Ok(())
}

fn acquire_owner(ctx: &Context, create: bool) -> Result<Option<File>> {
    acquire_catalog_owner(&ctx.catalog.path, create)
}

fn acquire_catalog_owner(catalog: &Path, create: bool) -> Result<Option<File>> {
    let path = lock_path(catalog);
    if !create && !path.exists() {
        return Ok(None);
    }
    if path.exists() {
        let _ = pin(&path, false)?;
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(create)
        .truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(3);
    }
    let lock = options.open(&path).map_err(message)?;
    if is_link(&lock.metadata().map_err(message)?) || file_identity(&path)?.links != 1 {
        return Err("所有者ロックの形式が不正です。".into());
    }
    lock.try_lock_exclusive().map_err(|_| {
        "別プロセスがcatalogを使用しています。終了後に再実行してください。".to_string()
    })?;
    Ok(Some(lock))
}

fn stored_binding(conn: &Connection) -> Result<Binding> {
    validate_catalog(conn)?;
    conn.query_row(
        "SELECT app_database_path, app_file_id FROM tile_catalog_binding WHERE id = 1",
        [],
        |row| {
            Ok(Binding {
                path: PathBuf::from(row.get::<_, String>(0)?),
                file_id: row.get(1)?,
            })
        },
    )
    .map_err(message)
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn hash_bytes(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

fn snapshot(conn: &Connection, skip_binding: bool, control: &mut Control<'_>) -> Result<Snapshot> {
    control.tick("checking", 0)?;
    let mut hash = Sha256::new();
    hash.update(b"geocode-database-content-v1\0");
    let mut stmt=conn.prepare("SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_schema ORDER BY type COLLATE BINARY, name COLLATE BINARY").map_err(message)?;
    let definitions = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(message)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(message)?;
    let mut counts = BTreeMap::new();
    let mut completed = 0;
    for (kind, name, table, sql) in definitions {
        for field in [&kind, &name, &table, &sql] {
            hash_bytes(&mut hash, field.as_bytes());
        }
        if kind != "table" || (skip_binding && name == "tile_catalog_binding") {
            continue;
        }
        if sql.to_ascii_uppercase().contains("CREATE VIRTUAL TABLE") {
            return Err("仮想テーブルを含むDBは移設照合に対応していません。".into());
        }
        let order = if sql.to_ascii_uppercase().contains("WITHOUT ROWID") {
            let mut info = conn
                .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")
                .map_err(message)?;
            let columns = info
                .query_map([&name], |r| r.get::<_, String>(0))
                .map_err(message)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(message)?;
            if columns.is_empty() {
                return Err("主キーを確認できません。".into());
            }
            columns
                .iter()
                .map(|v| format!("{} COLLATE BINARY", quote(v)))
                .collect::<Vec<_>>()
                .join(",")
        } else {
            "_rowid_".into()
        };
        // 識別子はsqlite_schemaから取得して必ず引用する。値をSQLへ連結しない。
        let mut query = conn
            .prepare(&format!("SELECT * FROM {} ORDER BY {order}", quote(&name)))
            .map_err(message)?;
        let width = query.column_count();
        hash.update((width as u64).to_le_bytes());
        let mut rows = query.query([]).map_err(message)?;
        let mut count = 0u64;
        while let Some(row) = rows.next().map_err(message)? {
            if count % 1024 == 0 {
                control.tick("checking", completed)?;
            }
            hash.update(b"row\0");
            for column in 0..width {
                match row.get_ref(column).map_err(message)? {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(v) => {
                        hash.update([1]);
                        hash.update(v.to_le_bytes());
                    },
                    ValueRef::Real(v) => {
                        hash.update([2]);
                        hash.update(v.to_bits().to_le_bytes());
                    },
                    ValueRef::Text(v) | ValueRef::Blob(v) => {
                        if v.len() > 32 * 1024 * 1024 {
                            return Err("単一値の容量が移設照合の上限を超えています。".into());
                        }
                        hash.update([
                            if matches!(row.get_ref(column).map_err(message)?, ValueRef::Text(_)) {
                                3
                            } else {
                                4
                            },
                        ]);
                        hash_bytes(&mut hash, v);
                    },
                }
            }
            count += 1;
            completed += 1;
        }
        hash.update(count.to_le_bytes());
        counts.insert(name, count);
    }
    Ok(Snapshot {
        sha256: format!("{:x}", hash.finalize()),
        rows: counts,
    })
}

fn stage_document<T: Serialize>(
    path: &Path,
    value: &T,
    permissions: &Path,
) -> Result<(Vec<File>, tempfile::NamedTempFile)> {
    validate_filename(path)?;
    if path.exists() {
        return Err("移設記録の保存先は既に存在します。上書きしません。".into());
    }
    let parent = path.parent().ok_or("保存先が不正です。")?;
    let parents = pin_directory(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(message)?;
    crate::init::protect_maintenance_file(permissions, temp.path()).map_err(message)?;
    serde_json::to_writer_pretty(&mut temp, value).map_err(message)?;
    temp.write_all(b"\n").map_err(message)?;
    temp.as_file().sync_all().map_err(message)?;
    Ok((parents, temp))
}

fn create_document<T: Serialize>(path: &Path, value: &T, permissions: &Path) -> Result<()> {
    let (_parents, temp) = stage_document(path, value, permissions)?;
    temp.persist_noclobber(path).map_err(message)?;
    Ok(())
}

fn pin_directory(path: &Path) -> Result<Vec<File>> {
    // ドライブ直下を保存先にする場合、ルートにはファイル名がない。
    if !(path.is_absolute() && path.parent().is_none()) {
        validate_filename(path)?;
    }
    pin_components(path, false)
}

fn backup(
    source: &Connection,
    destination: &Path,
    permissions: &Path,
    control: &mut Control<'_>,
) -> Result<()> {
    control.tick("backup", 0)?;
    let temp = tempfile::NamedTempFile::new_in(destination.parent().ok_or("保存先が不正です。")?)
        .map_err(message)?;
    crate::init::protect_maintenance_file(permissions, temp.path()).map_err(message)?;
    let dest = Connection::open(temp.path()).map_err(message)?;
    struct BackupGuard(*mut rusqlite::ffi::sqlite3_backup);
    impl Drop for BackupGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    rusqlite::ffi::sqlite3_backup_finish(self.0);
                }
            }
        }
    }
    // handlesは両Connectionの生存中だけ利用する。SQLite本体に含まれるbackup APIを使い、依存featureを変えない。
    let rc = unsafe {
        let backup = rusqlite::ffi::sqlite3_backup_init(
            dest.handle(),
            c"main".as_ptr(),
            source.handle(),
            c"main".as_ptr(),
        );
        if backup.is_null() {
            return Err("整合バックアップを開始できません。".into());
        }
        let mut guard = BackupGuard(backup);
        let result = loop {
            let result = rusqlite::ffi::sqlite3_backup_step(backup, 128);
            if result != rusqlite::ffi::SQLITE_OK {
                break result;
            }
            control.tick(
                "backup",
                (rusqlite::ffi::sqlite3_backup_pagecount(backup)
                    - rusqlite::ffi::sqlite3_backup_remaining(backup))
                .max(0) as u64,
            )?;
        };
        let finish = rusqlite::ffi::sqlite3_backup_finish(backup);
        guard.0 = std::ptr::null_mut();
        if result == rusqlite::ffi::SQLITE_DONE {
            finish
        } else {
            result
        }
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err(format!("整合バックアップに失敗しました（SQLite {rc}）。"));
    }
    validate_catalog(&dest)?;
    drop(dest);
    temp.as_file().sync_all().map_err(message)?;
    temp.persist_noclobber(destination).map_err(message)?;
    Ok(())
}

pub fn execute(
    config_path: &Path,
    request: Request,
    cancellation: &CancellationToken,
    progress: &mut dyn FnMut(&str, u64) -> Result<()>,
) -> Result<Value> {
    if !cfg!(all(windows, target_pointer_width = "64")) {
        return Err("本体DBの移設操作はWindows 64bitのローカルディスクに対応しています。".into());
    }
    let purpose = if matches!(request, Request::Inspect) {
        OpenFor::Inspect
    } else {
        OpenFor::Maintenance
    };
    let ctx = Context::with_locations(config_path, purpose, None)?;
    execute_in_context(
        &ctx,
        request,
        &mut Control {
            cancellation,
            progress,
        },
    )
}

fn execute_in_context(ctx: &Context, request: Request, control: &mut Control<'_>) -> Result<Value> {
    let _owner = acquire_owner(
        ctx,
        matches!(request, Request::Prepare { .. } | Request::Apply { .. }),
    )?;
    let catalog = open_readonly(&ctx.catalog.path)?;
    catalog.execute_batch("BEGIN").map_err(message)?;
    let previous = stored_binding(&catalog)?;
    let accepted = ctx.accepts(&previous, &ctx.target);
    if matches!(request, Request::Inspect) {
        return Ok(
            json!({"binding_matches":accepted,"previous":previous,"target":ctx.target,
            "catalog":ctx.catalog,"same_file":previous.file_id==ctx.target.file_id,
            "message":if same(&previous,&ctx.target){"対応付けは一致しています。"}else if accepted{"この保存先の本体DB差し替えは許可されています。"}else{"移設計画で同一性を確認してください。元DBまたは移設前の記録が必要な場合があります。"}}),
        );
    }
    if let Request::Apply { plan } = request {
        drop(catalog);
        return apply(ctx, plan, control);
    }
    if matches!(request, Request::Prepare { .. }) && !accepted {
        return Err("移設前の正しい対応付けを確認できません。既に移設した場合は元DBとの照合を使用してください。".into());
    }
    if matches!(request, Request::Plan { .. }) && accepted {
        return Err("対応付けは既に有効です。更新は不要です。".into());
    }
    let app = open_readonly(&ctx.target.path)?;
    app.execute_batch("BEGIN").map_err(message)?;
    let application = snapshot(&app, false, control)?;
    let contents = snapshot(&catalog, true, control)?;
    let created = now()?;
    match request {
        Request::Prepare { output } => {
            let proof = sign(
                &ctx.key,
                "proof",
                Proof {
                    version: 1,
                    created,
                    expires: created + PROOF_LIFETIME,
                    binding: Binding {
                        path: previous.path.clone(),
                        file_id: ctx.target.file_id.clone(),
                    },
                    application,
                    catalog_contents: contents,
                },
            )?;
            ctx.recheck()?;
            control.tick("saving_proof", 0)?;
            // 保存先と署名済みの記録を準備してから、現在許可されている実体を移設の基準とする。
            let (_parents, temp) = stage_document(&output, &proof, &ctx.catalog.path)?;
            // 読取トランザクションを閉じ、対応先の更新がカタログ本体に反映できるようにする。
            drop(catalog);
            record_accepted_binding(ctx, &previous)?;
            checkpoint_proof_catalog(ctx)?;
            temp.persist_noclobber(&output).map_err(message)?;
            Ok(json!({"state":"succeeded","proof_path":output,"expires":created+PROOF_LIFETIME}))
        },
        Request::Plan {
            source_database,
            proof,
        } => serde_json::to_value(make_plan(
            ctx,
            previous,
            application,
            contents,
            source_database,
            proof,
            control,
        )?)
        .map_err(message),
        _ => unreachable!(),
    }
}

fn make_plan(
    ctx: &Context,
    previous: Binding,
    application: Snapshot,
    contents: Snapshot,
    source_database: Option<PathBuf>,
    proof: Option<PathBuf>,
    control: &mut Control<'_>,
) -> Result<Signed<Plan>> {
    let created = now()?;
    if source_database.is_some() && proof.is_some() {
        return Err("元DBと移設記録はどちらか一方を指定してください。".into());
    }
    let mut original_binding = None;
    let mut _original_pins = Vec::new();
    let evidence = if previous.file_id == ctx.target.file_id {
        "same_file"
    } else if ctx.accepts(&previous, &ctx.target) {
        "authorized_replacement"
    } else if let Some(source) = source_database {
        _original_pins = pin(&source, true)?;
        let source_binding = binding(&source)?;
        if source_binding.file_id != previous.file_id && !ctx.accepts(&previous, &source_binding) {
            return Err("指定した元DBはcatalogが記録した実ファイルと一致しません。通常のバックアップコピーだけでは証明できません。".into());
        }
        let original = open_readonly(&source_binding.path)?;
        original.execute_batch("BEGIN").map_err(message)?;
        crate::db::pool::validate_existing_schema_sync(&original)?;
        if snapshot(&original, false, control)? != application {
            return Err("元DBと移設先DBの内容が一致しません。対応付けを更新しません。".into());
        }
        original_binding = Some(source_binding);
        "original_database"
    } else if let Some(path) = proof {
        let signed: Signed<Proof> = read_document(&path)?;
        verify(&ctx.key, "proof", &signed)?;
        let evidence = signed.payload;
        if evidence.version != 1
            || evidence.created > created
            || evidence.expires < created
            || evidence.expires - evidence.created != PROOF_LIFETIME
            || evidence.binding != previous
            || evidence.application != application
            || evidence.catalog_contents != contents
        {
            return Err("移設記録の期限・元DB・catalogの内容が一致しません。".into());
        }
        if previous.path.is_file() {
            _original_pins = pin(&previous.path, true)?;
            let old = binding(&previous.path)?;
            if old.file_id != previous.file_id {
                return Err("移動前の本体DBのパスが別ファイルに置換されています。".into());
            }
            let source = open_readonly(&old.path)?;
            source.execute_batch("BEGIN").map_err(message)?;
            if snapshot(&source, false, control)? != application {
                return Err("移設記録の作成後に元DBが変更されています。".into());
            }
            original_binding = Some(old);
        }
        "prepared_proof"
    } else {
        return Err("同一性を確認できません。catalogと一致する元ファイル、または移設前に作成した記録を指定してください。強制更新は行いません。".into());
    };
    ctx.recheck()?;
    control.tick("planned", application.rows.values().sum())?;
    sign(
        &ctx.key,
        "plan",
        Plan {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            created,
            expires: created + PLAN_LIFETIME,
            config_sha256: ctx.config_sha256.clone(),
            catalog: ctx.catalog.clone(),
            previous,
            target: ctx.target.clone(),
            original: original_binding,
            application,
            catalog_contents: contents,
            evidence: evidence.into(),
        },
    )
}

fn apply(ctx: &Context, signed: Signed<Plan>, control: &mut Control<'_>) -> Result<Value> {
    verify(&ctx.key, "plan", &signed)?;
    let plan_hash = bytes_hash(&encoded(&signed)?);
    let plan = signed.payload;
    if plan.version != 1
        || uuid::Uuid::parse_str(&plan.id)
            .map(|id| id.to_string())
            .ok()
            .as_deref()
            != Some(&plan.id)
        || !same(&ctx.catalog, &plan.catalog)
        || !same(&ctx.target, &plan.target)
    {
        return Err("移設計画の対象が現在の設定・DBと一致しません。".into());
    }
    let root = ctx
        .catalog
        .path
        .parent()
        .ok_or("catalogの保存先が不正です。")?
        .join(format!("catalog-relocation-{}", plan.id));
    let receipt_path = root.join("receipt.json");
    let mut conn = Connection::open_with_flags(
        &ctx.catalog.path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(message)?;
    conn.busy_timeout(Duration::from_secs(2)).map_err(message)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(message)?;
    let previous = stored_binding(&tx)?;
    if same(&previous, &plan.target) {
        let receipt: Signed<Receipt> = read_document(&receipt_path)?;
        verify(&ctx.key, "receipt", &receipt)?;
        if receipt.payload.plan_sha256 != plan_hash || receipt.payload.plan_id != plan.id {
            return Err("適用済みの移設記録と一致しません。".into());
        }
        return Ok(
            json!({"state":"succeeded","already_applied":true,"backup":receipt.payload.backup,"receipt":receipt_path}),
        );
    }
    let current = now()?;
    if plan.created > current
        || plan.expires < current
        || plan.expires - plan.created != PLAN_LIFETIME
        || plan.config_sha256 != ctx.config_sha256
        || previous != plan.previous
    {
        return Err(
            "移設計画が古いか、確認後に対応先・設定が変わりました。新しい計画を作成してください。"
                .into(),
        );
    }
    let _original_pins = verify_application(ctx, &plan, control)?;
    if snapshot(&tx, true, control)? != plan.catalog_contents {
        return Err("計画後にDBの内容が変更されました。対応付けを更新しません。".into());
    }
    control.tick("before_backup", 0)?;
    ctx.recheck()?;
    let recovering = root.exists();
    if !recovering {
        crate::init::create_maintenance_directory(&ctx.catalog.path, &root).map_err(message)?;
    }
    let _root = pin_directory(&root)?;
    let backup_path = root.join("catalog.before.sqlite");
    if recovering {
        let saved: Signed<Receipt> = read_document(&receipt_path).map_err(
            |_| "中断記録を確認できません。既存記録を保全し、新しい計画を作成してください。",
        )?;
        verify(&ctx.key, "receipt", &saved)?;
        if saved.payload.version != 1
            || saved.payload.plan_sha256 != plan_hash
            || saved.payload.plan_id != plan.id
            || saved.payload.previous != previous
            || saved.payload.target != ctx.target
            || saved.payload.backup != backup_path
        {
            return Err("中断記録が今回の移設計画と一致しません。".into());
        }
    } else {
        // 書込txと同じ接続からbackupするとSQLITE_BUSYになるため、元状態を別の読取接続から取得する。
        let backup_source = open_readonly(&ctx.catalog.path)?;
        backup(&backup_source, &backup_path, &ctx.catalog.path, control)?;
    }
    let backup_conn = open_readonly(&backup_path)?;
    if stored_binding(&backup_conn)? != previous
        || snapshot(&backup_conn, true, control)? != plan.catalog_contents
    {
        return Err("バックアップの照合に失敗しました。".into());
    }
    drop(backup_conn);
    let receipt = Receipt {
        version: 1,
        plan_sha256: plan_hash,
        plan_id: plan.id,
        previous: previous.clone(),
        target: ctx.target.clone(),
        backup: backup_path.clone(),
        state: "prepared".into(),
    };
    if !recovering {
        create_document(
            &receipt_path,
            &sign(&ctx.key, "receipt", receipt)?,
            &ctx.catalog.path,
        )?;
    }
    control.tick("before_commit", 0)?;
    ctx.recheck()?;
    let changed = tx
        .execute(
            r#"
        UPDATE tile_catalog_binding
        SET app_database_path = ?1, app_file_id = ?2
        WHERE id = 1 AND app_database_path = ?3 AND app_file_id = ?4
        "#,
            (
                &ctx.target.path.to_string_lossy(),
                &ctx.target.file_id,
                &previous.path.to_string_lossy(),
                &previous.file_id,
            ),
        )
        .map_err(message)?;
    if changed != 1 {
        return Err("対応付けの競合を検出しました。".into());
    }
    if snapshot(&tx, true, control)? != plan.catalog_contents
        || !same(&stored_binding(&tx)?, &ctx.target)
    {
        return Err("対応付け以外の変更を検出しました。".into());
    }
    ctx.recheck()?;
    control.tick("committing", 0)?;
    tx.commit().map_err(message)?;
    // commit後の中断は適用済みとして明示する。receiptは事前に同期保存済みで、再実行も検証できる。
    let warning = (control.progress)("completed", 0).err();
    Ok(
        json!({"state":"succeeded","already_applied":false,"backup":backup_path,"receipt":receipt_path,"warning":warning}),
    )
}

fn verify_application(ctx: &Context, plan: &Plan, control: &mut Control<'_>) -> Result<Vec<File>> {
    let app = open_readonly(&ctx.target.path)?;
    app.execute_batch("BEGIN").map_err(message)?;
    let _original_pins = if let Some(original) = &plan.original {
        let pins = pin(&original.path, true)?;
        // 元ファイルは署名済み計画の作成時に照合済み。適用時もその実体と全内容を照合する。
        if !same(&binding(&original.path)?, original) {
            return Err(
                "確認後に元DBが移動・置換されました。新しい計画を作成してください。".into(),
            );
        }
        let source = open_readonly(&original.path)?;
        source.execute_batch("BEGIN").map_err(message)?;
        if snapshot(&source, false, control)? != plan.application {
            return Err("計画後に元DBの内容が変更されました。".into());
        }
        pins
    } else {
        Vec::new()
    };
    if snapshot(&app, false, control)? != plan.application {
        return Err("計画後に本体DBの内容が変更されました。".into());
    }
    Ok(_original_pins)
}
