//! 名称候補の選別、代表位置、上限付きの完成DB格納。

use super::model::{Geometry, LabelMetadata, PolygonPart};
use crate::tilegen::{
    geometry::{Point, Rect},
    operation::OperationContext,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const EXTRACTION_REVISION: &str = "places-landmarks-selected-tags-anchor-v1";
const NAME_KEYS: [&str; 5] = ["name", "name:ja", "name:en", "int_name", "short_name"];
const MAX_NAME_BYTES: usize = 512;
const MAX_NAMES_BYTES: usize = 2048;
const MAX_QUERY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_QUERY_LABELS: usize = 100_000;
const ATTRIBUTE_KEYS: [&str; 16] = [
    "highway", "service", "surface", "access", "oneway", "ref", "layer", "bridge", "tunnel",
    "railway", "waterway", "water", "landuse", "natural", "leisure", "building",
];
pub(crate) const CATEGORIES: [&str; 24] = [
    "place.city",
    "place.town",
    "place.village",
    "place.hamlet",
    "place.suburb",
    "place.quarter",
    "place.neighbourhood",
    "place.isolated_dwelling",
    "place.locality",
    "place.administrative",
    "natural.island",
    "natural.peak",
    "natural.volcano",
    "natural.saddle",
    "water.lake",
    "water.river",
    "landmark.station",
    "landmark.airport",
    "landmark.townhall",
    "landmark.education",
    "landmark.hospital",
    "landmark.park",
    "landmark.tourism",
    "landmark.historic",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LabelCandidate {
    pub osm_type: i64,
    pub osm_id: i64,
    pub category: String,
    pub names: BTreeMap<String, String>,
    pub anchor: Point,
    pub importance: i64,
    pub population: Option<u64>,
    pub admin_level: Option<u8>,
    pub capital: bool,
}

pub fn category(tags: &BTreeMap<String, String>) -> Option<&'static str> {
    let get = |key: &str| tags.get(key).map(String::as_str).unwrap_or("");
    match get("place") {
        "city" => return Some("place.city"),
        "town" => return Some("place.town"),
        "village" => return Some("place.village"),
        "hamlet" => return Some("place.hamlet"),
        "suburb" => return Some("place.suburb"),
        "quarter" => return Some("place.quarter"),
        "neighbourhood" => return Some("place.neighbourhood"),
        "isolated_dwelling" => return Some("place.isolated_dwelling"),
        "locality" => return Some("place.locality"),
        "island" | "islet" | "archipelago" => return Some("natural.island"),
        _ => (),
    }
    match get("natural") {
        "peak" => return Some("natural.peak"),
        "volcano" => return Some("natural.volcano"),
        "saddle" => return Some("natural.saddle"),
        "water" => return Some("water.lake"),
        _ => (),
    }
    if matches!(get("waterway"), "river" | "canal") {
        return Some("water.river");
    }
    if get("railway") == "station" {
        return Some("landmark.station");
    }
    if get("aeroway") == "aerodrome" {
        return Some("landmark.airport");
    }
    match get("amenity") {
        "townhall" => return Some("landmark.townhall"),
        "school" | "college" | "university" => return Some("landmark.education"),
        "hospital" => return Some("landmark.hospital"),
        _ => (),
    }
    if matches!(get("leisure"), "park" | "garden") {
        return Some("landmark.park");
    }
    if matches!(
        get("tourism"),
        "museum" | "attraction" | "zoo" | "theme_park"
    ) {
        return Some("landmark.tourism");
    }
    if matches!(get("historic"), "castle" | "ruins" | "archaeological_site") {
        return Some("landmark.historic");
    }
    if get("boundary") == "administrative"
        && get("admin_level")
            .parse::<u8>()
            .is_ok_and(|n| (2..=10).contains(&n))
    {
        return Some("place.administrative");
    }
    None
}

/// 名称がない対象を、形状解決のためだけに大量選択しない。
pub fn selected(tags: &BTreeMap<String, String>) -> bool {
    category(tags).is_some()
        && NAME_KEYS
            .iter()
            .any(|key| tags.get(*key).is_some_and(|name| !name.trim().is_empty()))
}

pub fn candidate(
    tags: &BTreeMap<String, String>,
    osm_type: i64,
    osm_id: i64,
    anchor: Point,
) -> std::result::Result<Option<LabelCandidate>, &'static str> {
    let Some(category) = category(tags) else {
        return Ok(None);
    };
    let mut names = BTreeMap::new();
    let mut bytes = 0;
    for key in NAME_KEYS {
        if let Some(name) = tags.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if name.len() > MAX_NAME_BYTES {
                return Err("invalid-name");
            }
            let normalized = name
                .chars()
                .map(|c| {
                    if matches!(c, '\r' | '\n' | '\t') {
                        ' '
                    } else {
                        c
                    }
                })
                .collect::<String>();
            let name = normalized.trim();
            if name.len() > MAX_NAME_BYTES || name.chars().any(|c| c.is_control()) {
                return Err("invalid-name");
            }
            bytes += name.len();
            if bytes > MAX_NAMES_BYTES {
                return Err("names-too-long");
            }
            names.insert(key.to_owned(), name.to_owned());
        }
    }
    if names.is_empty() {
        return Ok(None);
    }
    let population = tags
        .get("population")
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&p| p <= 2_000_000_000);
    let admin_level = tags
        .get("admin_level")
        .and_then(|s| s.parse::<u8>().ok())
        .filter(|&n| (2..=12).contains(&n));
    let capital = tags
        .get("capital")
        .is_some_and(|s| !s.is_empty() && s != "no");
    let rank = match category {
        "place.city" => 900,
        "place.town" => 800,
        "place.administrative" => 750,
        "place.village" => 700,
        "place.suburb" => 650,
        "place.quarter" => 600,
        "place.hamlet" => 550,
        "place.neighbourhood" => 500,
        "natural.island" => 700,
        "natural.peak" | "natural.volcano" => 650,
        "water.river" | "water.lake" => 600,
        "landmark.station" | "landmark.airport" => 650,
        _ => 400,
    };
    Ok(Some(LabelCandidate {
        osm_type,
        osm_id,
        category: category.into(),
        names,
        anchor,
        importance: rank * 1_000_000
            + population.unwrap_or(0).min(999_999) as i64
            + if capital { 100_000_000 } else { 0 },
        population,
        admin_level,
        capital,
    }))
}

pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE map_labels(id INTEGER PRIMARY KEY,osm_type INTEGER NOT NULL,osm_id INTEGER NOT NULL,category TEXT NOT NULL,names TEXT NOT NULL,x REAL NOT NULL,y REAL NOT NULL,importance INTEGER NOT NULL,population INTEGER,admin_level INTEGER,capital INTEGER NOT NULL,UNIQUE(osm_type,osm_id,category));
        CREATE VIRTUAL TABLE map_label_rtree USING rtree(id,min_x,max_x,min_y,max_y);
        CREATE INDEX map_labels_source ON map_labels(osm_type,osm_id);
        CREATE TABLE map_label_members(relation_id INTEGER NOT NULL,way_id INTEGER NOT NULL,PRIMARY KEY(relation_id,way_id)) WITHOUT ROWID;
        CREATE TABLE map_feature_attributes(osm_type INTEGER NOT NULL,osm_id INTEGER NOT NULL,attributes TEXT NOT NULL,PRIMARY KEY(osm_type,osm_id)) WITHOUT ROWID;")?;
    Ok(())
}

pub fn insert(conn: &Connection, label: &LabelCandidate) -> Result<()> {
    validate(label)?;
    conn.execute("INSERT INTO map_labels(osm_type,osm_id,category,names,x,y,importance,population,admin_level,capital) VALUES(?,?,?,?,?,?,?,?,?,?)", params![label.osm_type,label.osm_id,label.category,serde_json::to_string(&label.names)?,label.anchor.x,label.anchor.y,label.importance,label.population,label.admin_level,label.capital])?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO map_label_rtree VALUES(?,?,?,?,?)",
        params![
            id,
            label.anchor.x,
            label.anchor.x,
            label.anchor.y,
            label.anchor.y
        ],
    )?;
    Ok(())
}

pub fn save_attributes(
    conn: &Connection,
    osm_type: i64,
    osm_id: i64,
    tags: &BTreeMap<String, String>,
) -> Result<()> {
    let attributes = tags
        .iter()
        .filter(|(key, value)| ATTRIBUTE_KEYS.contains(&key.as_str()) && value.len() <= 256)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<BTreeMap<_, _>>();
    conn.execute(
        "INSERT OR REPLACE INTO map_feature_attributes VALUES(?,?,?)",
        params![osm_type, osm_id, serde_json::to_string(&attributes)?],
    )?;
    Ok(())
}

