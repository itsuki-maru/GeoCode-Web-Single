//! 選択した本体DBと地図の保存先を検査し、管理画面の設定に反映する。
use super::*;
use crate::{
    init, local_routing::catalog as graphs, model::ApplicationInitSetup, tilegen::dataset::Dataset,
};
use std::path::Component;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Locations {
    pub(super) database: PathBuf,
    pub(super) catalog: PathBuf,
    pub(super) datasets: PathBuf,
    pub(super) cache: PathBuf,
    pub(super) work: PathBuf,
}

impl Locations {
    pub(super) fn current(settings: &ApplicationInitSetup) -> Self {
        Self {
            database: settings.sqlite_database_path.clone(),
            catalog: settings.tile_catalog_database_path.clone().into(),
            datasets: settings.tile_dataset_path.clone().into(),
            cache: settings.tile_cache_path.clone().into(),
            work: settings.tile_work_path.clone().into(),
        }
    }

    pub(super) fn set(&self, settings: &mut ApplicationInitSetup) -> Result<()> {
        if settings.sqlite_database_path != self.database {
            settings.database_url = database_url(&settings.database_url, &self.database)?;
        }
        settings.sqlite_database_path = self.database.clone();
        settings.tile_catalog_database_path = self.catalog.to_string_lossy().into_owned();
        settings.tile_dataset_path = self.datasets.to_string_lossy().into_owned();
        settings.tile_cache_path = self.cache.to_string_lossy().into_owned();
        settings.tile_work_path = self.work.to_string_lossy().into_owned();
        Ok(())
    }

    pub(super) fn document(&self, old: &Self, mut doc: Value, old_url: &str) -> Result<Value> {
        if self.database != old.database {
            doc["sqlite_database_path"] = json!(self.database);
            doc["database_url"] = json!(database_url(old_url, &self.database)?);
        }
        for (key, from, to) in [
            ("tile_catalog_database_path", &old.catalog, &self.catalog),
            ("tile_dataset_path", &old.datasets, &self.datasets),
            ("tile_cache_path", &old.cache, &self.cache),
            ("tile_work_path", &old.work, &self.work),
        ] {
            if from != to {
                doc[key] = json!(to);
            }
        }
        Ok(doc)
    }
}

