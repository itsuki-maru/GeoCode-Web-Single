use super::{
    APPLICATION_ID, Bounds, Coord, GraphInfo, PROFILE_VERSION, SCHEMA, TravelMode, inspect,
    profile, restrictions,
};
use crate::tilegen::pbf::{self, Object};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use std::{fs, path::Path};

pub fn build(
    pbf: &Path,
    output: &Path,
    check: impl FnMut() -> Result<()>,
    mut progress: impl FnMut(&str, u64),
) -> Result<GraphInfo> {
    build_with_progress(pbf, output, check, |stage, count, _, _| {
        progress(stage, count)
    })
}

/// 地物の処理件数と、フレームを最後まで処理した時点の累計バイト数を個別に通知する。
pub(crate) fn build_with_progress(
    pbf: &Path,
    output: &Path,
    mut check: impl FnMut() -> Result<()>,
    mut progress: impl FnMut(&str, u64, Option<u64>, Option<(u64, u64)>),
) -> Result<GraphInfo> {
    check()?;
    ensure!(!output.exists(), "同名の経路データがすでに存在します");
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let temp = tempfile::Builder::new()
        .prefix(".routing-")
        .tempdir_in(parent)?;
    let path = temp.path().join("building.sqlite");
    let mut db = Connection::open(&path)?;
    db.pragma_update(None, "application_id", APPLICATION_ID)?;
    db.pragma_update(None, "user_version", SCHEMA)?;
    db.execute_batch(
        "
        PRAGMA temp_store=FILE;
        PRAGMA cache_size=-98304;
        CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),info TEXT NOT NULL);
        CREATE TABLE nodes(id INTEGER PRIMARY KEY,lat REAL,lon REAL,car INTEGER,foot INTEGER,shape INTEGER NOT NULL);
        CREATE TABLE edges(id INTEGER PRIMARY KEY,way INTEGER NOT NULL,seq INTEGER NOT NULL,
            a INTEGER NOT NULL,b INTEGER NOT NULL,car_f REAL NOT NULL,car_b REAL NOT NULL,
            foot_f REAL NOT NULL,foot_b REAL NOT NULL,meters REAL NOT NULL DEFAULT 0,
            UNIQUE(way,seq));
        CREATE TEMP TABLE relations(id INTEGER PRIMARY KEY,document TEXT NOT NULL);
        CREATE TABLE turns(relation_id INTEGER NOT NULL,mode INTEGER NOT NULL,only_turn INTEGER NOT NULL,
            sequence BLOB NOT NULL, PRIMARY KEY(mode,relation_id,sequence)) WITHOUT ROWID;
        CREATE TEMP TABLE blocked(way INTEGER NOT NULL, mode INTEGER NOT NULL,
            PRIMARY KEY(way,mode)) WITHOUT ROWID;
        CREATE VIRTUAL TABLE edge_rtree USING rtree(id,west,east,south,north);
        BEGIN;
    ",
    )?;
    let count = std::cell::Cell::new(0_u64);
    let mut segments = 0u64;
    let mut conditional_ways = 0_u64;
    progress("ways", 0, None, None);
    let mut insert_node=db.prepare("INSERT INTO nodes(id,shape) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET shape=0 WHERE shape=1")?;
    let mut insert_edge = db.prepare(
        "INSERT INTO edges(way,seq,a,b,car_f,car_b,foot_f,foot_b) VALUES(?,?,?,?,?,?,?,?)",
    )?;
    let poll = std::cell::RefCell::new(&mut check);
    let first = pbf::scan_routing_ways(
        pbf,
        |object| {
            match object {
                Object::Way(way) => {
                    let car = profile::speeds(&way.tags, TravelMode::Car);
                    let foot = profile::speeds(&way.tags, TravelMode::Foot);
                    if way.tags.contains_key("highway")
                        && way.tags.keys().any(|k| k.ends_with(":conditional"))
                    {
                        conditional_ways += 1;
                    }
                    if car == [0.0; 2] && foot == [0.0; 2] {
                        return Ok(());
                    }
                    for (i, id) in way.nodes.iter().enumerate() {
                        if i != 0 && i.is_multiple_of(4096) {
                            (poll.borrow_mut())()?;
                        }
                        insert_node.execute(params![id, i != 0 && i + 1 < way.nodes.len()])?;
                    }
                    for (index, pair) in way.nodes.windows(2).enumerate() {
                        if index != 0 && index.is_multiple_of(4096) {
                            (poll.borrow_mut())()?;
                        }
                        if pair[0] == pair[1] {
                            continue;
                        }
                        segments += 1;
                        insert_edge.execute(params![
                            way.id,
                            index as i64,
                            pair[0],
                            pair[1],
                            car[0],
                            car[1],
                            foot[0],
                            foot[1]
                        ])?;
                    }
                    count.set(count.get() + 1);
                },
                Object::Relation(rel) => {
                    restrictions::stage(&db, &rel)?;
                },
                _ => {},
            }
            Ok(())
        },
        || (poll.borrow_mut())(),
        |done, total| progress("ways", count.get(), None, Some((done, total))),
    )?;
    drop((insert_node, insert_edge));
    let count = std::cell::Cell::new(0_u64);
    let mut conditional_nodes = 0_u64;
    progress("nodes", 0, None, None);
    let needed_nodes = checked_sql(&mut db, &mut check, |db| {
        db.query_row("SELECT count(*) FROM nodes", [], |r| r.get(0))
    })?;
    let mut resolve_node =
        db.prepare("UPDATE nodes SET lat=?,lon=?,car=?,foot=? WHERE id=? AND lat IS NULL")?;
    let second = pbf::scan_routing_nodes(
        pbf,
        |object| {
            if let Object::TaggedNode(n) = object {
                let nref = &n.node;
                let (car, foot) = if n.tags.is_empty() {
                    (true, true)
                } else {
                    (
                        profile::passable(&n.tags, TravelMode::Car),
                        profile::passable(&n.tags, TravelMode::Foot),
                    )
                };
                let changed =
                    resolve_node.execute(params![nref.lat, nref.lon, car, foot, nref.id])?;
                if changed != 0 {
                    if n.tags.keys().any(|k| k.ends_with(":conditional")) {
                        conditional_nodes += 1;
                    }
                    count.set(count.get() + 1);
                }
            }
            Ok(())
        },
        &mut check,
        |done, total| {
            progress(
                "nodes",
                count.get(),
                Some(needed_nodes),
                Some((done, total)),
            )
        },
    )?;
    drop(resolve_node);
    progress("restrictions", 0, None, None);
    ensure!(
        first.source_sha256 == second.source_sha256,
        "取り込み中に入力PBFが変更されました"
    );
    let missing: i64 = checked_sql(&mut db, &mut check, |db| {
        db.query_row("SELECT count(*) FROM nodes WHERE lat IS NULL", [], |r| {
            r.get(0)
        })
    })?;
    ensure!(
        missing == 0,
        "道路が参照するノードがPBFに {missing} 件欠落しています"
    );
    let (excluded, outside) = restrictions::resolve(&db, &mut check, |done, total| {
        progress("restrictions", done, Some(total), None)
    })?;
    checked_sql(&mut db, &mut check, |db| {
        db.execute_batch(
            "
        UPDATE edges SET car_f=0,car_b=0 WHERE way IN (SELECT way FROM blocked WHERE mode=0);
        UPDATE edges SET foot_f=0,foot_b=0 WHERE way IN (SELECT way FROM blocked WHERE mode=1);
    ",
        )
    })?;
    index(&db, &mut check, &mut |stage, done| {
        progress(stage, done, Some(segments), None)
    })?;
    progress("sql_indexes", 0, None, None);
    checked_sql(&mut db, &mut check, |db| {
        db.execute_batch(
            "
        CREATE INDEX outgoing ON edges(a);
        CREATE INDEX incoming ON edges(b);
        DELETE FROM nodes WHERE NOT EXISTS (SELECT 1 FROM edges WHERE a=nodes.id)
                            AND NOT EXISTS (SELECT 1 FROM edges WHERE b=nodes.id);
    ",
        )
    })?;
    check()?;
    progress("validate", 0, None, None);
    let edge_count: u64 = db.query_row("SELECT count(*) FROM edges", [], |r| r.get(0))?;
    ensure!(edge_count > 0, "通行可能な道路区間がありません");
    let indexed: u64 = checked_sql(&mut db, &mut check, |db| {
        db.query_row("SELECT count(*) FROM edge_rtree", [], |r| r.get(0))
    })?;
    ensure!(
        indexed == edge_count,
        "道路区間と空間索引の件数が一致しません"
    );
    let (node_count, bounds) = checked_sql(&mut db, &mut check, |db| {
        db.query_row(
            "SELECT count(*),min(lon),min(lat),max(lon),max(lat) FROM nodes",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    Bounds {
                        west: r.get(1)?,
                        south: r.get(2)?,
                        east: r.get(3)?,
                        north: r.get(4)?,
                    },
                ))
            },
        )
    })?;
    let info = GraphInfo {
        schema_version: SCHEMA,
        profile_version: PROFILE_VERSION.into(),
        source_sha256: first.source_sha256,
        edge_count,
        node_count,
        bounds,
        restriction_count: db.query_row(
            "SELECT count(DISTINCT relation_id) FROM turns",
            [],
            |r| r.get(0),
        )?,
        excluded_restriction_count: excluded,
        outside_restriction_count: outside,
        conditional_way_count: conditional_ways,
        conditional_node_count: conditional_nodes,
        attribution: "© OpenStreetMap contributors".into(),
    };
    db.execute(
        "INSERT INTO metadata VALUES(1,?)",
        [serde_json::to_string(&info)?],
    )?;
    db.execute_batch("COMMIT")?;
    let integrity: String = checked_sql(&mut db, &mut check, |db| {
        db.query_row("PRAGMA quick_check", [], |r| r.get(0))
    })?;
    ensure!(
        integrity == "ok",
        "経路データの整合性検証に失敗しました: {integrity}"
    );
    drop(db);
    let persisted = inspect(&path)?;
    check()?;
    tempfile::TempPath::try_from_path(&path)?
        .persist_noclobber(output)
        .context("完成した経路データの公開に失敗しました")?;
    progress("publish_graph", edge_count, None, None);
    Ok(persisted)
}