pub fn relation_member(conn: &Connection, relation_id: i64, way_id: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO map_label_members VALUES(?,?)",
        params![relation_id, way_id],
    )?;
    Ok(())
}

pub fn attributes(
    conn: &Connection,
    osm_type: i64,
    osm_id: i64,
) -> Result<BTreeMap<String, String>> {
    use rusqlite::OptionalExtension;
    let text: Option<String> = conn.query_row("SELECT attributes FROM map_feature_attributes WHERE osm_type=? AND osm_id=? AND length(CAST(attributes AS BLOB))<=8192",params![osm_type,osm_id],|r|r.get(0)).optional()?;
    text.map(|s| serde_json::from_str(&s).context("詳細属性の形式が不正です"))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn validate(label: &LabelCandidate) -> Result<()> {
    ensure!(
        (0..=2).contains(&label.osm_type)
            && label.osm_id != 0
            && CATEGORIES.contains(&label.category.as_str())
            && !label.names.is_empty()
            && label.names.len() <= 5,
        "名称候補の元地物・分類が不正です"
    );
    ensure!(
        (0..=1_100_000_000).contains(&label.importance)
            && label.population.is_none_or(|p| p <= 2_000_000_000)
            && label.admin_level.is_none_or(|n| (2..=12).contains(&n)),
        "名称候補の重要度が不正です"
    );
    ensure!(
        label
            .names
            .iter()
            .all(|(k, v)| NAME_KEYS.contains(&k.as_str())
                && !v.is_empty()
                && v.len() <= MAX_NAME_BYTES
                && !v.chars().any(|c| c.is_control()))
            && label.names.values().map(String::len).sum::<usize>() <= MAX_NAMES_BYTES,
        "名称候補の文字列が不正です"
    );
    ensure!(
        label.anchor.x.is_finite()
            && label.anchor.y.is_finite()
            && (0.0..=1.0).contains(&label.anchor.x)
            && (0.0..=1.0).contains(&label.anchor.y),
        "名称候補の位置が不正です"
    );
    Ok(())
}

pub fn query_labels(conn: &Connection, bounds: Rect) -> Result<Vec<LabelCandidate>> {
    query_labels_inner(conn, bounds, None)
}

/// 描画しない分類をSQL側で除外し、その取得量を表示対象の上限へ含めない。
pub fn query_labels_for_categories(
    conn: &Connection,
    bounds: Rect,
    categories: &[&str],
) -> Result<Vec<LabelCandidate>> {
    ensure!(
        categories.len() <= CATEGORIES.len()
            && categories
                .iter()
                .all(|category| CATEGORIES.contains(category)),
        "名称の照会分類が不正です"
    );
    if categories.is_empty() {
        return Ok(Vec::new());
    }
    query_labels_inner(conn, bounds, Some(categories))
}

fn query_labels_inner(
    conn: &Connection,
    bounds: Rect,
    categories: Option<&[&str]>,
) -> Result<Vec<LabelCandidate>> {
    let mut sql = String::from(
        "SELECT l.osm_type,l.osm_id,l.category,l.names,l.x,l.y,l.importance,l.population,l.admin_level,l.capital,length(CAST(l.names AS BLOB)),length(CAST(l.category AS BLOB)) FROM map_label_rtree r JOIN map_labels l ON l.id=r.id WHERE r.min_x<=? AND r.max_x>=? AND r.min_y<=? AND r.max_y>=?",
    );
    let mut values: Vec<rusqlite::types::Value> = vec![
        bounds.max_x.into(),
        bounds.min_x.into(),
        bounds.max_y.into(),
        bounds.min_y.into(),
    ];
    if let Some(categories) = categories {
        let placeholders = vec!["?"; categories.len()].join(",");
        sql.push_str(&format!(" AND l.category IN ({placeholders})"));
        values.extend(
            categories
                .iter()
                .map(|category| rusqlite::types::Value::Text((*category).to_owned())),
        );
    }
    sql.push_str(" ORDER BY l.importance DESC,l.osm_type,l.osm_id,l.category");
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(values))?;
    let mut result = Vec::new();
    let mut bytes = 0;
    while let Some(row) = rows.next()? {
        ensure!(
            (1..=4096).contains(&row.get::<_, i64>(10)?)
                && (1..=64).contains(&row.get::<_, i64>(11)?),
            "保存名称の文字列が過大です"
        );
        let names: String = row.get(3)?;
        bytes += names.len() + std::mem::size_of::<LabelCandidate>();
        ensure!(
            names.len() <= 4096 && bytes <= MAX_QUERY_BYTES && result.len() < MAX_QUERY_LABELS,
            "名称候補の取得量が上限を超えました"
        );
        let label = LabelCandidate {
            osm_type: row.get(0)?,
            osm_id: row.get(1)?,
            category: row.get(2)?,
            names: serde_json::from_str(&names)?,
            anchor: Point {
                x: row.get(4)?,
                y: row.get(5)?,
            },
            importance: row.get(6)?,
            population: row.get(7)?,
            admin_level: row.get(8)?,
            capital: row.get(9)?,
        };
        validate(&label)?;
        result.push(label);
    }
    Ok(result)
}

