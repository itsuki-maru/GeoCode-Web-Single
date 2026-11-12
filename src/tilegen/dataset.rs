//! 既存のGISサーバーやアプリケーション向けに、同期処理でオフラインのタイル生成を行う。
//!
//! 描画ワーカーごとに1つの[`RenderSession`]を保持し、キャッシュミス時に再利用する。
//! HTTPルーティング、キャッシュの検索・公開、要求の集約、タスクのスケジューリングは
//! 呼出元アプリケーションが担当する。このモジュールはスレッドやサービスを起動せず、
//! プロセス全体のハンドラーも登録しない。呼び出しはブロックするため、非同期サーバーでは
//! 非同期実行基盤のI/Oスレッドで描画せず、ブロッキング処理用ワーカーで実行する。
//!
//! 操作コンテキストは、SQLiteのVM実行や図形処理ループを含め、協調的な取消・期限・進捗を扱う。
//! OSのI/Oや外部ライブラリの個々のラスタ描画・エンコード呼び出しは、戻るまで中断できない。

use std::{
    error::Error,
    fmt,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

pub use crate::tilegen::operation::{
    Diagnostic, DiagnosticLevel, OperationContext, OperationMonitor, ProgressSnapshot, Stage,
    Status,
};
pub use crate::tilegen::{cancel::CancellationToken, tile::TileId};
use crate::tilegen::{
    cancel::is_interrupted,
    geometry::Rect,
    identity::{self, RenderContract},
    operation::{DeadlineExceeded, OperationAlreadyStarted, OperationGuard},
    renderer::{self, Candidate},
    store::{Store, StoreMetadata},
    style::Style,
    tile::TILE_SIZE,
};

/// 内部の描画依存を公開しないSDKの処理結果。
pub type Result<T> = std::result::Result<T, RenderError>;

/// 組み込み先アプリケーションがプログラムで判定するための分類。
///
/// 検索・描画の失敗は原因の連鎖をすべて保持する。既存の低水準な検証・資源上限の失敗には
/// まだ構造化された分類がないものがあり、メッセージの文字列照合で分類せず、
/// 意図的に`Query`または`Render`として扱う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorKind {
    InvalidTile,
    InvalidDataset,
    DatasetChanged,
    Cancelled,
    DeadlineExceeded,
    InvalidOperation,
    Io,
    Query,
    Render,
    Encode,
    ResourceLimit,
}

/// 安定した分類と、任意の根本原因を持つSDKの失敗。
#[derive(Debug)]
pub struct RenderError {
    kind: ErrorKind,
    message: String,
    source: Option<anyhow::Error>,
}

impl RenderError {
    /// 表示用メッセージを解析せずに分類を確認できる。
    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            source: None,
        }
    }

    fn caused(
        kind: ErrorKind,
        message: impl Into<String>,
        source: impl Into<anyhow::Error>,
    ) -> Self {
        let source = source.into();
        let kind = if source.chain().any(|cause| cause.is::<DeadlineExceeded>()) {
            ErrorKind::DeadlineExceeded
        } else if source
            .chain()
            .any(|cause| cause.is::<OperationAlreadyStarted>())
        {
            ErrorKind::InvalidOperation
        } else if is_interrupted(&source) {
            ErrorKind::Cancelled
        } else {
            kind
        };
        Self {
            kind,
            message: message.into(),
            source: Some(source),
        }
    }
}

impl fmt::Display for RenderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for RenderError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_ref().map(|error| error.as_ref())
    }
}

/// 入力データが地理的な範囲を網羅すると確認できているかを表す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Coverage {
    /// 道路地物の外接矩形だけでは、入力データの網羅範囲を確定できない。
    Unknown,
}

/// 呼出元の地図UIに表示する出典情報。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribution {
    pub text: String,
    pub copyright_url: String,
    pub data_license: String,
    pub source_timestamp: Option<String>,
    pub additional: Vec<(String, String)>,
}

/// 完成済みデータセットから読み取る情報。範囲には正規化したWebメルカトル座標を使う。
#[derive(Debug, Clone)]
pub struct DatasetInfo {
    pub dataset_id: String,
    pub schema_version: u32,
    pub geometry_version: u32,
    pub importer_version: String,
    pub import_rules_hash: String,
    pub source_sha256: String,
    pub source_bytes: u64,
    pub source_timestamp: Option<String>,
    pub feature_count: u64,
    pub feature_bounds: Rect,
    pub coverage: Coverage,
    pub attribution: Attribution,
    pub extension: Option<serde_json::Value>,
}

