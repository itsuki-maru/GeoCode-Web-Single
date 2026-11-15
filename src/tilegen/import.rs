//! PBFを順番に2回走査し、ディスクを使って依存関係を解決する。

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::tilegen::{
    cancel::CancellationToken,
    geometry::{Rect, project},
    identity::{IMPORT_COMPATIBILITY_VERSION, imported_dataset_id},
    operation::{DiagnosticLevel, OperationContext, OperationGuard, Stage},
    pbf::{self, Object},
    simplify,
    store::{self, GEOMETRY_VERSION, MAX_POINTS, SCHEMA_VERSION, StoreMetadata},
    style::{IMPORT_RULES_VERSION, RoadAttributes, RoadClass, normalize_tags_with_diagnostics},
};

const BATCH_UPDATES: usize = 50_000;
// これはアプリ側のレコード書き出し閾値であり、ロールバックジャーナルの上限ではない。
// 検証済みの単一形状レコードはこれを超える場合があり、最大MAX_POINTS * 16バイトになる。
const BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_LAT: f64 = 85.051_128_779_806_6;

#[cfg(test)]
use crate::tilegen::test_support;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissingNodes {
    Error,
    SkipWay,
}

impl MissingNodes {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::SkipWay => "skip-way",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub input: PathBuf,
    pub store: PathBuf,
    pub work_dir: PathBuf,
    pub missing_nodes: MissingNodes,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub peak_rss_bytes: Option<u64>,
    pub store: PathBuf,
    pub metadata: StoreMetadata,
    pub needed_node_count: u64,
    pub selected_way_count: u64,
    pub missing_node_references: u64,
    pub pass1_seconds: f64,
    pub pass2_seconds: f64,
    pub geometry_and_lod_seconds: f64,
    pub final_validation_seconds: f64,
    pub total_seconds: f64,
    pub store_bytes: u64,
    pub staging_bytes: u64,
    pub journal_peak_bytes: u64,
}

pub fn run(options: &ImportOptions) -> Result<ImportReport> {
    run_with_cancellation(options, &CancellationToken::new())
}

pub fn run_with_cancellation(
    options: &ImportOptions,
    cancel: &CancellationToken,
) -> Result<ImportReport> {
    run_with_context(options, &OperationContext::new(cancel.clone()))
}

/// 操作単位の取消・期限・取得型の進捗通知を伴って取り込む。
/// コンテキストは一度だけ使用できる。公開後の後処理は非致命的とし、その途中で
/// 取消が届いても、公開済みストアの成功は確定済みとして扱う。
pub fn run_with_context(
    options: &ImportOptions,
    context: &OperationContext,
) -> Result<ImportReport> {
    run_with_context_and_validation(options, context, store::finish)
}

#[cfg(test)]
fn run_with_validation(
    options: &ImportOptions,
    cancel: &CancellationToken,
    validate: impl FnOnce(&Connection, &StoreMetadata) -> Result<()>,
) -> Result<ImportReport> {
    run_with_context_and_validation(options, &OperationContext::new(cancel.clone()), validate)
}

fn run_with_context_and_validation(
    options: &ImportOptions,
    context: &OperationContext,
    validate: impl FnOnce(&Connection, &StoreMetadata) -> Result<()>,
) -> Result<ImportReport> {
    let guard = context.start()?;
    let result = run_checked(options, context, &guard, validate)
        .map_err(|error| interruption_reason(error, context));
    match result {
        Ok(report) => {
            guard.succeed_committed();
            Ok(report)
        },
        Err(error) => {
            context.diagnostic(DiagnosticLevel::Error, format!("{error:#}"));
            guard.fail(&error);
            Err(error)
        },
    }
}

fn install_progress(connection: &mut Connection, context: &OperationContext) {
    let operation = context.clone();
    connection.progress_handler(10_000, Some(move || operation.check().is_err()));
}

fn interruption_reason(error: anyhow::Error, context: &OperationContext) -> anyhow::Error {
    let interrupted = error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(code, _))
                if code.code == rusqlite::ErrorCode::OperationInterrupted
        )
    });
    if interrupted {
        context.check().err().unwrap_or(error)
    } else {
        error
    }
}