pub fn summary(conn: &Connection, skipped: BTreeMap<String, u64>) -> Result<LabelMetadata> {
    let mut categories = BTreeMap::new();
    let mut statement = conn
        .prepare("SELECT category,count(*) FROM map_labels GROUP BY category ORDER BY category")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        categories.insert(row.get(0)?, row.get(1)?);
    }
    Ok(LabelMetadata {
        revision: 1,
        count: categories.values().sum(),
        categories,
        skipped,
    })
}

/// 同名でも離れた地物は残し、同じ場所を表すNode・面・行政代表点だけを整理する。
pub fn deduplicate(conn: &Connection, context: &OperationContext) -> Result<u64> {
    let before: u64 = conn.query_row("SELECT count(*) FROM map_labels", [], |row| row.get(0))?;
    // Relationとそのmember Wayは、代表位置が離れていても同じ名称なら一方へまとめる。
    // JSON内の優先名を比較し、同名の無関係なWayには適用しない。
    conn.execute_batch("CREATE TEMP TABLE relation_duplicate_label_ids AS SELECT w.id FROM map_labels w JOIN map_label_members m ON w.osm_type=1 AND w.osm_id=m.way_id JOIN map_labels r ON r.osm_type=2 AND r.osm_id=m.relation_id WHERE w.category=r.category AND coalesce(json_extract(w.names,'$.\"name:ja\"'),json_extract(w.names,'$.name'),json_extract(w.names,'$.int_name'),json_extract(w.names,'$.\"name:en\"'),json_extract(w.names,'$.short_name'))=coalesce(json_extract(r.names,'$.\"name:ja\"'),json_extract(r.names,'$.name'),json_extract(r.names,'$.int_name'),json_extract(r.names,'$.\"name:en\"'),json_extract(r.names,'$.short_name')); DELETE FROM map_label_rtree WHERE id IN(SELECT id FROM relation_duplicate_label_ids); DELETE FROM map_labels WHERE id IN(SELECT id FROM relation_duplicate_label_ids); DROP TABLE relation_duplicate_label_ids;")?;
    let mut statement=conn.prepare("SELECT id,category,names,x,y,importance,osm_type,osm_id FROM map_labels ORDER BY importance DESC,osm_type,osm_id,category")?;
    let mut rows = statement.query([])?;
    // 全国の候補を保持せず、採用済み候補を一時表の固定位置セルで検索する。
    conn.execute_batch("CREATE TEMP TABLE accepted_label_names(id INTEGER PRIMARY KEY,name TEXT,group_name TEXT,cx INTEGER,cy INTEGER,x REAL,y REAL); CREATE INDEX accepted_label_names_position ON accepted_label_names(name,group_name,cx,cy); CREATE TEMP TABLE duplicate_label_ids(id INTEGER PRIMARY KEY);")?;
    while let Some(row) = rows.next()? {
        context.check()?;
        let id: i64 = row.get(0)?;
        let category: String = row.get(1)?;
        let names: BTreeMap<String, String> = serde_json::from_str(&row.get::<_, String>(2)?)?;
        let name = names
            .get("name:ja")
            .or_else(|| names.get("name"))
            .or_else(|| names.get("int_name"))
            .or_else(|| names.get("name:en"))
            .or_else(|| names.get("short_name"))
            .context("名称がありません")?;
        let group = if category.starts_with("place.") {
            "place"
        } else {
            &category
        };
        let x: f64 = row.get(3)?;
        let y: f64 = row.get(4)?;
        let radius = 0.000002;
        let cx = (x / radius).floor() as i64;
        let cy = (y / radius).floor() as i64;
        let duplicate:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM accepted_label_names WHERE name=? AND group_name=? AND cx BETWEEN ? AND ? AND cy BETWEEN ? AND ? AND (x-?)*(x-?)+(y-?)*(y-?)<=?)",params![name,group,cx-1,cx+1,cy-1,cy+1,x,x,y,y,radius*radius],|r|r.get(0))?;
        if duplicate {
            conn.execute("INSERT INTO duplicate_label_ids VALUES(?)", [id])?;
        } else {
            conn.execute(
                "INSERT INTO accepted_label_names VALUES(?,?,?,?,?,?,?)",
                params![id, name, group, cx, cy, x, y],
            )?;
        }
    }
    drop(rows);
    drop(statement);
    conn.execute_batch("DELETE FROM map_label_rtree WHERE id IN(SELECT id FROM duplicate_label_ids); DELETE FROM map_labels WHERE id IN(SELECT id FROM duplicate_label_ids); DROP TABLE accepted_label_names; DROP TABLE duplicate_label_ids;")?;
    let after: u64 = conn.query_row("SELECT count(*) FROM map_labels", [], |row| row.get(0))?;
    Ok(before - after)
}

