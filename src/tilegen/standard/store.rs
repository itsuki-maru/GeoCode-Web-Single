//! 形式2の追加表。道路の表・LODは形式1と同じ読み取り処理を使用する。

use super::model::*;
use crate::tilegen::{
    geometry::{Point, Rect},
    store::{self as roads, StoreMetadata},
    style::RoadAttributes,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeMap;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_POINTS: usize = 1_000_000;
const MAX_RINGS: usize = 16_384;
pub const AREA_LOD_ERROR_PX: f64 = 0.25;
pub const ROAD_LOD_ERROR_PX: f64 = 0.5;

pub fn initialize(conn: &Connection) -> Result<()> {
    roads::initialize(conn)?;
    conn.execute(
        "UPDATE metadata SET value='2' WHERE key='schema_version'",
        [],
    )?;
    conn.execute_batch("CREATE TABLE standard_features(
      id INTEGER PRIMARY KEY,osm_type INTEGER NOT NULL,osm_id INTEGER NOT NULL,role INTEGER NOT NULL,
      kind INTEGER NOT NULL,layer INTEGER NOT NULL,structure INTEGER NOT NULL,
      min_zoom INTEGER NOT NULL,min_x REAL NOT NULL,max_x REAL NOT NULL,min_y REAL NOT NULL,max_y REAL NOT NULL,
      point_count INTEGER NOT NULL,geometry BLOB NOT NULL,UNIQUE(osm_type,osm_id,role,kind));
      CREATE VIRTUAL TABLE standard_rtree USING rtree(id,min_x,max_x,min_y,max_y);
      CREATE TABLE standard_geometry_lod(feature_id INTEGER NOT NULL REFERENCES standard_features(id),zoom INTEGER NOT NULL,geometry BLOB NOT NULL,PRIMARY KEY(feature_id,zoom)) WITHOUT ROWID;")?;
    super::elevation::initialize(conn)?;
    Ok(())
}

pub fn initialize_v2(conn: &Connection) -> Result<()> {
    initialize(conn)?;
    conn.execute(
        "UPDATE metadata SET value='3' WHERE key='schema_version'",
        [],
    )?;
    super::labels::initialize(conn)?;
    Ok(())
}

pub fn capabilities(conn: &Connection) -> Result<DatasetCapabilities> {
    let Some(metadata) = details(conn)? else {
        return Ok(DatasetCapabilities::default());
    };
    if metadata.revision == 2 {
        return metadata
            .capabilities
            .context("名称対応DBの収録能力がありません");
    }
    Ok(DatasetCapabilities {
        labels: false,
        elevation: metadata.elevation.is_some(),
        contours: metadata
            .elevation
            .as_ref()
            .is_some_and(|e| e["contour_features"].as_u64().unwrap_or(0) > 0),
    })
}

fn rings(g: &Geometry) -> Vec<&[Point]> {
    match g {
        Geometry::Line(p) => vec![p],
        Geometry::Polygon(parts) => parts
            .iter()
            .flat_map(|p| {
                std::iter::once(p.outer.as_slice()).chain(p.holes.iter().map(Vec::as_slice))
            })
            .collect(),
    }
}
pub fn bounds(g: &Geometry) -> Result<Rect> {
    let mut found: Option<Rect> = None;
    for ring in rings(g) {
        let b = Rect::from_points(ring)?;
        found = Some(match found {
            None => b,
            Some(a) => Rect {
                min_x: a.min_x.min(b.min_x),
                max_x: a.max_x.max(b.max_x),
                min_y: a.min_y.min(b.min_y),
                max_y: a.max_y.max(b.max_y),
            },
        });
    }
    found.context("空の形状")
}
fn encode(g: &Geometry) -> Result<(Vec<u8>, usize)> {
    let all = rings(g);
    ensure!(
        !all.is_empty() && all.len() <= MAX_RINGS,
        "形状のリング数が上限外です"
    );
    let total = all.iter().try_fold(0usize, |n, p| {
        n.checked_add(p.len()).context("点数が過大です")
    })?;
    ensure!((2..=MAX_POINTS).contains(&total), "形状の点数が上限外です");
    let mut out = Vec::with_capacity(total * 16 + all.len() * 4 + 16);
    out.push(if matches!(g, Geometry::Line(_)) { 0 } else { 1 });
    let put = |out: &mut Vec<u8>, p: &[Point]| -> Result<()> {
        ensure!((2..=MAX_POINTS).contains(&p.len()), "不正なリング長です");
        out.extend_from_slice(&(p.len() as u32).to_le_bytes());
        out.extend(roads::encode_points(p)?);
        Ok(())
    };
    match g {
        Geometry::Line(p) => put(&mut out, p)?,
        Geometry::Polygon(parts) => {
            out.extend_from_slice(&(parts.len() as u32).to_le_bytes());
            for part in parts {
                ensure!(
                    part.outer.len() >= 4 && part.outer.first() == part.outer.last(),
                    "外周が閉じていません"
                );
                out.extend_from_slice(&(part.holes.len() as u32).to_le_bytes());
                put(&mut out, &part.outer)?;
                for h in &part.holes {
                    ensure!(h.len() >= 4 && h.first() == h.last(), "穴が閉じていません");
                    put(&mut out, h)?;
                }
            }
        },
    }
    ensure!(out.len() <= MAX_BYTES, "形状が大きすぎます");
    Ok((out, total))
}
fn decode(bytes: &[u8]) -> Result<Geometry> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES,
        "不正な形状長です"
    );
    let mut pos = 1usize;
    let mut total = 0usize;
    fn number(bytes: &[u8], pos: &mut usize) -> Result<usize> {
        let b = bytes
            .get(*pos..*pos + 4)
            .context("形状が切断されています")?;
        *pos += 4;
        Ok(u32::from_le_bytes(b.try_into()?) as usize)
    }
    fn points(bytes: &[u8], pos: &mut usize, total: &mut usize) -> Result<Vec<Point>> {
        let n = number(bytes, pos)?;
        ensure!((2..=MAX_POINTS).contains(&n), "不正な点数です");
        *total = total.checked_add(n).context("点数が過大です")?;
        ensure!(*total <= MAX_POINTS, "累計点数が過大です");
        let data = bytes
            .get(*pos..*pos + n * 16)
            .context("形状が切断されています")?;
        *pos += n * 16;
        data.chunks_exact(16)
            .map(|b| {
                let p = Point {
                    x: f64::from_le_bytes(b[..8].try_into()?),
                    y: f64::from_le_bytes(b[8..].try_into()?),
                };
                ensure!(
                    p.x.is_finite()
                        && p.y.is_finite()
                        && (0.0..=1.0).contains(&p.x)
                        && (0.0..=1.0).contains(&p.y),
                    "不正な座標です"
                );
                Ok(p)
            })
            .collect()
    }
    let g = if bytes[0] == 0 {
        Geometry::Line(points(bytes, &mut pos, &mut total)?)
    } else {
        ensure!(bytes[0] == 1, "未知の形状形式です");
        let n = number(bytes, &mut pos)?;
        ensure!((1..=MAX_RINGS).contains(&n), "不正な部品数です");
        let mut parts = Vec::new();
        let mut ring_count = 0;
        for _ in 0..n {
            let h = number(bytes, &mut pos)?;
            ring_count += h + 1;
            ensure!(ring_count <= MAX_RINGS, "穴の数が過大です");
            let outer = points(bytes, &mut pos, &mut total)?;
            let mut holes = Vec::new();
            for _ in 0..h {
                holes.push(points(bytes, &mut pos, &mut total)?);
            }
            ensure!(
                outer.len() >= 4
                    && outer.first() == outer.last()
                    && holes.iter().all(|p| p.len() >= 4 && p.first() == p.last()),
                "リングが閉じていません"
            );
            parts.push(PolygonPart { outer, holes });
        }
        Geometry::Polygon(parts)
    };
    ensure!(pos == bytes.len(), "形状に余剰バイトがあります");
    Ok(g)
}
pub fn insert_feature(conn: &Connection, f: &Feature) -> Result<()> {
    insert_feature_with_context(
        conn,
        f,
        &crate::tilegen::operation::OperationContext::new(
            crate::tilegen::cancel::CancellationToken::new(),
        ),
    )
}
pub fn insert_feature_with_context(
    conn: &Connection,
    f: &Feature,
    context: &crate::tilegen::operation::OperationContext,
) -> Result<()> {
    context.check()?;
    validate_feature(f)?;
    let (data, points) = encode(&f.geometry)?;
    let b = bounds(&f.geometry)?;
    ensure!(f.structure <= 2, "構造属性が不正です");
    let min_zoom = if f.kind == FeatureKind::Contour {
        if f.role % 500 == 0 {
            10
        } else if f.role % 100 == 0 {
            12
        } else {
            14
        }
    } else {
        f.kind.min_zoom()
    };
    conn.execute("INSERT INTO standard_features(osm_type,osm_id,role,kind,layer,structure,min_zoom,min_x,max_x,min_y,max_y,point_count,geometry) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![f.osm_type,f.osm_id,f.role,f.kind as i64,f.layer,f.structure,min_zoom,b.min_x,b.max_x,b.min_y,b.max_y,points as i64,data])?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO standard_rtree VALUES(?,?,?,?,?)",
        params![id, b.min_x, b.max_x, b.min_y, b.max_y],
    )?;
    for zoom in min_zoom..=13 {
        context.check()?;
        let epsilon = AREA_LOD_ERROR_PX / (256.0 * f64::from(1u32 << zoom));
        let lod = match &f.geometry {
            Geometry::Line(p) => Geometry::Line(crate::tilegen::simplify::simplify_with_check(
                p,
                &vec![false; p.len()],
                epsilon,
                || context.check(),
            )?),
            Geometry::Polygon(parts) => {
                let mut simple = Vec::new();
                let mut accepted = true;
                for part in parts {
                    for ring in std::iter::once(&part.outer).chain(part.holes.iter()) {
                        let p = crate::tilegen::simplify::simplify_with_check(
                            ring,
                            &vec![false; ring.len()],
                            epsilon,
                            || context.check(),
                        )?;
                        if p.len() < 4 {
                            accepted = false;
                            break;
                        }
                        simple.push(p);
                    }
                    if !accepted {
                        break;
                    }
                }
                if accepted {
                    match super::areas::polygon_from_rings(simple, context) {
                        Ok(p)
                            if p.len() == parts.len()
                                && p.iter().map(|p| p.holes.len()).sum::<usize>()
                                    == parts.iter().map(|p| p.holes.len()).sum::<usize>() =>
                        {
                            Geometry::Polygon(p)
                        },
                        _ => f.geometry.clone(),
                    }
                } else {
                    f.geometry.clone()
                }
            },
        };
        let (bytes, _) = encode(&lod)?;
        conn.execute(
            "INSERT INTO standard_geometry_lod VALUES(?,?,?)",
            params![id, zoom, bytes],
        )?;
    }
    Ok(())
}
pub fn insert_road(
    conn: &Connection,
    id: i64,
    attrs: RoadAttributes,
    points: &[Point],
) -> Result<()> {
    insert_road_with_context(
        conn,
        id,
        attrs,
        points,
        &crate::tilegen::operation::OperationContext::default(),
    )
}
pub fn insert_road_with_context(
    conn: &Connection,
    id: i64,
    attrs: RoadAttributes,
    points: &[Point],
    context: &crate::tilegen::operation::OperationContext,
) -> Result<()> {
    context.check()?;
    let b = Rect::from_points(points)?;
    let data = roads::encode_points(points)?;
    conn.execute("INSERT INTO features(osm_way_id,road_class,is_link,effective_layer,structure_rank,min_x,max_x,min_y,max_y,point_count,points) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        params![id,attrs.road_class as i64,attrs.is_link,attrs.effective_layer,attrs.structure_rank,b.min_x,b.max_x,b.min_y,b.max_y,points.len() as i64,data])?;
    let fid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO feature_rtree VALUES(?,?,?,?,?)",
        params![fid, b.min_x, b.max_x, b.min_y, b.max_y],
    )?;
    // 道路readerと共通の形式を維持し、広域向けには簡略化したLODを保存する。
    let protected = vec![false; points.len()];
    for z in 6..=15 {
        context.check()?;
        let p = crate::tilegen::simplify::simplify_with_check(
            points,
            &protected,
            ROAD_LOD_ERROR_PX / (256.0 * f64::from(1u32 << z)),
            || context.check(),
        )?;
        conn.execute(
            "INSERT INTO geometry_lod VALUES(?,?,?,?)",
            params![fid, z, p.len() as i64, roads::encode_points(&p)?],
        )?;
    }
    Ok(())
}
pub fn query_features(conn: &Connection, b: Rect, zoom: u8) -> Result<Vec<Feature>> {
    let mut q=conn.prepare("SELECT f.osm_type,f.osm_id,f.role,f.kind,f.layer,f.structure,length(coalesce(l.geometry,f.geometry)),coalesce(l.geometry,f.geometry) FROM standard_rtree r JOIN standard_features f ON f.id=r.id LEFT JOIN standard_geometry_lod l ON l.feature_id=f.id AND l.zoom=? WHERE r.min_x<=? AND r.max_x>=? AND r.min_y<=? AND r.max_y>=? AND f.min_zoom<=? ORDER BY f.kind,f.layer,f.structure,f.osm_type,f.osm_id,f.role,f.id")?;
    let mut rows = q.query(params![zoom, b.max_x, b.min_x, b.max_y, b.min_y, zoom])?;
    let mut out = Vec::new();
    let mut bytes = 0usize;
    while let Some(r) = rows.next()? {
        let n: i64 = r.get(6)?;
        ensure!(n > 0 && n as usize <= MAX_BYTES, "形状BLOBが過大です");
        bytes += n as usize;
        ensure!(
            bytes <= MAX_BYTES && out.len() < 100_000,
            "候補地物の上限を超えました"
        );
        let feature = Feature {
            osm_type: r.get(0)?,
            osm_id: r.get(1)?,
            role: r.get(2)?,
            kind: FeatureKind::from_code(r.get(3)?)?,
            layer: r.get(4)?,
            structure: r.get(5)?,
            geometry: decode(&r.get::<_, Vec<u8>>(7)?)?,
        };
        validate_feature(&feature)?;
        out.push(feature);
    }
    Ok(out)
}
pub fn details(conn: &Connection) -> Result<Option<StandardMetadata>> {
    let data:Option<String>=conn.query_row("SELECT value FROM metadata WHERE key='standard_document' AND length(CAST(value AS BLOB))<=1048576",[],|r|r.get(0)).optional()?;
    data.map(|s| {
        let m: StandardMetadata = serde_json::from_str(&s)?;
        validate_metadata(&m)?;
        let schema: String = conn.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )?;
        ensure!(
            matches!((schema.as_str(), m.revision), ("2", 1) | ("3", 2)),
            "完成形式と追加メタデータの版が一致しません"
        );
        Ok(m)
    })
    .transpose()
}

