//! 道路形式を変更せず、線・複合面・標高を新しい不変DBへ取り込む。

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::{
    areas, labels,
    model::{
        ContourData, DatasetCapabilities, Feature, FeatureKind, Geometry, SourceInfo,
        StandardFeatureSet, StandardMetadata,
    },
    store,
};
use crate::tilegen::{
    geometry::{Point, project},
    import::{ImportReport, MissingNodes},
    operation::{DiagnosticLevel, OperationContext, OperationGuard, Stage},
    pbf::{self, MemberKind, Object, Relation},
    store::StoreMetadata,
    style::normalize_tags,
};

pub const IMPORT_REVISION: &str = "standard-areas-dem-contours-v2-mixed-dem";
const MAX_POINTS: usize = 1_000_000;
const MAX_DOCUMENT_BYTES: usize = 24 * 1024 * 1024;

pub use super::model::{InvalidAreas, StandardImportOptions};

pub fn run_with_context(
    options: &StandardImportOptions,
    context: &OperationContext,
) -> Result<ImportReport> {
    let guard = context.start()?;
    let result = run(options, context, &guard).map_err(|error| match context.check() {
        Err(stop) => error.context(stop),
        Ok(()) => error,
    });
    match &result {
        Ok(_) => guard.succeed_committed(),
        Err(error) => {
            context.diagnostic(DiagnosticLevel::Error, format!("{error:#}"));
            guard.fail(error);
        },
    }
    result
}