fn database_url(old: &str, path: &Path) -> Result<String> {
    let filename = path
        .to_str()
        .ok_or("本体DBのパスを設定JSONに保存できません。")?;
    let mut url = format!(
        "sqlite:{}",
        filename
            .replace('%', "%25")
            .replace('?', "%3F")
            .replace('#', "%23")
    );
    if let Some((_, options)) = old.split_once('?') {
        url.push('?');
        url.push_str(options);
    }
    let parsed = SqliteConnectOptions::from_str(&url).map_err(message)?;
    if parsed.get_filename() != path {
        return Err("本体DBの接続先を正しく表現できません。".into());
    }
    Ok(url)
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Selection {
    database: Option<PathBuf>,
    tiles: Option<PathBuf>,
    catalog: Option<PathBuf>,
    datasets: Option<PathBuf>,
    cache: Option<PathBuf>,
    work: Option<PathBuf>,
    files: BTreeMap<String, PathBuf>,
}

fn proposed(old: &Locations, s: &Selection) -> Locations {
    let choose = |explicit: &Option<PathBuf>, leaf: &str, current: &PathBuf| {
        explicit
            .clone()
            .or_else(|| s.tiles.as_ref().map(|root| root.join(leaf)))
            .unwrap_or_else(|| current.clone())
    };
    Locations {
        database: s.database.clone().unwrap_or_else(|| old.database.clone()),
        catalog: choose(&s.catalog, "catalog.sqlite", &old.catalog),
        datasets: choose(&s.datasets, "datasets", &old.datasets),
        cache: choose(&s.cache, "png", &old.cache),
        work: choose(&s.work, "work", &old.work),
    }
}

#[derive(Serialize)]
pub(super) struct MapFile {
    id: String,
    pub(super) name: String,
    pub(super) path: PathBuf,
    previous: PathBuf,
    pub(super) error: Option<String>,
    #[serde(skip)]
    key: String,
    #[serde(skip)]
    registered: Reference,
}

pub(super) fn maps(
    db: &Connection,
    old: &Locations,
    paths: &Locations,
    files: &BTreeMap<String, PathBuf>,
) -> Result<(Vec<MapFile>, Vec<File>)> {
    let mut stmt = db
        .prepare(
            r#"
        SELECT id, name, storage_kind, database_path, dataset_key, retired
        FROM local_tile_datasets
        ORDER BY name, id
    "#,
        )
        .map_err(message)?;
    let mut rows = stmt.query([]).map_err(message)?;
    let mut result = Vec::new();
    let mut pins = Vec::new();
    while let Some(row) = rows.next().map_err(message)? {
        let (id, name, kind, saved, key, retired): (String, String, String, String, String, bool) = (
            row.get(0).map_err(message)?,
            row.get(1).map_err(message)?,
            row.get(2).map_err(message)?,
            row.get(3).map_err(message)?,
            row.get(4).map_err(message)?,
            row.get(5).map_err(message)?,
        );
        let saved = PathBuf::from(saved);
        let previous = if kind == "managed" {
            old.datasets.join(&saved)
        } else {
            saved.clone()
        };
        let path = match (kind.as_str(), files.get(&id)) {
            (_, Some(selected)) => selected.clone(),
            ("managed", None)
                if saved
                    .components()
                    .all(|c| matches!(c, Component::Normal(_))) =>
            {
                paths.datasets.join(&saved)
            },
            ("external", None) if saved.is_absolute() => saved.clone(),
            _ => return Err(format!("「{name}」のカタログ登録パスが不正です。")),
        };
        if retired && !files.contains_key(&id) {
            continue;
        }
        let checked = (|| {
            if !path.is_absolute() {
                return Err("完成DBには絶対ファイルパスを指定してください。".into());
            }
            let handle = hold_file(&path, true)?;
            let map = Dataset::open(&path).map_err(message)?;
            if map.info().dataset_id != key {
                return Err("登録済みの地図とは異なる完成DBです。".to_string());
            }
            pins.push(handle);
            Ok(())
        })();
        result.push(MapFile {
            id,
            name,
            path,
            previous,
            error: checked.err(),
            key,
            registered: Reference { kind, path: saved },
        });
    }
    if files.keys().any(|id| !result.iter().any(|r| &r.id == id)) {
        return Err("指定した地図はこのカタログにありません。".into());
    }
    Ok((result, pins))
}

pub(super) fn validate_roots(
    next: &Locations,
    warnings: &mut Vec<String>,
    settings: &ApplicationInitSetup,
) -> Result<Vec<File>> {
    let mut pins = Vec::new();
    let catalog = super::super::physical_path(&next.catalog)?;
    let mut roots = Vec::<PathBuf>::new();
    for (label, path) in [
        ("データセット", &next.datasets),
        ("PNG", &next.cache),
        ("作業領域", &next.work),
    ] {
        if path.is_dir() {
            pins.push(hold_file(path, false)?);
        } else if path.exists() {
            return Err(format!(
                "{label}のフォルダーが見つかりません。個別の保存先を確認してください。 {}",
                path.display()
            ));
        }
        let root = super::super::physical_path(path)?;
        if std::iter::once(&catalog).chain(&roots).any(|other| {
            super::super::same_or_below(&root, other) || super::super::same_or_below(other, &root)
        }) {
            return Err(format!(
                "{label}のフォルダーが他のタイル保存先と重なっています。"
            ));
        }
        roots.push(root);
    }
    let generations = |root: &Path| -> Result<Vec<graphs::Generation>> {
        graphs::store(root, false)
            .map_err(message)?
            .map(|p| graphs::generations(&p).map_err(message))
            .transpose()
            .map(Option::unwrap_or_default)
    };
    let moved = generations(&next.datasets)?;
    for generation in &moved {
        let path = next
            .datasets
            .join("routing")
            .join(&generation.id)
            .join(graphs::GRAPH);
        pins.push(hold_file(&path, true)?);
        let info = crate::local_routing::inspect(&path).map_err(|e| {
            format!(
                "道路網「{}」を開けません。 {}　{e}",
                generation.name,
                path.display()
            )
        })?;
        if serde_json::to_value(info).map_err(message)? != generation.info {
            return Err(format!(
                "道路網「{}」のDBと世代記録が一致しません。 {}",
                generation.name,
                path.display()
            ));
        }
    }
    if let Some(http) = &settings.local_routing_http
        && http.enabled
    {
        let name = http.dataset_name().map_err(message)?;
        if !moved.iter().any(|g| g.name == name) {
            warnings.push(format!("この保存先には配信設定の道路網「{name}」がありません。経路を使う場合は「経路」タブで配信する道路網を選んでください。"));
        }
    }
    Ok(pins)
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Current,
    Check {
        selection: Selection,
    },
    Apply {
        selection: Selection,
        expected: String,
    },
    InitializeCatalog {
        expected: String,
    },
    Recover,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Reference {
    kind: String,
    path: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
struct Edit {
    id: String,
    key: String,
    before: Reference,
    after: Reference,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    storage_version: u32,
    config_before: String,
    config_after: String,
    next: Locations,
    edits: Vec<Edit>,
}

struct Checked {
    maps: Vec<MapFile>,
    warnings: Vec<String>,
    _handles: Vec<File>,
    owner: Option<File>,
}

// ハンドルはこの操作の間だけ保持する。外付け媒体の永続的なファイルIDは使用しない。
fn hold_file(path: &Path, freeze: bool) -> Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(if freeze { 1 } else { 3 })
            .custom_flags(0x02000000);
    }
    #[cfg(not(windows))]
    let _ = freeze;
    opts.open(path).map_err(|e| format!("保存先を開けません。使用中のアプリ・生成処理を終了し、ドライブを確認してください。 {}　{e}", path.display()))
}

fn catalog_owner(catalog: &Path, create: bool) -> Result<Option<File>> {
    let path = lock_path(catalog);
    if !create && !path.try_exists().map_err(message)? {
        return Ok(None);
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("タイル管理DBのロックを開けません。 {}　{e}", path.display()))?;
    lock.try_lock_exclusive().map_err(|_| {
        format!(
            "このタイル管理DBを使う処理を終了してください。 {}",
            catalog.display()
        )
    })?;
    Ok(Some(lock))
}

fn missing(label: &str, path: &Path) -> String {
    format!(
        "{label}が見つかりません。ドライブを再接続するか保存先を選び直してください。 {}",
        path.display()
    )
}

fn can_initialize(paths: &Locations, config: &Path) -> bool {
    if !paths.database.is_file() || paths.catalog.exists() {
        return false;
    }
    let Some(directory) = paths.catalog.parent() else {
        return false;
    };
    // 初回設定の標準 tiles は、まだ作成されていない場合がある。任意の外部フォルダーなら接続を確認する。
    if !directory.is_dir() {
        let default = config.parent().map(|parent| parent.join("tiles"));
        let default = default.and_then(|p| super::super::physical_path(&p).ok());
        let selected = super::super::physical_path(directory).ok();
        if selected.is_none() || selected != default {
            return false;
        }
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = paths.catalog.as_os_str().to_os_string();
        name.push(suffix);
        if !matches!(fs::symlink_metadata(name), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            return false;
        }
    }
    // 作成失敗後に残ったロックファイルでも、所有者がいなければ再試行できる。
    if catalog_owner(&paths.catalog, false).is_err() {
        return false;
    }
    [&paths.datasets, &paths.cache, &paths.work]
        .into_iter()
        .all(|p| match fs::read_dir(p) {
            Ok(mut items) => items.next().is_none(),
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        })
}

fn verify_application(
    app: &Path,
    url: &str,
    freeze: Option<bool>,
) -> Result<(Option<File>, Option<String>)> {
    validate_filename(app)?;
    if !app.is_file() {
        return Err(missing("本体DB", app));
    }
    let handle = freeze.map(|mode| hold_file(app, mode)).transpose()?;
    let options = SqliteConnectOptions::from_str(url).map_err(message)?;
    let selected = app.canonicalize().map_err(message)?;
    if !options.get_filename().is_absolute()
        || options.get_filename().canonicalize().ok() != Some(selected)
    {
        return Err(
            "設定JSONの本体DBと接続先が異なります。使用する本体DBを選んでください。".into(),
        );
    }
    let warning = open_readonly(app)
        .and_then(|db| crate::db::pool::existing_schema_needs_upgrade(&db))
        .map(|needs_upgrade| {
            needs_upgrade.then(|| {
                "以前のバージョンの本体DBです。本体アプリを一度起動してDBを更新してください。"
                    .to_owned()
            })
        })
        .map_err(|e| {
            format!(
                "このバージョンのGeoCode-Webで利用できる本体DBを選んでください。 {}　{e}",
                app.display()
            )
        })?;
    Ok((handle, warning))
}

fn verify_catalog(catalog: &Path, check_contents: bool) -> Result<Connection> {
    let db = open_readonly(catalog)
        .map_err(|e| format!("タイル管理DBを開けません。 {}　{e}", catalog.display()))?;
    // 選択したカタログは通常起動と同じ整合性検査を通してから保存する。
    let result = if check_contents {
        super::super::open_catalog_file(catalog)?;
        super::super::validate_catalog(&db)
    } else {
        super::super::validate_catalog_format(&db)
    };
    result.map_err(|e| {
        format!(
            "タイル管理DBの形式を確認してください。 {}　{e}",
            catalog.display()
        )
    })?;
    Ok(db)
}

fn check(
    settings: &ApplicationInitSetup,
    old: &Locations,
    next: &Locations,
    selection: &Selection,
    apply: bool,
) -> Result<Checked> {
    let tile_selection = selection.tiles.is_some()
        || selection.catalog.is_some()
        || selection.datasets.is_some()
        || selection.cache.is_some()
        || selection.work.is_some()
        || !selection.files.is_empty();
    let inspect_tiles = tile_selection || !apply;
    let mut test = settings.clone();
    next.set(&mut test)?;
    let mut handles = Vec::new();
    let mut warnings = Vec::new();
    // tiles だけを変更する場合には、現在使用中の本体DBを書き込み禁止にしない。
    let freeze = selection.database.as_ref().map(|_| apply);
    match verify_application(&next.database, &test.database_url, freeze) {
        Ok((handle, warning)) => {
            handles.extend(handle);
            warnings.extend(warning);
        },
        Err(reason) if selection.database.is_some() => return Err(reason),
        Err(reason) => warnings.push(reason),
    }
    if apply && old.database != next.database && old.database.is_file() {
        handles.push(hold_file(&old.database, true)?);
    }
    let physical = |p: &Path| super::super::physical_path(p).unwrap_or_else(|_| p.to_owned());
    let database = physical(&next.database);
    let catalog = physical(&next.catalog);
    if super::super::path_key(&database) == super::super::path_key(&catalog) {
        return Err("本体DBとタイル管理DBには別々のファイルを選んでください。".into());
    }
    for (label, root) in [
        ("データセット", &next.datasets),
        ("PNG", &next.cache),
        ("作業領域", &next.work),
    ] {
        if super::super::same_or_below(&database, &physical(root)) {
            return Err(format!("本体DBを{label}のフォルダー内に指定できません。"));
        }
    }
    if !inspect_tiles || !next.catalog.is_file() {
        let health = if next.catalog.is_file() {
            verify_catalog(&next.catalog, false).map(|_| ())
        } else {
            Err(missing("タイル管理DB", &next.catalog))
        };
        if let Err(reason) = health {
            if tile_selection {
                return Err(reason);
            }
            warnings.push(reason);
        }
        return Ok(Checked {
            maps: Vec::new(),
            warnings,
            _handles: handles,
            owner: None,
        });
    }
    LocalTileConfig::from_setup(&test)?;
    validate_filename(&next.catalog)?;
    if apply && old.catalog.is_file() && old.catalog.canonicalize().map_err(message)? != catalog {
        handles.push(hold_file(&old.catalog, true)?);
        handles.extend(catalog_owner(&old.catalog, false)?);
    }
    for (label, explicit) in [
        ("データセット", &selection.datasets),
        ("PNG", &selection.cache),
        ("作業領域", &selection.work),
    ] {
        if let Some(path) = explicit
            && !path.is_dir()
        {
            return Err(missing(label, path));
        }
    }
    handles.push(hold_file(
        &next.catalog,
        apply && selection.files.is_empty(),
    )?);
    let owner = if apply {
        catalog_owner(&next.catalog, false)?
    } else {
        None
    };
    handles.extend(validate_roots(next, &mut warnings, settings)?);
    let db = verify_catalog(&next.catalog, true)?;
    let (maps, pins) = maps(
        &db,
        if old.catalog == next.catalog {
            old
        } else {
            next
        },
        next,
        &selection.files,
    )?;
    handles.extend(pins);
    Ok(Checked {
        maps,
        warnings,
        _handles: handles,
        owner,
    })
}

fn edits(
    checked: &Checked,
    next: &Locations,
    files: &BTreeMap<String, PathBuf>,
) -> Result<Vec<Edit>> {
    let mut result = Vec::new();
    for map in &checked.maps {
        if !files.contains_key(&map.id) {
            continue;
        }
        let file = map.path.canonicalize().map_err(message)?;
        let root = super::super::physical_path(&next.datasets)?;
        let after = match file.strip_prefix(root) {
            Ok(relative) => Reference {
                kind: "managed".into(),
                path: relative.to_owned(),
            },
            Err(_) => Reference {
                kind: "external".into(),
                path: file,
            },
        };
        if map.registered != after {
            result.push(Edit {
                id: map.id.clone(),
                key: map.key.clone(),
                before: map.registered.clone(),
                after,
            });
        }
    }
    Ok(result)
}

fn apply_edits(tx: &Connection, edits: &[Edit]) -> Result<()> {
    for edit in edits {
        let updated = tx
            .execute(
                r#"
            UPDATE local_tile_datasets
            SET storage_kind = ?1, database_path = ?2
            WHERE id = ?3 AND dataset_key = ?4
              AND ((storage_kind = ?5 AND database_path = ?6)
                OR (storage_kind = ?1 AND database_path = ?2))
        "#,
                rusqlite::params![
                    edit.after.kind,
                    edit.after.path.to_string_lossy(),
                    edit.id,
                    edit.key,
                    edit.before.kind,
                    edit.before.path.to_string_lossy()
                ],
            )
            .map_err(message)?;
        if updated != 1 {
            return Err(format!(
                "地図登録が別の操作で変更されました。保存先を確認してください。 {}",
                edit.id
            ));
        }
    }
    Ok(())
}

fn save_journal(path: &Path, journal: &Journal, config: &Path) -> Result<()> {
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("設定フォルダーがありません。")?)
            .map_err(message)?;
    init::protect_maintenance_file(config, temp.path()).map_err(message)?;
    serde_json::to_writer(&mut temp, journal).map_err(message)?;
    temp.as_file().sync_all().map_err(message)?;
    temp.persist_noclobber(path).map_err(message)?;
    Ok(())
}

