//! 永続化された読み取り専用の地物ストア。接続は単一のワーカーが所有する。

use std::{collections::BTreeMap, mem::size_of, path::Path};

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::tilegen::{
    geometry::{Point, Rect},
    operation::OperationContext,
    style::{RoadAttributes, RoadClass, Style},
};

pub const SCHEMA_VERSION: u32 = 1;
pub const GEOMETRY_VERSION: u32 = 1;
pub const MAX_POINTS: usize = 1_000_000;
pub const MAX_GEOMETRY_BYTES: usize = MAX_POINTS * 16;
pub const MAX_CANDIDATES: usize = 1_000_000;
const CANDIDATE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreMetadata {
    pub schema_version: u32,
    pub geometry_version: u32,
    pub importer_version: String,
    pub import_rules_hash: String,
    pub dataset_id: String,
    pub source_sha256: String,
    pub source_bytes: u64,
    pub source_timestamp: Option<String>,
    pub created_unix_seconds: u64,
    pub coordinate_system: String,
    pub bbox: Rect,
    pub feature_count: u64,
    pub original_point_count: u64,
    pub lod_point_counts: BTreeMap<u8, u64>,
    pub missing_nodes_policy: String,
    pub excluded_way_count: u64,
    pub skipped_missing_way_count: u64,
    pub degenerate_way_count: u64,
    pub clamped_node_count: u64,
    pub highway_counts: BTreeMap<String, u64>,
    pub complete: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct FeatureKey {
    pub feature_id: i64,
    pub osm_way_id: i64,
    pub attributes: RoadAttributes,
}

pub struct Store {
    connection: Connection,
    metadata: StoreMetadata,
    has_render_attributes_index: bool,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("open read-only feature store {}", path.display()))?;
        connection.execute_batch(
            "PRAGMA query_only=ON; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;",
        )?;
        let version: Option<String> = connection
            .query_row(
                "SELECT value FROM metadata WHERE key='schema_version'
                 AND length(CAST(value AS BLOB))<=32",
                [],
                |row| row.get(0),
            )
            .optional()
            .context("read store schema; a completed feature store is required")?;
        ensure!(
            matches!(version.as_deref(), Some("1" | "2" | "3")),
            "unsupported store schema; re-import the PBF"
        );
        let complete: Option<String> = connection
            .query_row(
                "SELECT value FROM metadata WHERE key='complete'
                 AND length(CAST(value AS BLOB))<=5",
                [],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(complete.as_deref() == Some("true"), "store is incomplete");
        let document: String = {
            let mut statement = connection.prepare(
                "SELECT length(CAST(value AS BLOB)),value FROM metadata WHERE key='document'",
            )?;
            let mut rows = statement.query([])?;
            let row = rows.next()?.context("missing feature-store metadata")?;
            let length: i64 = row.get(0)?;
            ensure!(
                (1..=1024 * 1024).contains(&length),
                "store metadata exceeds its size limit"
            );
            row.get(1)?
        };
        let metadata: StoreMetadata =
            serde_json::from_str(&document).context("invalid store metadata")?;
        ensure!(
            metadata.complete
                && matches!(
                    (metadata.schema_version, metadata.geometry_version),
                    (1, 1) | (2, 2) | (3, 2)
                ),
            "unsupported or incomplete feature store; re-import the PBF"
        );
        ensure!(
            version.as_deref() == Some(metadata.schema_version.to_string().as_str()),
            "store schema metadata mismatch"
        );
        ensure!(metadata.feature_count > 0, "feature store is empty");
        validate_rect(metadata.bbox)?;
        ensure!(
            metadata.bbox.min_x >= 0.0
                && metadata.bbox.max_x <= 1.0
                && metadata.bbox.min_y >= 0.0
                && metadata.bbox.max_y <= 1.0
                && metadata.coordinate_system == "web-mercator-normalized-f64",
            "invalid feature-store coordinate system or bounds"
        );
        ensure!(
            metadata.lod_point_counts.len() == 10
                && (6..=15).all(|z| metadata.lod_point_counts.contains_key(&z)),
            "store metadata is missing LOD levels"
        );
        let has_render_attributes_index = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_index_list('features')
             WHERE name='feature_render_attributes' AND partial=0)",
            [],
            |row| row.get(0),
        )?;
        Ok(Self {
            connection,
            metadata,
            has_render_attributes_index,
        })
    }

    pub fn metadata(&self) -> &StoreMetadata {
        &self.metadata
    }

    /// 追加形式の読み取り処理だけへ、query_onlyの接続を貸し出す。
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    /// キーだけを返す。形状は各描画段階で個別に読み込む。
    pub fn query_candidates(&self, bbox: Rect, zoom: u8) -> Result<Vec<FeatureKey>> {
        self.query_candidates_with_progress(bbox, zoom, |_| {})
    }

    pub(crate) fn query_candidates_with_progress(
        &self,
        bbox: Rect,
        zoom: u8,
        mut progress: impl FnMut(u64),
    ) -> Result<Vec<FeatureKey>> {
        ensure!(zoom <= 22, "zoom must be <= 22");
        validate_rect(bbox)?;
        if zoom < 6 {
            return Ok(Vec::new());
        }
        let style = Style::roads_v1();
        // 任意のカバリングインデックスにより、ズーム6の広域属性検索で
        // 元の形状BLOBを含む地物行へアクセスすることを避ける。
        let query = if zoom == 6 && self.has_render_attributes_index {
            "SELECT f.feature_id,f.osm_way_id,f.road_class,f.is_link,
                    f.effective_layer,f.structure_rank
             FROM feature_rtree r JOIN features f INDEXED BY feature_render_attributes
                  ON f.feature_id=r.feature_id
             WHERE r.min_x<=?1 AND r.max_x>=?2 AND r.min_y<=?3 AND r.max_y>=?4"
        } else {
            "SELECT f.feature_id,f.osm_way_id,f.road_class,f.is_link,
                    f.effective_layer,f.structure_rank
             FROM feature_rtree r JOIN features f ON f.feature_id=r.feature_id
             WHERE r.min_x<=?1 AND r.max_x>=?2 AND r.min_y<=?3 AND r.max_y>=?4"
        };
        let mut statement = self.connection.prepare_cached(query)?;
        let mut rows = statement.query(params![bbox.max_x, bbox.min_x, bbox.max_y, bbox.min_y])?;
        let limit = MAX_CANDIDATES.min(CANDIDATE_BYTES / size_of::<FeatureKey>());
        let mut candidates = Vec::new();
        let mut scanned = 0_u64;
        while let Some(row) = rows.next()? {
            scanned += 1;
            if scanned.is_multiple_of(1024) {
                progress(scanned);
            }
            let is_link: i64 = row.get(3)?;
            let structure_rank: i64 = row.get(5)?;
            ensure!((0..=1).contains(&is_link), "invalid road link attribute");
            ensure!(
                (0..=2).contains(&structure_rank),
                "invalid road structure rank"
            );
            let attributes = RoadAttributes {
                road_class: RoadClass::from_code(row.get(2)?)?,
                is_link: is_link == 1,
                effective_layer: row.get(4)?,
                structure_rank: structure_rank as u8,
            };
            if !style.visible(attributes, zoom) {
                continue;
            }
            ensure!(
                candidates.len() < limit,
                "tile exceeds candidate limit ({limit} roads / 32 MiB)"
            );
            if candidates.len() == candidates.capacity() {
                let target = (candidates.capacity().max(128) * 2).min(limit);
                candidates
                    .try_reserve_exact(target - candidates.len())
                    .context("allocate tile candidate keys")?;
            }
            candidates.push(FeatureKey {
                feature_id: row.get(0)?,
                osm_way_id: row.get(1)?,
                attributes,
            });
        }
        progress(scanned);
        Ok(candidates)
    }

    /// エラーやスタック巻き戻しの経路も含め、SQLiteのコールバックを単一操作の期間に限定する。
    pub(crate) fn operation(&mut self, context: &OperationContext) -> Result<StoreOperation<'_>> {
        context.check()?;
        let context = context.clone();
        self.connection
            .progress_handler(10_000, Some(move || context.check().is_err()));
        Ok(StoreOperation { store: self })
    }

    pub fn load_geometry(&self, feature_id: i64, zoom: u8) -> Result<Vec<Point>> {
        ensure!(zoom <= 22, "zoom must be <= 22");
        let (query, has_zoom) = if (6..=15).contains(&zoom) {
            (
                "SELECT point_count,length(points),points FROM geometry_lod
                 WHERE feature_id=?1 AND zoom=?2",
                true,
            )
        } else {
            (
                "SELECT point_count,length(points),points FROM features WHERE feature_id=?1",
                false,
            )
        };
        let mut statement = self.connection.prepare_cached(query)?;
        let mut rows = if has_zoom {
            statement.query(params![feature_id, zoom])?
        } else {
            statement.query(params![feature_id])?
        };
        let Some(row) = rows.next()? else {
            bail!("missing geometry for feature {feature_id} at zoom {zoom}");
        };
        let count: i64 = row.get(0)?;
        let length: i64 = row.get(1)?;
        ensure!(
            (2..=MAX_POINTS as i64).contains(&count) && length == count * 16,
            "invalid geometry size for feature {feature_id}"
        );
        let bytes: Vec<u8> = row.get(2)?;
        decode_points(&bytes, count as usize)
            .with_context(|| format!("read feature {feature_id} at zoom {zoom}"))
    }
}