fn run_checked(
    options: &ImportOptions,
    context: &OperationContext,
    guard: &OperationGuard,
    validate: impl FnOnce(&Connection, &StoreMetadata) -> Result<()>,
) -> Result<ImportReport> {
    context.check()?;
    guard.stage(Stage::Validating);
    let started = Instant::now();
    let source_before = fs::metadata(&options.input)
        .with_context(|| format!("read input metadata {}", options.input.display()))?;
    ensure!(source_before.is_file(), "input must be a regular PBF file");
    ensure!(
        !options.store.exists(),
        "store already exists: {}",
        options.store.display()
    );
    ensure!(
        !options.work_dir.exists(),
        "work directory already exists; use a fresh directory: {}",
        options.work_dir.display()
    );
    create_parent(&options.store)?;
    create_parent(&options.work_dir)?;
    fs::create_dir(&options.work_dir)
        .with_context(|| format!("create work directory {}", options.work_dir.display()))?;

    let staging_path = options.work_dir.join("staging.sqlite");
    let mut stage = Connection::open(&staging_path)?;
    install_progress(&mut stage, context);
    store::configure_writer(&stage)?;
    stage.execute_batch(
        "CREATE TABLE selected_ways(
           way_id INTEGER PRIMARY KEY,node_ids BLOB NOT NULL,
           road_class INTEGER NOT NULL,is_link INTEGER NOT NULL,
           effective_layer INTEGER NOT NULL,structure_rank INTEGER NOT NULL
         );
         CREATE TABLE needed_nodes(
           node_id INTEGER PRIMARY KEY,reference_count INTEGER NOT NULL,
           lon REAL,lat REAL
         );",
    )?;

    let mut highway_counts = BTreeMap::new();
    let mut selected_way_count = 0_u64;
    let mut excluded_way_count = 0_u64;
    let mut journal_peak_bytes = 0_u64;
    let pass1_started = Instant::now();
    guard.stage(Stage::ImportPass1);
    context.diagnostic(
        DiagnosticLevel::Info,
        "import pass 1: select ways and collect required node IDs",
    );
    stage.execute_batch("BEGIN IMMEDIATE")?;
    let first = {
        let mut insert_way = stage.prepare(
            "INSERT INTO selected_ways
             (way_id,node_ids,road_class,is_link,effective_layer,structure_rank)
             VALUES(?1,?2,?3,?4,?5,?6)",
        )?;
        let mut insert_node = stage.prepare(
            "INSERT INTO needed_nodes(node_id,reference_count) VALUES(?1,1)
             ON CONFLICT(node_id) DO UPDATE SET reference_count=reference_count+1",
        )?;
        let mut batch = Batch::new(&staging_path);
        let mut visited_objects = 0_u64;
        let report = pbf::scan_with_check(
            &options.input,
            |object| {
                context.check()?;
                if visited_objects.is_multiple_of(1024) {
                    guard.progress(visited_objects, None);
                }
                visited_objects += 1;
                let Object::Way(way) = object else {
                    return Ok(());
                };
                if let Some(highway) = way.tags.get("highway") {
                    record_highway(&mut highway_counts, highway);
                }
                let Some(attributes) = normalize_tags_with_diagnostics(&way.tags, |warning| {
                    context.diagnostic(
                        DiagnosticLevel::Warning,
                        format!("Way {}: {warning}", way.id),
                    );
                }) else {
                    excluded_way_count += 1;
                    return Ok(());
                };
                ensure!(
                    way.nodes.len() <= MAX_POINTS,
                    "Way {} exceeds {MAX_POINTS} node references",
                    way.id
                );
                let node_ids = encode_ids_with_check(&way.nodes, || context.check())?;
                insert_way
                    .execute(params![
                        way.id,
                        node_ids,
                        attributes.road_class as u8,
                        attributes.is_link,
                        attributes.effective_layer,
                        attributes.structure_rank
                    ])
                    .with_context(|| {
                        format!("store selected Way {}; duplicate IDs are invalid", way.id)
                    })?;
                batch.record(&stage, 1, way.nodes.len() * 8 + 64)?;
                for (index, node) in way.nodes.into_iter().enumerate() {
                    if index.is_multiple_of(1024) {
                        context.check()?;
                    }
                    insert_node.execute([node])?;
                    batch.record(&stage, 1, 8)?;
                }
                selected_way_count += 1;
                Ok(())
            },
            || context.check(),
        )?;
        guard.progress(visited_objects, None);
        journal_peak_bytes = journal_peak_bytes.max(batch.sample_journal());
        report
    };
    stage.execute_batch("COMMIT")?;
    check_source(&options.input, &source_before)?;
    let pass1_seconds = pass1_started.elapsed().as_secs_f64();
    ensure!(
        selected_way_count > 0,
        "PBF contains no supported road ways"
    );
    let needed_node_count: i64 =
        stage.query_row("SELECT count(*) FROM needed_nodes", [], |r| r.get(0))?;
    let needed_node_count = u64::try_from(needed_node_count)?;

    let pass2_started = Instant::now();
    guard.stage(Stage::ImportPass2);
    guard.progress(0, Some(needed_node_count));
    let mut clamped_node_count = 0_u64;
    context.diagnostic(
        DiagnosticLevel::Info,
        format!("import pass 2: resolve {needed_node_count} required nodes for {selected_way_count} ways"),
    );
    stage.execute_batch("BEGIN IMMEDIATE")?;
    let second = {
        let mut lookup =
            stage.prepare("SELECT lon IS NOT NULL FROM needed_nodes WHERE node_id=?1")?;
        let mut update = stage.prepare("UPDATE needed_nodes SET lon=?1,lat=?2 WHERE node_id=?3")?;
        let mut batch = Batch::new(&staging_path);
        let mut resolved_nodes = 0_u64;
        let report = pbf::scan_with_check(
            &options.input,
            |object| {
                context.check()?;
                let Object::Node(node) = object else {
                    return Ok(());
                };
                let present: Option<bool> = lookup.query_row([node.id], |r| r.get(0)).optional()?;
                match present {
                    None => return Ok(()),
                    Some(true) => bail!("duplicate required Node ID {}", node.id),
                    Some(false) => {},
                }
                // SQLiteはNaNをNULLへ変換するため、渡す前に検証する。
                project(node.lon, node.lat)
                    .with_context(|| format!("invalid coordinate on required Node {}", node.id))?;
                if node.lat.abs() > MAX_LAT {
                    clamped_node_count += 1;
                }
                update.execute(params![node.lon, node.lat, node.id])?;
                batch.record(&stage, 1, 24)?;
                resolved_nodes += 1;
                if resolved_nodes.is_multiple_of(1024) {
                    guard.progress(resolved_nodes, Some(needed_node_count));
                }
                Ok(())
            },
            || context.check(),
        )?;
        guard.progress(resolved_nodes, Some(needed_node_count));
        journal_peak_bytes = journal_peak_bytes.max(batch.sample_journal());
        report
    };
    stage.execute_batch("COMMIT")?;
    check_source(&options.input, &source_before)?;
    ensure!(
        first.source_sha256 == second.source_sha256
            && first.bytes == second.bytes
            && first.bytes == source_before.len(),
        "input PBF changed between import passes"
    );
    let pass2_seconds = pass2_started.elapsed().as_secs_f64();

    let building_path = options.store.with_extension("building.sqlite");
    let building_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&building_path)
        .with_context(|| format!("create new building store {}", building_path.display()))?;
    drop(building_file);
    let mut output = Connection::open(&building_path)?;
    install_progress(&mut output, context);
    store::initialize(&output)?;
    // LODの基準点のために両DBを開いたままにする。
    // 各接続へ64 MiBずつ割り当てず、推奨ページキャッシュ量を合計64 MiBに保つ。
    stage.execute_batch("PRAGMA cache_size=-16384")?;
    output.execute_batch("PRAGMA cache_size=-49152")?;
    output.execute_batch("BEGIN IMMEDIATE")?;
    let geometry_started = Instant::now();
    guard.stage(Stage::BuildingGeometry);
    guard.progress(0, Some(selected_way_count));
    let mut feature_count = 0_u64;
    let mut original_point_count = 0_u64;
    let mut missing_node_references = 0_u64;
    let mut skipped_missing_way_count = 0_u64;
    let mut degenerate_way_count = 0_u64;
    let mut lod_point_counts: BTreeMap<u8, u64> = (6..=15).map(|z| (z, 0)).collect();
    let mut bounds: Option<Rect> = None;
    context.diagnostic(
        DiagnosticLevel::Info,
        "import: build projected features, R-tree and zoom 6..15 LOD",
    );
    {
        let mut ways = stage.prepare(
            "SELECT way_id,node_ids,road_class,is_link,effective_layer,structure_rank
             FROM selected_ways ORDER BY way_id",
        )?;
        let mut rows = ways.query([])?;
        let mut node_lookup =
            stage.prepare("SELECT lon,lat,reference_count FROM needed_nodes WHERE node_id=?1")?;
        let mut feature_insert = output.prepare(
            "INSERT INTO features(osm_way_id,road_class,is_link,effective_layer,structure_rank,
              min_x,max_x,min_y,max_y,point_count,points)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        )?;
        let mut index_insert = output.prepare(
            "INSERT INTO feature_rtree(feature_id,min_x,max_x,min_y,max_y)
             VALUES(?1,?2,?3,?4,?5)",
        )?;
        let mut lod_insert = output.prepare(
            "INSERT INTO geometry_lod(feature_id,zoom,point_count,points) VALUES(?1,?2,?3,?4)",
        )?;
        let mut batch = Batch::new(&building_path);
        let mut processed_ways = 0_u64;
        while let Some(row) = rows.next()? {
            context.check()?;
            if processed_ways.is_multiple_of(1024) {
                guard.progress(processed_ways, Some(selected_way_count));
            }
            processed_ways += 1;
            let way_id: i64 = row.get(0)?;
            let node_bytes: Vec<u8> = row.get(1)?;
            let node_ids = decode_ids_with_check(&node_bytes, || context.check())?;
            drop(node_bytes);
            if node_ids.len() < 2 {
                degenerate_way_count += 1;
                continue;
            }
            let attributes = RoadAttributes {
                road_class: RoadClass::from_code(row.get(2)?)?,
                is_link: row.get(3)?,
                effective_layer: row.get(4)?,
                structure_rank: row.get(5)?,
            };
            let mut points = Vec::new();
            let mut protected = Vec::new();
            points.try_reserve_exact(node_ids.len())?;
            protected.try_reserve_exact(node_ids.len())?;
            let mut missing = Vec::new();
            let mut missing_count = 0_u64;
            let mut previous_lon: Option<f64> = None;
            let mut crosses_antimeridian = false;
            for (index, id) in node_ids.into_iter().enumerate() {
                if index.is_multiple_of(1024) {
                    context.check()?;
                }
                let coordinate: Option<(Option<f64>, Option<f64>, i64)> = node_lookup
                    .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .optional()?;
                let Some((Some(lon), Some(lat), references)) = coordinate else {
                    missing_count += 1;
                    if missing.len() < 8 {
                        missing.push(id);
                    }
                    continue;
                };
                if let Some(previous) = previous_lon {
                    crosses_antimeridian |= (lon - previous).abs() > 180.0;
                }
                previous_lon = Some(lon);
                points.push(project(lon, lat).with_context(|| format!("project Way {way_id}"))?);
                protected.push(references >= 2);
            }
            if missing_count > 0 {
                missing_node_references += missing_count;
                if options.missing_nodes == MissingNodes::Error {
                    bail!(
                        "Way {way_id} has {missing_count} missing Node references (examples: {missing:?}); \
                         use a complete PBF or --missing-nodes skip-way"
                    );
                }
                skipped_missing_way_count += 1;
                context.diagnostic(
                    DiagnosticLevel::Warning,
                    format!("skip Way {way_id}: {missing_count} missing Nodes ({missing:?})"),
                );
                continue;
            }
            ensure!(
                !crosses_antimeridian,
                "Way {way_id} crosses the antimeridian, which is unsupported"
            );
            if points
                .iter()
                .all(|p| p.x == points[0].x && p.y == points[0].y)
            {
                degenerate_way_count += 1;
                continue;
            }
            let bbox = Rect::from_points(&points)?;
            let geometry = store::encode_points(&points)?;
            feature_insert.execute(params![
                way_id,
                attributes.road_class as u8,
                attributes.is_link,
                attributes.effective_layer,
                attributes.structure_rank,
                bbox.min_x,
                bbox.max_x,
                bbox.min_y,
                bbox.max_y,
                points.len() as i64,
                &geometry
            ])?;
            drop(geometry);
            let feature_id = output.last_insert_rowid();
            index_insert.execute(params![
                feature_id, bbox.min_x, bbox.max_x, bbox.min_y, bbox.max_y
            ])?;
            batch.record(&output, 2, points.len() * 16 + 48)?;
            for zoom in 6_u8..=15 {
                context.check()?;
                let epsilon = 0.5 / (256.0 * f64::from(1_u32 << zoom));
                let lod =
                    simplify::simplify_with_check(&points, &protected, epsilon, || context.check())
                        .with_context(|| format!("simplify Way {way_id} at zoom {zoom}"))?;
                let geometry = store::encode_points(&lod)?;
                lod_insert.execute(params![feature_id, zoom, lod.len() as i64, geometry])?;
                batch.record(&output, 1, lod.len() * 16 + 24)?;
                *lod_point_counts
                    .get_mut(&zoom)
                    .expect("LOD zoom initialized") += lod.len() as u64;
            }
            feature_count += 1;
            original_point_count += points.len() as u64;
            bounds = Some(match bounds {
                Some(previous) => union(previous, bbox),
                None => bbox,
            });
        }
        guard.progress(processed_ways, Some(selected_way_count));
        journal_peak_bytes = journal_peak_bytes.max(batch.sample_journal());
    }
    output.execute_batch("COMMIT")?;
    let geometry_and_lod_seconds = geometry_started.elapsed().as_secs_f64();
    ensure!(
        feature_count > 0,
        "no valid road features remain after import exclusions"
    );
    let source_timestamp = first.timestamp.or(second.timestamp);
    let import_rules = serde_json::json!({
        "rules_version": IMPORT_RULES_VERSION,
        "missing_nodes": options.missing_nodes,
        "max_points": MAX_POINTS,
        "lod_min_zoom": 6,
        "lod_max_zoom": 15,
        "lod_error_px": 0.5,
        "schema_version": SCHEMA_VERSION,
        "geometry_version": GEOMETRY_VERSION,
    });
    let import_rules_hash = hex_hash(serde_json::to_vec(&import_rules)?);
    let dataset_id = imported_dataset_id(&first.source_sha256, &import_rules_hash);
    let metadata = StoreMetadata {
        schema_version: SCHEMA_VERSION,
        geometry_version: GEOMETRY_VERSION,
        importer_version: IMPORT_COMPATIBILITY_VERSION.to_owned(),
        import_rules_hash,
        dataset_id,
        source_sha256: first.source_sha256,
        source_bytes: first.bytes,
        source_timestamp,
        created_unix_seconds: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        coordinate_system: "web-mercator-normalized-f64".to_owned(),
        bbox: bounds.context("missing feature bounds")?,
        feature_count,
        original_point_count,
        lod_point_counts,
        missing_nodes_policy: options.missing_nodes.as_str().to_owned(),
        excluded_way_count,
        skipped_missing_way_count,
        degenerate_way_count,
        clamped_node_count,
        highway_counts,
        complete: true,
    };
    let validation_started = Instant::now();
    guard.stage(Stage::FinalValidation);
    context.check()?;
    validate(&output, &metadata)?;
    context.check()?;
    output.close().map_err(|(_, error)| error)?;
    let staging_bytes = fs::metadata(&staging_path)?.len();
    stage.close().map_err(|(_, error)| error)?;
    let store_bytes = fs::metadata(&building_path)?.len();

    // 新しいハードリンクの作成により、並行作成中または既存のストアを置き換えずに
    // 原子的に公開する。構築中ファイルは同じディレクトリ・ファイルシステムへ置く。
    guard.stage(Stage::Publishing);
    context.check()?;
    fs::hard_link(&building_path, &options.store)
        .with_context(|| format!("publish completed store {}", options.store.display()))?;
    if let Err(error) = fs::remove_file(&building_path) {
        context.diagnostic(
            DiagnosticLevel::Warning,
            format!("could not remove building-store link: {error}"),
        );
    }
    if let Err(error) = fs::remove_file(&staging_path) {
        context.diagnostic(
            DiagnosticLevel::Warning,
            format!("could not remove completed staging file: {error}"),
        );
    }
    if let Err(error) = fs::remove_dir(&options.work_dir) {
        context.diagnostic(
            DiagnosticLevel::Warning,
            format!("could not remove completed work directory: {error}"),
        );
    }
    let final_validation_seconds = validation_started.elapsed().as_secs_f64();
    Ok(ImportReport {
        peak_rss_bytes: crate::tilegen::metrics::peak_rss_bytes(),
        store: options.store.clone(),
        metadata,
        needed_node_count,
        selected_way_count,
        missing_node_references,
        pass1_seconds,
        pass2_seconds,
        geometry_and_lod_seconds,
        final_validation_seconds,
        total_seconds: started.elapsed().as_secs_f64(),
        store_bytes,
        staging_bytes,
        journal_peak_bytes,
    })
}