fn run(
    options: &StandardImportOptions,
    context: &OperationContext,
    guard: &OperationGuard,
) -> Result<ImportReport> {
    let start = Instant::now();
    let base = &options.base;
    let extended = options.feature_set == StandardFeatureSet::StandardV2;
    guard.stage(Stage::Validating);
    context.check()?;
    ensure!(base.input.is_file(), "入力PBFがありません");
    ensure!(!base.store.exists(), "既存の完成DBは上書きしません");
    ensure!(
        extended || options.contour_data == ContourData::On,
        "contour-data offはstandard-v2でのみ指定できます"
    );
    ensure!(
        !base.work_dir.exists(),
        "既存の作業ディレクトリは使用しません"
    );
    ensure!(
        options.elevation_input.is_some()
            || options.elevation_datum_policy == super::model::ElevationDatumPolicy::Strict,
        "標高入力がない場合は混在許可を指定できません"
    );
    // 地物構築を始める前に、標高の受入条件を確認する。
    let elevation_inspection = if let Some(path) = &options.elevation_input {
        let inspected =
            super::elevation::inspect_input(path, options.elevation_datum_policy, context);
        context.check()?;
        ensure!(
            inspected.allowed,
            "DEM事前検査に失敗しました: {}",
            inspected.error.as_deref().unwrap_or("原因を取得できません")
        );
        for warning in &inspected.warnings {
            context.diagnostic(DiagnosticLevel::Warning, warning);
        }
        Some(inspected)
    } else {
        None
    };
    if let Some(parent) = base.store.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = base.work_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&base.work_dir)?;
    let staging_path = base.work_dir.join("standard-staging.sqlite");
    let staging = Connection::open(&staging_path)?;
    crate::tilegen::store::configure_writer(&staging)?;
    let operation = context.clone();
    staging.progress_handler(10_000, Some(move || operation.check().is_err()));
    staging.execute_batch("CREATE TABLE relations(id INTEGER PRIMARY KEY,document TEXT NOT NULL);
        CREATE TABLE member_ways(id INTEGER PRIMARY KEY);
        CREATE TABLE selected_ways(id INTEGER PRIMARY KEY,node_ids BLOB NOT NULL,tags TEXT NOT NULL);
        CREATE TABLE nodes(id INTEGER PRIMARY KEY,x REAL,y REAL);
        CREATE TABLE used_areas(id INTEGER NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(id,kind));")?;
    if extended {
        staging.execute_batch("CREATE TABLE node_labels(id INTEGER PRIMARY KEY,document TEXT NOT NULL); CREATE TABLE label_relations(id INTEGER PRIMARY KEY,document TEXT NOT NULL);")?;
    }
    let mut label_skipped = BTreeMap::<String, u64>::new();
    let mut metadata = StandardMetadata {
        revision: if extended { 2 } else { 1 },
        counts: BTreeMap::new(),
        skipped_areas: BTreeMap::new(),
        sources: Vec::new(),
        elevation: None,
        capabilities: extended.then_some(DatasetCapabilities {
            labels: true,
            elevation: options.elevation_input.is_some(),
            contours: options.elevation_input.is_some() && options.contour_data == ContourData::On,
        }),
        labels: None,
    };
    let before = input_fingerprint(&base.input)?;
    let first_started = Instant::now();
    guard.stage(Stage::ImportPass1);
    staging.execute_batch("BEGIN IMMEDIATE")?;
    let mut batch = Batch::new(&staging_path);
    let mut objects = 0;
    let first = pbf::scan_all_with_check(
        &base.input,
        |object| {
            objects += 1;
            if objects % 1024 == 0 {
                guard.progress(objects, None);
            }
            let Object::Relation(relation) = object else {
                return Ok(());
            };
            if extended && labels::selected(&relation.tags) {
                for member in &relation.members {
                    if member.kind == MemberKind::Node
                        && matches!(member.role.as_str(), "label" | "admin_centre")
                    {
                        staging
                            .execute("INSERT OR IGNORE INTO nodes(id) VALUES(?)", [member.id])?;
                        batch.record(&staging, 16)?;
                    }
                }
                if relation.tags.get("type").map(String::as_str) != Some("multipolygon") {
                    let document = serde_json::to_string(&relation)?;
                    ensure!(
                        document.len() <= MAX_DOCUMENT_BYTES,
                        "行政名称Relationが過大です"
                    );
                    staging.execute(
                        "INSERT INTO label_relations VALUES(?,?)",
                        params![relation.id, document],
                    )?;
                    batch.record(&staging, document.len() + 32)?;
                    if labels::category(&relation.tags) == Some("water.river") {
                        for member in &relation.members {
                            if member.kind == MemberKind::Way {
                                staging.execute(
                                    "INSERT OR IGNORE INTO member_ways VALUES(?)",
                                    [member.id],
                                )?;
                                batch.record(&staging, 16)?;
                            }
                        }
                    }
                }
            }
            if relation.tags.get("type").map(String::as_str) != Some("multipolygon") {
                return Ok(());
            }
            // 分類のない旧形式Relationは、次の走査でouterタグを確認する。
            if area_kind(&relation.tags).is_none()
                && has_area_tag(&relation.tags)
                && !(extended && labels::selected(&relation.tags))
            {
                return Ok(());
            }
            let document = serde_json::to_string(&relation)?;
            ensure!(
                document.len() <= MAX_DOCUMENT_BYTES,
                "Relationの保存量が上限を超えました"
            );
            staging.execute(
                "INSERT INTO relations VALUES(?1,?2)",
                params![relation.id, document],
            )?;
            batch.record(&staging, document.len() + 32)?;
            for (index, member) in relation.members.iter().enumerate() {
                if index.is_multiple_of(1024) {
                    context.check()?;
                }
                if member.kind == MemberKind::Way {
                    staging.execute("INSERT OR IGNORE INTO member_ways VALUES(?1)", [member.id])?;
                    batch.record(&staging, 16)?;
                }
            }
            Ok(())
        },
        || context.check(),
    )?;
    batch.sample();
    staging.execute_batch("COMMIT")?;
    check_input(&base.input, &before)?;
    let pass1_seconds = first_started.elapsed().as_secs_f64();

    let second_started = Instant::now();
    guard.stage(Stage::ImportPass2);
    staging.execute_batch("BEGIN IMMEDIATE")?;
    let mut highway_counts = BTreeMap::new();
    let (mut selected_way_count, mut excluded_way_count) = (0, 0);
    let second = pbf::scan_with_check(
        &base.input,
        |object| {
            let Object::Way(way) = object else {
                return Ok(());
            };
            context.check()?;
            if let Some(highway) = way.tags.get("highway") {
                let label = if highway.len() <= 64
                    && (highway_counts.contains_key(highway) || highway_counts.len() < 256)
                {
                    highway.as_str()
                } else {
                    "<other>"
                };
                *highway_counts.entry(label.to_owned()).or_insert(0) += 1;
            }
            let needed: bool = staging.query_row(
                "SELECT EXISTS(SELECT 1 FROM member_ways WHERE id=?1)",
                [way.id],
                |r| r.get(0),
            )?;
            if !needed
                && area_kind(&way.tags).is_none()
                && line_kind(&way.tags).is_none()
                && normalize_tags(&way.tags).is_none()
                && !(extended && labels::selected(&way.tags))
            {
                excluded_way_count += 1;
                return Ok(());
            }
            ensure!(way.nodes.len() <= MAX_POINTS, "Wayの参照数上限を超えました");
            let ids = encode_ids(&way.nodes);
            let tags = serde_json::to_string(&way.tags)?;
            staging.execute(
                "INSERT INTO selected_ways VALUES(?1,?2,?3)",
                params![way.id, ids, tags],
            )?;
            batch.record(&staging, way.nodes.len() * 8 + tags.len() + 32)?;
            for (index, node) in way.nodes.into_iter().enumerate() {
                if index.is_multiple_of(1024) {
                    context.check()?;
                }
                staging.execute("INSERT OR IGNORE INTO nodes(id) VALUES(?1)", [node])?;
                batch.record(&staging, 16)?;
            }
            selected_way_count += 1;
            if selected_way_count % 1024 == 0 {
                guard.progress(selected_way_count, None);
            }
            Ok(())
        },
        || context.check(),
    )?;
    batch.sample();
    staging.execute_batch("COMMIT")?;
    check_input(&base.input, &before)?;
    ensure!(
        first.source_sha256 == second.source_sha256 && first.bytes == second.bytes,
        "走査中にPBFが変更されました"
    );
    let needed_node_count: u64 =
        staging.query_row("SELECT count(*) FROM nodes", [], |r| r.get(0))?;

    guard.stage(Stage::ImportPass3);
    guard.progress(0, Some(needed_node_count));
    let (mut resolved, mut clamped_node_count) = (0, 0);
    staging.execute_batch("BEGIN IMMEDIATE")?;
    let resolve_node = |object| {
        let (node, tags) = match object {
            Object::Node(node) => (node, None),
            Object::TaggedNode(tagged) => (tagged.node, Some(tagged.tags)),
            _ => return Ok(()),
        };
        if let Some(tags) = tags {
            if labels::selected(&tags) {
                match labels::candidate(&tags, 0, node.id, project(node.lon, node.lat)?) {
                    Ok(Some(label)) => {
                        let document = serde_json::to_string(&label)?;
                        staging.execute(
                            "INSERT INTO node_labels VALUES(?,?)",
                            params![node.id, document],
                        )?;
                        batch.record(&staging, document.len() + 32)?;
                    },
                    Err(reason) => {
                        *label_skipped.entry(reason.into()).or_default() += 1;
                    },
                    _ => (),
                }
            }
        }
        let present: Option<bool> = staging
            .query_row(
                "SELECT x IS NOT NULL FROM nodes WHERE id=?1",
                [node.id],
                |r| r.get(0),
            )
            .optional()?;
        match present {
            None => return Ok(()),
            Some(true) => bail!("必要NodeのIDが重複しています: {}", node.id),
            Some(false) => {},
        }
        let p = project(node.lon, node.lat)?;
        if node.lat.abs() > crate::tilegen::geometry::MAX_LAT {
            clamped_node_count += 1;
        }
        staging.execute(
            "UPDATE nodes SET x=?1,y=?2 WHERE id=?3",
            params![p.x, p.y, node.id],
        )?;
        batch.record(&staging, 24)?;
        resolved += 1;
        if resolved % 1024 == 0 {
            guard.progress(resolved, Some(needed_node_count));
        }
        Ok(())
    };
    let third = if extended {
        pbf::scan_with_node_tags_with_check(&base.input, resolve_node, || context.check())?
    } else {
        pbf::scan_with_check(&base.input, resolve_node, || context.check())?
    };
    batch.sample();
    staging.execute_batch("COMMIT")?;
    check_input(&base.input, &before)?;
    ensure!(
        first.source_sha256 == third.source_sha256 && first.bytes == third.bytes,
        "走査中にPBFが変更されました"
    );
    let pass2_seconds = second_started.elapsed().as_secs_f64();
    let missing_node_references = needed_node_count - resolved;
    let geometry_started = Instant::now();
    guard.stage(Stage::BuildingGeometry);

    let filename = base
        .store
        .file_name()
        .context("完成DBのファイル名がありません")?
        .to_string_lossy();
    let building_path = base
        .store
        .with_file_name(format!(".{filename}.{}.building", uuid::Uuid::new_v4()));
    let output = Connection::open(&building_path)?;
    if extended {
        store::initialize_v2(&output)?;
    } else {
        store::initialize(&output)?;
    }
    let operation = context.clone();
    output.progress_handler(10_000, Some(move || operation.check().is_err()));
    output.execute_batch("BEGIN IMMEDIATE")?;
    let mut output_batch = Batch::new(&building_path);
    if extended {
        let mut statement = staging.prepare("SELECT document FROM node_labels ORDER BY id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            context.check()?;
            let label: labels::LabelCandidate = serde_json::from_str(&row.get::<_, String>(0)?)?;
            labels::insert(&output, &label)?;
            output_batch.record(&output, 2048)?;
        }
        let mut statement = staging.prepare("SELECT document FROM label_relations ORDER BY id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            context.check()?;
            let relation: Relation = serde_json::from_str(&row.get::<_, String>(0)?)?;
            let anchor = relation_label_anchor(&staging, &relation)?.or(
                if labels::category(&relation.tags) == Some("water.river") {
                    river_relation_anchor(&staging, &relation, context)?
                } else {
                    None
                },
            );
            if let Some(anchor) = anchor {
                record_label(
                    &output,
                    &relation.tags,
                    2,
                    relation.id,
                    anchor,
                    &mut label_skipped,
                )?;
                labels::save_attributes(&output, 2, relation.id, &relation.tags)?;
                for member in &relation.members {
                    if member.kind == MemberKind::Way {
                        labels::relation_member(&output, relation.id, member.id)?;
                    }
                }
            } else {
                *label_skipped
                    .entry("missing-representative-node".into())
                    .or_default() += 1;
            }
        }
    }
    let mut record = |feature: &Feature| -> Result<()> {
        store::insert_feature_with_context(&output, feature, context)?;
        *metadata
            .counts
            .entry(kind_name(feature.kind).into())
            .or_default() += 1;
        let points = match &feature.geometry {
            Geometry::Line(points) => points.len(),
            Geometry::Polygon(parts) => parts
                .iter()
                .map(|p| p.outer.len() + p.holes.iter().map(Vec::len).sum::<usize>())
                .sum(),
        };
        output_batch.record(&output, points * 16 + 128)
    };

    let mut statement = staging.prepare("SELECT document FROM relations ORDER BY id")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        context.check()?;
        let relation: Relation = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let kind = match relation_kind(&staging, &relation, context) {
            Ok(kind) => kind,
            Err(error) => {
                area_error(
                    options.invalid_areas,
                    &mut metadata.skipped_areas,
                    context,
                    "relation",
                    relation.id,
                    error,
                )?;
                continue;
            },
        };
        if kind.is_none() && !(extended && labels::selected(&relation.tags)) {
            continue;
        }
        let geometry = areas::relation(
            &relation,
            |id| load_way(&staging, id).map(|v| v.0),
            |id| load_node(&staging, id),
            || context.check(),
        );
        match geometry {
            Ok(parts) => {
                let (layer, structure) = layer(&relation.tags);
                if let Some(kind) = kind {
                    record(&Feature {
                        osm_type: 2,
                        osm_id: relation.id,
                        role: 0,
                        kind,
                        geometry: Geometry::Polygon(parts.clone()),
                        layer,
                        structure,
                    })?;
                }
                if extended {
                    labels::save_attributes(&output, 2, relation.id, &relation.tags)?;
                    if labels::selected(&relation.tags) {
                        let anchor = relation_label_anchor(&staging, &relation)?
                            .or(labels::polygon_anchor(&parts, context)?);
                        if let Some(anchor) = anchor {
                            record_label(
                                &output,
                                &relation.tags,
                                2,
                                relation.id,
                                anchor,
                                &mut label_skipped,
                            )?;
                        } else {
                            *label_skipped
                                .entry("missing-interior-anchor".into())
                                .or_default() += 1;
                        }
                    }
                }
                for (index, member) in relation.members.iter().enumerate() {
                    if index.is_multiple_of(1024) {
                        context.check()?;
                    }
                    if member.kind == MemberKind::Way && kind.is_some() {
                        staging.execute(
                            "INSERT OR IGNORE INTO used_areas VALUES(?1,?2)",
                            params![member.id, kind_name(kind.unwrap())],
                        )?;
                    }
                    if extended
                        && member.kind == MemberKind::Way
                        && labels::selected(&relation.tags)
                    {
                        labels::relation_member(&output, relation.id, member.id)?;
                    }
                }
            },
            Err(error) => area_error(
                options.invalid_areas,
                &mut metadata.skipped_areas,
                context,
                "relation",
                relation.id,
                error,
            )?,
        }
    }
    drop(rows);
    drop(statement);
    drop(record);

    let mut skipped_missing_way_count = 0;
    let mut degenerate_way_count = 0;
    let mut statement =
        staging.prepare("SELECT id,node_ids,tags FROM selected_ways ORDER BY id")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        context.check()?;
        let way_id: i64 = row.get(0)?;
        let ids = decode_ids(&row.get::<_, Vec<u8>>(1)?)?;
        let tags: BTreeMap<String, String> = serde_json::from_str(&row.get::<_, String>(2)?)?;
        let area = area_kind(&tags);
        let linear = line_kind(&tags);
        let road = normalize_tags(&tags);
        let points = load_points(&staging, &ids, context);
        if extended {
            labels::save_attributes(&output, 1, way_id, &tags)?;
            if labels::selected(&tags) {
                let anchor = match &points {
                    Ok(points) if ids.len() >= 4 && ids.first() == ids.last() => {
                        match areas::closed_way(points.clone(), || context.check()) {
                            Ok(parts) => labels::polygon_anchor(&parts, context)?,
                            Err(_) => None,
                        }
                    },
                    Ok(points) => labels::line_anchor(points),
                    Err(_) => None,
                };
                if let Some(anchor) = anchor {
                    record_label(&output, &tags, 1, way_id, anchor, &mut label_skipped)?;
                } else {
                    *label_skipped
                        .entry("missing-way-anchor".into())
                        .or_default() += 1;
                }
            }
        }
        if let Some(attributes) = road {
            match &points {
                Ok(points)
                    if points.len() >= 2
                        && !points.windows(2).any(|p| (p[0].x - p[1].x).abs() > 0.5) =>
                {
                    store::insert_road_with_context(&output, way_id, attributes, points, context)?;
                    *metadata.counts.entry("road".into()).or_default() += 1;
                    output_batch.record(&output, points.len() * 16)?;
                },
                Ok(_) => degenerate_way_count += 1,
                Err(error) => match base.missing_nodes {
                    MissingNodes::Error => bail!("道路Way {way_id}: {error:#}"),
                    MissingNodes::SkipWay => skipped_missing_way_count += 1,
                },
            }
        }
        if let Some(kind) = linear {
            match &points {
                Ok(points)
                    if points.len() >= 2
                        && !points.windows(2).any(|p| (p[0].x - p[1].x).abs() > 0.5) =>
                {
                    let (layer, structure) = layer(&tags);
                    store::insert_feature_with_context(
                        &output,
                        &Feature {
                            osm_type: 1,
                            osm_id: way_id,
                            role: 1,
                            kind,
                            geometry: Geometry::Line(points.clone()),
                            layer,
                            structure,
                        },
                        context,
                    )?;
                    *metadata.counts.entry(kind_name(kind).into()).or_default() += 1;
                    output_batch.record(&output, points.len() * 16)?;
                },
                Ok(_) => {},
                Err(error) => match base.missing_nodes {
                    MissingNodes::Error => bail!("線Way {way_id}: {error:#}"),
                    MissingNodes::SkipWay => skipped_missing_way_count += 1,
                },
            }
        }
        if let Some(kind) = area {
            let used: bool = staging.query_row(
                "SELECT EXISTS(SELECT 1 FROM used_areas WHERE id=?1 AND kind=?2)",
                params![way_id, kind_name(kind)],
                |r| r.get(0),
            )?;
            if used {
                continue;
            }
            let polygon = points.and_then(|points| {
                ensure!(
                    ids.len() >= 4 && ids.first() == ids.last(),
                    "面WayがNode IDで閉鎖されていません"
                );
                areas::closed_way(points, || context.check())
            });
            match polygon {
                Ok(parts) => {
                    let (layer, structure) = layer(&tags);
                    let feature = Feature {
                        osm_type: 1,
                        osm_id: way_id,
                        role: 0,
                        kind,
                        geometry: Geometry::Polygon(parts),
                        layer,
                        structure,
                    };
                    store::insert_feature_with_context(&output, &feature, context)?;
                    *metadata.counts.entry(kind_name(kind).into()).or_default() += 1;
                    output_batch.record(&output, ids.len() * 16)?;
                },
                Err(error) => area_error(
                    options.invalid_areas,
                    &mut metadata.skipped_areas,
                    context,
                    "way",
                    way_id,
                    error,
                )?,
            }
        }
    }
    drop(rows);
    drop(statement);
    output_batch.sample();
    output.execute_batch("COMMIT")?;
    metadata.sources.push(SourceInfo {
        kind: "osm-pbf".into(),
        sha256: first.source_sha256.clone(),
        bytes: first.bytes,
        details: serde_json::json!({"timestamp":first.timestamp,"passes":3}),
    });
    if let Some(path) = &options.landmask_input {
        guard.stage(Stage::ImportLandmask);
        metadata
            .sources
            .push(super::landmask::import_into(&output, path, context)?);
    }
    if let Some(path) = &options.elevation_input {
        guard.stage(Stage::ImportElevation);
        if let Some(inspected) = &elevation_inspection {
            inspected.verify_unchanged(context)?;
        }
        let (sources, details) = super::elevation::import_into_with_policy_and_contours(
            &output,
            path,
            options.elevation_datum_policy,
            options.contour_data == ContourData::On,
            context,
        )?;
        metadata.sources.extend(sources);
        metadata.elevation = Some(details);
    }
    if extended {
        let duplicates = labels::deduplicate(&output, context)?;
        if duplicates > 0 {
            *label_skipped.entry("duplicate".into()).or_default() += duplicates;
        }
        metadata.labels = Some(labels::summary(&output, label_skipped)?);
    }
    context.check()?;
    // 面・海陸・等高線の追加後に、完成表を分類別件数の唯一の根拠にする。
    metadata.counts.clear();
    let roads: u64 = output.query_row("SELECT count(*) FROM features", [], |row| row.get(0))?;
    if roads > 0 {
        metadata.counts.insert("road".into(), roads);
    }
    {
        let mut statement = output
            .prepare("SELECT kind,count(*) FROM standard_features GROUP BY kind ORDER BY kind")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            context.check()?;
            let kind = FeatureKind::from_code(row.get(0)?)?;
            metadata.counts.insert(kind_name(kind).into(), row.get(1)?);
        }
    }
    // 地形・陸域を追加した後の値は、全テーブルから集計する。
    let (feature_count, bounds, original_point_count, lod_point_counts) = store::summary(&output)?;
    ensure!(feature_count > 0, "表示できる地物がありません");
    metadata
        .sources
        .sort_by(|a, b| a.kind.cmp(&b.kind).then(a.sha256.cmp(&b.sha256)));
    let input_identity = input_keys(&metadata.sources);
    let source_identity = hash(serde_json::to_vec(&input_identity)?);
    // 指定だけでなく、実際に採用した標高処理の意味を識別へ含める。
    let elevation_rules = metadata.elevation.as_ref().map(|details| {
        serde_json::json!({
            "revision": details["revision"],
            "effective_datum_policy": details["effective_datum_policy"],
            "effective_surface_policy": details["effective_surface_policy"],
            "horizontal_transformation": details["horizontal_transformation"],
            "vertical_correction": details["vertical_correction"],
        })
    });
    let mut import_rules = serde_json::json!({"revision":IMPORT_REVISION,"schema":options.feature_set.schema(),"geometry":2,"missing_nodes":base.missing_nodes,"invalid_areas":options.invalid_areas,"max_points":MAX_POINTS,"empty_role":"outer","nested_relations":"reject","antimeridian":"reject","contours_m":20,"area_lod_error_px":store::AREA_LOD_ERROR_PX,"road_lod_error_px":store::ROAD_LOD_ERROR_PX,"input_identity":input_identity,"elevation":elevation_rules});
    if extended {
        import_rules["labels"] = serde_json::json!(labels::EXTRACTION_REVISION);
        import_rules["contour_data"] = serde_json::json!(if options.elevation_input.is_some() {
            options.contour_data.as_str()
        } else {
            "unavailable"
        });
    }
    let import_rules_hash = hash(serde_json::to_vec(&import_rules)?);
    let dataset_id = hash(
        format!("geocode-standard-dataset-v1/{source_identity}/{import_rules_hash}").into_bytes(),
    );
    let store_metadata = StoreMetadata {
        schema_version: options.feature_set.schema(),
        geometry_version: 2,
        importer_version: IMPORT_REVISION.into(),
        import_rules_hash,
        dataset_id,
        source_sha256: source_identity,
        source_bytes: metadata.sources.iter().try_fold(0u64, |total, source| {
            total
                .checked_add(source.bytes)
                .context("入力資料の合計サイズが桁あふれしました")
        })?,
        source_timestamp: first.timestamp,
        created_unix_seconds: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        coordinate_system: "web-mercator-normalized-f64".into(),
        bbox: bounds,
        feature_count,
        original_point_count,
        lod_point_counts,
        missing_nodes_policy: base.missing_nodes.as_str().into(),
        excluded_way_count,
        skipped_missing_way_count,
        degenerate_way_count,
        clamped_node_count,
        highway_counts,
        complete: true,
    };
    let geometry_and_lod_seconds = geometry_started.elapsed().as_secs_f64();
    let validation_started = Instant::now();
    guard.stage(Stage::FinalValidation);
    check_input(&base.input, &before)?;
    store::finish(&output, &store_metadata, &metadata)?;
    context.check()?;
    output.close().map_err(|(_, e)| e)?;
    let staging_bytes = fs::metadata(&staging_path)?.len();
    staging.close().map_err(|(_, e)| e)?;
    let store_bytes = fs::metadata(&building_path)?.len();
    guard.stage(Stage::Publishing);
    context.check()?;
    fs::hard_link(&building_path, &base.store)
        .context("新完成DBの公開に失敗しました。既存ファイルは変更しません")?;
    // 公開後の補助ファイル清掃失敗で、確定済み成功を取り消さない。
    for path in [&building_path, &staging_path] {
        if let Err(e) = fs::remove_file(path) {
            context.diagnostic(
                DiagnosticLevel::Warning,
                format!("作業ファイルを削除できません: {e}"),
            );
        }
    }
    let _ = fs::remove_dir(&base.work_dir);
    Ok(ImportReport {
        peak_rss_bytes: crate::tilegen::metrics::peak_rss_bytes(),
        store: base.store.clone(),
        metadata: store_metadata,
        needed_node_count,
        selected_way_count,
        missing_node_references,
        pass1_seconds,
        pass2_seconds,
        geometry_and_lod_seconds,
        final_validation_seconds: validation_started.elapsed().as_secs_f64(),
        total_seconds: start.elapsed().as_secs_f64(),
        store_bytes,
        staging_bytes,
        journal_peak_bytes: batch.peak.max(output_batch.peak),
    })
}