pub(crate) struct StoreOperation<'a> {
    store: &'a mut Store,
}

impl std::ops::Deref for StoreOperation<'_> {
    type Target = Store;

    fn deref(&self) -> &Store {
        self.store
    }
}

impl Drop for StoreOperation<'_> {
    fn drop(&mut self) {
        // このスコープ所有者より先に、すべてのステートメントが破棄される。
        // 取消後に呼出元でスタックが巻き戻されても、解除によって捕捉した操作を解放する。
        self.store
            .connection
            .progress_handler(0, None::<fn() -> bool>);
    }
}

pub(crate) fn configure_writer(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "PRAGMA journal_mode=DELETE;
         PRAGMA synchronous=FULL;
         PRAGMA temp_store=FILE;
         PRAGMA cache_size=-65536;
         PRAGMA foreign_keys=ON;",
    )?;
    Ok(())
}

pub(crate) fn initialize(connection: &Connection) -> Result<()> {
    configure_writer(connection)?;
    connection.execute_batch(
        "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
         CREATE TABLE features(
           feature_id INTEGER PRIMARY KEY,
           osm_way_id INTEGER NOT NULL UNIQUE,
           road_class INTEGER NOT NULL CHECK(road_class IN (10,20,30,40,50,60,70,80)),
           is_link INTEGER NOT NULL CHECK(is_link IN (0,1)),
           effective_layer INTEGER NOT NULL CHECK(effective_layer BETWEEN -32768 AND 32767),
           structure_rank INTEGER NOT NULL CHECK(structure_rank BETWEEN 0 AND 2),
           min_x REAL NOT NULL,max_x REAL NOT NULL,min_y REAL NOT NULL,max_y REAL NOT NULL,
           point_count INTEGER NOT NULL CHECK(point_count BETWEEN 2 AND 1000000),
           points BLOB NOT NULL CHECK(length(points)=point_count*16),
           CHECK(min_x<=max_x AND min_y<=max_y),
           CHECK(min_x>=0 AND max_x<=1 AND min_y>=0 AND max_y<=1)
         );
         CREATE VIRTUAL TABLE feature_rtree USING rtree(
           feature_id,min_x,max_x,min_y,max_y
         );
         CREATE INDEX feature_render_attributes ON features(
           feature_id,osm_way_id,road_class,is_link,effective_layer,structure_rank
         );
         CREATE TABLE geometry_lod(
           feature_id INTEGER NOT NULL REFERENCES features(feature_id),
           zoom INTEGER NOT NULL CHECK(zoom BETWEEN 6 AND 15),
           point_count INTEGER NOT NULL CHECK(point_count BETWEEN 2 AND 1000000),
           points BLOB NOT NULL CHECK(length(points)=point_count*16),
           PRIMARY KEY(feature_id,zoom)
         ) WITHOUT ROWID;
         INSERT INTO metadata VALUES('complete','false');",
    )?;
    connection.execute(
        "INSERT INTO metadata VALUES('schema_version',?1)",
        [SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

pub(crate) fn finish(connection: &Connection, metadata: &StoreMetadata) -> Result<()> {
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    ensure!(
        integrity == "ok",
        "SQLite integrity check failed: {integrity}"
    );
    let rtree: String =
        connection.query_row("SELECT rtreecheck('feature_rtree')", [], |r| r.get(0))?;
    ensure!(rtree == "ok", "R-tree integrity check failed: {rtree}");
    let foreign_keys: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |r| r.get(0),
    )?;
    ensure!(!foreign_keys, "store has invalid foreign keys");
    let feature_count: i64 =
        connection.query_row("SELECT count(*) FROM features", [], |r| r.get(0))?;
    let rtree_count: i64 =
        connection.query_row("SELECT count(*) FROM feature_rtree", [], |r| r.get(0))?;
    let lod_count: i64 =
        connection.query_row("SELECT count(*) FROM geometry_lod", [], |r| r.get(0))?;
    ensure!(
        feature_count > 0
            && feature_count as u64 == metadata.feature_count
            && feature_count == rtree_count
            && lod_count == feature_count * 10,
        "incomplete feature / R-tree / LOD records"
    );
    let missing_index: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM features f
         LEFT JOIN feature_rtree r ON r.feature_id=f.feature_id WHERE r.feature_id IS NULL)",
        [],
        |r| r.get(0),
    )?;
    ensure!(!missing_index, "feature missing from R-tree");
    connection.execute_batch("BEGIN IMMEDIATE")?;
    connection.execute(
        "INSERT INTO metadata(key,value) VALUES('document',?1)",
        [serde_json::to_string(metadata)?],
    )?;
    connection.execute("UPDATE metadata SET value='true' WHERE key='complete'", [])?;
    connection.execute_batch("COMMIT")?;
    Ok(())
}