/// 画像データは余白のない行優先のsRGB RGBA8で、RGB値にアルファ値を乗算しない形式とする。
/// 現在の`roads-v1`画像は完全に不透明である。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum PixelFormat {
    Rgba8SrgbStraightAlpha,
}

/// タイルキャッシュに使う描画契約の表示情報。生成元の製品版やビルド来歴は含めない。
/// 保存用の完全な契約は[`Dataset::render_contract()`]から取得する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderProfile {
    pub style_version: String,
    pub style_hash: String,
    pub renderer_version: String,
    pub image_version: String,
    pub tile_size: u32,
    pub pixel_format: PixelFormat,
}

/// セッション設定。省略時は形式ごとの既定契約を使い、明示設定は新しい名称対応DBへ適用する。
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct RenderOptions {
    spec: Option<super::render_spec::RenderSpec>,
}
impl RenderOptions {
    pub fn with_spec(spec: super::render_spec::RenderSpec) -> Self {
        Self {
            spec: Some(spec.normalized()),
        }
    }
    pub fn spec(self) -> Option<super::render_spec::RenderSpec> {
        self.spec
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows { volume: u32, index: u64 },
    #[cfg(not(any(unix, windows)))]
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    bytes: u64,
    modified: SystemTime,
    identity: FileIdentity,
}

fn fingerprint(path: &Path) -> std::io::Result<FileFingerprint> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "dataset must be a regular file",
        ));
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        FileIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    };
    #[cfg(windows)]
    let identity = windows_file_identity(&file)?;
    #[cfg(not(any(unix, windows)))]
    let identity = FileIdentity::Unavailable;
    Ok(FileFingerprint {
        bytes: metadata.len(),
        modified: metadata.modified()?,
        identity,
    })
}

fn reject_sidecars(path: &Path, kind: ErrorKind) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let sidecar = PathBuf::from(name);
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => {
                return Err(RenderError::new(
                    kind,
                    "dataset must be closed without WAL or journal sidecars",
                ));
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => {
                return Err(RenderError::caused(
                    kind,
                    "cannot verify dataset journal state",
                    error,
                ));
            },
        }
    }
    Ok(())
}