/// 時間のかかる索引作成・集計・整合性検査でも取消を受け付ける。
/// ワーカーだけがDB接続を使い、呼び出し側はSQLiteの割り込みハンドルを保持する。
fn checked_sql<T: Send>(
    db: &mut Connection,
    check: &mut impl FnMut() -> Result<()>,
    query: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send,
) -> Result<T> {
    use std::{sync::mpsc, thread, time::Duration};
    check()?;
    let interrupt = db.get_interrupt_handle();
    let (tx, rx) = mpsc::channel();
    thread::scope(|scope| {
        scope.spawn(move || {
            let _ = tx.send(query(db));
        });
        let mut cancellation = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(result) => {
                    return if let Some(error) = cancellation {
                        Err(error)
                    } else {
                        Ok(result?)
                    };
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if cancellation.is_none() {
                        cancellation = check().err();
                    }
                    if cancellation.is_some() {
                        interrupt.interrupt();
                    }
                },
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("経路データの検査処理が停止しました")
                },
            }
        }
    })
}

fn index(
    db: &Connection,
    check: &mut impl FnMut() -> Result<()>,
    progress: &mut impl FnMut(&str, u64),
) -> Result<()> {
    let mut cursor = 0_i64;
    let mut count = 0_u64;
    progress("index", 0);
    // 一定件数ずつ読み、SELECTを終えてから同じテーブルを更新する。全国データでもメモリ使用量を抑える。
    let mut read = db.prepare(
        "SELECT e.id,a.lat,a.lon,b.lat,b.lon,e.car_f+e.car_b+e.foot_f+e.foot_b>0
        FROM edges e JOIN nodes a ON a.id=e.a JOIN nodes b ON b.id=e.b
        WHERE e.id>? ORDER BY e.id LIMIT 4096",
    )?;
    let mut update = db.prepare("UPDATE edges SET meters=? WHERE id=?")?;
    let mut spatial = db.prepare("INSERT INTO edge_rtree VALUES(?,?,?,?,?)")?;
    let mut delete = db.prepare("DELETE FROM edges WHERE id=?")?;
    loop {
        check()?;
        let batch: Vec<_> = read
            .query_map([cursor], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    Coord {
                        lat: r.get(1)?,
                        lon: r.get(2)?,
                    },
                    Coord {
                        lat: r.get(3)?,
                        lon: r.get(4)?,
                    },
                    r.get::<_, bool>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        if batch.is_empty() {
            break;
        }
        for (id, a, b, usable) in batch {
            cursor = id;
            let meters = a.distance(b);
            count += 1;
            if !usable {
                delete.execute([id])?;
                continue;
            }
            update.execute(params![meters, id])?;
            let (west, east) = if (a.lon - b.lon).abs() > 180. {
                (-180., 180.)
            } else {
                (a.lon.min(b.lon), a.lon.max(b.lon))
            };
            spatial.execute(params![id, west, east, a.lat.min(b.lat), a.lat.max(b.lat)])?;
        }
        progress("index", count);
    }
    Ok(())
}
