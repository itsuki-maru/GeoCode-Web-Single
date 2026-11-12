//! 新しい地図の配色・文字・表示設定と、隣接タイルの画素一致を検証する。

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use geocode_web_single::tilegen::{
    cancel::CancellationToken,
    geometry::Point,
    operation::OperationContext,
    render_spec::RenderSpec,
    standard::{
        self,
        labels::LabelCandidate,
        model::{
            DatasetCapabilities, Feature, FeatureKind, Geometry, PolygonPart, SourceInfo,
            StandardMetadata,
        },
    },
    store::{Store, StoreMetadata},
    style::{RoadAttributes, RoadClass},
    tile::TileId,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

const GOLDEN_ROOT: &str = "tests/fixtures/carto-render-golden";

fn context() -> OperationContext {
    OperationContext::new(CancellationToken::new())
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn tile(zoom: u8) -> TileId {
    TileId::new(zoom, 1 << (zoom - 1), 1 << (zoom - 1)).unwrap()
}
fn point(tile: TileId, x: f64, y: f64) -> Point {
    let scale = 256.0 * 2_f64.powi(i32::from(tile.z));
    Point {
        x: (f64::from(tile.x) * 256.0 + x) / scale,
        y: (f64::from(tile.y) * 256.0 + y) / scale,
    }
}
fn area(
    tile: TileId,
    id: i64,
    kind: FeatureKind,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Feature {
    Feature {
        osm_type: 1,
        osm_id: id,
        role: 0,
        kind,
        geometry: Geometry::Polygon(vec![PolygonPart {
            outer: [
                (x, y),
                (x + width, y),
                (x + width, y + height),
                (x, y + height),
                (x, y),
            ]
            .map(|(x, y)| point(tile, x, y))
            .to_vec(),
            holes: vec![],
        }]),
        layer: 0,
        structure: 1,
    }
}
fn fixture(zoom: u8, reverse: bool) -> (tempfile::TempDir, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("complete.sqlite");
    let conn = Connection::open(&path).unwrap();
    standard::store::initialize_v2(&conn).unwrap();
    let tile = tile(zoom);
    let mut features = vec![
        area(
            tile,
            1,
            FeatureKind::Residential,
            -60.0,
            -60.0,
            650.0,
            650.0,
        ),
        area(tile, 2, FeatureKind::Forest, 310.0, -40.0, 220.0, 270.0),
        area(tile, 3, FeatureKind::Park, 90.0, 160.0, 100.0, 68.0),
        area(tile, 4, FeatureKind::Water, -40.0, 310.0, 650.0, 120.0),
        area(tile, 5, FeatureKind::Building, 24.0, 24.0, 28.0, 24.0),
        area(tile, 6, FeatureKind::Building, 73.0, 25.0, 35.0, 23.0),
    ];
    if reverse {
        features.reverse();
    }
    for feature in &features {
        standard::store::insert_feature(&conn, feature).unwrap();
    }
    let mut roads = RoadClass::ALL
        .into_iter()
        .enumerate()
        .map(|(index, class)| {
            let y = 65.0 + index as f64 * 25.0;
            (
                100 + index as i64,
                RoadAttributes {
                    road_class: class,
                    is_link: false,
                    effective_layer: 0,
                    structure_rank: if index == 3 {
                        0
                    } else if index == 5 {
                        2
                    } else {
                        1
                    },
                },
                vec![
                    point(tile, -100.0, y - 20.0),
                    point(tile, 250.0, y),
                    point(tile, 580.0, y + 40.0),
                ],
            )
        })
        .collect::<Vec<_>>();
    if reverse {
        roads.reverse();
    }
    for (id, attributes, points) in roads {
        standard::store::insert_road(&conn, id, attributes, &points).unwrap();
    }
    let mut labels = vec![
        (1, "place.city", "高松市", 240.25, 45.75, 900_000_001),
        (2, "landmark.station", "高松駅", 48.5, 275.25, 650_000_001),
        (3, "water.lake", "瀬戸内海", 260.25, 365.5, 600_000_001),
        (4, "landmark.park", "栗林公園", 140.5, 190.5, 400_000_001),
    ];
    if reverse {
        labels.reverse();
    }
    for (id, category, name, x, y, importance) in labels {
        standard::labels::insert(
            &conn,
            &LabelCandidate {
                osm_type: 0,
                osm_id: id,
                category: category.into(),
                names: BTreeMap::from([("name".into(), name.into())]),
                anchor: point(tile, x, y),
                importance,
                population: None,
                admin_level: None,
                capital: false,
            },
        )
        .unwrap();
    }
    finish_fixture(&conn, zoom);
    conn.close().unwrap();
    (temporary, path)
}

fn finish_fixture(conn: &Connection, zoom: u8) {
    let (count, bounds, points, lod) = standard::store::summary(&conn).unwrap();
    let metadata = StoreMetadata {
        schema_version: 3,
        geometry_version: 2,
        importer_version: "carto-render-fixture-v1".into(),
        import_rules_hash: hash(b"carto-render-fixture-v1"),
        dataset_id: hash(format!("carto-render-fixture-{zoom}")),
        source_sha256: hash(b"carto-render-input"),
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
        revision: 2,
        counts: BTreeMap::new(),
        skipped_areas: BTreeMap::new(),
        sources: vec![SourceInfo {
            kind: "osm".into(),
            sha256: hash(b"carto-render-input"),
            bytes: 1,
            details: serde_json::json!({"fixture":"carto-render-v1"}),
        }],
        elevation: None,
        capabilities: Some(DatasetCapabilities {
            labels: true,
            contours: false,
            elevation: false,
        }),
        labels: Some(standard::labels::summary(&conn, BTreeMap::new()).unwrap()),
    };
    standard::store::finish(&conn, &metadata, &extra).unwrap();
}

fn road_fragment_fixture(zoom: u8, structure_rank: u8) -> (tempfile::TempDir, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("road-fragments.sqlite");
    let conn = Connection::open(&path).unwrap();
    standard::store::initialize_v2(&conn).unwrap();
    let tile = tile(zoom);
    for index in 0..5 {
        let x = 48.25 + index as f64 * 40.0;
        let y = 64.25 + index as f64 * 32.0;
        let attributes = RoadAttributes {
            road_class: if zoom == 6 {
                RoadClass::Motorway
            } else {
                RoadClass::Primary
            },
            is_link: false,
            effective_layer: if structure_rank == 2 {
                1
            } else if structure_rank == 0 {
                -1
            } else {
                0
            },
            structure_rank,
        };
        // 数十～数百mの短い橋が、低ズームでは1px未満の断片になる状態を再現する。
        standard::store::insert_road(
            &conn,
            index + 1,
            attributes,
            &[point(tile, x, y), point(tile, x + 0.5, y)],
        )
        .unwrap();
    }
    finish_fixture(&conn, zoom);
    conn.close().unwrap();
    (temporary, path)
}
fn render(path: &Path, tile: TileId, spec: &RenderSpec) -> tiny_skia::Pixmap {
    standard::paint::render_tile_with_spec(&Store::open(path).unwrap(), tile, &context(), spec)
        .unwrap()
        .0
}
fn crop(image: &tiny_skia::Pixmap, x: u32, y: u32) -> Vec<u8> {
    let mut output = Vec::new();
    for row in y..y + 256 {
        let start = ((row * image.width() + x) * 4) as usize;
        output.extend_from_slice(&image.data()[start..start + 1024]);
    }
    output
}

#[test]
fn 新配色の道路と建物と文字を個別に切り替える() {
    let (_temporary, path) = fixture(16, false);
    let spec = RenderSpec::osm_like();
    let full = render(&path, tile(16), &spec);
    for field in 0..3 {
        let mut disabled = spec;
        match field {
            0 => disabled.roads = false,
            1 => disabled.buildings = false,
            _ => disabled.labels = false,
        }
        assert!(
            full.data() != render(&path, tile(16), &disabled).data(),
            "表示設定{field}を無効にした画素が変わりません"
        );
    }
    let mut disabled = spec;
    disabled.buildings = false;
    let pixel = |image: &tiny_skia::Pixmap| image.pixel(35, 35).unwrap().demultiply();
    assert_eq!(
        pixel(&full).red(),
        standard::carto_style::feature_color(FeatureKind::Building)[0]
    );
    assert_eq!(
        pixel(&render(&path, tile(16), &disabled)).red(),
        standard::carto_style::feature_color(FeatureKind::Residential)[0]
    );
}

#[test]
fn 低ズームの短い橋とトンネルに通常道路より太い丸点を描かない() {
    let mut spec = RenderSpec::osm_like();
    spec.labels = false;
    for zoom in [6, 10, 12] {
        let (_ground_temporary, ground) = road_fragment_fixture(zoom, 1);
        let ground = render(&ground, tile(zoom), &spec);
        assert!(
            ground
                .data()
                .chunks_exact(4)
                .any(|pixel| pixel != standard::carto_style::BACKGROUND),
            "道路断片が描画されていません"
        );
        for structure_rank in [0, 2] {
            let (_structure_temporary, path) = road_fragment_fixture(zoom, structure_rank);
            let structure = render(&path, tile(zoom), &spec);
            assert!(
                structure.data() == ground.data(),
                "低ズームの構造強調で短い道路断片の画素が変わりました: z={zoom}, structure={structure_rank}"
            );
        }
    }
    let (_ground_temporary, ground) = road_fragment_fixture(13, 1);
    let ground = render(&ground, tile(13), &spec);
    for structure_rank in [0, 2] {
        let (_structure_temporary, path) = road_fragment_fixture(13, structure_rank);
        assert!(
            render(&path, tile(13), &spec).data() != ground.data(),
            "ズーム13の道路構造を強調していません: structure={structure_rank}"
        );
    }
}

#[test]
fn 新配色と文字と破線の四タイルは大きな窓と入力順変更でも一致する() {
    let (_temporary, path) = fixture(16, false);
    let (_reverse_temporary, reverse_path) = fixture(16, true);
    let store = Store::open(&path).unwrap();
    let spec = RenderSpec::osm_like();
    let quad = standard::paint::render_quad_with_spec(&store, tile(16), &context(), &spec).unwrap();
    for y in 0..2 {
        for x in 0..2 {
            let current = TileId::new(16, tile(16).x + x, tile(16).y + y).unwrap();
            assert!(
                render(&path, current, &spec).data() == crop(&quad, x * 256, y * 256),
                "大きな描画窓との境界画素が変わりました: {current}"
            );
            assert!(
                render(&path, current, &spec).data()
                    == render(&reverse_path, current, &spec).data(),
                "入力順で画素が変わりました: {current}"
            );
        }
    }
}

#[test]
fn 新しい地図の固定画像を確認する() {
    let mut cases = Vec::new();
    for zoom in [14, 16] {
        let (_temporary, path) = fixture(zoom, false);
        let image = render(&path, tile(zoom), &RenderSpec::osm_like());
        let target = Path::new(GOLDEN_ROOT).join(format!("city-z{zoom}.png"));
        if std::env::var_os("GEOCODE_UPDATE_CARTO_GOLDEN").is_some() {
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            image.save_png(&target).unwrap();
        }
        let expected = tiny_skia::Pixmap::load_png(&target).unwrap();
        assert!(
            image.data() == expected.data(),
            "新地図の固定画像が変化しました: {}",
            target.display()
        );
        cases.push(serde_json::json!({
            "name":format!("city-z{zoom}"),"z":zoom,"x":tile(zoom).x,"y":tile(zoom).y,
            "rgba_sha256":hash(image.data()),
        }));
    }
    let manifest = serde_json::json!({
        "format":1,"purpose":"名称と新配色の固定画像。従来の道路35枚・標準7枚とは別に確認する。",
        "style_version":"osm-like-v1","style_hash":RenderSpec::osm_like().hash(),
        "font_sha256":standard::text::font_hash(),"cases":cases,
    });
    let path = Path::new(GOLDEN_ROOT).join("manifest.json");
    if std::env::var_os("GEOCODE_UPDATE_CARTO_GOLDEN").is_some() {
        fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    }
    let expected: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        expected, manifest,
        "新描画契約と固定画像の記録が一致しません"
    );
}