fn verify_rollback_header(path: &Path) -> Result<()> {
    let mut header = [0_u8; 20];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| {
            RenderError::caused(
                ErrorKind::InvalidDataset,
                "cannot read completed SQLite store header",
                error,
            )
        })?;
    // SQLiteヘッダーの18/19バイト目は、書込・読取のファイル形式版を表す。
    // 1はロールバックジャーナル、2はWAL。読み取り専用接続がWAL用の共有メモリ付属ファイルを
    // 作成しないよう、SQLiteを開く前にWALを拒否する。
    if &header[..16] != b"SQLite format 3\0" || header[18] != 1 || header[19] != 1 {
        return Err(RenderError::new(
            ErrorKind::InvalidDataset,
            "dataset must be a completed SQLite store using rollback journal mode",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> std::io::Result<FileIdentity> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct FileInformation {
        attributes: u32,
        created: FileTime,
        accessed: FileTime,
        written: FileTime,
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut c_void,
            information: *mut FileInformation,
        ) -> i32;
    }
    let mut information = FileInformation::default();
    // 安全性: 生存中のFileがハンドルを所有し、FileInformationはWin32の
    // BY_HANDLE_FILE_INFORMATIONと同じ配置で、この呼び出し中も書き込み可能である。
    let success = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if success == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(FileIdentity::Windows {
        volume: information.volume_serial,
        index: u64::from(information.index_high) << 32 | u64::from(information.index_low),
    })
}

#[derive(Debug)]
struct DatasetInner {
    path: PathBuf,
    fingerprint: FileFingerprint,
    metadata_bytes: Vec<u8>,
    info: DatasetInfo,
    profile: RenderProfile,
    render_contract: RenderContract,
}

/// 変更しない完成済みローカルデータセットを参照する、共有可能なハンドル。
///
/// 開く際にメタデータを検証するが、DBの全行検査やファイル全体のハッシュ計算は行わない。
/// 完成ファイルは変更せず、更新は新しいパスで公開して新しいDatasetを作成する。
/// メタデータ・ファイル識別の検査は通常の置換・変更を検出するものであり、
/// メタデータを偽装した意図的な改変の検出は保証しない。
#[derive(Debug, Clone)]
pub struct Dataset(Arc<DatasetInner>);

impl Dataset {
    /// PBF・CLI・Python・ネットワークを必要とせず、完成済みストアを開く。
    /// 相対パスは一度だけ解決し、以降の呼び出しはプロセスの作業ディレクトリに依存しない。
    /// シンボリックリンクは、その時点の参照先へ解決する。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = fs::canonicalize(path.as_ref()).map_err(|error| {
            RenderError::caused(ErrorKind::Io, "cannot resolve the dataset path", error)
        })?;
        let before = fingerprint(&path).map_err(|error| {
            RenderError::caused(ErrorKind::Io, "cannot read the dataset file", error)
        })?;
        reject_sidecars(&path, ErrorKind::InvalidDataset)?;
        verify_rollback_header(&path)?;
        let store = Store::open(&path).map_err(|error| {
            RenderError::caused(
                ErrorKind::InvalidDataset,
                "cannot open a completed dataset",
                error,
            )
        })?;
        let metadata = store.metadata();
        validate_identity(metadata)?;
        let render_contract =
            RenderContract::for_format(metadata.schema_version, metadata.geometry_version)
                .ok_or_else(|| {
                    RenderError::new(
                        ErrorKind::InvalidDataset,
                        "unsupported render contract for the dataset format",
                    )
                })?;
        let metadata_bytes = serde_json::to_vec(metadata).map_err(|error| {
            RenderError::caused(
                ErrorKind::InvalidDataset,
                "cannot read dataset identity",
                error,
            )
        })?;
        let extra = if matches!(metadata.schema_version, 2 | 3) {
            Some(
                crate::tilegen::standard::store::details(store.connection())
                    .map_err(|error| {
                        RenderError::caused(
                            ErrorKind::InvalidDataset,
                            "新形式のメタデータを読み取れません",
                            error,
                        )
                    })?
                    .ok_or_else(|| {
                        RenderError::new(
                            ErrorKind::InvalidDataset,
                            "新形式のメタデータがありません",
                        )
                    })?,
            )
        } else {
            None
        };
        let uses_dem = extra.as_ref().is_some_and(|m| m.elevation.is_some());
        let info = DatasetInfo {
            dataset_id: metadata.dataset_id.clone(),
            schema_version: metadata.schema_version,
            geometry_version: metadata.geometry_version,
            importer_version: metadata.importer_version.clone(),
            import_rules_hash: metadata.import_rules_hash.clone(),
            source_sha256: metadata.source_sha256.clone(),
            source_bytes: metadata.source_bytes,
            source_timestamp: metadata.source_timestamp.clone(),
            feature_count: metadata.feature_count,
            feature_bounds: metadata.bbox,
            coverage: Coverage::Unknown,
            attribution: Attribution {
                text: "© OpenStreetMap contributors".to_owned(),
                copyright_url: "https://www.openstreetmap.org/copyright".to_owned(),
                data_license: "Open Database License (ODbL)".to_owned(),
                source_timestamp: metadata.source_timestamp.clone(),
                additional: if uses_dem {
                    vec![(
                        "国土地理院（標高データを加工）".into(),
                        "https://www.gsi.go.jp/kiban/".into(),
                    )]
                } else {
                    Vec::new()
                },
            },
            extension: extra.map(|m| serde_json::to_value(m).expect("メタデータの直列化")),
        };
        let after = fingerprint(&path).map_err(|error| {
            RenderError::caused(
                ErrorKind::DatasetChanged,
                "dataset changed while opening",
                error,
            )
        })?;
        reject_sidecars(&path, ErrorKind::DatasetChanged)?;
        if before != after {
            return Err(RenderError::new(
                ErrorKind::DatasetChanged,
                "dataset changed while opening",
            ));
        }
        Ok(Self(Arc::new(DatasetInner {
            path,
            fingerprint: before,
            metadata_bytes,
            info,
            profile: RenderProfile {
                style_version: render_contract.style_version.clone(),
                style_hash: render_contract.style_hash.clone(),
                renderer_version: format!(
                    "{}-render-v{}",
                    match metadata.schema_version {
                        1 => "roads",
                        3 => "osm-like",
                        _ => "standard-terrain",
                    },
                    render_contract.renderer_revision
                ),
                image_version: format!(
                    "{}-{}-{}-v{}",
                    render_contract.pixel_format,
                    render_contract.color_space,
                    render_contract.alpha_mode,
                    render_contract.image_revision
                ),
                tile_size: render_contract.tile_size,
                pixel_format: PixelFormat::Rgba8SrgbStraightAlpha,
            },
            render_contract,
        })))
    }

    pub fn info(&self) -> &DatasetInfo {
        &self.0.info
    }

    pub fn profile(&self) -> &RenderProfile {
        &self.0.profile
    }

    pub fn render_contract(&self) -> &RenderContract {
        &self.0.render_contract
    }

    /// 同じDBの別表示を、保存された不変契約へ解決する。
    /// 保存PNGの照会も使うため、開いた時点の情報だけで解決し、ファイルの現存検査は生成時に行う。
    pub fn render_contract_for(&self, options: &RenderOptions) -> Result<RenderContract> {
        let contract = match options.spec {
            Some(spec) => RenderContract::for_spec(
                self.info().schema_version,
                self.info().geometry_version,
                spec,
            )
            .ok_or_else(|| {
                RenderError::new(
                    ErrorKind::InvalidDataset,
                    "この完成DBでは指定した描画設定を利用できません。",
                )
            })?,
            None => self.render_contract().clone(),
        };
        if let Some(spec) = contract.render_spec {
            let caps = self
                .info()
                .extension
                .as_ref()
                .and_then(|v| v.get("capabilities"));
            for (enabled, key, message) in [
                (
                    spec.labels,
                    "labels",
                    "名称情報がありません。standard-v2で新しいDBを作成してください。",
                ),
                (
                    spec.hillshade,
                    "elevation",
                    "標高データを収録していないため陰影を生成できません。",
                ),
                (
                    spec.contours,
                    "contours",
                    "等高線を収録していないため生成できません。",
                ),
            ] {
                if enabled
                    && !caps
                        .and_then(|c| c.get(key))
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                {
                    return Err(RenderError::new(ErrorKind::InvalidDataset, message));
                }
            }
        }
        Ok(contract)
    }

    pub fn cache_key_for(&self, tile: TileId, options: &RenderOptions) -> Result<String> {
        validate_tile(tile)?;
        self.ensure_current()?;
        let contract = self.render_contract_for(options)?;
        Ok(identity::tile_cache_key(
            &self.info().dataset_id,
            &contract,
            tile.z,
            tile.x,
            tile.y,
        ))
    }

    /// 呼出元が管理するタイルキャッシュ向けに、SDKが生成する決定的なキーを返す。
    /// 保存済みデータセット識別、描画互換性契約、XYZ座標だけを含む。
    /// ファイルパス、生成元の製品版、ビルド来歴はキーに含めない。
    /// 描画依存・実行構成を同じ互換性契約で利用できるかは、呼出元で認定する。
    pub fn cache_key(&self, tile: TileId) -> Result<String> {
        validate_tile(tile)?;
        self.ensure_current()?;
        Ok(self.key(tile))
    }

    /// ワーカーが所有する、再利用可能な読み取り専用接続を作成する。
    ///
    /// セッションは呼出元の描画ワーカー内で作成する。共有接続プールとしては使わない。
    /// 既存の索引付きストアと従来形式のストアに対応する。
    pub fn create_session(&self, options: RenderOptions) -> Result<RenderSession> {
        let contract = self.render_contract_for(&options)?;
        self.ensure_current()?;
        let store = Store::open(&self.0.path).map_err(|error| {
            RenderError::caused(
                ErrorKind::InvalidDataset,
                "cannot open render session",
                error,
            )
        })?;
        let metadata_bytes = serde_json::to_vec(store.metadata()).map_err(|error| {
            RenderError::caused(
                ErrorKind::InvalidDataset,
                "cannot read session identity",
                error,
            )
        })?;
        self.ensure_current()?;
        if metadata_bytes != self.0.metadata_bytes {
            return Err(RenderError::new(
                ErrorKind::DatasetChanged,
                "session metadata differs from the opened dataset",
            ));
        }
        Ok(RenderSession {
            dataset: self.clone(),
            store,
            contract,
        })
    }

    fn ensure_current(&self) -> Result<()> {
        reject_sidecars(&self.0.path, ErrorKind::DatasetChanged)?;
        let current = fingerprint(&self.0.path).map_err(|error| {
            RenderError::caused(
                ErrorKind::DatasetChanged,
                "dataset file is no longer available",
                error,
            )
        })?;
        reject_sidecars(&self.0.path, ErrorKind::DatasetChanged)?;
        if current != self.0.fingerprint {
            return Err(RenderError::new(
                ErrorKind::DatasetChanged,
                "dataset file changed; open a new Dataset",
            ));
        }
        Ok(())
    }

    fn key(&self, tile: TileId) -> String {
        identity::tile_cache_key(
            &self.0.info.dataset_id,
            &self.0.render_contract,
            tile.z,
            tile.x,
            tile.y,
        )
    }
}