fn validate_feature(feature: &Feature) -> Result<()> {
    ensure!(
        feature.structure <= 2 && (1..=4).contains(&feature.osm_type),
        "地物の構造・元種別が不正です"
    );
    let linear = matches!(
        feature.kind,
        FeatureKind::Waterway | FeatureKind::Railway | FeatureKind::Contour
    );
    ensure!(
        linear == matches!(feature.geometry, Geometry::Line(_)),
        "分類と形状種別が一致しません"
    );
    if feature.kind == FeatureKind::Contour {
        ensure!(
            (-12000..=12000).contains(&feature.role) && feature.role % 20 == 0,
            "等高線の標高が不正です"
        );
    }
    Ok(())
}
fn validate_metadata(m: &StandardMetadata) -> Result<()> {
    ensure!(
        matches!(m.revision, 1 | 2)
            && m.sources.len() <= 64
            && m.counts.len() <= 64
            && m.skipped_areas.len() <= 64,
        "追加形式の版・件数が未対応です"
    );
    if m.revision == 1 {
        ensure!(
            m.capabilities.is_none() && m.labels.is_none(),
            "旧形式へ名称対応の能力は追加できません"
        );
    } else {
        let capabilities = m.capabilities.context("収録能力がありません")?;
        let labels = m.labels.as_ref().context("名称の集計がありません")?;
        ensure!(
            capabilities.labels
                && capabilities.elevation == m.elevation.is_some()
                && (!capabilities.contours || capabilities.elevation),
            "収録能力が不整合です"
        );
        ensure!(
            labels.revision == 1
                && labels.categories.len() <= 64
                && labels.skipped.len() <= 64
                && labels
                    .categories
                    .values()
                    .try_fold(0_u64, |sum, &count| sum.checked_add(count))
                    == Some(labels.count),
            "名称の版・集計が不正です"
        );
    }
    for source in &m.sources {
        ensure!(
            !source.kind.is_empty()
                && source.kind.len() <= 64
                && source.sha256.len() == 64
                && source
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "資料の識別が不正です"
        );
    }
    if let Some(elevation) = &m.elevation {
        ensure!(
            matches!(elevation["revision"].as_u64(), Some(1 | 2))
                && elevation["cells"].as_u64().is_some_and(|n| n > 0),
            "標高メタデータが未対応です"
        );
        if elevation["revision"] == 2 {
            validate_elevation_metadata(elevation)?;
            let sources = m
                .sources
                .iter()
                .filter(|source| source.kind == "elevation")
                .collect::<Vec<_>>();
            ensure!(
                sources.len() == 1 && sources[0].details == *elevation,
                "標高資料と追加メタデータが一致しません"
            );
        }
    }
    Ok(())
}

