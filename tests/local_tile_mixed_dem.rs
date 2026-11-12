//! 原資料値を使う混在DEMの採用・完成検査・識別・描画を小地域で確認する。

#[path = "standard_tile_fixture/mod.rs"]
mod fixture;

use std::path::{Path, PathBuf};

use geocode_web_single::tilegen::{
    cancel::CancellationToken,
    dataset::{Dataset, RenderOptions},
    geometry::project,
    import::{ImportOptions, MissingNodes},
    operation::{OperationContext, Stage},
    standard::{
        self,
        elevation::Sampler,
        model::{ElevationDatumPolicy, InvalidAreas, StandardImportOptions},
    },
    tile::TileId,
};
use rusqlite::Connection;
use serde_json::{Value, json};

const JGD2000: &str = "fguuid:jgd2000.bl";
const JGD2011: &str = "fguuid:jgd2011.bl";

fn policy(value: &str) -> ElevationDatumPolicy {
    value.parse().unwrap()
}

fn xml(crs: &str, x_offset: usize, values: impl Fn(usize, usize) -> String) -> String {
    let tuples = (0..8)
        .flat_map(|y| (0..8).map(move |x| (x, y)))
        .map(|(x, y)| values(x, y))
        .collect::<Vec<_>>()
        .join("\n");
    let west = 139.7 - 8.0 / 3600.0 + x_offset as f64 / 3600.0;
    let east = west + 8.0 / 3600.0;
    let north = 35.7 + 4.0 / 3600.0;
    let south = north - 8.0 / 3600.0;
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM>
<gml:boundedBy><gml:Envelope srsName="{crs}"><gml:lowerCorner>{south:.15} {west:.15}</gml:lowerCorner><gml:upperCorner>{north:.15} {east:.15}</gml:upperCorner></gml:Envelope></gml:boundedBy>
<gml:Grid><gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>7 7</gml:high></gml:GridEnvelope></gml:limits><gml:axisLabels>x y</gml:axisLabels></gml:Grid>
<gml:rangeSet><gml:DataBlock><gml:tupleList>{tuples}</gml:tupleList></gml:DataBlock></gml:rangeSet>
<gml:coverageFunction><gml:GridFunction><gml:sequenceRule order="+x-y">Linear</gml:sequenceRule><gml:startPoint>0 0</gml:startPoint></gml:GridFunction></gml:coverageFunction>
</DEM></Dataset>"#
    )
}

fn options(
    root: &Path,
    pbf: &Path,
    dem: &Path,
    name: &str,
    datum_policy: &str,
) -> StandardImportOptions {
    StandardImportOptions {
        base: ImportOptions {
            input: pbf.to_owned(),
            store: root.join(format!("{name}.sqlite")),
            work_dir: root.join(format!("{name}-work")),
            missing_nodes: MissingNodes::Error,
        },
        elevation_input: Some(dem.to_owned()),
        elevation_datum_policy: policy(datum_policy),
        landmask_input: None,
        invalid_areas: InvalidAreas::Error,
        feature_set: Default::default(),
        contour_data: Default::default(),
    }
}