pub(crate) fn encode_points(points: &[Point]) -> Result<Vec<u8>> {
    ensure!(
        (2..=MAX_POINTS).contains(&points.len()),
        "geometry must have 2..={MAX_POINTS} points"
    );
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(points.len() * 16)
        .context("allocate geometry buffer")?;
    for point in points {
        ensure!(
            point.x.is_finite()
                && point.y.is_finite()
                && (0.0..=1.0).contains(&point.x)
                && (0.0..=1.0).contains(&point.y),
            "geometry has an invalid projected coordinate"
        );
        bytes.extend_from_slice(&point.x.to_le_bytes());
        bytes.extend_from_slice(&point.y.to_le_bytes());
    }
    Ok(bytes)
}

fn decode_points(bytes: &[u8], count: usize) -> Result<Vec<Point>> {
    ensure!(
        (2..=MAX_POINTS).contains(&count)
            && bytes.len() == count * 16
            && bytes.len() <= MAX_GEOMETRY_BYTES,
        "invalid geometry buffer size"
    );
    let mut points = Vec::new();
    points
        .try_reserve_exact(count)
        .context("allocate decoded geometry")?;
    for point in bytes.as_chunks::<16>().0 {
        let x = f64::from_le_bytes(point[..8].try_into()?);
        let y = f64::from_le_bytes(point[8..].try_into()?);
        ensure!(
            x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y),
            "invalid geometry coordinate"
        );
        points.push(Point { x, y });
    }
    Ok(points)
}