fn validate_identity(metadata: &StoreMetadata) -> Result<()> {
    let sha256 = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if !sha256(&metadata.dataset_id)
        || !sha256(&metadata.source_sha256)
        || !sha256(&metadata.import_rules_hash)
        || metadata.importer_version.is_empty()
        || metadata.source_bytes == 0
    {
        return Err(RenderError::new(
            ErrorKind::InvalidDataset,
            "dataset metadata is missing a valid content/import identity",
        ));
    }
    Ok(())
}

fn validate_tile(tile: TileId) -> Result<()> {
    TileId::new(tile.z, tile.x, tile.y)
        .map(|_| ())
        .map_err(|error| RenderError::caused(ErrorKind::InvalidTile, "invalid XYZ tile", error))
}

fn context_error(
    context: &OperationContext,
    fallback: ErrorKind,
    message: &'static str,
    source: anyhow::Error,
) -> RenderError {
    // SQLite・描画処理の実際の原因連鎖を保持する。SQLiteがSQLITE_INTERRUPTだけを
    // 報告する場合も、型付きの外側の分類で停止理由を伝える。
    let kind = match context.check() {
        Err(error) if is_interrupted(&error) => ErrorKind::Cancelled,
        Err(error) if error.chain().any(|cause| cause.is::<DeadlineExceeded>()) => {
            ErrorKind::DeadlineExceeded
        },
        _ => fallback,
    };
    RenderError::caused(kind, message, source)
}