pub fn validate_stored(conn: &Connection, expected: &LabelMetadata) -> Result<()> {
    ensure!(
        summary(conn, expected.skipped.clone())? == *expected,
        "名称候補の集計が一致しません"
    );
    let check: String = conn.query_row("SELECT rtreecheck('map_label_rtree')", [], |r| r.get(0))?;
    ensure!(check == "ok", "名称候補の空間索引が不正です");
    let bad: bool = conn.query_row("SELECT (SELECT count(*) FROM map_labels)<>(SELECT count(*) FROM map_label_rtree) OR EXISTS(SELECT 1 FROM map_labels l LEFT JOIN map_label_rtree r ON r.id=l.id WHERE r.id IS NULL OR r.min_x>l.x OR r.max_x<l.x OR r.min_y>l.y OR r.max_y<l.y)",[],|r|r.get(0))?;
    ensure!(!bad, "名称候補と空間索引が一致しません");
    // 全体を一括ロードせず、1候補ずつ保存値の検証を行う。
    let mut statement=conn.prepare("SELECT osm_type,osm_id,category,names,x,y,importance,population,admin_level,capital,length(CAST(names AS BLOB)),length(CAST(category AS BLOB)) FROM map_labels ORDER BY id")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        ensure!(
            (1..=4096).contains(&row.get::<_, i64>(10)?)
                && (1..=64).contains(&row.get::<_, i64>(11)?),
            "保存名称の文字列が過大です"
        );
        let names: String = row.get(3)?;
        ensure!(names.len() <= 4096, "保存名称が上限を超えました");
        validate(&LabelCandidate {
            osm_type: row.get(0)?,
            osm_id: row.get(1)?,
            category: row.get(2)?,
            names: serde_json::from_str(&names)?,
            anchor: Point {
                x: row.get(4)?,
                y: row.get(5)?,
            },
            importance: row.get(6)?,
            population: row.get(7)?,
            admin_level: row.get(8)?,
            capital: row.get(9)?,
        })?;
    }
    drop(rows);
    drop(statement);
    let mut statement=conn.prepare("SELECT osm_type,osm_id,length(CAST(attributes AS BLOB)),attributes FROM map_feature_attributes ORDER BY osm_type,osm_id")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        ensure!(
            (0..=2).contains(&row.get::<_, i64>(0)?)
                && row.get::<_, i64>(1)? != 0
                && (2..=8192).contains(&row.get::<_, i64>(2)?),
            "詳細属性の元地物・保存量が不正です"
        );
        let attributes: BTreeMap<String, String> = serde_json::from_str(&row.get::<_, String>(3)?)?;
        ensure!(
            attributes.len() <= 16
                && attributes.iter().all(
                    |(key, value)| ATTRIBUTE_KEYS.contains(&key.as_str()) && value.len() <= 256
                ),
            "詳細属性の項目・値が不正です"
        );
    }
    Ok(())
}

pub fn line_anchor(points: &[Point]) -> Option<Point> {
    let total: f64 = points
        .windows(2)
        .map(|p| libm::hypot(p[1].x - p[0].x, p[1].y - p[0].y))
        .sum();
    if total <= 0.0 {
        return points.first().copied();
    }
    let mut remaining = total * 0.5;
    for pair in points.windows(2) {
        let length = libm::hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
        if length > 0.0 && remaining <= length {
            let t = remaining / length;
            return Some(Point {
                x: pair[0].x + (pair[1].x - pair[0].x) * t,
                y: pair[0].y + (pair[1].y - pair[0].y) * t,
            });
        }
        remaining -= length;
    }
    points.last().copied()
}