fn elevation_count(document: &Value, key: &str) -> Result<u64> {
    document[key]
        .as_u64()
        .with_context(|| format!("標高メタデータの件数がありません: {key}"))
}

fn coordinate_systems<'a>(document: &'a Value, key: &str) -> Result<Vec<&'a str>> {
    let values = document[key]
        .as_array()
        .with_context(|| format!("標高メタデータのCRS一覧がありません: {key}"))?;
    ensure!(
        !values.is_empty() && values.len() <= 3,
        "標高メタデータのCRS件数が不正です"
    );
    let names = values
        .iter()
        .map(|value| value.as_str().context("標高CRSが文字列ではありません"))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        names.iter().all(|name| matches!(
            *name,
            "fguuid:jgd2000.bl" | "fguuid:jgd2011.bl" | "fguuid:jgd2024.bl"
        )) && names.windows(2).all(|pair| pair[0] < pair[1]),
        "標高CRS一覧に未知値・重複・順序の不整合があります"
    );
    Ok(names)
}

fn elevation_bounds(value: &Value) -> Result<Rect> {
    let bounds: Rect = serde_json::from_value(value.clone()).context("標高範囲がありません")?;
    Rect::new(bounds.min_x, bounds.max_x, bounds.min_y, bounds.max_y)?;
    ensure!(
        0.0 <= bounds.min_x
            && bounds.min_x < bounds.max_x
            && bounds.max_x <= 1.0
            && 0.0 <= bounds.min_y
            && bounds.min_y < bounds.max_y
            && bounds.max_y <= 1.0,
        "標高範囲が正規化した地図座標の外にあります"
    );
    Ok(bounds)
}