fn execute_operation<T>(
    context: &OperationContext,
    operation: impl FnOnce(&OperationGuard) -> Result<T>,
) -> Result<T> {
    let guard = context.start().map_err(|error| {
        RenderError::caused(
            ErrorKind::InvalidOperation,
            "cannot start tile operation",
            error,
        )
    })?;
    match operation(&guard) {
        Ok(value) => {
            guard.succeed().map_err(|error| {
                RenderError::caused(
                    ErrorKind::Render,
                    "tile operation stopped before completion",
                    error,
                )
            })?;
            Ok(value)
        },
        Err(error) => {
            context.diagnostic(DiagnosticLevel::Error, error.to_string());
            let failure = match error.kind() {
                ErrorKind::Cancelled => anyhow::anyhow!(crate::tilegen::cancel::Interrupted),
                ErrorKind::DeadlineExceeded => anyhow::anyhow!(DeadlineExceeded),
                _ => anyhow::anyhow!(error.to_string()),
            };
            guard.fail(&failure);
            Err(error)
        },
    }
}

/// 呼出元の1ワーカーが所有する、1つの読み取り専用接続と描画コンテキスト。
pub struct RenderSession {
    dataset: Dataset,
    store: Store,
    contract: RenderContract,
}

impl RenderSession {
    pub fn render_contract(&self) -> &RenderContract {
        &self.contract
    }
    pub fn cache_key(&self, tile: TileId) -> Result<String> {
        validate_tile(tile)?;
        self.dataset.ensure_current()?;
        Ok(identity::tile_cache_key(
            &self.dataset.info().dataset_id,
            &self.contract,
            tile.z,
            tile.x,
            tile.y,
        ))
    }
    pub fn dataset(&self) -> &Dataset {
        &self.dataset
    }