#[cfg(test)]
fn in_ring(point: Point, ring: &[Point]) -> bool {
    let mut inside = false;
    for pair in ring.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if (a.y > point.y) != (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
        {
            inside = !inside;
        }
    }
    inside
}
#[cfg(test)]
fn in_part(point: Point, part: &PolygonPart) -> bool {
    in_ring(point, &part.outer) && !part.holes.iter().any(|h| in_ring(point, h))
}

pub fn polygon_anchor(parts: &[PolygonPart], context: &OperationContext) -> Result<Option<Point>> {
    let mut best = None;
    let mut best_width = 0.0;
    for part in parts {
        context.check()?;
        let bounds = Rect::from_points(&part.outer)?;
        for row in 0..9 {
            let y = bounds.min_y + (bounds.max_y - bounds.min_y) * (row as f64 + 0.5) / 9.0;
            let mut crossings = Vec::new();
            for ring in std::iter::once(&part.outer).chain(part.holes.iter()) {
                for (i, pair) in ring.windows(2).enumerate() {
                    if i.is_multiple_of(4096) {
                        context.check()?;
                    }
                    let (a, b) = (pair[0], pair[1]);
                    if (a.y > y) != (b.y > y) {
                        crossings.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
                    }
                }
            }
            crossings.sort_by(f64::total_cmp);
            for pair in crossings.chunks_exact(2) {
                let point = Point {
                    x: (pair[0] + pair[1]) * 0.5,
                    y,
                };
                let width = pair[1] - pair[0];
                if width > best_width {
                    best = Some(point);
                    best_width = width;
                }
            }
        }
    }
    Ok(best)
}

pub fn geometry_anchor(geometry: &Geometry, context: &OperationContext) -> Result<Option<Point>> {
    match geometry {
        Geometry::Line(p) => Ok(line_anchor(p)),
        Geometry::Polygon(p) => polygon_anchor(p, context),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 関係memberの重複だけを除き離れた同名施設を保持する() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let tags = BTreeMap::from([
            ("name".into(), "中央公園".into()),
            ("leisure".into(), "park".into()),
        ]);
        for (osm_type, osm_id, x) in [(2, 50, 0.2), (1, 10, 0.5), (1, 11, 0.9)] {
            insert(
                &conn,
                &candidate(&tags, osm_type, osm_id, Point { x, y: 0.5 })
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
        }
        relation_member(&conn, 50, 10).unwrap();
        assert_eq!(deduplicate(&conn, &OperationContext::default()).unwrap(), 1);
        let labels = query_labels(&conn, Rect::new(0.0, 1.0, 0.0, 1.0).unwrap()).unwrap();
        assert_eq!(labels.len(), 2);
        assert!(labels.iter().all(|label| label.osm_id != 10));
    }
    #[test]
    fn 穴のある面の代表点は面の内側に置く() {
        let ring = |a: f64, b: f64| {
            vec![
                Point { x: a, y: a },
                Point { x: b, y: a },
                Point { x: b, y: b },
                Point { x: a, y: b },
                Point { x: a, y: a },
            ]
        };
        let part = PolygonPart {
            outer: ring(0.1, 0.9),
            holes: vec![ring(0.2, 0.8)],
        };
        let point = polygon_anchor(std::slice::from_ref(&part), &OperationContext::default())
            .unwrap()
            .unwrap();
        assert!(in_part(point, &part));
    }
    #[test]
    fn 独立地名を往復し同名別地点を統合しない() {
        let c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        let tags = BTreeMap::from([
            ("name".into(), "中央町".into()),
            ("name:ja".into(), "中央町".into()),
            ("place".into(), "quarter".into()),
        ]);
        for id in [1, 2] {
            insert(
                &c,
                &candidate(
                    &tags,
                    0,
                    id,
                    Point {
                        x: id as f64 * 0.1,
                        y: 0.2,
                    },
                )
                .unwrap()
                .unwrap(),
            )
            .unwrap();
        }
        let summary = summary(&c, BTreeMap::new()).unwrap();
        assert_eq!(summary.count, 2);
        validate_stored(&c, &summary).unwrap();
        assert_eq!(
            query_labels(&c, Rect::new(0.0, 1.0, 0.0, 1.0).unwrap())
                .unwrap()
                .len(),
            2
        );
    }
}