fn relation_label_anchor(staging: &Connection, relation: &Relation) -> Result<Option<Point>> {
    for role in ["label", "admin_centre"] {
        for member in &relation.members {
            if member.kind == MemberKind::Node && member.role == role {
                let point: Option<(Option<f64>, Option<f64>)> = staging
                    .query_row("SELECT x,y FROM nodes WHERE id=?", [member.id], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .optional()?;
                if let Some((Some(x), Some(y))) = point {
                    return Ok(Some(Point { x, y }));
                }
            }
        }
    }
    Ok(None)
}

fn river_relation_anchor(
    staging: &Connection,
    relation: &Relation,
    context: &OperationContext,
) -> Result<Option<Point>> {
    let mut best = None::<(f64, i64, Point)>;
    let mut count = 0;
    for member in &relation.members {
        context.check()?;
        if member.kind != MemberKind::Way {
            continue;
        }
        let points =
            load_way(staging, member.id).and_then(|way| load_points(staging, &way.0, context));
        let points = match points {
            Ok(points) => points,
            Err(_) => {
                context.check()?;
                return Ok(None);
            },
        };
        count += points.len();
        if count > MAX_POINTS {
            return Ok(None);
        }
        let mut length = 0.0;
        for (index, pair) in points.windows(2).enumerate() {
            if index.is_multiple_of(4096) {
                context.check()?;
            }
            length += libm::hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
        }
        if let Some(anchor) = labels::line_anchor(&points) {
            if best.is_none_or(|(previous, id, _)| {
                length > previous || (length == previous && member.id < id)
            }) {
                best = Some((length, member.id, anchor));
            }
        }
    }
    Ok(best.map(|(_, _, point)| point))
}

fn record_label(
    output: &Connection,
    tags: &BTreeMap<String, String>,
    osm_type: i64,
    osm_id: i64,
    anchor: Point,
    skipped: &mut BTreeMap<String, u64>,
) -> Result<()> {
    match labels::candidate(tags, osm_type, osm_id, anchor) {
        Ok(Some(candidate)) => labels::insert(output, &candidate)?,
        Err(reason) => {
            *skipped.entry(reason.into()).or_default() += 1;
        },
        _ => (),
    }
    Ok(())
}

fn has_area_tag(tags: &BTreeMap<String, String>) -> bool {
    [
        "building", "landuse", "natural", "leisure", "water", "waterway",
    ]
    .iter()
    .any(|k| tags.contains_key(*k))
}

pub fn area_kind(tags: &BTreeMap<String, String>) -> Option<FeatureKind> {
    use FeatureKind::*;
    let get = |k: &str| tags.get(k).map(String::as_str).unwrap_or("");
    if get("area") == "no" {
        return None;
    }
    if !get("building").is_empty()
        && !["no", "construction", "proposed", "demolished", "ruins"].contains(&get("building"))
    {
        return Some(Building);
    }
    if get("natural") == "water"
        || get("waterway") == "riverbank"
        || ["reservoir", "basin"].contains(&get("landuse"))
    {
        return Some(Water);
    }
    if get("natural") == "wood" || get("landuse") == "forest" {
        return Some(Forest);
    }
    if ["park", "garden", "recreation_ground"].contains(&get("leisure"))
        || get("landuse") == "recreation_ground"
    {
        return Some(Park);
    }
    if ["grassland", "heath", "scrub"].contains(&get("natural"))
        || ["grass", "meadow", "village_green"].contains(&get("landuse"))
    {
        return Some(Grass);
    }
    if [
        "farmland",
        "farmyard",
        "orchard",
        "vineyard",
        "plant_nursery",
    ]
    .contains(&get("landuse"))
    {
        return Some(Farmland);
    }
    match get("landuse") {
        "residential" => return Some(Residential),
        "commercial" | "retail" => return Some(Commercial),
        "industrial" => return Some(Industrial),
        _ => {},
    }
    match get("natural") {
        "sand" | "beach" => Some(Sand),
        "bare_rock" | "scree" | "shingle" => Some(BareRock),
        "wetland" => Some(Wetland),
        _ => None,
    }
}

fn line_kind(tags: &BTreeMap<String, String>) -> Option<FeatureKind> {
    if tags.get("area").is_some_and(|v| v == "yes") {
        return None;
    }
    if tags
        .get("waterway")
        .is_some_and(|v| ["river", "stream", "canal", "drain", "ditch"].contains(&v.as_str()))
    {
        return Some(FeatureKind::Waterway);
    }
    if tags.get("railway").is_some_and(|v| {
        [
            "rail",
            "light_rail",
            "narrow_gauge",
            "subway",
            "tram",
            "monorail",
            "funicular",
        ]
        .contains(&v.as_str())
    }) {
        return Some(FeatureKind::Railway);
    }
    None
}

fn kind_name(kind: FeatureKind) -> &'static str {
    use FeatureKind::*;
    match kind {
        Land => "land",
        Forest => "forest",
        Grass => "grass",
        Park => "park",
        Farmland => "farmland",
        Residential => "residential",
        Commercial => "commercial",
        Industrial => "industrial",
        Sand => "sand",
        BareRock => "bare-rock",
        Wetland => "wetland",
        Water => "water",
        Building => "building",
        Waterway => "waterway",
        Railway => "railway",
        Contour => "contour",
    }
}