struct Batch {
    updates: usize,
    bytes: usize,
    journal_path: PathBuf,
    journal_peak_bytes: u64,
}

impl Batch {
    fn new(database: &Path) -> Self {
        let mut path = database.as_os_str().to_owned();
        path.push("-journal");
        Self {
            updates: 0,
            bytes: 0,
            journal_path: path.into(),
            journal_peak_bytes: 0,
        }
    }

    fn sample_journal(&mut self) -> u64 {
        if let Ok(metadata) = fs::metadata(&self.journal_path) {
            self.journal_peak_bytes = self.journal_peak_bytes.max(metadata.len());
        }
        self.journal_peak_bytes
    }

    fn record(&mut self, connection: &Connection, updates: usize, bytes: usize) -> Result<()> {
        self.updates = self
            .updates
            .checked_add(updates)
            .context("batch update overflow")?;
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .context("batch byte overflow")?;
        if self.updates >= BATCH_UPDATES || self.bytes >= BATCH_BYTES {
            self.sample_journal();
            connection.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
            self.updates = 0;
            self.bytes = 0;
        }
        Ok(())
    }
}

fn create_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .with_context(|| format!("create directory {}", parent.display()))?;
    }
    Ok(())
}

fn check_source(path: &Path, expected: &fs::Metadata) -> Result<()> {
    let actual = fs::metadata(path)?;
    ensure!(
        actual.is_file()
            && actual.len() == expected.len()
            && actual.modified()? == expected.modified()?,
        "input PBF changed during import: {}",
        path.display()
    );
    Ok(())
}