fn validate_rect(rect: Rect) -> Result<()> {
    ensure!(
        [rect.min_x, rect.max_x, rect.min_y, rect.max_y]
            .iter()
            .all(|x| x.is_finite())
            && rect.min_x <= rect.max_x
            && rect.min_y <= rect.max_y,
        "invalid projected search rectangle"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LONG_RECURSIVE_SQL: &str = "WITH RECURSIVE work(n) AS (
           VALUES(0) UNION ALL SELECT n+1 FROM work WHERE n<1000000000
         ) SELECT sum(n) FROM work";

    fn assert_sql_vm_interrupts(connection: &Connection) {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        use std::time::Duration;

        // 本番用フックが欠けている場合は、2秒後にこの接続を中断する。
        // 代替処理でこの異常系試験の時間を制限するが、その場合の試験結果は失敗とする。
        let interrupt = connection.get_interrupt_handle();
        let fallback = Arc::new(AtomicBool::new(false));
        let fallback_worker = fallback.clone();
        let (done, wait) = mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            if matches!(
                wait.recv_timeout(Duration::from_secs(2)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                fallback_worker.store(true, Ordering::Release);
                interrupt.interrupt();
            }
        });
        let result: rusqlite::Result<i64> =
            connection.query_row(LONG_RECURSIVE_SQL, [], |row| row.get(0));
        let _ = done.send(());
        watchdog.join().unwrap();
        assert!(
            !fallback.load(Ordering::Acquire),
            "SQL progress hook did not stop the query before watchdog fallback"
        );
        assert!(
            matches!(result, Err(rusqlite::Error::SqliteFailure(code, _))
            if code.code == rusqlite::ErrorCode::OperationInterrupted)
        );
    }

    fn assert_nontrivial_sql_succeeds(connection: &Connection) -> Result<()> {
        // これは10,000回を大きく超えるVM操作を実行する。取消済みの進捗フックが残っていれば、
        // 通常のSELECT 1では成功しても、この処理では中断される。
        let result: i64 = connection.query_row(
            "WITH RECURSIVE work(n) AS (
               VALUES(0) UNION ALL SELECT n+1 FROM work WHERE n<20000
             ) SELECT sum(n) FROM work",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(result, 200_010_000);
        Ok(())
    }

    #[test]
    fn operation_sql_progress_hook_interrupts_cancellation_and_cleans_up() -> Result<()> {
        let mut store = candidate_store_fixture(true)?;
        let cancel = crate::tilegen::cancel::CancellationToken::new();
        let context = OperationContext::new(cancel.clone());
        {
            let scoped = store.operation(&context)?;
            // 取消からこの直接SQL呼び出しまでの間には、SDKや操作の検査を意図的に挟まない。
            // この処理を止められるのはSQLiteのVMフックだけである。
            cancel.cancel();
            assert_sql_vm_interrupts(&scoped.connection);
        }
        assert_nontrivial_sql_succeeds(&store.connection)?;
        let next = OperationContext::default();
        let scoped = store.operation(&next)?;
        assert_nontrivial_sql_succeeds(&scoped.connection)?;
        Ok(())
    }

    #[test]
    fn operation_sql_progress_hook_observes_deadline_set_after_installation() -> Result<()> {
        let mut store = candidate_store_fixture(false)?;
        let context = OperationContext::default();
        {
            let scoped = store.operation(&context)?;
            let _expired = context.clone().with_deadline(std::time::Instant::now());
            assert_sql_vm_interrupts(&scoped.connection);
        }
        assert_nontrivial_sql_succeeds(&store.connection)?;
        Ok(())
    }

    #[test]
    fn operation_scope_clears_cancelled_sql_hook_during_unwind() -> Result<()> {
        let mut store = candidate_store_fixture(true)?;
        let cancel = crate::tilegen::cancel::CancellationToken::new();
        let context = OperationContext::new(cancel.clone());
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _scoped = store.operation(&context).unwrap();
            cancel.cancel();
            panic!("controlled operation-scope unwind");
        }));
        assert!(panic.is_err());
        assert_nontrivial_sql_succeeds(&store.connection)?;
        let next = OperationContext::default();
        let scoped = store.operation(&next)?;
        assert_nontrivial_sql_succeeds(&scoped.connection)?;
        Ok(())
    }

    fn candidate_store_fixture(indexed: bool) -> Result<Store> {
        let connection = Connection::open_in_memory()?;
        initialize(&connection)?;
        if !indexed {
            connection.execute_batch("DROP INDEX feature_render_attributes;")?;
        }
        let insert = |id: i64, class: RoadClass, link: bool, bbox: Rect| -> Result<()> {
            let points = [
                Point {
                    x: bbox.min_x,
                    y: bbox.min_y,
                },
                Point {
                    x: bbox.max_x,
                    y: bbox.max_y,
                },
            ];
            connection.execute(
                "INSERT INTO features VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,2,?11)",
                params![
                    id,
                    10_000 - id,
                    class as u8,
                    i64::from(link),
                    id % 5 - 2,
                    id % 3,
                    bbox.min_x,
                    bbox.max_x,
                    bbox.min_y,
                    bbox.max_y,
                    encode_points(&points)?
                ],
            )?;
            connection.execute(
                "INSERT INTO feature_rtree VALUES(?1,?2,?3,?4,?5)",
                params![id, bbox.min_x, bbox.max_x, bbox.min_y, bbox.max_y],
            )?;
            Ok(())
        };
        // IDと描画優先度は、挿入順とは意図的に異なる値にする。
        for (class, id) in RoadClass::ALL
            .into_iter()
            .zip([60, 10, 50, 20, 40, 30, 80, 70])
        {
            let bbox = Rect {
                min_x: 0.4,
                max_x: 0.6,
                min_y: 0.4,
                max_y: 0.6,
            };
            insert(id, class, false, bbox)?;
            insert(id + 1000, class, true, bbox)?;
        }
        insert(
            91,
            RoadClass::Motorway,
            false,
            Rect {
                min_x: 0.500_000_03,
                max_x: 0.500_000_07,
                min_y: 0.45,
                max_y: 0.55,
            },
        )?;
        insert(
            92,
            RoadClass::Motorway,
            false,
            Rect {
                min_x: 0.2,
                max_x: 0.3,
                min_y: 0.2,
                max_y: 0.3,
            },
        )?;
        let metadata = StoreMetadata {
            schema_version: SCHEMA_VERSION,
            geometry_version: GEOMETRY_VERSION,
            importer_version: "test".into(),
            import_rules_hash: "test".into(),
            dataset_id: "test".into(),
            source_sha256: "test".into(),
            source_bytes: 0,
            source_timestamp: None,
            created_unix_seconds: 0,
            coordinate_system: "web-mercator-normalized-f64".into(),
            bbox: Rect {
                min_x: 0.2,
                max_x: 0.6,
                min_y: 0.2,
                max_y: 0.6,
            },
            feature_count: 18,
            original_point_count: 36,
            lod_point_counts: BTreeMap::new(),
            missing_nodes_policy: "error".into(),
            excluded_way_count: 0,
            skipped_missing_way_count: 0,
            degenerate_way_count: 0,
            clamped_node_count: 0,
            highway_counts: BTreeMap::new(),
            complete: true,
        };
        Ok(Store {
            connection,
            metadata,
            has_render_attributes_index: indexed,
        })
    }

    #[test]
    fn zoom6_covering_index_preserves_legacy_candidates_and_rtree_boundaries() -> Result<()> {
        let windows = [
            Rect {
                min_x: 0.45,
                max_x: 0.55,
                min_y: 0.45,
                max_y: 0.55,
            },
            Rect {
                min_x: 0.1,
                max_x: 0.2,
                min_y: 0.2,
                max_y: 0.3,
            },
            Rect {
                min_x: 0.49,
                max_x: 0.500_000_015,
                min_y: 0.49,
                max_y: 0.51,
            },
            Rect {
                min_x: 0.0,
                max_x: 0.01,
                min_y: 0.0,
                max_y: 0.01,
            },
        ];
        for indexed in [false, true] {
            let store = candidate_store_fixture(indexed)?;
            let mut legacy = store.connection.prepare(
                "SELECT f.feature_id,f.osm_way_id,f.road_class,f.is_link,
                    f.effective_layer,f.structure_rank
             FROM feature_rtree r JOIN features f ON f.feature_id=r.feature_id
             WHERE r.min_x<=?1 AND r.max_x>=?2 AND r.min_y<=?3 AND r.max_y>=?4",
            )?;
            for bbox in windows {
                for zoom in [6, 7, 10, 14, 18] {
                    let mut rows =
                        legacy.query(params![bbox.max_x, bbox.min_x, bbox.max_y, bbox.min_y])?;
                    let mut expected = BTreeMap::new();
                    while let Some(row) = rows.next()? {
                        let attrs = RoadAttributes {
                            road_class: RoadClass::from_code(row.get(2)?)?,
                            is_link: row.get::<_, i64>(3)? == 1,
                            effective_layer: row.get(4)?,
                            structure_rank: row.get(5)?,
                        };
                        if Style::roads_v1().visible(attrs, zoom) {
                            expected.insert(row.get::<_, i64>(0)?, (row.get::<_, i64>(1)?, attrs));
                        }
                    }
                    let actual: BTreeMap<_, _> = store
                        .query_candidates(bbox, zoom)?
                        .into_iter()
                        .map(|key| (key.feature_id, (key.osm_way_id, key.attributes)))
                        .collect();
                    assert_eq!(
                        actual, expected,
                        "candidate set differs at zoom {zoom}, bbox {bbox:?}"
                    );
                }
            }
            let ids = |bbox, zoom| -> Result<Vec<i64>> {
                let mut ids: Vec<_> = store
                    .query_candidates(bbox, zoom)?
                    .into_iter()
                    .map(|key| key.feature_id)
                    .collect();
                ids.sort_unstable();
                Ok(ids)
            };
            assert_eq!(ids(windows[0], 6)?, [70, 91]);
            assert_eq!(ids(windows[0], 7)?, [70, 80, 91, 1070]);
            assert_eq!(ids(windows[1], 6)?, [92]);
            // R-treeのf32境界は外向きに丸められる。元のf64の最小値が要求矩形の外にあっても、
            // この粗いインデックスで該当した地物を除外せず保持する。
            assert!(windows[2].max_x < 0.500_000_03);
            assert!(ids(windows[2], 6)?.contains(&91));
            assert!(ids(windows[3], 6)?.is_empty());
        }
        Ok(())
    }

    #[test]
    fn zoom6_covering_index_still_rejects_corrupt_hidden_road_attributes() -> Result<()> {
        for indexed in [false, true] {
            for update in [
                "UPDATE features SET road_class=999 WHERE feature_id=60",
                "UPDATE features SET is_link=2 WHERE feature_id=60",
                "UPDATE features SET structure_rank=3 WHERE feature_id=60",
                "UPDATE features SET effective_layer=32768 WHERE feature_id=60",
            ] {
                let store = candidate_store_fixture(indexed)?;
                store
                    .connection
                    .execute_batch("PRAGMA ignore_check_constraints=ON;")?;
                store.connection.execute(update, [])?;
                let bbox = Rect {
                    min_x: 0.45,
                    max_x: 0.55,
                    min_y: 0.45,
                    max_y: 0.55,
                };
                for zoom in [6, 14] {
                    assert!(
                        store.query_candidates(bbox, zoom).is_err(),
                        "ignored {update} at zoom {zoom}"
                    );
                }
            }
        }
        Ok(())
    }

    #[test]
    fn malformed_geometry_is_rejected_before_decoding() {
        assert!(decode_points(&[0; 31], 2).is_err());
        assert!(decode_points(&[], usize::MAX).is_err());
        let mut points = vec![Point { x: 0.5, y: 0.5 }; 2];
        points[1].x = f64::NAN;
        assert!(encode_points(&points).is_err());
    }

    #[test]
    fn rejects_incomplete_and_unknown_store() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("store.sqlite");
        let connection = Connection::open(&path)?;
        initialize(&connection)?;
        connection.close().map_err(|(_, error)| error)?;
        assert!(Store::open(&path).is_err());
        let connection = Connection::open(&path)?;
        connection.execute(
            "UPDATE metadata SET value='999' WHERE key='schema_version'",
            [],
        )?;
        connection.close().map_err(|(_, error)| error)?;
        assert!(Store::open(&path).is_err());
        Ok(())
    }

    #[test]
    fn crossing_geometry_is_found_and_missing_lod_never_falls_back() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("store.sqlite");
        let connection = Connection::open(&path)?;
        initialize(&connection)?;
        let points = [Point { x: 0.1, y: 0.5 }, Point { x: 0.9, y: 0.5 }];
        let geometry = encode_points(&points)?;
        connection.execute(
            "INSERT INTO features VALUES(1,42,80,0,0,1,0.1,0.9,0.5,0.5,2,?1)",
            [&geometry],
        )?;
        connection.execute("INSERT INTO feature_rtree VALUES(1,0.1,0.9,0.5,0.5)", [])?;
        for zoom in 6..=15 {
            connection.execute(
                "INSERT INTO geometry_lod VALUES(1,?1,2,?2)",
                params![zoom, &geometry],
            )?;
        }
        let metadata = StoreMetadata {
            schema_version: SCHEMA_VERSION,
            geometry_version: GEOMETRY_VERSION,
            importer_version: "test".into(),
            import_rules_hash: "test".into(),
            dataset_id: "test".into(),
            source_sha256: "test".into(),
            source_bytes: 0,
            source_timestamp: None,
            created_unix_seconds: 0,
            coordinate_system: "web-mercator-normalized-f64".into(),
            bbox: Rect::from_points(&points)?,
            feature_count: 1,
            original_point_count: 2,
            lod_point_counts: (6..=15).map(|z| (z, 2)).collect(),
            missing_nodes_policy: "error".into(),
            excluded_way_count: 0,
            skipped_missing_way_count: 0,
            degenerate_way_count: 0,
            clamped_node_count: 0,
            highway_counts: BTreeMap::new(),
            complete: true,
        };
        finish(&connection, &metadata)?;
        connection.close().map_err(|(_, error)| error)?;
        let store = Store::open(&path)?;
        assert!(store.has_render_attributes_index);
        let query = Rect {
            min_x: 0.4,
            max_x: 0.6,
            min_y: 0.49,
            max_y: 0.51,
        };
        assert_eq!(store.query_candidates(query, 14)?.len(), 1);
        assert_eq!(store.query_candidates(query, 6)?.len(), 1);
        assert!(store.query_candidates(query, 5)?.is_empty());
        assert_eq!(store.load_geometry(1, 14)?, points);
        assert_eq!(store.load_geometry(1, 18)?, points);
        drop(store);
        let connection = Connection::open(&path)?;
        connection.execute_batch("DROP INDEX feature_render_attributes;")?;
        connection.execute(
            "DELETE FROM geometry_lod WHERE feature_id=1 AND zoom=14",
            [],
        )?;
        connection.close().map_err(|(_, error)| error)?;
        let store = Store::open(&path)?;
        assert!(!store.has_render_attributes_index);
        assert_eq!(store.query_candidates(query, 6)?.len(), 1);
        assert!(store.load_geometry(1, 14).is_err());
        drop(store);
        let connection = Connection::open(&path)?;
        connection.execute_batch(
            "CREATE INDEX feature_render_attributes ON features(feature_id) WHERE feature_id<0;",
        )?;
        connection.close().map_err(|(_, error)| error)?;
        let store = Store::open(&path)?;
        assert!(!store.has_render_attributes_index);
        assert_eq!(store.query_candidates(query, 6)?.len(), 1);
        Ok(())
    }
}