    /// ファイルへ書き込まず、所有するメモリ上に1枚のタイルを描画する。
    /// 地物が空、または地物範囲外のタイルには通常の背景画像を生成する。
    pub fn render(&mut self, tile: TileId, cancel: &CancellationToken) -> Result<RenderedTile> {
        self.render_with_context(tile, &OperationContext::new(cancel.clone()))
    }

    /// 新しい使い切りの操作コンテキストで描画する。監視は独立してポーリングできる。
    /// 監視結果が読まれなくても、イベントが無制限に蓄積することはない。
    pub fn render_with_context(
        &mut self,
        tile: TileId,
        context: &OperationContext,
    ) -> Result<RenderedTile> {
        execute_operation(context, |guard| self.render_inner(tile, context, guard))
    }

    /// エンコードを含む単一の期限内で、応答用PNGバイト列を生成する。
    /// キャッシュ公開前の公開可否・HTTP状態は、呼出元自身が確認する。
    pub fn render_png_with_context(
        &mut self,
        tile: TileId,
        context: &OperationContext,
    ) -> Result<RenderedPngTile> {
        let started = Instant::now();
        execute_operation(context, |guard| {
            let rendered = self.render_inner(tile, context, guard)?;
            guard.stage(Stage::Encoding);
            guard.progress(0, Some(1));
            context.check().map_err(|error| {
                RenderError::caused(ErrorKind::Encode, "PNG generation stopped", error)
            })?;
            let encode_started = Instant::now();
            let png = rendered.image.encode_png().map_err(|error| {
                if let Err(stop) = context.check() {
                    RenderError::caused(ErrorKind::Encode, "PNG generation stopped", stop)
                } else {
                    error
                }
            })?;
            let encode_time = encode_started.elapsed();
            context.check().map_err(|error| {
                RenderError::caused(ErrorKind::Encode, "PNG generation stopped", error)
            })?;
            self.dataset.ensure_current()?;
            guard.progress(1, Some(1));
            Ok(RenderedPngTile {
                tile: rendered.tile,
                cache_key: rendered.cache_key,
                png,
                stats: rendered.stats,
                encode_time,
                elapsed: started.elapsed(),
            })
        })
    }