fn relation_kind(
    connection: &Connection,
    relation: &Relation,
    context: &OperationContext,
) -> Result<Option<FeatureKind>> {
    if let Some(kind) = area_kind(&relation.tags) {
        return Ok(Some(kind));
    }
    if has_area_tag(&relation.tags) {
        return Ok(None);
    }
    let mut found = None;
    for member in &relation.members {
        context.check()?;
        if member.kind != MemberKind::Way || member.role == "inner" {
            continue;
        }
        let tags: Option<String> = connection
            .query_row(
                "SELECT tags FROM selected_ways WHERE id=?1",
                [member.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(tags) = tags {
            let tags: BTreeMap<String, String> = serde_json::from_str(&tags)?;
            if let Some(kind) = area_kind(&tags) {
                ensure!(
                    found.is_none() || found == Some(kind),
                    "旧形式Relationのouterタグ分類が矛盾しています"
                );
                found = Some(kind);
            }
        }
    }
    Ok(found)
}

fn layer(tags: &BTreeMap<String, String>) -> (i16, u8) {
    let present = |k: &str| tags.get(k).is_some_and(|v| !v.is_empty() && v != "no");
    let (bridge, tunnel) = (present("bridge"), present("tunnel"));
    let rank = match (bridge, tunnel) {
        (true, false) => 2,
        (false, true) => 0,
        _ => 1,
    };
    (
        tags.get("layer")
            .and_then(|v| v.parse().ok())
            .unwrap_or(match rank {
                0 => -1,
                2 => 1,
                _ => 0,
            }),
        rank,
    )
}

fn encode_ids(ids: &[i64]) -> Vec<u8> {
    ids.iter().flat_map(|v| v.to_le_bytes()).collect()
}
fn decode_ids(bytes: &[u8]) -> Result<Vec<i64>> {
    ensure!(
        bytes.len() % 8 == 0 && bytes.len() / 8 <= MAX_POINTS,
        "Node参照BLOBが不正です"
    );
    Ok(bytes
        .chunks_exact(8)
        .map(|v| i64::from_le_bytes(v.try_into().unwrap()))
        .collect())
}
fn load_way(connection: &Connection, id: i64) -> Result<(Vec<i64>, BTreeMap<String, String>)> {
    let (bytes, tags): (Vec<u8>, String) = connection.query_row(
        "SELECT node_ids,tags FROM selected_ways WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((decode_ids(&bytes)?, serde_json::from_str(&tags)?))
}
fn load_node(connection: &Connection, id: i64) -> Result<Point> {
    let value: Option<(Option<f64>, Option<f64>)> = connection
        .query_row("SELECT x,y FROM nodes WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    match value {
        Some((Some(x), Some(y))) => Ok(Point { x, y }),
        _ => bail!("必要Node {id}がありません"),
    }
}
fn load_points(
    connection: &Connection,
    ids: &[i64],
    context: &OperationContext,
) -> Result<Vec<Point>> {
    let mut points = Vec::with_capacity(ids.len());
    for (i, id) in ids.iter().enumerate() {
        if i % 1024 == 0 {
            context.check()?;
        }
        let p = load_node(connection, *id)?;
        if points.last() != Some(&p) {
            points.push(p);
        }
    }
    Ok(points)
}

/// 入力の内容識別だけを使い、走査回数・集計・説明等の診断情報は識別へ入れない。
fn input_keys(sources: &[SourceInfo]) -> Vec<(&str, &str)> {
    let mut keys = sources
        .iter()
        .map(|s| (s.kind.as_str(), s.sha256.as_str()))
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    keys
}

fn hash(bytes: Vec<u8>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn input_fingerprint(path: &Path) -> Result<(u64, SystemTime)> {
    let m = fs::metadata(path)?;
    Ok((m.len(), m.modified()?))
}
fn check_input(path: &Path, before: &(u64, SystemTime)) -> Result<()> {
    ensure!(
        input_fingerprint(path)? == *before,
        "取り込み中に入力PBFが変更されました"
    );
    Ok(())
}
fn area_error(
    policy: InvalidAreas,
    counts: &mut BTreeMap<String, u64>,
    context: &OperationContext,
    kind: &str,
    id: i64,
    error: anyhow::Error,
) -> Result<()> {
    context.check()?;
    if policy == InvalidAreas::Error {
        return Err(error.context(format!("面{kind} {id}の構築に失敗しました")));
    }
    let reason = error.to_string();
    let category = if reason.contains("ありません") || reason.contains("不足") {
        "missing-member"
    } else if reason.contains("入れ子Relation") {
        "nested-relation"
    } else if reason.contains("上限") {
        "resource-limit"
    } else if reason.contains("日付変更線") {
        "antimeridian"
    } else if reason.contains("交差") || reason.contains("接触") {
        "intersection"
    } else if reason.contains("閉鎖") || reason.contains("閉じ") {
        "open-ring"
    } else {
        "invalid-geometry"
    };
    *counts.entry(format!("{kind}:{category}")).or_default() += 1;
    context.diagnostic(
        DiagnosticLevel::Warning,
        format!("面{kind} {id}を除外しました: {error:#}"),
    );
    Ok(())
}

struct Batch {
    updates: usize,
    bytes: usize,
    journal: PathBuf,
    peak: u64,
}
impl Batch {
    fn new(path: &Path) -> Self {
        let mut p = path.as_os_str().to_owned();
        p.push("-journal");
        Self {
            updates: 0,
            bytes: 0,
            journal: p.into(),
            peak: 0,
        }
    }
    fn record(&mut self, connection: &Connection, bytes: usize) -> Result<()> {
        self.updates += 1;
        self.bytes += bytes;
        if self.updates >= 50_000 || self.bytes >= 8 * 1024 * 1024 {
            self.peak = self
                .peak
                .max(fs::metadata(&self.journal).map(|m| m.len()).unwrap_or(0));
            connection.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
            self.updates = 0;
            self.bytes = 0;
        }
        Ok(())
    }
    fn sample(&mut self) {
        self.peak = self
            .peak
            .max(fs::metadata(&self.journal).map(|m| m.len()).unwrap_or(0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 入力来歴の説明や集計や走査回数で内容識別を変えない() {
        let first = vec![SourceInfo {
            kind: "osm-pbf".into(),
            sha256: "a".repeat(64),
            bytes: 10,
            details: serde_json::json!({"passes":3,"description":"旧説明"}),
        }];
        let mut second = first.clone();
        second[0].bytes = 20;
        second[0].details =
            serde_json::json!({"passes":4,"description":"説明の修正","counter":123});
        assert_eq!(input_keys(&first), input_keys(&second));
        second[0].sha256 = "b".repeat(64);
        assert_ne!(input_keys(&first), input_keys(&second));
    }
    use crate::tilegen::{
        import::ImportOptions,
        pbf::{Member, Node, Way},
        test_support::Fixture,
    };

    fn sample() -> Fixture {
        let mut f = Fixture::sample();
        for (id, lon, lat) in [
            (20, 139.70, 35.70),
            (21, 139.71, 35.70),
            (22, 139.71, 35.71),
            (23, 139.70, 35.71),
            (24, 139.702, 35.702),
            (25, 139.704, 35.702),
            (26, 139.704, 35.704),
            (27, 139.702, 35.704),
        ] {
            f.nodes.push(Node { id, lon, lat });
        }
        f.ways.extend([
            Way {
                id: 101,
                nodes: vec![20, 21, 22],
                tags: BTreeMap::new(),
            },
            Way {
                id: 102,
                nodes: vec![20, 23, 22],
                tags: BTreeMap::new(),
            },
            Way {
                id: 103,
                nodes: vec![24, 25, 26, 27, 24],
                tags: BTreeMap::new(),
            },
        ]);
        f.relations.push(Relation {
            id: 101,
            members: vec![
                Member {
                    id: 102,
                    kind: MemberKind::Way,
                    role: "outer".into(),
                },
                Member {
                    id: 101,
                    kind: MemberKind::Way,
                    role: "outer".into(),
                },
                Member {
                    id: 103,
                    kind: MemberKind::Way,
                    role: "inner".into(),
                },
            ],
            tags: BTreeMap::from([
                ("type".into(), "multipolygon".into()),
                ("building".into(), "yes".into()),
            ]),
        });
        f
    }

    #[test]
    fn 地名nodeだけのpbfでも新形式を完成できる() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let input = temp.path().join("point.pbf");
        let mut fixture = Fixture::sample();
        fixture.nodes.truncate(1);
        fixture.ways.clear();
        fixture.node_tags.insert(
            1,
            BTreeMap::from([
                ("place".into(), "town".into()),
                ("name".into(), "独立町".into()),
            ]),
        );
        fixture.write(&input);
        let options = StandardImportOptions {
            base: ImportOptions {
                input,
                store: temp.path().join("point.sqlite"),
                work_dir: temp.path().join("work"),
                missing_nodes: MissingNodes::Error,
            },
            elevation_input: None,
            elevation_datum_policy: Default::default(),
            landmask_input: None,
            invalid_areas: InvalidAreas::Error,
            feature_set: StandardFeatureSet::StandardV2,
            contour_data: ContourData::On,
        };
        let report = run_with_context(&options, &OperationContext::default())?;
        assert_eq!(report.metadata.feature_count, 1);
        let conn = Connection::open(&options.base.store)?;
        let metadata = store::details(&conn)?.unwrap();
        assert!(metadata.counts.is_empty());
        assert_eq!(metadata.labels.unwrap().count, 1);
        Ok(())
    }

    #[test]
    fn 新形式は独立地名と施設名と行政代表点を三走査で保存する() -> Result<()> {
        for dense in [false, true] {
            let temp = tempfile::tempdir()?;
            let input = temp.path().join("labels.pbf");
            let mut fixture = sample();
            fixture.dense = dense;
            fixture.relations_first = true;
            fixture.ways_first = true;
            fixture.nodes.extend([
                Node {
                    id: 50,
                    lon: 140.0,
                    lat: 36.0,
                },
                Node {
                    id: 51,
                    lon: 140.1,
                    lat: 36.0,
                },
            ]);
            fixture.node_tags.insert(
                50,
                BTreeMap::from([
                    ("place".into(), "city".into()),
                    ("name".into(), "東市".into()),
                    ("name:en".into(), "East City".into()),
                ]),
            );
            fixture.node_tags.insert(
                51,
                BTreeMap::from([
                    ("place".into(), "town".into()),
                    ("name".into(), "長".repeat(300)),
                ]),
            );
            fixture.relations[0].tags.extend([
                ("amenity".into(), "school".into()),
                ("name".into(), "南学園".into()),
            ]);
            fixture.relations.push(Relation {
                id: 200,
                members: vec![Member {
                    id: 50,
                    kind: MemberKind::Node,
                    role: "label".into(),
                }],
                tags: BTreeMap::from([
                    ("type".into(), "boundary".into()),
                    ("boundary".into(), "administrative".into()),
                    ("admin_level".into(), "7".into()),
                    ("name".into(), "東市".into()),
                ]),
            });
            fixture.ways.extend([
                Way {
                    id: 104,
                    nodes: vec![20, 21, 22, 23, 20],
                    tags: BTreeMap::from([
                        ("historic".into(), "castle".into()),
                        ("name".into(), "西城".into()),
                    ]),
                },
                Way {
                    id: 105,
                    nodes: vec![1, 2, 3],
                    tags: BTreeMap::from([
                        ("waterway".into(), "river".into()),
                        ("name".into(), "青川".into()),
                    ]),
                },
            ]);
            fixture.relations.push(Relation {
                id: 201,
                members: vec![Member {
                    id: 105,
                    kind: MemberKind::Way,
                    role: "main_stream".into(),
                }],
                tags: BTreeMap::from([
                    ("type".into(), "waterway".into()),
                    ("waterway".into(), "river".into()),
                    ("name".into(), "青川".into()),
                ]),
            });
            fixture.write(&input);
            let options = StandardImportOptions {
                base: ImportOptions {
                    input: input.clone(),
                    store: temp.path().join("labels.sqlite"),
                    work_dir: temp.path().join("work"),
                    missing_nodes: MissingNodes::Error,
                },
                elevation_input: None,
                elevation_datum_policy: Default::default(),
                landmask_input: None,
                invalid_areas: InvalidAreas::Error,
                feature_set: StandardFeatureSet::StandardV2,
                contour_data: ContourData::Off,
            };
            let report = run_with_context(&options, &OperationContext::default())?;
            assert_eq!(report.metadata.schema_version, 3);
            assert_eq!(report.metadata.geometry_version, 2);
            assert!(report.metadata.bbox.max_x >= project(140.0, 36.0)?.x);
            fs::remove_file(&input)?;
            let db = Connection::open(&options.base.store)?;
            let candidates = labels::query_labels(
                &db,
                crate::tilegen::geometry::Rect::new(0.0, 1.0, 0.0, 1.0)?,
            )?;
            assert_eq!(candidates.len(), 4);
            assert!(candidates.iter().any(|label| label.osm_type == 0
                && label.osm_id == 50
                && label.category == "place.city"));
            assert!(candidates.iter().any(|label| label.osm_type == 1
                && label.osm_id == 104
                && label.category == "landmark.historic"));
            assert!(candidates.iter().any(|label| label.osm_type == 2
                && label.osm_id == 101
                && label.category == "landmark.education"));
            assert!(candidates.iter().any(|label| label.osm_type == 2
                && label.osm_id == 201
                && label.category == "water.river"));
            let metadata = store::details(&db)?.unwrap();
            assert_eq!(
                metadata.labels.unwrap().skipped.get("invalid-name"),
                Some(&1)
            );
            assert_eq!(
                store::capabilities(&db)?,
                DatasetCapabilities {
                    labels: true,
                    elevation: false,
                    contours: false
                }
            );
            assert_eq!(
                labels::attributes(&db, 1, 10)?
                    .get("highway")
                    .map(String::as_str),
                Some("residential")
            );
        }
        Ok(())
    }

    #[test]
    fn 等高線の非収録は新形式だけで明示し格子を残す() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let input = temp.path().join("map.pbf");
        Fixture::sample().write(&input);
        let dem = temp.path().join("dem.xml");
        fs::write(
            &dem,
            r#"<Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM><gml:Envelope srsName="fguuid:jgd2011.bl"><gml:lowerCorner>35 139</gml:lowerCorner><gml:upperCorner>36 140</gml:upperCorner></gml:Envelope><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>1 1</gml:high></gml:GridEnvelope><gml:tupleList>地表面,100 地表面,120 地表面,140 地表面,160</gml:tupleList></DEM></Dataset>"#,
        )?;
        let mut options = StandardImportOptions {
            base: ImportOptions {
                input,
                store: temp.path().join("map.sqlite"),
                work_dir: temp.path().join("work"),
                missing_nodes: MissingNodes::Error,
            },
            elevation_input: Some(dem),
            elevation_datum_policy: Default::default(),
            landmask_input: None,
            invalid_areas: InvalidAreas::Error,
            feature_set: StandardFeatureSet::StandardV1,
            contour_data: ContourData::Off,
        };
        assert!(run_with_context(&options, &OperationContext::default()).is_err());
        assert!(!options.base.work_dir.exists());
        options.feature_set = StandardFeatureSet::StandardV2;
        run_with_context(&options, &OperationContext::default())?;
        let db = Connection::open(&options.base.store)?;
        assert_eq!(
            store::capabilities(&db)?,
            DatasetCapabilities {
                labels: true,
                elevation: true,
                contours: false
            }
        );
        assert!(
            db.query_row("SELECT count(*) FROM standard_dem_chunks", [], |r| r
                .get::<_, u64>(0))?
                > 0
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM standard_features WHERE kind=150",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            0
        );
        Ok(())
    }

    #[test]
    fn 逆順の複合建物を別完成形式へ保存し元入力なしでも復元できる() -> Result<()> {
        for backwards in [false, true] {
            let temp = tempfile::tempdir()?;
            let input = temp.path().join("map.pbf");
            let mut fixture = sample();
            fixture.relations_first = backwards;
            fixture.ways_first = backwards;
            fixture.dense = true;
            fixture.zlib = true;
            fixture.write(&input);
            let options = StandardImportOptions {
                base: ImportOptions {
                    input: input.clone(),
                    store: temp.path().join("map.sqlite"),
                    work_dir: temp.path().join("work"),
                    missing_nodes: MissingNodes::Error,
                },
                elevation_input: None,
                elevation_datum_policy: Default::default(),
                landmask_input: None,
                invalid_areas: InvalidAreas::Error,
                feature_set: Default::default(),
                contour_data: Default::default(),
            };
            let report = run_with_context(&options, &OperationContext::default())?;
            assert_eq!(report.metadata.schema_version, 2);
            assert_eq!(report.metadata.geometry_version, 2);
            assert_eq!(report.metadata.feature_count, 2);
            fs::remove_file(&input)?;
            let db = Connection::open_with_flags(
                &options.base.store,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let metadata = store::details(&db)?.unwrap();
            assert_eq!(metadata.counts.get("building"), Some(&1));
            let features = store::query_features(&db, report.metadata.bbox, 16)?;
            let Geometry::Polygon(parts) = &features[0].geometry else {
                panic!("面が必要です")
            };
            assert_eq!(parts.len(), 1);
            assert_eq!(parts[0].holes.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn 欠損した穴は面全体を除外し既存完成データベースを上書きしない() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let input = temp.path().join("map.pbf");
        let mut fixture = sample();
        fixture.ways.retain(|w| w.id != 103);
        fixture.write(&input);
        let mut options = StandardImportOptions {
            base: ImportOptions {
                input,
                store: temp.path().join("map.sqlite"),
                work_dir: temp.path().join("work-error"),
                missing_nodes: MissingNodes::Error,
            },
            elevation_input: None,
            elevation_datum_policy: Default::default(),
            landmask_input: None,
            invalid_areas: InvalidAreas::Error,
            feature_set: Default::default(),
            contour_data: Default::default(),
        };
        assert!(run_with_context(&options, &OperationContext::default()).is_err());
        assert!(!options.base.store.exists());
        options.invalid_areas = InvalidAreas::SkipFeature;
        options.base.work_dir = temp.path().join("work-skip");
        let report = run_with_context(&options, &OperationContext::default())?;
        assert_eq!(report.metadata.feature_count, 1);
        let original = fs::read(&options.base.store)?;
        options.base.work_dir = temp.path().join("work-again");
        assert!(run_with_context(&options, &OperationContext::default()).is_err());
        assert_eq!(fs::read(&options.base.store)?, original);
        Ok(())
    }

    #[test]
    fn 分類の除外と水路鉄道を明示する() {
        assert_eq!(
            area_kind(&BTreeMap::from([("building".into(), "yes".into())])),
            Some(FeatureKind::Building)
        );
        assert!(area_kind(&BTreeMap::from([("building".into(), "no".into())])).is_none());
        assert!(
            area_kind(&BTreeMap::from([
                ("building".into(), "yes".into()),
                ("area".into(), "no".into())
            ]))
            .is_none()
        );
        assert!(area_kind(&BTreeMap::from([("building:part".into(), "yes".into())])).is_none());
        assert_eq!(
            line_kind(&BTreeMap::from([("railway".into(), "rail".into())])),
            Some(FeatureKind::Railway)
        );
        assert_eq!(
            line_kind(&BTreeMap::from([("waterway".into(), "stream".into())])),
            Some(FeatureKind::Waterway)
        );
    }
}