fn validate_elevation_metadata(document: &Value) -> Result<()> {
    let sources = coordinate_systems(document, "source_coordinate_systems")?;
    let contributors = coordinate_systems(document, "contributing_coordinate_systems")?;
    let policy = document["datum_policy"]
        .as_str()
        .context("標高の混在方針がありません")?;
    ensure!(
        matches!(policy, "strict" | "allow-jgd2000-2011")
            && (sources.len() == 1
                || (policy == "allow-jgd2000-2011"
                    && sources == ["fguuid:jgd2000.bl", "fguuid:jgd2011.bl"]))
            && contributors.iter().all(|name| sources.contains(name)),
        "標高のCRS構成と混在方針が一致しません"
    );
    ensure!(
        document["mixed_input_coordinate_systems"].as_bool() == Some(sources.len() > 1)
            && document["mixed_coordinate_systems"].as_bool() == Some(contributors.len() > 1)
            && if sources.len() == 1 {
                document["crs"].as_str() == Some(sources[0])
            } else {
                document.get("crs").is_some_and(Value::is_null)
            },
        "標高の単独・混在CRS表示が一致しません"
    );
    let effective = if contributors.len() == 1 {
        "source-values-single-crs-v2"
    } else {
        "source-values-mixed-jgd2000-2011-v2"
    };
    ensure!(
        document["effective_datum_policy"].as_str() == Some(effective)
            && document["effective_surface_policy"].as_str()
                == Some(super::elevation::EFFECTIVE_SURFACE_POLICY)
            && document["horizontal_transformation"].as_str() == Some("none-source-lonlat-v1")
            && document["vertical_correction"].as_str() == Some("none-source-height-v1"),
        "標高の実効方針または補正方法が未対応です"
    );
    let records = document["coordinate_systems"]
        .as_object()
        .context("標高のCRS別集計がありません")?;
    ensure!(
        records.len() == sources.len() && sources.iter().all(|name| records.contains_key(*name)),
        "標高の元CRS一覧と集計が一致しません"
    );
    let mut totals = [0_u64; 4];
    let mut combined: Option<Rect> = None;
    for name in &sources {
        let record = &records[*name];
        let input = elevation_count(record, "input_grids")?;
        let valid = elevation_count(record, "valid_grids")?;
        let cells = elevation_count(record, "contributed_cells")?;
        let ground = elevation_count(record, "ground_cells")?;
        ensure!(
            (1..=200_000).contains(&input)
                && valid <= input
                && cells <= valid * 4_000_000
                && ground <= cells
                && contributors.contains(name) == (cells > 0),
            "標高のCRS別件数が不整合です: {name}"
        );
        let digest = record["sha256"]
            .as_str()
            .context("標高資料のhashがありません")?;
        ensure!(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "標高資料のhashが不正です"
        );
        if cells == 0 {
            ensure!(
                record.get("coverage_bounds").is_some_and(Value::is_null),
                "採用セルのない標高資料に範囲があります"
            );
        } else {
            let bounds = elevation_bounds(&record["coverage_bounds"])?;
            combined = Some(match combined {
                Some(previous) => Rect {
                    min_x: previous.min_x.min(bounds.min_x),
                    max_x: previous.max_x.max(bounds.max_x),
                    min_y: previous.min_y.min(bounds.min_y),
                    max_y: previous.max_y.max(bounds.max_y),
                },
                None => bounds,
            });
        }
        for (sum, count) in totals.iter_mut().zip([input, valid, cells, ground]) {
            *sum = sum
                .checked_add(count)
                .context("標高件数の合計が桁あふれしました")?;
        }
    }
    ensure!(
        totals
            == [
                elevation_count(document, "input_grids")?,
                elevation_count(document, "grids")?,
                elevation_count(document, "cells")?,
                elevation_count(document, "ground_cells")?,
            ]
            && totals[0] <= 200_000
            && totals[3] > 0,
        "標高全体とCRS別の件数が一致しません"
    );
    let expected = combined.context("採用済み標高の範囲がありません")?;
    let actual = elevation_bounds(&document["coverage_bounds"])?;
    ensure!(
        [
            actual.min_x - expected.min_x,
            actual.max_x - expected.max_x,
            actual.min_y - expected.min_y,
            actual.max_y - expected.max_y,
        ]
        .iter()
        .all(|difference| difference.abs() <= 1e-12),
        "標高全体とCRS別の範囲が一致しません"
    );
    let resolutions = document["cells_per_degree"]
        .as_array()
        .context("標高格子の解像度がありません")?;
    ensure!(
        !resolutions.is_empty() && resolutions.len() <= 16,
        "標高格子の解像度数が不正です"
    );
    let resolutions = resolutions
        .iter()
        .map(|value| {
            value
                .as_u64()
                .context("標高格子の解像度が整数ではありません")
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        resolutions.iter().all(|value| (1..=36_000).contains(value))
            && resolutions.windows(2).all(|pair| pair[0] < pair[1])
            && document["contour_interval_m"] == 20
            && document["index_contour_interval_m"] == 100,
        "標高格子・等高線の条件が未対応です"
    );
    let min = document["min_elevation_m"]
        .as_f64()
        .context("標高最小値がありません")?;
    let max = document["max_elevation_m"]
        .as_f64()
        .context("標高最大値がありません")?;
    ensure!(
        min.is_finite() && max.is_finite() && -15_000.0 <= min && min <= max && max <= 100_000.0,
        "標高の最大・最小値が不正です"
    );
    Ok(())
}
pub fn summary(conn: &Connection) -> Result<(u64, Rect, u64, BTreeMap<u8, u64>)> {
    let extended: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_labels')",
        [],
        |r| r.get(0),
    )?;
    let query = if extended {
        "SELECT count(*),min(min_x),max(max_x),min(min_y),max(max_y),coalesce(sum(point_count),0) FROM (SELECT min_x,max_x,min_y,max_y,point_count FROM features UNION ALL SELECT min_x,max_x,min_y,max_y,point_count FROM standard_features UNION ALL SELECT x,x,y,y,1 FROM map_labels)"
    } else {
        "SELECT count(*),min(min_x),max(max_x),min(min_y),max(max_y),coalesce(sum(point_count),0) FROM (SELECT min_x,max_x,min_y,max_y,point_count FROM features UNION ALL SELECT min_x,max_x,min_y,max_y,point_count FROM standard_features)"
    };
    let (n, minx, maxx, miny, maxy, points): (
        u64,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        u64,
    ) = conn.query_row(query, [], |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
        ))
    })?;
    ensure!(n > 0, "取り込める地物がありません");
    let b = Rect::new(
        minx.context("外接範囲なし")?,
        maxx.unwrap(),
        miny.unwrap(),
        maxy.unwrap(),
    )?;
    let mut lod = BTreeMap::new();
    for z in 6..=15 {
        let c: u64 = conn.query_row(
            "SELECT coalesce(sum(point_count),0) FROM geometry_lod WHERE zoom=?",
            [z],
            |r| r.get(0),
        )?;
        lod.insert(z, c);
    }
    Ok((n, b, points, lod))
}
pub fn finish(conn: &Connection, metadata: &StoreMetadata, extra: &StandardMetadata) -> Result<()> {
    validate_metadata(extra)?;
    match &extra.elevation {
        Some(elevation) if elevation["revision"] == 2 => {
            let stored: Option<String> = conn
                .query_row(
                    "SELECT value FROM standard_dem_metadata WHERE key='document' AND length(CAST(value AS BLOB))<=1048576",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let stored: Value = serde_json::from_str(
                &stored.context("保存した標高メタデータがないか、上限を超えています")?,
            )?;
            ensure!(
                stored == *elevation,
                "格子の標高メタデータと完成DBの出典情報が一致しません"
            );
            super::elevation::validate_stored_summary(conn, elevation)?;
        },
        None => {
            let has_elevation: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM standard_dem_chunks) OR EXISTS(SELECT 1 FROM standard_dem_metadata)",
                [],
                |row| row.get(0),
            )?;
            ensure!(
                !has_elevation,
                "標高格子またはメタデータがあるのに、完成DBの標高出典がありません"
            );
        },
        _ => {},
    }
    ensure!(
        matches!((metadata.schema_version, extra.revision), (2, 1) | (3, 2))
            && metadata.geometry_version == 2
            && metadata.complete,
        "完成形式が不正です"
    );
    if metadata.schema_version == 3 {
        super::labels::validate_stored(
            conn,
            extra.labels.as_ref().context("名称集計がありません")?,
        )?;
        if !extra.capabilities.context("収録能力がありません")?.contours {
            let count: u64 = conn.query_row(
                "SELECT count(*) FROM standard_features WHERE kind=150",
                [],
                |r| r.get(0),
            )?;
            ensure!(count == 0, "等高線非収録のDBに等高線があります");
        }
    }
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    ensure!(integrity == "ok", "SQLite整合性エラー");
    for table in ["feature_rtree", "standard_rtree"] {
        let result: String = conn.query_row("SELECT rtreecheck(?)", [table], |r| r.get(0))?;
        ensure!(result == "ok", "索引整合性エラー");
    }
    for (features, index) in [
        ("features", "feature_rtree"),
        ("standard_features", "standard_rtree"),
    ] {
        let key = if features == "features" {
            "feature_id"
        } else {
            "id"
        };
        let mismatch:bool=conn.query_row(&format!("SELECT (SELECT count(*) FROM {features})<>(SELECT count(*) FROM {index}) OR EXISTS(SELECT 1 FROM {features} f LEFT JOIN {index} r ON r.{key}=f.{key} WHERE r.{key} IS NULL OR r.min_x>f.min_x OR r.max_x<f.max_x OR r.min_y>f.min_y OR r.max_y<f.max_y)"),[],|r|r.get(0))?;
        ensure!(!mismatch, "地物と空間索引の件数・範囲が一致しません");
    }
    let foreign_keys: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |r| r.get(0),
    )?;
    ensure!(!foreign_keys, "完成DBの外部キーが不正です");
    let invalid_lod:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM features f WHERE (SELECT count(*) FROM geometry_lod l WHERE l.feature_id=f.feature_id)<>10) OR EXISTS(SELECT 1 FROM standard_features f WHERE (SELECT count(*) FROM standard_geometry_lod l WHERE l.feature_id=f.id)<>max(0,14-f.min_zoom)) OR EXISTS(SELECT 1 FROM standard_geometry_lod l JOIN standard_features f ON f.id=l.feature_id WHERE l.zoom<f.min_zoom OR l.zoom>13 OR length(l.geometry) NOT BETWEEN 1 AND 33554432)",[],|r|r.get(0))?;
    ensure!(!invalid_lod, "完成DBのLODが不足しているか不正です");
    let (n, _, _, _) = summary(conn)?;
    ensure!(n == metadata.feature_count, "地物数が一致しません");
    let document = serde_json::to_string(metadata)?;
    let standard_document = serde_json::to_string(extra)?;
    ensure!(
        document.len() <= 1024 * 1024 && standard_document.len() <= 1024 * 1024,
        "完成メタデータが1MiBを超えました"
    );
    conn.execute_batch("BEGIN IMMEDIATE")?;
    conn.execute("INSERT INTO metadata VALUES('document',?)", [document])?;
    conn.execute(
        "INSERT INTO metadata VALUES('standard_document',?)",
        [standard_document],
    )?;
    conn.execute("UPDATE metadata SET value='true' WHERE key='complete'", [])?;
    conn.execute_batch("COMMIT")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn elevation_metadata(conn: &Connection) -> StandardMetadata {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dem.xml");
        std::fs::write(
            &path,
            r#"<Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM>
<gml:boundedBy><gml:Envelope srsName="fguuid:jgd2011.bl">
<gml:lowerCorner>35 139</gml:lowerCorner><gml:upperCorner>36 140</gml:upperCorner>
</gml:Envelope></gml:boundedBy><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>1 1</gml:high></gml:GridEnvelope>
<gml:sequenceRule order="+x-y">Linear</gml:sequenceRule><gml:startPoint>0 0</gml:startPoint>
<gml:tupleList>地表面,100 地表面,120 地表面,140 地表面,160</gml:tupleList></DEM></Dataset>"#,
        )
        .unwrap();
        let (sources, elevation) = super::super::elevation::import_into(
            conn,
            &path,
            &crate::tilegen::operation::OperationContext::default(),
        )
        .unwrap();
        StandardMetadata {
            revision: 1,
            sources,
            elevation: Some(elevation),
            ..Default::default()
        }
    }

    #[test]
    fn 標高の出典と採用集計の矛盾を完成メタデータとして受け付けない() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let valid = elevation_metadata(&conn);
        validate_metadata(&valid).unwrap();
        for (pointer, replacement) in [
            ("/revision", serde_json::json!(999)),
            ("/mixed_coordinate_systems", serde_json::json!(true)),
            ("/horizontal_transformation", serde_json::json!("converted")),
            (
                "/effective_surface_policy",
                serde_json::json!("unknown-surface-policy"),
            ),
            ("/effective_surface_policy", Value::Null),
            ("/ground_cells", serde_json::json!(u64::MAX)),
            (
                "/coordinate_systems/fguuid:jgd2011.bl/contributed_cells",
                serde_json::json!(0),
            ),
            (
                "/coordinate_systems/fguuid:jgd2011.bl/sha256",
                serde_json::json!("hashなし"),
            ),
        ] {
            let mut changed = valid.clone();
            let elevation = changed.elevation.as_mut().unwrap();
            *elevation.pointer_mut(pointer).unwrap() = replacement;
            changed.sources[0].details = elevation.clone();
            assert!(validate_metadata(&changed).is_err(), "{pointer}");
        }
        let mut changed = valid;
        changed.sources[0].details["cells"] = serde_json::json!(0);
        assert!(validate_metadata(&changed).is_err());
    }

    #[test]
    fn 標高の集計だけを改変しても実格子と違えば完成公開しない() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut extra = elevation_metadata(&conn);
        insert_feature(&conn, &feature()).unwrap();
        let elevation = extra.elevation.as_mut().unwrap();
        let cells = elevation["cells"].as_u64().unwrap();
        elevation["cells"] = serde_json::json!(cells + 1);
        elevation["coordinate_systems"]["fguuid:jgd2011.bl"]["contributed_cells"] =
            serde_json::json!(cells + 1);
        extra.sources[0].details = elevation.clone();
        conn.execute(
            "UPDATE standard_dem_metadata SET value=? WHERE key='document'",
            [elevation.to_string()],
        )
        .unwrap();
        validate_metadata(&extra).unwrap();
        let error = finish(&conn, &metadata(&conn), &extra).unwrap_err();
        assert!(error.to_string().contains("保存格子"), "{error:#}");
        assert_eq!(
            conn.query_row(
                "SELECT value FROM metadata WHERE key='complete'",
                [],
                |row| { row.get::<_, String>(0) }
            )
            .unwrap(),
            "false"
        );
    }

    #[test]
    fn 標高の出典欠落や保存文書の不一致を完成成功にしない() {
        for change in 0..4 {
            let conn = Connection::open_in_memory().unwrap();
            initialize(&conn).unwrap();
            let mut extra = elevation_metadata(&conn);
            insert_feature(&conn, &feature()).unwrap();
            match change {
                0 => extra.elevation = None,
                1 => {
                    extra.elevation = None;
                    conn.execute("DELETE FROM standard_dem_chunks", []).unwrap();
                },
                2 => {
                    conn.execute("DELETE FROM standard_dem_metadata", [])
                        .unwrap();
                },
                3 => {
                    conn.execute(
                        "UPDATE standard_dem_metadata SET value='{}' WHERE key='document'",
                        [],
                    )
                    .unwrap();
                },
                _ => unreachable!(),
            }
            assert!(finish(&conn, &metadata(&conn), &extra).is_err(), "{change}");
            assert_eq!(
                conn.query_row(
                    "SELECT value FROM metadata WHERE key='complete'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                "false"
            );
        }
    }

    #[test]
    fn 面の穴と複数部品を復元し余剰バイトを拒否する() {
        let ring = vec![
            Point { x: 0.1, y: 0.1 },
            Point { x: 0.9, y: 0.1 },
            Point { x: 0.5, y: 0.9 },
            Point { x: 0.1, y: 0.1 },
        ];
        let g = Geometry::Polygon(vec![PolygonPart {
            outer: ring.clone(),
            holes: vec![ring],
        }]);
        let (mut b, _) = encode(&g).unwrap();
        assert_eq!(decode(&b).unwrap(), g);
        b.push(0);
        assert!(decode(&b).is_err());
    }
    fn feature() -> Feature {
        Feature {
            osm_type: 1,
            osm_id: 1,
            role: 0,
            kind: FeatureKind::Forest,
            layer: 0,
            structure: 1,
            geometry: Geometry::Polygon(vec![PolygonPart {
                outer: vec![
                    Point { x: 0.1, y: 0.1 },
                    Point { x: 0.9, y: 0.1 },
                    Point { x: 0.5, y: 0.9 },
                    Point { x: 0.1, y: 0.1 },
                ],
                holes: vec![],
            }]),
        }
    }
    fn metadata(conn: &Connection) -> StoreMetadata {
        let (n, b, p, l) = summary(conn).unwrap();
        StoreMetadata {
            schema_version: 2,
            geometry_version: 2,
            importer_version: "検証".into(),
            import_rules_hash: "a".repeat(64),
            dataset_id: "b".repeat(64),
            source_sha256: "c".repeat(64),
            source_bytes: 1,
            source_timestamp: None,
            created_unix_seconds: 0,
            coordinate_system: "web-mercator-normalized-f64".into(),
            bbox: b,
            feature_count: n,
            original_point_count: p,
            lod_point_counts: l,
            missing_nodes_policy: "error".into(),
            excluded_way_count: 0,
            skipped_missing_way_count: 0,
            degenerate_way_count: 0,
            clamped_node_count: 0,
            highway_counts: BTreeMap::new(),
            complete: true,
        }
    }
    #[test]
    fn 索引や必須lodの欠損を完成成功にしない() {
        for change in [
            "DELETE FROM standard_rtree",
            "DELETE FROM standard_geometry_lod WHERE zoom=6",
        ] {
            let conn = Connection::open_in_memory().unwrap();
            initialize(&conn).unwrap();
            insert_feature(&conn, &feature()).unwrap();
            let m = metadata(&conn);
            conn.execute(change, []).unwrap();
            assert!(
                finish(
                    &conn,
                    &m,
                    &StandardMetadata {
                        revision: 1,
                        ..Default::default()
                    }
                )
                .is_err()
            );
            assert_eq!(
                conn.query_row("SELECT value FROM metadata WHERE key='complete'", [], |r| r
                    .get::<_, String>(0))
                    .unwrap(),
                "false"
            );
        }
    }
    #[test]
    fn 不明構造や形状分類不一致を欠けた成功画像にしない() {
        for change in [
            "UPDATE standard_features SET structure=3",
            "UPDATE standard_features SET kind=140",
        ] {
            let conn = Connection::open_in_memory().unwrap();
            initialize(&conn).unwrap();
            insert_feature(&conn, &feature()).unwrap();
            conn.execute(change, []).unwrap();
            assert!(query_features(&conn, Rect::new(0.0, 1.0, 0.0, 1.0).unwrap(), 14).is_err());
        }
    }
    #[test]
    fn 未対応の追加メタデータ版を現在の契約へ混ぜない() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        conn.execute(
            "INSERT INTO metadata VALUES('standard_document',?)",
            [serde_json::to_string(&StandardMetadata {
                revision: 999,
                ..Default::default()
            })
            .unwrap()],
        )
        .unwrap();
        assert!(details(&conn).is_err());
    }
}