fn imported(options: &StandardImportOptions) -> (PathBuf, Dataset, Value) {
    standard::import::run_with_context(options, &OperationContext::default()).unwrap();
    let database = Connection::open_with_flags(
        &options.base.store,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let details = standard::store::details(&database).unwrap().unwrap();
    assert_eq!(details.counts.get("building"), Some(&1));
    let elevation = details.elevation.unwrap();
    drop(database);
    (
        options.base.store.clone(),
        Dataset::open(&options.base.store).unwrap(),
        elevation,
    )
}

fn render(dataset: &Dataset, tile: TileId) -> Vec<u8> {
    dataset
        .create_session(RenderOptions::default())
        .unwrap()
        .render(tile, &CancellationToken::new())
        .unwrap()
        .image
        .rgba()
        .to_vec()
}

#[test]
fn 隣接する異なる測地系の原標高を連続して読み入力順や保存先で画像を変えない() {
    let root = tempfile::tempdir().unwrap();
    let pbf = root.path().join("map.pbf");
    fixture::write_inputs(&pbf, &root.path().join("unused.xml"));
    let west = root.path().join("west.xml");
    let east = root.path().join("east.xml");
    let west_xml = xml(JGD2000, 0, |x, y| {
        format!("地表面,{}", 100 + 20 * x + 10 * y)
    });
    let east_xml = xml(JGD2011, 8, |x, y| {
        format!("地表面,{}", 260 + 20 * x + 10 * y)
    });
    std::fs::write(&west, &west_xml).unwrap();
    std::fs::write(&east, &east_xml).unwrap();
    let manifest = root.path().join("dem.json");
    std::fs::write(&manifest, json!({"files":[west,east]}).to_string()).unwrap();
    let (path, dataset, details) = imported(&options(
        root.path(),
        &pbf,
        &manifest,
        "first",
        "allow-jgd2000-2011",
    ));
    assert_eq!(
        details["source_coordinate_systems"],
        json!([JGD2000, JGD2011])
    );
    assert_eq!(
        details["contributing_coordinate_systems"],
        json!([JGD2000, JGD2011])
    );
    assert_eq!(details["mixed_coordinate_systems"], true);
    assert!(details["crs"].is_null());
    assert_eq!(details["cells"], 128);
    assert!(details["contour_features"].as_u64().unwrap() > 0);

    let connection =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let latitude = 35.7 + 0.5 / 3600.0;
    let tile = TileId::from_lon_lat(20, 139.7, latitude).unwrap();
    let sampler =
        Sampler::new(&connection, tile.bounds(), 20, &OperationContext::default()).unwrap();
    // 境界の左右と中点は、入力に与えた同じ一次斜面の値になる。
    for (offset, expected) in [(-0.25, 275.0), (0.0, 280.0), (0.25, 285.0)] {
        let height = sampler
            .sample(project(139.7 + offset / 3600.0, latitude).unwrap())
            .unwrap();
        assert!((height - expected).abs() < 0.001, "{offset}: {height}");
    }
    drop(sampler);
    drop(connection);

    let moved = root.path().join("moved");
    std::fs::create_dir(&moved).unwrap();
    std::fs::write(moved.join("renamed-a.xml"), &east_xml).unwrap();
    std::fs::write(moved.join("renamed-z.xml"), &west_xml).unwrap();
    let other_manifest = root.path().join("other.json");
    std::fs::write(
        &other_manifest,
        json!({"files":[moved.join("renamed-a.xml"),moved.join("renamed-z.xml")]}).to_string(),
    )
    .unwrap();
    let (_, repeated, _) = imported(&options(
        root.path(),
        &pbf,
        &other_manifest,
        "second",
        "allow-jgd2000-2011",
    ));
    assert_eq!(dataset.info().dataset_id, repeated.info().dataset_id);
    let visible = TileId::from_lon_lat(16, 139.7, 35.7).unwrap();
    assert_eq!(
        dataset.cache_key(visible).unwrap(),
        repeated.cache_key(visible).unwrap()
    );
    std::fs::remove_file(&pbf).unwrap();
    std::fs::remove_file(&west).unwrap();
    std::fs::remove_file(&east).unwrap();
    std::fs::remove_dir_all(&moved).unwrap();
    let image = render(&dataset, visible);
    assert_eq!(image, render(&repeated, visible));
    assert!(image.chunks_exact(4).any(|pixel| pixel != &image[..4]));
}

#[test]
fn 重複と欠損の入力測地系を採用セルの測地系と区別する() {
    let root = tempfile::tempdir().unwrap();
    let pbf = root.path().join("map.pbf");
    fixture::write_inputs(&pbf, &root.path().join("unused.xml"));
    let selected = root.path().join("selected.xml");
    let overlap = root.path().join("overlap.xml");
    let no_data = root.path().join("no-data.xml");
    std::fs::write(
        &selected,
        xml(JGD2000, 0, |x, y| format!("地表面,{}", 100 + x + y)),
    )
    .unwrap();
    std::fs::write(&overlap, xml(JGD2011, 0, |_, _| "地表面,900".into())).unwrap();
    std::fs::write(&no_data, xml(JGD2011, 8, |_, _| "データなし,-9999".into())).unwrap();
    let manifest = root.path().join("dem.json");
    std::fs::write(&manifest,json!({"files":[{"path":overlap,"priority":0},{"path":no_data,"priority":0},{"path":selected,"priority":10}]}).to_string()).unwrap();
    let (_, _, details) = imported(&options(
        root.path(),
        &pbf,
        &manifest,
        "mixed",
        "allow-jgd2000-2011",
    ));
    assert_eq!(details["input_grids"], 3);
    assert_eq!(details["grids"], 2);
    assert_eq!(details["cells"], 64);
    assert_eq!(details["mixed_input_coordinate_systems"], true);
    assert_eq!(details["mixed_coordinate_systems"], false);
    assert_eq!(details["contributing_coordinate_systems"], json!([JGD2000]));
    let unused = &details["coordinate_systems"][JGD2011];
    assert_eq!(unused["input_grids"], 2);
    assert_eq!(unused["valid_grids"], 1);
    assert_eq!(unused["contributed_cells"], 0);
    assert_eq!(unused["ground_cells"], 0);
    assert!(unused["coverage_bounds"].is_null());
    assert_eq!(details["max_elevation_m"], 114.0);
}

#[test]
fn 禁止した混在は壊れたpbfを走査する前に停止する() {
    let root = tempfile::tempdir().unwrap();
    let pbf = root.path().join("not-a-pbf.pbf");
    std::fs::write(&pbf, b"not a PBF").unwrap();
    let directory = root.path().join("dem");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(
        directory.join("old.xml"),
        xml(JGD2000, 0, |_, _| "地表面,100".into()),
    )
    .unwrap();
    std::fs::write(
        directory.join("new.xml"),
        xml(JGD2011, 8, |_, _| "地表面,100".into()),
    )
    .unwrap();
    let options = options(root.path(), &pbf, &directory, "rejected", "strict");
    let context = OperationContext::default();
    let error = standard::import::run_with_context(&options, &context).unwrap_err();
    assert!(format!("{error:#}").contains("混在"), "{error:#}");
    assert_eq!(context.monitor().snapshot().stage, Stage::Validating);
    assert!(!options.base.work_dir.exists());
    assert!(!options.base.store.exists());
}

#[test]
fn 単独資料は混在許可を選んだだけでは別の地図にしない() {
    let root = tempfile::tempdir().unwrap();
    let pbf = root.path().join("map.pbf");
    let dem = root.path().join("dem.xml");
    fixture::write_inputs(&pbf, &dem);
    let (_, strict, _) = imported(&options(root.path(), &pbf, &dem, "strict", "strict"));
    let (_, allowed, _) = imported(&options(
        root.path(),
        &pbf,
        &dem,
        "allowed",
        "allow-jgd2000-2011",
    ));
    assert_eq!(strict.info().dataset_id, allowed.info().dataset_id);
    let tile = TileId::from_lon_lat(16, 139.7, 35.7).unwrap();
    assert_eq!(
        strict.cache_key(tile).unwrap(),
        allowed.cache_key(tile).unwrap()
    );
    assert_eq!(render(&strict, tile), render(&allowed, tile));
}
