//! 処理済みWGS84陸域Shapefileの2次元Polygonを逐次取り込む。

use super::{
    areas,
    model::{Feature, FeatureKind, Geometry, SourceInfo},
    store,
};
use crate::tilegen::{
    geometry::{Rect, project},
    operation::OperationContext,
};
use anyhow::{Context, Result, ensure};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, Read},
    path::Path,
};

const MAX_RECORD: usize = 16 * 1024 * 1024;
const MAX_POINTS: usize = 1_000_000;

pub fn import_into(
    connection: &Connection,
    input: &Path,
    context: &OperationContext,
) -> Result<SourceInfo> {
    context.check()?;
    let before = fs::metadata(input)?;
    ensure!(
        before.is_file(),
        "陸域入力はPolygon Shapefileを指定してください"
    );
    let raw_scope:(Option<f64>,Option<f64>,Option<f64>,Option<f64>)=connection.query_row(
        "SELECT min(min_x),max(max_x),min(min_y),max(max_y) FROM (SELECT min_x,max_x,min_y,max_y FROM features UNION ALL SELECT min_x,max_x,min_y,max_y FROM standard_features WHERE osm_type IN (1,2))",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let coverage = match raw_scope {
        (Some(x0), Some(x1), Some(y0), Some(y1)) => {
            let b = Rect::new(x0, x1, y0, y1)?.expand(1.0 / 360.0);
            Rect::new(
                b.min_x.max(0.0),
                b.max_x.min(1.0),
                b.min_y.max(0.0),
                b.max_y.min(1.0),
            )?
        },
        _ => Rect::new(0.0, 1.0, 0.0, 1.0)?,
    };
    let prj_path = input.with_extension("prj");
    let prj_before = fs::metadata(&prj_path).context("陸域Shapefileと同名の.prjが必要です")?;
    ensure!(
        prj_before.len() <= 64 * 1024,
        "陸域の座標参照系ファイルが大きすぎます"
    );
    let prj = fs::read_to_string(&prj_path)?;
    validate_prj(&prj)?;
    let mut reader = BufReader::new(File::open(input)?);
    let mut header = [0; 100];
    reader.read_exact(&mut header)?;
    ensure!(
        be32(&header) == 9994 && le32(&header[28..]) == 1000 && le32(&header[32..]) == 5,
        "陸域入力は2次元Polygon Shapefileを指定してください"
    );
    let declared = u64::from(be32(&header[24..])) * 2;
    ensure!(
        declared == before.len() && declared >= 100,
        "Shapefileの宣言サイズが実ファイルと一致しません"
    );
    let mut hash = Sha256::new();
    hash.update(b"geocode-landmask-shp-wgs84-v1");
    hash.update((prj.len() as u64).to_le_bytes());
    hash.update(prj.as_bytes());
    hash.update(header);
    for n in [
        coverage.min_x,
        coverage.max_x,
        coverage.min_y,
        coverage.max_y,
    ] {
        hash.update(n.to_le_bytes());
    }
    let mut batch = super::elevation::WriteBatch::new(connection)?;
    let mut position = 100_u64;
    let mut records = 0_u64;
    let mut features = 0_u64;
    let mut points_count = 0_u64;
    let mut skipped = 0_u64;
    while position < declared {
        context.check()?;
        ensure!(
            position + 8 <= declared,
            "Shapefileの末尾レコードが途中です"
        );
        let mut h = [0; 8];
        reader.read_exact(&mut h)?;
        hash.update(h);
        position += 8;
        let record = be32(&h);
        let size = (be32(&h[4..]) as usize)
            .checked_mul(2)
            .context("Shapefileレコードサイズが溢れました")?;
        ensure!(
            (4..=MAX_RECORD).contains(&size) && position + size as u64 <= declared,
            "陸域レコードのサイズが不正または上限超過です。分割版の陸域データを指定してください"
        );
        records += 1;
        ensure!(
            u64::from(record) == records,
            "Shapefileのレコード番号が連続していません"
        );
        let mut data = vec![0; size];
        reader.read_exact(&mut data)?;
        hash.update(&data);
        position += size as u64;
        if le32(&data) == 0 {
            ensure!(size == 4, "Null Shapeの長さが不正です");
            continue;
        }
        ensure!(
            size >= 44 && le32(&data) == 5,
            "陸域レコードがPolygonではありません"
        );
        let n_parts = le32(&data[36..]) as usize;
        let n_points = le32(&data[40..]) as usize;
        ensure!(
            (1..=16384).contains(&n_parts) && (4..=MAX_POINTS).contains(&n_points),
            "陸域の輪郭数・点数が上限を超えました。分割版を指定してください"
        );
        let start = 44 + n_parts * 4;
        ensure!(
            start + n_points * 16 == size,
            "陸域レコードの点配列サイズが一致しません"
        );
        let f64_at = |at: usize| f64::from_le_bytes(data[at..at + 8].try_into().unwrap());
        let (west, south, east, north) = (f64_at(4), f64_at(12), f64_at(20), f64_at(28));
        ensure!(
            [west, south, east, north].iter().all(|v| v.is_finite())
                && west <= east
                && south <= north
                && west >= -180.0
                && east <= 180.0
                && south >= -90.0
                && north <= 90.0,
            "陸域レコードの外接範囲が不正です"
        );
        let nw = project(west, north)?;
        let se = project(east, south)?;
        let record_bounds = Rect::new(nw.x, se.x, nw.y, se.y)?;
        // 表示範囲外でも座標と宣言bboxの整合は検査し、誤った海域判定を防ぐ。
        for i in 0..n_points {
            if i.is_multiple_of(4096) {
                context.check()?;
            }
            let lon = f64_at(start + i * 16);
            let lat = f64_at(start + i * 16 + 8);
            ensure!(
                lon.is_finite()
                    && lat.is_finite()
                    && lon >= west - 1e-9
                    && lon <= east + 1e-9
                    && lat >= south - 1e-9
                    && lat <= north + 1e-9,
                "陸域の座標が宣言外接範囲と一致しません"
            );
        }
        if !record_bounds.intersects(coverage) {
            skipped += 1;
            continue;
        }
        let mut offsets = (0..n_parts)
            .map(|i| le32(&data[44 + i * 4..]) as usize)
            .collect::<Vec<_>>();
        ensure!(
            offsets[0] == 0
                && offsets.windows(2).all(|w| w[0] < w[1])
                && offsets.last().is_some_and(|&v| v < n_points),
            "陸域輪郭の始点索引が不正です"
        );
        offsets.push(n_points);
        let mut rings = Vec::with_capacity(n_parts);
        for bounds in offsets.windows(2) {
            context.check()?;
            ensure!(bounds[1] - bounds[0] >= 4, "陸域輪郭の点数が不足しています");
            let mut ring = Vec::with_capacity(bounds[1] - bounds[0]);
            for i in bounds[0]..bounds[1] {
                if i.is_multiple_of(4096) {
                    context.check()?;
                }
                let p = &data[start + i * 16..];
                let lon = f64::from_le_bytes(p[..8].try_into()?);
                let lat = f64::from_le_bytes(p[8..16].try_into()?);
                ring.push(project(lon, lat)?);
            }
            ensure!(ring.first() == ring.last(), "陸域輪郭が閉じていません");
            rings.push(ring);
        }
        let parts = areas::polygon_from_rings(rings, context)
            .with_context(|| format!("陸域レコード{record}の形状が不正です"))?;
        store::insert_feature_with_context(
            connection,
            &Feature {
                osm_type: 3,
                osm_id: i64::from(record),
                role: 0,
                kind: FeatureKind::Land,
                geometry: Geometry::Polygon(parts),
                layer: 0,
                structure: 1,
            },
            context,
        )?;
        batch.record(n_points.saturating_mul(16 * 15))?;
        features += 1;
        points_count += n_points as u64;
    }
    context.check()?;
    let after = fs::metadata(input)?;
    let prj_after = fs::metadata(&prj_path)?;
    ensure!(
        before.len() == after.len()
            && before.modified()? == after.modified()?
            && prj_before.len() == prj_after.len()
            && prj_before.modified()? == prj_after.modified()?
            && fs::read_to_string(&prj_path)? == prj,
        "陸域入力が取り込み中に変更されました"
    );
    ensure!(features > 0, "陸域Shapefileに有効な面がありません");
    batch.finish()?;
    Ok(SourceInfo {
        kind: "landmask".into(),
        sha256: format!("{:x}", hash.finalize()),
        bytes: before.len() + prj_before.len(),
        details: json!({"revision":1,"format":"shapefile-polygon-2d","crs":"WGS84 geographic degrees","features":features,"points":points_count,"skipped_records":skipped,"coverage":coverage}),
    })
}
fn le32(v: &[u8]) -> u32 {
    u32::from_le_bytes(v[..4].try_into().unwrap())
}
fn be32(v: &[u8]) -> u32 {
    u32::from_be_bytes(v[..4].try_into().unwrap())
}

/// 初期対応は公開陸域データのWKT1・WGS84経緯度に限定する。
fn validate_prj(prj: &str) -> Result<()> {
    let wkt = prj
        .to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    ensure!(
        wkt.starts_with("GEOGCS[")
            && wkt.ends_with(']')
            && !wkt.contains("PROJCS[")
            && !wkt.contains("VERT_CS[")
            && !wkt.contains("COMPD_CS["),
        "陸域入力はWKT1のWGS84経緯度Shapefileだけに対応しています"
    );
    ensure!(
        wkt.contains("DATUM[\"D_WGS_1984\"")
            || wkt.contains("DATUM[\"WGS_1984\"")
            || wkt.contains("DATUM[\"WGS84\"")
            || wkt.contains("DATUM[\"WORLD_GEODETIC_SYSTEM_1984\""),
        "陸域の測地系はWGS84を指定してください"
    );
    let parameters = |name: &str, count: usize| -> Result<Vec<String>> {
        let key = format!("{name}[");
        let mut positions = wkt.match_indices(&key);
        let (position, _) = positions
            .next()
            .with_context(|| format!("陸域の{name}指定がありません"))?;
        ensure!(
            positions.next().is_none(),
            "陸域の座標系指定が重複しています"
        );
        let rest = &wkt[position + key.len()..];
        let end = rest.find(']').context("陸域のWKTが途中で終了しています")?;
        let values = rest[..end]
            .split(',')
            .take(count)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        ensure!(
            values.len() == count,
            "陸域の座標系パラメータが不足しています"
        );
        Ok(values)
    };
    let spheroid = parameters("SPHEROID", 3)?;
    let semi_major: f64 = spheroid[1].parse()?;
    let inverse_flattening: f64 = spheroid[2].parse()?;
    ensure!(
        (semi_major - 6378137.0).abs() < 1e-6 && (inverse_flattening - 298.257223563).abs() < 1e-9,
        "陸域の楕円体がWGS84ではありません"
    );
    let prime = parameters("PRIMEM", 2)?;
    let meridian: f64 = prime[1].parse()?;
    ensure!(
        meridian.abs() < 1e-12,
        "陸域の本初子午線はGreenwich 0度を指定してください"
    );
    let unit = parameters("UNIT", 2)?;
    let factor: f64 = unit[1].parse()?;
    ensure!(
        unit[0] == "\"DEGREE\"" && (factor - std::f64::consts::PI / 180.0).abs() < 1e-14,
        "陸域座標の単位がdegreeではありません"
    );
    if wkt.contains("TOWGS84[") {
        for value in parameters("TOWGS84", 7)? {
            let value: f64 = value.parse()?;
            ensure!(
                value.abs() < 1e-12,
                "陸域の非ゼロ測地変換には対応していません"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tilegen::standard::store;
    const PRJ: &str = "GEOGCS[\"GCS_WGS_1984\",DATUM[\"D_WGS_1984\",SPHEROID[\"WGS_1984\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"Degree\",0.0174532925199433]]";
    fn shape() -> Vec<u8> {
        let points = [
            (139_f64, 35_f64),
            (139.1, 35.0),
            (139.1, 35.1),
            (139.0, 35.1),
            (139.0, 35.0),
        ];
        let record_size = 44 + 4 + points.len() * 16;
        let mut out = vec![0; 100];
        out[..4].copy_from_slice(&9994_u32.to_be_bytes());
        out[24..28].copy_from_slice(&(((108 + record_size) / 2) as u32).to_be_bytes());
        out[28..32].copy_from_slice(&1000_u32.to_le_bytes());
        out[32..36].copy_from_slice(&5_u32.to_le_bytes());
        out.extend_from_slice(&1_u32.to_be_bytes());
        out.extend_from_slice(&((record_size / 2) as u32).to_be_bytes());
        out.extend_from_slice(&5_u32.to_le_bytes());
        for n in [139_f64, 35.0, 139.1, 35.1] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        out.extend_from_slice(&1_u32.to_le_bytes());
        out.extend_from_slice(&(points.len() as u32).to_le_bytes());
        out.extend_from_slice(&0_u32.to_le_bytes());
        for (x, y) in points {
            out.extend_from_slice(&x.to_le_bytes());
            out.extend_from_slice(&y.to_le_bytes());
        }
        out
    }
    #[test]
    fn 陸域Polygonを本体内で読み入力位置に依存しない() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("land.shp");
        fs::write(&path, shape()).unwrap();
        fs::write(path.with_extension("prj"), PRJ).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        store::initialize(&connection).unwrap();
        let source = import_into(&connection, &path, &OperationContext::default()).unwrap();
        assert_eq!(source.kind, "landmask");
        assert_eq!(source.details["features"], 1);
        assert_eq!(source.sha256.len(), 64);
    }
    #[test]
    fn 投影座標の陸域と壊れたレコードを拒否する() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("land.shp");
        fs::write(&path, shape()).unwrap();
        fs::write(
            path.with_extension("prj"),
            "PROJCS[\"WGS 84\",UNIT[\"Degree\",1]]",
        )
        .unwrap();
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        assert!(import_into(&conn, &path, &OperationContext::default()).is_err());
        fs::write(path.with_extension("prj"), PRJ).unwrap();
        let mut bytes = shape();
        bytes.truncate(120);
        fs::write(&path, bytes).unwrap();
        assert!(import_into(&conn, &path, &OperationContext::default()).is_err());
    }
    #[test]
    fn 度単位係数と本初子午線と楕円体の偽装を拒否する() {
        assert!(validate_prj(PRJ).is_ok());
        for bad in [
            PRJ.replace("0.0174532925199433", "1"),
            PRJ.replace("Greenwich\",0", "Greenwich\",2"),
            PRJ.replace("6378137", "6370000"),
            PRJ.replace("D_WGS_1984", "D_Tokyo"),
        ] {
            assert!(validate_prj(&bad).is_err());
        }
    }
}
