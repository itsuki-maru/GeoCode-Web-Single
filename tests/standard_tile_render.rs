//! 標準地図の人工入力による固定画像、移設、境界、容量・時間の検証。
//! 新規の基準画像は初期実装のレビュー用であり、旧道路35画像の代替にはしない。

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use geocode_web_single::tilegen::{
    cancel::CancellationToken,
    dataset::Dataset,
    geometry::Point,
    metrics,
    operation::OperationContext,
    standard::{
        self,
        model::{Feature, FeatureKind, Geometry, PolygonPart, SourceInfo, StandardMetadata},
    },
    store::{Store, StoreMetadata},
    style::{RoadAttributes, RoadClass},
    tile::TileId,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ROOT: &str = "tests/fixtures/standard-render-golden";

#[derive(Clone, Copy)]
struct Scene {
    name: &'static str,
    tile: TileId,
    kind: u8,
}

fn scenes() -> Vec<Scene> {
    let mut scenes = [
        ("city-z14", 14, 0),
        ("city-z16", 16, 0),
        ("forest-farmland", 11, 1),
        ("water-islands", 13, 2),
        ("coast-world", 0, 3),
        ("coast-regional", 5, 3),
    ]
    .into_iter()
    .map(|(name, z, kind)| Scene {
        name,
        tile: TileId::new(
            z,
            if z == 0 { 0 } else { 1u32 << (z - 1) },
            if z == 0 { 0 } else { 1u32 << (z - 1) },
        )
        .unwrap(),
        kind,
    })
    .collect::<Vec<_>>();
    let center = geocode_web_single::tilegen::geometry::project(139.0, 35.0).unwrap();
    let tile = TileId::new(
        16,
        (center.x * 65536.0).floor() as u32,
        (center.y * 65536.0).floor() as u32,
    )
    .unwrap();
    scenes.push(Scene {
        name: "mountain-contours",
        tile,
        kind: 4,
    });
    scenes
}

fn context() -> OperationContext {
    OperationContext::new(CancellationToken::new())
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn point(tile: TileId, x: f64, y: f64) -> Point {
    let scale = 2_f64.powi(tile.z.into());
    Point {
        x: (f64::from(tile.x) + x / 256.0) / scale,
        y: (f64::from(tile.y) + y / 256.0) / scale,
    }
}
fn ring(tile: TileId, xy: &[(f64, f64)]) -> Vec<Point> {
    xy.iter().map(|&(x, y)| point(tile, x, y)).collect()
}
fn rectangle(tile: TileId, x: f64, y: f64, w: f64, h: f64) -> Vec<Point> {
    ring(
        tile,
        &[(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)],
    )
}
fn area(
    tile: TileId,
    id: i64,
    kind: FeatureKind,
    outer: Vec<Point>,
    holes: Vec<Vec<Point>>,
) -> Feature {
    let _ = tile;
    Feature {
        osm_type: 1,
        osm_id: id,
        role: 0,
        kind,
        geometry: Geometry::Polygon(vec![PolygonPart { outer, holes }]),
        layer: 0,
        structure: 1,
    }
}
fn line(tile: TileId, id: i64, kind: FeatureKind, xy: &[(f64, f64)]) -> Feature {
    Feature {
        osm_type: 1,
        osm_id: id,
        role: 0,
        kind,
        geometry: Geometry::Line(ring(tile, xy)),
        layer: 0,
        structure: 1,
    }
}

fn features(scene: Scene) -> Vec<Feature> {
    let tile = scene.tile;
    match scene.kind {
        0 => {
            let mut features = vec![
                area(
                    tile,
                    1,
                    FeatureKind::Residential,
                    rectangle(tile, -40.0, -40.0, 600.0, 600.0),
                    vec![],
                ),
                area(
                    tile,
                    2,
                    FeatureKind::Park,
                    rectangle(tile, 16.0, 170.0, 75.0, 70.0),
                    vec![],
                ),
                area(
                    tile,
                    3,
                    FeatureKind::Water,
                    ring(
                        tile,
                        &[
                            (-20.0, 115.0),
                            (210.0, 98.0),
                            (530.0, 140.0),
                            (530.0, 163.0),
                            (210.0, 124.0),
                            (-20.0, 143.0),
                            (-20.0, 115.0),
                        ],
                    ),
                    vec![],
                ),
            ];
            for row in 0..5 {
                for column in 0..7 {
                    let x = 10.0 + f64::from(column) * 40.0;
                    let y = 12.0 + f64::from(row) * 42.0;
                    let holes = if (row + column) % 5 == 0 {
                        vec![rectangle(tile, x + 6.0, y + 5.0, 9.0, 9.0)]
                    } else {
                        vec![]
                    };
                    features.push(area(
                        tile,
                        100 + i64::from(row * 7 + column),
                        FeatureKind::Building,
                        rectangle(tile, x, y, 26.0, 25.0),
                        holes,
                    ));
                }
            }
            features.push(line(
                tile,
                900,
                FeatureKind::Railway,
                &[(-25.0, 245.0), (200.0, 180.0), (530.0, 220.0)],
            ));
            features
        },
        1 => vec![
            area(
                tile,
                1,
                FeatureKind::Forest,
                rectangle(tile, -50.0, -50.0, 600.0, 600.0),
                vec![rectangle(tile, 100.0, 100.0, 100.0, 100.0)],
            ),
            area(
                tile,
                2,
                FeatureKind::Farmland,
                rectangle(tile, 105.0, 105.0, 90.0, 90.0),
                vec![],
            ),
            area(
                tile,
                3,
                FeatureKind::Grass,
                rectangle(tile, 12.0, 175.0, 70.0, 65.0),
                vec![],
            ),
            area(
                tile,
                4,
                FeatureKind::Sand,
                rectangle(tile, 160.0, 12.0, 70.0, 55.0),
                vec![],
            ),
            line(
                tile,
                5,
                FeatureKind::Waterway,
                &[(-30.0, 95.0), (100.0, 52.0), (180.0, 96.0), (530.0, 14.0)],
            ),
        ],
        2 => vec![
            area(
                tile,
                1,
                FeatureKind::Forest,
                rectangle(tile, -30.0, -30.0, 580.0, 580.0),
                vec![],
            ),
            area(
                tile,
                2,
                FeatureKind::Water,
                ring(
                    tile,
                    &[
                        (-20.0, 25.0),
                        (250.0, 10.0),
                        (280.0, 225.0),
                        (160.0, 260.0),
                        (-20.0, 200.0),
                        (-20.0, 25.0),
                    ],
                ),
                vec![
                    rectangle(tile, 65.0, 65.0, 50.0, 45.0),
                    rectangle(tile, 230.0, 130.0, 45.0, 80.0),
                ],
            ),
            area(
                tile,
                3,
                FeatureKind::Water,
                rectangle(tile, 330.0, 30.0, 150.0, 160.0),
                vec![rectangle(tile, 375.0, 70.0, 30.0, 50.0)],
            ),
        ],
        3 => vec![
            area(
                tile,
                1,
                FeatureKind::Land,
                ring(
                    tile,
                    &[
                        (18.0, 15.0),
                        (167.0, 22.0),
                        (145.0, 70.0),
                        (188.0, 120.0),
                        (149.0, 172.0),
                        (166.0, 238.0),
                        (15.0, 239.0),
                        (18.0, 15.0),
                    ],
                ),
                vec![rectangle(tile, 60.0, 95.0, 30.0, 40.0)],
            ),
            area(
                tile,
                2,
                FeatureKind::Land,
                rectangle(tile, 208.0, 58.0, 23.0, 40.0),
                vec![],
            ),
        ],
        _ => vec![
            area(
                tile,
                1,
                FeatureKind::Forest,
                rectangle(tile, -30.0, -30.0, 590.0, 590.0),
                vec![],
            ),
            area(
                tile,
                2,
                FeatureKind::BareRock,
                rectangle(tile, 140.0, 90.0, 60.0, 55.0),
                vec![],
            ),
            area(
                tile,
                3,
                FeatureKind::Water,
                rectangle(tile, 18.0, 180.0, 35.0, 40.0),
                vec![],
            ),
        ],
    }
}

fn roads(scene: Scene) -> Vec<(i64, RoadAttributes, Vec<Point>)> {
    let attributes = |class, layer, structure| RoadAttributes {
        road_class: class,
        is_link: false,
        effective_layer: layer,
        structure_rank: structure,
    };
    match scene.kind {
        0 => vec![
            (
                1000,
                attributes(RoadClass::Primary, 0, 1),
                ring(scene.tile, &[(-30.0, 75.5), (130.0, 71.25), (530.0, 88.5)]),
            ),
            (
                1001,
                attributes(RoadClass::Residential, 1, 2),
                ring(
                    scene.tile,
                    &[(130.5, -30.0), (140.5, 148.0), (118.5, 530.0)],
                ),
            ),
            (
                1002,
                attributes(RoadClass::Secondary, -1, 0),
                ring(
                    scene.tile,
                    &[(-30.0, 205.0), (155.0, 195.0), (530.0, 200.0)],
                ),
            ),
        ],
        1 => vec![(
            2000,
            attributes(RoadClass::Primary, 0, 1),
            ring(
                scene.tile,
                &[
                    (-40.0, 250.0),
                    (110.0, 190.0),
                    (210.0, 200.0),
                    (530.0, 130.0),
                ],
            ),
        )],
        2 => vec![(
            3000,
            attributes(RoadClass::Primary, 1, 2),
            ring(
                scene.tile,
                &[(-30.0, 150.0), (280.0, 140.0), (530.0, 180.0)],
            ),
        )],
        _ => vec![],
    }
}

fn terrain_xml(tile: TileId) -> String {
    let first = point(tile, -45.0, -45.0);
    let longitude = first.x * 360.0 - 180.0;
    let latitude = libm::atan(libm::sinh(std::f64::consts::PI * (1.0 - 2.0 * first.y))) * 180.0
        / std::f64::consts::PI;
    let west = (longitude * 9000.0).floor() / 9000.0;
    let north = (latitude * 9000.0).ceil() / 9000.0;
    let east = west + 129.0 / 9000.0;
    let south = north - 129.0 / 9000.0;
    let mut tuples = String::new();
    for y in 0..129 {
        for x in 0..129 {
            let dx = f64::from(x) - 63.0;
            let dy = f64::from(y) - 65.0;
            let height = (450.0 - 6.0 * libm::sqrt(dx * dx + dy * dy)).max(0.0);
            if (8..15).contains(&x) && (8..15).contains(&y) {
                tuples.push_str("データなし,-9999 ");
            } else {
                tuples.push_str(&format!("地表面,{height:.3} "));
            }
        }
    }
    format!(
        r#"<Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM><gml:boundedBy><gml:Envelope srsName="fguuid:jgd2024.bl"><gml:lowerCorner>{south:.12} {west:.12}</gml:lowerCorner><gml:upperCorner>{north:.12} {east:.12}</gml:upperCorner></gml:Envelope></gml:boundedBy><gml:Grid><gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>128 128</gml:high></gml:GridEnvelope></gml:limits></gml:Grid><gml:rangeSet><gml:DataBlock><gml:tupleList>{tuples}</gml:tupleList></gml:DataBlock></gml:rangeSet><gml:coverageFunction><gml:GridFunction><gml:sequenceRule order="+x-y">Linear</gml:sequenceRule><gml:startPoint>0 0</gml:startPoint></gml:GridFunction></gml:coverageFunction></DEM></Dataset>"#
    )
}

fn build(scene: Scene, reverse: bool) -> (tempfile::TempDir, PathBuf, Value) {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("complete.sqlite");
    let connection = Connection::open(&path).unwrap();
    standard::store::initialize(&connection).unwrap();
    let canonical = features(scene);
    let osm_hash = hash(serde_json::to_vec(&canonical).unwrap());
    let mut selected = canonical;
    if reverse {
        selected.reverse();
    }
    let started = Instant::now();
    for feature in &selected {
        standard::store::insert_feature(&connection, feature).unwrap();
    }
    for (id, attrs, geometry) in roads(scene) {
        standard::store::insert_road(&connection, id, attrs, &geometry).unwrap();
    }
    let mut sources = vec![SourceInfo {
        kind: if scene.kind == 3 { "landmask" } else { "osm" }.into(),
        sha256: osm_hash,
        bytes: 1,
        details: json!({"fixture":scene.name}),
    }];
    let elevation = if scene.kind == 4 {
        let input = temporary.path().join("synthetic-dem.xml");
        fs::write(&input, terrain_xml(scene.tile)).unwrap();
        let (terrain_sources, details) =
            standard::elevation::import_into(&connection, &input, &context()).unwrap();
        sources.extend(terrain_sources);
        // 描画前に入力を取り除き、完成DBだけで標高を参照することを確認する。
        fs::remove_file(&input).unwrap();
        Some(details)
    } else {
        None
    };
    let source_hash = hash(serde_json::to_vec(&sources).unwrap());
    let (count, bounds, points, lod) = standard::store::summary(&connection).unwrap();
    let metadata = StoreMetadata {
        schema_version: 2,
        geometry_version: 2,
        importer_version: "standard-synthetic-fixture-v1".into(),
        import_rules_hash: hash(b"standard-synthetic-rules-v1"),
        dataset_id: hash(format!("standard-fixture:{}:{source_hash}", scene.name)),
        source_sha256: source_hash.clone(),
        source_bytes: 1,
        source_timestamp: None,
        created_unix_seconds: 0,
        coordinate_system: "web-mercator-normalized-f64".into(),
        bbox: bounds,
        feature_count: count,
        original_point_count: points,
        lod_point_counts: lod,
        missing_nodes_policy: "error".into(),
        excluded_way_count: 0,
        skipped_missing_way_count: 0,
        degenerate_way_count: 0,
        clamped_node_count: 0,
        highway_counts: BTreeMap::new(),
        complete: true,
    };
    let extra = StandardMetadata {
        revision: 1,
        counts: BTreeMap::new(),
        skipped_areas: BTreeMap::new(),
        sources,
        elevation,
        capabilities: None,
        labels: None,
    };
    standard::store::finish(&connection, &metadata, &extra).unwrap();
    connection.close().unwrap();
    let elapsed = started.elapsed().as_secs_f64();
    let bytes = fs::metadata(&path).unwrap().len();
    (
        temporary,
        path,
        json!({"name":scene.name,"database_bytes":bytes,"features":count,"points":points,"prepare_seconds":elapsed}),
    )
}

fn render(path: &Path, scene: Scene) -> tiny_skia::Pixmap {
    let store = Store::open(path).unwrap();
    standard::paint::render_tile(&store, scene.tile, &context()).unwrap()
}

#[test]
fn 標準地図の初期基準画像と画素が一致する() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join(ROOT);
    let manifest: Value = serde_json::from_slice(
        &fs::read(root.join("manifest.json")).expect("基準画像は明示生成テストで初回だけ作成する"),
    )
    .unwrap();
    assert_eq!(
        manifest["purpose"],
        "新機能の初期レビュー用基準。旧道路の固定35画像とは独立。"
    );
    let entries = manifest["cases"].as_array().unwrap();
    assert_eq!(entries.len(), scenes().len());
    for (scene, entry) in scenes().into_iter().zip(entries) {
        assert_eq!(entry["name"], scene.name);
        let (_temporary, path, _) = build(scene, false);
        let current = render(&path, scene);
        let reference = tiny_skia::Pixmap::decode_png(
            &fs::read(root.join(format!("{}.png", scene.name))).unwrap(),
        )
        .unwrap();
        assert_eq!(entry["rgba_sha256"], hash(current.data()), "{}", scene.name);
        assert_eq!(reference.data(), current.data(), "{}", scene.name);
        assert!(current.data().chunks_exact(4).all(|pixel| pixel[3] == 255));
    }
}

#[test]
#[ignore = "新機能の初回レビュー用画像を明示的に保存する。通常の回帰で期待値を更新しない"]
fn 標準地図の初期基準画像を明示的に保存する() {
    assert_eq!(
        std::env::var("GEOCODE_WRITE_STANDARD_GOLDENS").as_deref(),
        Ok("1")
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join(ROOT);
    fs::create_dir_all(&root).unwrap();
    let mut entries = Vec::new();
    for scene in scenes() {
        let (_temporary, path, _) = build(scene, false);
        let image = render(&path, scene);
        fs::write(
            root.join(format!("{}.png", scene.name)),
            image.encode_png().unwrap(),
        )
        .unwrap();
        entries.push(json!({"name":scene.name,"z":scene.tile.z,"x":scene.tile.x,"y":scene.tile.y,"rgba_sha256":hash(image.data())}));
    }
    let manifest = json!({"format":1,"purpose":"新機能の初期レビュー用基準。旧道路の固定35画像とは独立。","style_version":standard::paint::STYLE_VERSION,"style_hash":standard::paint::style_hash(),"cases":entries});
    fs::write(
        root.join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
    .unwrap();
}

#[test]
fn 地物の挿入順と保存場所が変わっても描画と識別が一致する() {
    for scene in scenes() {
        let (temporary, original, _) = build(scene, false);
        let (_reverse_temporary, reversed, _) = build(scene, true);
        let dataset = Dataset::open(&original).unwrap();
        let key = dataset.cache_key(scene.tile).unwrap();
        let bytes = render(&original, scene).take();
        assert_eq!(bytes, render(&reversed, scene).take(), "{}", scene.name);
        assert_eq!(
            key,
            Dataset::open(&reversed)
                .unwrap()
                .cache_key(scene.tile)
                .unwrap()
        );
        let moved = temporary.path().join("relocated.sqlite");
        fs::rename(&original, &moved).unwrap();
        assert_eq!(
            key,
            Dataset::open(&moved)
                .unwrap()
                .cache_key(scene.tile)
                .unwrap()
        );
        assert_eq!(bytes, render(&moved, scene).take());
    }
}

#[test]
fn 完成ストアの四タイルは独立した大きな描画窓と一致する() {
    for scene in scenes().into_iter().filter(|scene| scene.tile.z > 0) {
        let (_temporary, path, _) = build(scene, false);
        let store = Store::open(&path).unwrap();
        let large = standard::paint::render_quad(&store, scene.tile, &context()).unwrap();
        for dy in 0..2 {
            for dx in 0..2 {
                let tile = TileId::new(scene.tile.z, scene.tile.x + dx, scene.tile.y + dy).unwrap();
                let part = standard::paint::render_tile(&store, tile, &context()).unwrap();
                for row in 0..256_usize {
                    let expected = ((row + dy as usize * 256) * 512 + dx as usize * 256) * 4;
                    assert_eq!(
                        &large.data()[expected..expected + 1024],
                        &part.data()[row * 1024..(row + 1) * 1024],
                        "{} tile {dx},{dy} row {row}",
                        scene.name
                    );
                }
            }
        }
    }
}

#[test]
fn 小規模人工地域の容量と描画計測を記録する() {
    let mut results = Vec::new();
    for scene in scenes() {
        let (_temporary, path, mut result) = build(scene, false);
        let started = Instant::now();
        let image = render(&path, scene);
        result["miss_render_seconds"] = json!(started.elapsed().as_secs_f64());
        result["rgba_sha256"] = json!(hash(image.data()));
        result["process_peak_rss_bytes"] = json!(metrics::peak_rss_bytes());
        results.push(result);
    }
    let report =
        json!({"scope":"人工小領域。全国データの容量倍率・性能保証には使わない。","cases":results});
    if let Ok(path) = std::env::var("GEOCODE_STANDARD_RENDER_REPORT") {
        let path = Path::new(&path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&report).unwrap()),
        )
        .unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