fn next_document(
    old: &Locations,
    next: &Locations,
    mut doc: Value,
    old_url: &str,
) -> Result<Value> {
    doc.as_object_mut()
        .ok_or("設定JSONの形式が不正です。")?
        .remove("tile_database_replacement");
    next.document(old, doc, old_url)
}

fn document_hash(doc: &Value) -> Result<String> {
    let mut bytes = serde_json::to_vec_pretty(doc).map_err(message)?;
    bytes.push(b'\n');
    Ok(bytes_hash(&bytes))
}

fn save(
    config: &Path,
    doc: &Value,
    changed: bool,
    next: &Locations,
    changes: &[Edit],
    expected: &str,
    resume: bool,
) -> Result<()> {
    let pending = relocation::pending_path(config);
    if changed && !resume {
        init::backup_configuration(config, &config.with_added_extension("bak")).map_err(message)?;
    }
    // 両方を書き換える場合だけ中断記録を残す。保存先だけの通常操作はJSONの原子的置換で完了する。
    if !changes.is_empty() {
        let mut db = Connection::open_with_flags(&next.catalog, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(message)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(message)?;
        apply_edits(&tx, changes)?;
        if changed && !resume {
            save_journal(
                &pending,
                &Journal {
                    storage_version: 1,
                    config_before: expected.into(),
                    config_after: document_hash(doc)?,
                    next: next.clone(),
                    edits: changes.to_vec(),
                },
                config,
            )?;
        }
        tx.commit().map_err(message)?;
    }
    if changed {
        init::write_to_json_file(config.to_owned(), doc).map_err(|e| {
            if changes.is_empty() {
                e.to_string()
            } else {
                format!(
                    "地図の参照先を更新しました。「保存を再開」で設定の保存を完了してください。{e}"
                )
            }
        })?;
    }
    if (changed && !changes.is_empty()) || resume {
        fs::remove_file(pending).map_err(message)?;
    }
    Ok(())
}

pub fn run(config: &Path, action: Action) -> Result<Value> {
    let pending = relocation::pending_path(config);
    // 旧版の中断記録は、当時の署名とバックアップで最後まで復旧する。
    if matches!(action, Action::Recover) {
        let contents: Value =
            serde_json::from_slice(&fs::read(&pending).map_err(message)?).map_err(message)?;
        if contents.get("storage_version").is_none() {
            return relocation::recover(config);
        }
    }
    let write = matches!(
        &action,
        Action::Apply { .. } | Action::Recover | Action::InitializeCatalog { .. }
    );
    let _lock = if write {
        Some(init::lock_configuration(config).map_err(message)?)
    } else {
        None
    };
    let pin = hold_file(config, true)?;
    let raw = fs::read(config).map_err(message)?;
    let original: Value = serde_json::from_slice(&raw).map_err(message)?;
    let expected = bytes_hash(&raw);
    let settings = init::read_relocation_settings(config).map_err(message)?;
    let old = Locations::current(&settings);
    if matches!(action, Action::Current) {
        let pending = pending.try_exists().map_err(message)?;
        return Ok(json!({"current":old,"pending":pending,"expected":expected,
           "catalog_missing":!old.catalog.is_file(),"can_initialize_catalog":!pending && can_initialize(&old, config)}));
    }
    if !matches!(action, Action::Recover) {
        init::ensure_no_pending_move(config).map_err(message)?;
    }
    let (selection, journal) = match action {
        Action::Check { selection } => (selection, None),
        Action::Apply {
            selection,
            expected: was,
        } if was == expected => (selection, None),
        Action::InitializeCatalog { expected: was } if was == expected => {
            if !can_initialize(&old, config) {
                return Err(
                    "タイル管理DBを新規作成できません。使用する保存先を確認してください。".into(),
                );
            }
            let (_app, warning) =
                verify_application(&old.database, &settings.database_url, Some(true))?;
            let warnings: Vec<_> = warning.into_iter().collect();
            let cfg = LocalTileConfig::from_setup(&settings)?;
            crate::local_tiles::catalog::create_empty_catalog(
                &cfg.catalog_database_path,
                &[cfg.dataset_path, cfg.cache_path, cfg.work_path],
                &old.database,
            )?;
            return Ok(json!({"state":"succeeded","current":old,"maps":[],"warnings":warnings}));
        },
        Action::Recover => {
            let j: Journal =
                serde_json::from_slice(&fs::read(&pending).map_err(message)?).map_err(message)?;
            if j.storage_version != 1 {
                return Err("保存先の中断記録の版に対応していません。".into());
            }
            if expected == j.config_after {
                fs::remove_file(pending).map_err(message)?;
                return Ok(json!({"state":"succeeded","current":old}));
            }
            if expected != j.config_before {
                return Err("中断後に設定JSONが変更されました。保存先を確認してください。".into());
            }
            let files = j
                .edits
                .iter()
                .map(|e| {
                    (
                        e.id.clone(),
                        if e.after.kind == "managed" {
                            j.next.datasets.join(&e.after.path)
                        } else {
                            e.after.path.clone()
                        },
                    )
                })
                .collect();
            (
                Selection {
                    database: (j.next.database != old.database).then(|| j.next.database.clone()),
                    catalog: Some(j.next.catalog.clone()),
                    files,
                    ..Default::default()
                },
                Some(j),
            )
        },
        _ => {
            return Err(
                "表示後に設定が変更されました。「データの保存先」を開き直してください。".into(),
            );
        },
    };
    let next = journal
        .as_ref()
        .map(|j| j.next.clone())
        .unwrap_or_else(|| proposed(&old, &selection));
    let checked = check(&settings, &old, &next, &selection, write)?;
    if checked.maps.iter().any(|m| m.error.is_some()) {
        if journal.is_some() {
            return Err(
                "登録済みの完成DBを開けません。媒体を確認して保存を再開してください。".into(),
            );
        }
        return Ok(
            json!({"state":"needs_files","current":old,"target":next,"maps":checked.maps,"warnings":checked.warnings,"expected":expected}),
        );
    }
    if !write {
        return Ok(
            json!({"state":"checked","current":old,"target":next,"maps":checked.maps,"warnings":checked.warnings,"expected":expected}),
        );
    }
    let doc = next_document(&old, &next, original.clone(), &settings.database_url)?;
    let changed = doc != original;
    let changes = if let Some(j) = &journal {
        if j.config_after != document_hash(&doc)? {
            return Err("中断記録と設定の保存内容が一致しません。".into());
        }
        j.edits.clone()
    } else {
        edits(&checked, &next, &selection.files)?
    };
    let _new_owner = if !changes.is_empty() && checked.owner.is_none() {
        catalog_owner(&next.catalog, true)?
    } else {
        None
    };
    drop(pin);
    save(
        config,
        &doc,
        changed,
        &next,
        &changes,
        &expected,
        journal.is_some(),
    )?;
    Ok(json!({"state":"succeeded","current":next,"maps":checked.maps,"warnings":checked.warnings}))
}