    fn render_inner(
        &mut self,
        tile: TileId,
        context: &OperationContext,
        guard: &OperationGuard,
    ) -> Result<RenderedTile> {
        let started = Instant::now();
        context.check().map_err(|error| {
            RenderError::caused(ErrorKind::Render, "tile generation stopped", error)
        })?;
        guard.stage(Stage::Validating);
        validate_tile(tile)?;
        self.dataset.ensure_current()?;
        if matches!(self.dataset.info().schema_version, 2 | 3) {
            return self.render_standard_inner(tile, context, guard, started);
        }
        let style = Style::roads_v1();
        let store = self.store.operation(context).map_err(|error| {
            context_error(
                context,
                ErrorKind::Query,
                "cannot initialize query operation",
                error,
            )
        })?;
        guard.stage(Stage::Searching);
        guard.progress(0, None);
        let search = Instant::now();
        let keys = store
            .query_candidates_with_progress(renderer::query_rect(tile, &style), tile.z, |rows| {
                guard.progress(rows, None)
            })
            .map_err(|error| {
                context_error(
                    context,
                    ErrorKind::Query,
                    "tile candidate query failed",
                    error,
                )
            })?;
        let search_time = search.elapsed();
        context
            .check()
            .map_err(|error| RenderError::caused(ErrorKind::Query, "tile query stopped", error))?;
        guard.stage(Stage::Drawing);
        guard.progress(0, Some(keys.len() as u64 * 2));
        let mut candidates = Vec::new();
        candidates.try_reserve_exact(keys.len()).map_err(|error| {
            RenderError::caused(
                ErrorKind::ResourceLimit,
                "cannot allocate tile candidates",
                error,
            )
        })?;
        for (index, key) in keys.into_iter().enumerate() {
            if index.is_multiple_of(1024) {
                context.check().map_err(|error| {
                    RenderError::caused(ErrorKind::Render, "tile conversion stopped", error)
                })?;
            }
            candidates.push(Candidate {
                id: key.feature_id,
                osm_way_id: key.osm_way_id,
                attrs: key.attributes,
            });
        }
        let mut loaded_vertices = 0_u64;
        let mut loaded_features = 0_u64;
        let draw = Instant::now();
        let image = renderer::render_tile_with_check(
            tile,
            &style,
            &candidates,
            |id| {
                context.check()?;
                let points = store.load_geometry(id, tile.z)?;
                context.check()?;
                loaded_vertices += points.len() as u64;
                loaded_features += 1;
                guard.progress(loaded_features, Some(candidates.len() as u64 * 2));
                Ok(points)
            },
            || context.check(),
        )
        .map_err(|error| {
            context_error(context, ErrorKind::Render, "tile rendering failed", error)
        })?;
        let draw_time = draw.elapsed();
        drop(store);
        context.check().map_err(|error| {
            RenderError::caused(ErrorKind::Render, "tile rendering stopped", error)
        })?;
        self.dataset.ensure_current()?;
        // 公開する画像形式は、RGB値にアルファ値を乗算しないRGBAとする。現在のroads-v1は
        // 不透明な背景へ不透明な色を描くため、RGB値にアルファ値を乗算しても値は変わらない。
        if image.width() != TILE_SIZE
            || image.height() != TILE_SIZE
            || image
                .data()
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[3] != 255)
        {
            return Err(RenderError::new(
                ErrorKind::Render,
                "renderer returned an unsupported image layout",
            ));
        }
        let rendered = RenderedTile {
            tile,
            cache_key: self.cache_key(tile)?,
            image: TileImage {
                rgba: Arc::from(image.take()),
            },
            stats: RenderStats {
                search_time,
                draw_time,
                elapsed: started.elapsed(),
                candidate_count: candidates.len() as u64,
                loaded_vertices,
            },
        };
        context.check().map_err(|error| {
            RenderError::caused(
                ErrorKind::Render,
                "tile generation stopped before return",
                error,
            )
        })?;
        Ok(rendered)
    }

    fn render_standard_inner(
        &mut self,
        tile: TileId,
        context: &OperationContext,
        guard: &OperationGuard,
        started: Instant,
    ) -> Result<RenderedTile> {
        guard.stage(Stage::Drawing);
        let operation = self.store.operation(context).map_err(|e| {
            context_error(
                context,
                ErrorKind::Query,
                "標準地図の読み取りを開始できません",
                e,
            )
        })?;
        let drawing = match self.contract.render_spec {
            Some(spec) => crate::tilegen::standard::paint::render_tile_with_spec(
                &operation, tile, context, &spec,
            ),
            None => {
                crate::tilegen::standard::paint::render_tile_with_metrics(&operation, tile, context)
            },
        };
        let (image, candidate_count, loaded_vertices) = drawing.map_err(|e| {
            context_error(
                context,
                ErrorKind::Render,
                "標準地図の描画に失敗しました",
                e,
            )
        })?;
        drop(operation);
        context
            .check()
            .map_err(|e| context_error(context, ErrorKind::Render, "描画を停止しました", e))?;
        self.dataset.ensure_current()?;
        if image.width() != TILE_SIZE
            || image.height() != TILE_SIZE
            || image.data().chunks_exact(4).any(|p| p[3] != 255)
        {
            return Err(RenderError::new(
                ErrorKind::Render,
                "標準地図の画像形式が不正です",
            ));
        }
        let elapsed = started.elapsed();
        Ok(RenderedTile {
            tile,
            cache_key: self.cache_key(tile)?,
            image: TileImage {
                rgba: Arc::from(image.take()),
            },
            stats: RenderStats {
                search_time: Duration::ZERO,
                draw_time: elapsed,
                elapsed,
                candidate_count,
                loaded_vertices,
            },
        })
    }
}

/// 描画セッションやデータセットと独立した生存期間を持つ、所有された画素データ。
#[derive(Debug, Clone)]
pub struct TileImage {
    rgba: Arc<[u8]>,
}

impl TileImage {
    pub fn width(&self) -> u32 {
        TILE_SIZE
    }