#[cfg(test)]
fn encode_ids(ids: &[i64]) -> Result<Vec<u8>> {
    encode_ids_with_check(ids, || Ok(()))
}

fn encode_ids_with_check(ids: &[i64], mut check: impl FnMut() -> Result<()>) -> Result<Vec<u8>> {
    ensure!(ids.len() <= MAX_POINTS, "too many Way node references");
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(ids.len() * 8)?;
    for (index, id) in ids.iter().enumerate() {
        if index.is_multiple_of(1024) {
            check()?;
        }
        bytes.extend_from_slice(&id.to_le_bytes());
    }
    check()?;
    Ok(bytes)
}

#[cfg(test)]
fn decode_ids(bytes: &[u8]) -> Result<Vec<i64>> {
    decode_ids_with_check(bytes, || Ok(()))
}

fn decode_ids_with_check(bytes: &[u8], mut check: impl FnMut() -> Result<()>) -> Result<Vec<i64>> {
    ensure!(
        bytes.len().is_multiple_of(8) && bytes.len() <= MAX_POINTS * 8,
        "invalid staged Node ID array"
    );
    let mut ids = Vec::new();
    ids.try_reserve_exact(bytes.len() / 8)?;
    for (index, bytes) in bytes.as_chunks::<8>().0.iter().enumerate() {
        if index.is_multiple_of(1024) {
            check()?;
        }
        ids.push(i64::from_le_bytes(*bytes));
    }
    check()?;
    Ok(ids)
}