    pub fn height(&self) -> u32 {
        TILE_SIZE
    }

    pub fn stride(&self) -> usize {
        TILE_SIZE as usize * 4
    }

    pub fn format(&self) -> PixelFormat {
        PixelFormat::Rgba8SrgbStraightAlpha
    }

    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    /// 呼出元と画素データを共有する。応答の生成やテクスチャ処理などに使う。
    pub fn shared_rgba(&self) -> Arc<[u8]> {
        self.rgba.clone()
    }

    pub fn into_rgba(self) -> Arc<[u8]> {
        self.rgba
    }

    /// 応答用PNGバイト列をエンコードする。ファイル書込やサービスの起動は行わない。
    pub fn encode_png(&self) -> Result<Vec<u8>> {
        let pixmap = tiny_skia::PixmapRef::from_bytes(&self.rgba, TILE_SIZE, TILE_SIZE)
            .ok_or_else(|| RenderError::new(ErrorKind::Encode, "invalid PNG pixel buffer"))?;
        pixmap
            .encode_png()
            .map_err(|error| RenderError::caused(ErrorKind::Encode, "PNG encoding failed", error))
    }
}

/// 今回の描画だけの統計。プロセス全体のRSSは表さない。
#[derive(Debug, Clone)]
pub struct RenderStats {
    pub search_time: Duration,
    pub draw_time: Duration,
    pub elapsed: Duration,
    pub candidate_count: u64,
    /// 描画の各段階で読み込んだ図形頂点数。同じ頂点の再読込も含む。
    pub loaded_vertices: u64,
}

/// 生成した1枚のタイル。キャッシュの公開可否・公開先は呼出元が決める。
#[derive(Debug, Clone)]
pub struct RenderedTile {
    pub tile: TileId,
    pub cache_key: String,
    pub image: TileImage,
    pub stats: RenderStats,
}

/// 1回の描画・エンコード操作で生成した応答用PNGバイト列と所要時間。
#[derive(Debug, Clone)]
pub struct RenderedPngTile {
    pub tile: TileId,
    pub cache_key: String,
    pub png: Vec<u8>,
    /// 描画だけの統計。下の`elapsed`にはエンコード時間も含む。
    pub stats: RenderStats,
    pub encode_time: Duration,
    pub elapsed: Duration,
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    #[test]
    fn final_return_checks_control_before_marking_success() {
        let cancel = CancellationToken::new();
        let context = OperationContext::new(cancel.clone());
        let result = execute_operation(&context, |guard| {
            guard.stage(Stage::Drawing);
            cancel.cancel();
            Ok(())
        });
        assert_eq!(result.unwrap_err().kind(), ErrorKind::Cancelled);
        assert_eq!(context.monitor().snapshot().status, Status::Cancelled);

        let context = OperationContext::default();
        let result = execute_operation(&context, |_| {
            context.clone().with_deadline(Instant::now());
            Ok(())
        });
        assert_eq!(result.unwrap_err().kind(), ErrorKind::DeadlineExceeded);
        assert_eq!(
            context.monitor().snapshot().status,
            Status::DeadlineExceeded
        );
    }

    #[test]
    fn sql_interrupt_keeps_its_cause_and_the_precise_stop_category() {
        for deadline in [false, true] {
            let cancel = CancellationToken::new();
            let context = OperationContext::new(cancel.clone());
            let result: Result<()> = execute_operation(&context, |_| {
                if deadline {
                    context.clone().with_deadline(Instant::now());
                } else {
                    cancel.cancel();
                }
                let sql = rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_INTERRUPT),
                    None,
                );
                Err(context_error(
                    &context,
                    ErrorKind::Query,
                    "query stopped",
                    sql.into(),
                ))
            });
            let error = result.unwrap_err();
            assert_eq!(
                error.kind(),
                if deadline {
                    ErrorKind::DeadlineExceeded
                } else {
                    ErrorKind::Cancelled
                }
            );
            assert!(
                error
                    .source
                    .as_ref()
                    .unwrap()
                    .downcast_ref::<rusqlite::Error>()
                    .is_some()
            );
            assert_eq!(
                context.monitor().snapshot().status,
                if deadline {
                    Status::DeadlineExceeded
                } else {
                    Status::Cancelled
                }
            );
        }
    }
}