fn record_highway(counts: &mut BTreeMap<String, u64>, highway: &str) {
    // 任意の入力タグの統計量に、入力元のサイズと独立した上限を設ける。
    let key = if highway.len() > 256 {
        "<overlong-values>"
    } else if counts.contains_key(highway) || counts.len() < 256 {
        highway
    } else {
        "<other-values>"
    };
    *counts.entry(key.to_owned()).or_default() += 1;
}

fn union(a: Rect, b: Rect) -> Rect {
    Rect {
        min_x: a.min_x.min(b.min_x),
        max_x: a.max_x.max(b.max_x),
        min_y: a.min_y.min(b.min_y),
        max_y: a.max_y.max(b.max_y),
    }
}

fn hex_hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_during_final_validation_keeps_the_store_unpublished() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let options = ImportOptions {
            input: directory.path().join("input.osm.pbf"),
            store: directory.path().join("cancelled.sqlite"),
            work_dir: directory.path().join("work"),
            missing_nodes: MissingNodes::Error,
        };
        test_support::Fixture::sample().write(&options.input);
        let cancel = CancellationToken::new();
        let mut validation_finished = false;

        let result = run_with_validation(&options, &cancel, |connection, metadata| {
            store::finish(connection, metadata)?;
            validation_finished = true;
            cancel.cancel();
            Ok(())
        });

        assert!(
            validation_finished,
            "the real final validation must complete"
        );
        let error = result.expect_err("cancellation must prevent store publication");
        assert!(crate::tilegen::cancel::is_interrupted(&error), "{error:#}");
        assert!(!options.store.exists());
        assert!(options.store.with_extension("building.sqlite").exists());
        assert!(options.work_dir.join("staging.sqlite").exists());
        Ok(())
    }

    #[test]
    fn staged_node_ids_are_signed_and_checked() -> Result<()> {
        let ids = [-1, 1, i64::MAX];
        assert_eq!(decode_ids(&encode_ids(&ids)?)?, ids);
        assert!(decode_ids(&[0; 7]).is_err());
        Ok(())
    }

    #[test]
    fn arbitrary_highway_statistics_are_bounded() {
        let mut counts = BTreeMap::new();
        for i in 0..10_000 {
            record_highway(&mut counts, &format!("unknown-{i}"));
        }
        assert_eq!(counts.len(), 257);
        assert_eq!(counts.values().sum::<u64>(), 10_000);
        record_highway(&mut counts, &"x".repeat(1024));
        assert_eq!(counts["<overlong-values>"], 1);
        assert!(counts.keys().all(|key| key.len() <= 256));
    }

    #[test]
    fn context_deadline_fails_before_creating_import_files() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let options = ImportOptions {
            input: directory.path().join("input.osm.pbf"),
            store: directory.path().join("map.sqlite"),
            work_dir: directory.path().join("work"),
            missing_nodes: MissingNodes::Error,
        };
        let context = OperationContext::new(CancellationToken::new()).with_deadline(Instant::now());
        let monitor = context.monitor();
        let error = run_with_context(&options, &context).unwrap_err();
        assert!(crate::tilegen::operation::is_deadline_exceeded(&error));
        assert_eq!(
            monitor.snapshot().status,
            crate::tilegen::operation::Status::DeadlineExceeded
        );
        assert!(!options.work_dir.exists() && !options.store.exists());
        Ok(())
    }

    #[test]
    fn deadline_after_final_validation_keeps_the_store_unpublished() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let options = ImportOptions {
            input: directory.path().join("input.osm.pbf"),
            store: directory.path().join("map.sqlite"),
            work_dir: directory.path().join("work"),
            missing_nodes: MissingNodes::Error,
        };
        test_support::Fixture::sample().write(&options.input);
        let context = OperationContext::default();
        let error = run_with_context_and_validation(&options, &context, |connection, metadata| {
            store::finish(connection, metadata)?;
            context.clone().with_deadline(Instant::now());
            Ok(())
        })
        .unwrap_err();
        assert!(crate::tilegen::operation::is_deadline_exceeded(&error));
        let snapshot = context.monitor().snapshot();
        assert_eq!(
            snapshot.status,
            crate::tilegen::operation::Status::DeadlineExceeded
        );
        assert_eq!(snapshot.stage, Stage::FinalValidation);
        assert!(!options.store.exists());
        assert!(options.store.with_extension("building.sqlite").exists());
        Ok(())
    }

    #[test]
    fn final_sql_cancellation_is_typed_and_keeps_the_store_unpublished() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let options = ImportOptions {
            input: directory.path().join("input.osm.pbf"),
            store: directory.path().join("map.sqlite"),
            work_dir: directory.path().join("work"),
            missing_nodes: MissingNodes::Error,
        };
        test_support::Fixture::sample().write(&options.input);
        let token = CancellationToken::new();
        let context = OperationContext::new(token.clone());
        let monitor = context.monitor();
        let error = run_with_context_and_validation(&options, &context, |connection, _| {
            assert_eq!(monitor.snapshot().stage, Stage::FinalValidation);
            token.cancel();
            connection.query_row(
                "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n",
                [], |row| row.get::<_, i64>(0),
            )?;
            anyhow::bail!("SQL should be interrupted before completion")
        }).unwrap_err();
        assert!(crate::tilegen::cancel::is_interrupted(&error), "{error:#}");
        assert_eq!(
            monitor.snapshot().status,
            crate::tilegen::operation::Status::Cancelled
        );
        assert!(!options.store.exists());
        assert!(options.store.with_extension("building.sqlite").exists());
        Ok(())
    }

    #[test]
    fn sql_deadline_maps_to_its_typed_reason() -> Result<()> {
        let context = OperationContext::new(CancellationToken::new()).with_deadline(Instant::now());
        let mut connection = Connection::open_in_memory()?;
        install_progress(&mut connection, &context);
        let error = connection.query_row(
            "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n",
            [], |row| row.get::<_, i64>(0),
        ).unwrap_err();
        let error = interruption_reason(error.into(), &context);
        assert!(
            crate::tilegen::operation::is_deadline_exceeded(&error),
            "{error:#}"
        );
        Ok(())
    }

    #[test]
    fn successful_context_import_finishes_without_a_progress_consumer() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let options = ImportOptions {
            input: directory.path().join("input.osm.pbf"),
            store: directory.path().join("map.sqlite"),
            work_dir: directory.path().join("work"),
            missing_nodes: MissingNodes::Error,
        };
        test_support::Fixture::sample().write(&options.input);
        let context = OperationContext::new(CancellationToken::new());
        let monitor = context.monitor();
        let report = run_with_context(&options, &context)?;
        assert_eq!(report.metadata.feature_count, 1);
        let snapshot = monitor.snapshot();
        assert_eq!(
            snapshot.status,
            crate::tilegen::operation::Status::Succeeded
        );
        assert_eq!(snapshot.stage, Stage::Completed);
        Ok(())
    }

    #[test]
    fn normalization_warnings_are_bounded_and_keep_import_attributes() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let options = ImportOptions {
            input: directory.path().join("input.osm.pbf"),
            store: directory.path().join("map.sqlite"),
            work_dir: directory.path().join("work"),
            missing_nodes: MissingNodes::Error,
        };
        let mut fixture = test_support::Fixture::sample();
        fixture.ways = (10..50)
            .map(|id| crate::tilegen::pbf::Way {
                id,
                nodes: vec![1, 2, 3],
                tags: BTreeMap::from([
                    ("highway".into(), "residential".into()),
                    ("bridge".into(), "yes".into()),
                    ("tunnel".into(), "yes".into()),
                    ("layer".into(), "あ".repeat(1_000)),
                ]),
            })
            .collect();
        fixture.write(&options.input);
        let context = OperationContext::default();
        let report = run_with_context(&options, &context)?;
        assert_eq!(report.metadata.feature_count, 40);
        let output = store::Store::open(&options.store)?;
        let features = output.query_candidates(report.metadata.bbox, 14)?;
        assert_eq!(features.len(), 40);
        assert!(features.iter().all(|feature| {
            feature.attributes.effective_layer == 0 && feature.attributes.structure_rank == 1
        }));
        let snapshot = context.monitor().snapshot();
        assert_eq!(
            snapshot.status,
            crate::tilegen::operation::Status::Succeeded
        );
        assert_eq!(
            snapshot.diagnostics.len(),
            crate::tilegen::operation::MAX_DIAGNOSTICS
        );
        assert_eq!(
            snapshot.dropped_diagnostics,
            83 - crate::tilegen::operation::MAX_DIAGNOSTICS as u64
        );
        assert!(snapshot.diagnostics.iter().all(|diagnostic| {
            diagnostic.message.len() <= crate::tilegen::operation::MAX_DIAGNOSTIC_BYTES
        }));
        assert!(snapshot.diagnostics.iter().any(|diagnostic| {
            diagnostic.level == DiagnosticLevel::Warning
                && diagnostic.stage == Stage::ImportPass1
                && diagnostic.message.starts_with("Way 10: invalid layer ")
                && diagnostic.message.contains("(sample truncated)")
        }));
        Ok(())
    }

    #[test]
    fn cleanup_failure_is_a_diagnostic_and_keeps_the_published_success() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let options = ImportOptions {
            input: directory.path().join("input.osm.pbf"),
            store: directory.path().join("map.sqlite"),
            work_dir: directory.path().join("work"),
            missing_nodes: MissingNodes::Error,
        };
        test_support::Fixture::sample().write(&options.input);
        let context = OperationContext::default();
        let report = run_with_context_and_validation(&options, &context, |connection, metadata| {
            store::finish(connection, metadata)?;
            fs::write(options.work_dir.join("retained-file"), [])?;
            Ok(())
        });
        assert!(report.is_ok());
        assert_eq!(
            store::Store::open(&options.store)?.metadata().feature_count,
            1
        );
        assert!(!options.work_dir.join("staging.sqlite").exists());
        let snapshot = context.monitor().snapshot();
        assert_eq!(
            snapshot.status,
            crate::tilegen::operation::Status::Succeeded
        );
        assert!(snapshot.diagnostics.iter().any(|diagnostic| {
            diagnostic.level == DiagnosticLevel::Warning
                && diagnostic.stage == Stage::Publishing
                && diagnostic
                    .message
                    .starts_with("could not remove completed work directory:")
        }));
        Ok(())
    }
}
