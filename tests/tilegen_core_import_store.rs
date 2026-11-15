#[path = "tilegen_support/mod.rs"]
mod support;

use std::{collections::BTreeMap, path::Path};

use anyhow::Result;
use geocode_web_single::tilegen::{
    cancel::{CancellationToken, is_interrupted},
    geometry::{Point, project},
    import::{self, ImportOptions, MissingNodes},
    pbf::{Node, Way},
    simplify,
    store::Store,
};
use sha2::{Digest, Sha256};
use support::Fixture;

fn options(root: &Path, label: &str, missing_nodes: MissingNodes) -> ImportOptions {
    ImportOptions {
        input: root.join("input.osm.pbf"),
        store: root.join(format!("{label}.sqlite")),
        work_dir: root.join(format!("{label}-work")),
        missing_nodes,
    }
}

fn road(id: i64, nodes: Vec<i64>, highway: &str) -> Way {
    Way {
        id,
        nodes,
        tags: BTreeMap::from([("highway".into(), highway.into())]),
    }
}

#[test]
fn reverse_order_dense_zlib_import_keeps_shared_lod_anchors_without_source() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut fixture = Fixture::sample();
    fixture.dense = true;
    fixture.zlib = true;
    fixture.ways_first = true;
    fixture.ways.push(road(11, vec![2, 3], "primary"));
    let options = options(directory.path(), "complete", MissingNodes::Error);
    fixture.write(&options.input);
    let expected_hash = format!("{:x}", Sha256::digest(fixture.bytes()));

    let report = import::run(&options)?;
    assert_eq!(report.metadata.feature_count, 2);
    assert_eq!(report.needed_node_count, 3);
    assert_eq!(report.metadata.source_sha256, expected_hash);
    assert_eq!(report.metadata.lod_point_counts.len(), 10);
    assert!(report.metadata.complete);
    assert!(!options.work_dir.exists());
    std::fs::remove_file(&options.input)?;

    let store = Store::open(&options.store)?;
    assert_eq!(store.metadata().dataset_id, report.metadata.dataset_id);
    let keys = store.query_candidates(store.metadata().bbox, 14)?;
    assert_eq!(keys.len(), 2);
    let residential = keys.iter().find(|key| key.osm_way_id == 10).unwrap();
    // 保護がなければ、ズーム6では近接した3頂点が端点だけに簡略化される。
    // Node 2はWay 11と共有されるため、すべてのLODで固定点として残す必要がある。
    assert_eq!(store.load_geometry(residential.feature_id, 6)?.len(), 3);
    assert_eq!(store.load_geometry(residential.feature_id, 18)?.len(), 3);
    Ok(())
}

#[test]
fn missing_node_policy_rejects_or_skips_the_entire_way() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut fixture = Fixture::sample();
    fixture.nodes.retain(|node| node.id != 2);
    fixture.ways.push(road(11, vec![1, 3], "primary"));
    let strict = options(directory.path(), "strict", MissingNodes::Error);
    fixture.write(&strict.input);

    let error = import::run(&strict).unwrap_err();
    assert!(format!("{error:#}").contains("missing Node"));
    assert!(!strict.store.exists());
    assert!(strict.work_dir.exists());
    let building = strict.store.with_extension("building.sqlite");
    assert!(building.exists());
    assert!(Store::open(&building).is_err());

    let skip = options(directory.path(), "skip", MissingNodes::SkipWay);
    let report = import::run(&skip)?;
    assert_eq!(report.metadata.feature_count, 1);
    assert_eq!(report.metadata.skipped_missing_way_count, 1);
    assert_eq!(report.missing_node_references, 1);
    let store = Store::open(&skip.store)?;
    let keys = store.query_candidates(store.metadata().bbox, 14)?;
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].osm_way_id, 11);
    Ok(())
}

#[test]
fn duplicate_selected_way_or_required_node_is_rejected() -> Result<()> {
    for duplicate_way in [true, false] {
        let directory = tempfile::tempdir()?;
        let mut fixture = Fixture::sample();
        if duplicate_way {
            fixture.ways.push(road(10, vec![1, 3], "primary"));
        } else {
            fixture.nodes.push(Node {
                id: 1,
                lon: 139.699,
                lat: 35.7,
            });
        }
        let options = options(directory.path(), "duplicate", MissingNodes::Error);
        fixture.write(&options.input);
        let error = import::run(&options).unwrap_err();
        assert!(format!("{error:#}").contains("duplicate"));
        assert!(!options.store.exists());
    }
    Ok(())
}

#[test]
fn extraction_excludes_area_and_unknown_values_but_keeps_closed_roads() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut fixture = Fixture::sample();
    fixture.ways[0].nodes.push(1);
    fixture.ways.push(road(11, vec![1, 3], "construction"));
    fixture.ways.push(road(12, vec![1, 3], "unknown-road"));
    let mut area = road(13, vec![1, 2, 3, 1], "pedestrian");
    area.tags.insert("area".into(), "yes".into());
    fixture.ways.push(area);
    let options = options(directory.path(), "extraction", MissingNodes::Error);
    fixture.write(&options.input);

    let report = import::run(&options)?;
    assert_eq!(report.selected_way_count, 1);
    assert_eq!(report.metadata.feature_count, 1);
    assert_eq!(report.metadata.excluded_way_count, 3);
    assert_eq!(report.metadata.highway_counts["construction"], 1);
    let store = Store::open(&options.store)?;
    let keys = store.query_candidates(store.metadata().bbox, 14)?;
    for zoom in 6..=22 {
        let points = store.load_geometry(keys[0].feature_id, zoom)?;
        assert_eq!(points.first(), points.last());
        assert!(points.len() >= 3);
    }
    Ok(())
}

#[test]
fn geometry_failure_never_publishes_or_opens_an_incomplete_store() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut fixture = Fixture::sample();
    fixture.nodes[0].lon = 179.9;
    fixture.nodes[1].lon = -179.9;
    let options = options(directory.path(), "antimeridian", MissingNodes::Error);
    fixture.write(&options.input);

    let error = import::run(&options).unwrap_err();
    assert!(format!("{error:#}").contains("antimeridian"));
    assert!(!options.store.exists());
    let building = options.store.with_extension("building.sqlite");
    assert!(building.exists());
    assert!(Store::open(&building).is_err());
    Ok(())
}

#[test]
fn cancelled_import_has_no_output_side_effects() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let options = options(directory.path(), "cancelled", MissingNodes::Error);
    Fixture::sample().write(&options.input);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = import::run_with_cancellation(&options, &cancel).unwrap_err();
    assert!(is_interrupted(&error));
    assert!(!options.store.exists());
    assert!(!options.work_dir.exists());
    Ok(())
}

#[test]
fn existing_store_is_never_overwritten() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let options = options(directory.path(), "existing", MissingNodes::Error);
    Fixture::sample().write(&options.input);
    std::fs::write(&options.store, b"previous-store")?;
    assert!(import::run(&options).is_err());
    assert_eq!(std::fs::read(&options.store)?, b"previous-store");
    assert!(!options.work_dir.exists());
    Ok(())
}

#[test]
fn import_policy_is_part_of_the_dataset_identity() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let strict = options(directory.path(), "strict", MissingNodes::Error);
    Fixture::sample().write(&strict.input);
    let strict_report = import::run(&strict)?;
    let repeated = options(directory.path(), "same-input", MissingNodes::Error);
    let repeated_report = import::run(&repeated)?;
    assert_eq!(
        strict_report.metadata.dataset_id,
        repeated_report.metadata.dataset_id
    );
    assert_eq!(
        strict_report.metadata.importer_version,
        geocode_web_single::tilegen::identity::IMPORT_COMPATIBILITY_VERSION
    );
    let skip = options(directory.path(), "skip", MissingNodes::SkipWay);
    let skip_report = import::run(&skip)?;
    assert_eq!(
        strict_report.metadata.source_sha256,
        skip_report.metadata.source_sha256
    );
    assert_ne!(
        strict_report.metadata.import_rules_hash,
        skip_report.metadata.import_rules_hash
    );
    assert_ne!(
        strict_report.metadata.dataset_id,
        skip_report.metadata.dataset_id
    );
    Ok(())
}

#[test]
fn empty_import_after_exclusions_is_not_a_completed_store() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut fixture = Fixture::sample();
    fixture.nodes.retain(|node| node.id != 2);
    let options = options(directory.path(), "empty", MissingNodes::SkipWay);
    fixture.write(&options.input);
    let error = import::run(&options).unwrap_err();
    assert!(format!("{error:#}").contains("no valid road features"));
    assert!(!options.store.exists());
    assert!(Store::open(&options.store.with_extension("building.sqlite")).is_err());
    Ok(())
}

// japan-261108.osm.pbfのWay 1511000773を使用する。整数のナノ度表現で
// 読取処理への正確なf64入力を保持し、バイナリの検証用ファイルは使わない。
// この対称な閉ループでは、以前は頂点4の投影値が1 ULP異なることで、
// WindowsとLinuxで3番目に選ばれる固定点が変わっていた。
const NATIONAL_LOOP: [(i64, i64, i64); 17] = [
    (13811400950, 135577970600, 34715256400),
    (13811400936, 135577958800, 34715250000),
    (13811400937, 135577945000, 34715247800),
    (13811400938, 135577931200, 34715250100),
    (13811400939, 135577919500, 34715256500),
    (13811400940, 135577911700, 34715266200),
    (13811400941, 135577909000, 34715277600),
    (13811400942, 135577911800, 34715288900),
    (13811400951, 135577919700, 34715298500),
    (13811400943, 135577931400, 34715304900),
    (13811400944, 135577945300, 34715307100),
    (13811400945, 135577959100, 34715304800),
    (13811400946, 135577970800, 34715298400),
    (13811400947, 135577978500, 34715288700),
    (13811400948, 135577981200, 34715277300),
    (13811400949, 135577978400, 34715266000),
    (13811400950, 135577970600, 34715256400),
];

const NATIONAL_LOOP_SHA256: &str =
    "de5413fa4b1fb7b232758530e92b8ade862757c5b23c34e9a4df5ede12c00480";

fn national_loop_points() -> Result<Vec<Point>> {
    NATIONAL_LOOP
        .iter()
        .map(|&(_, lon, lat)| project(lon as f64 * 1e-9, lat as f64 * 1e-9))
        .collect()
}

fn geometry_sha256(points: &[Point]) -> String {
    let mut digest = Sha256::new();
    for point in points {
        digest.update(point.x.to_le_bytes());
        digest.update(point.y.to_le_bytes());
    }
    format!("{digest:x}", digest = digest.finalize())
}

fn national_loop_lod_indices(zoom: u8) -> &'static [usize] {
    if zoom == 15 {
        &[0, 4, 8, 12, 16]
    } else {
        &[0, 8, 12, 16]
    }
}

#[test]
fn national_loop_projection_and_lod_are_deterministic() -> Result<()> {
    let points = national_loop_points()?;
    let mut protected = [false; 17];
    for index in [0, 12, 16] {
        protected[index] = true;
    }
    // 以前差が生じた頂点について、両OSで同じビット列になることを固定する。
    // ダイジェストでは、保存時と同じリトルエンディアン順の全x/yのf64値も固定する。
    assert_eq!(points[4].x.to_bits(), 0x3fec_0d26_a006_6b6c);
    assert_eq!(points[4].y.to_bits(), 0x3fd9_6975_a085_8b8d);
    assert_eq!(geometry_sha256(&points), NATIONAL_LOOP_SHA256);
    for zoom in 6..=15 {
        let epsilon = 0.5 / (256.0 * f64::from(1_u32 << zoom));
        let lod = simplify::simplify(&points, &protected, epsilon)?;
        let expected: Vec<_> = national_loop_lod_indices(zoom)
            .iter()
            .map(|&index| points[index])
            .collect();
        assert_eq!(
            lod, expected,
            "Closed-loop retained vertices changed at z{zoom}"
        );
    }
    Ok(())
}

#[test]
fn national_loop_import_preserves_canonical_projection_and_shared_lod_anchor() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let options = options(directory.path(), "national-loop", MissingNodes::Error);
    let mut fixture = Fixture::sample();
    fixture.nodes = NATIONAL_LOOP[..16]
        .iter()
        .map(|&(id, lon, lat)| Node {
            id,
            lon: lon as f64 * 1e-9,
            lat: lat as f64 * 1e-9,
        })
        .collect();
    // 元データで別の選択対象Wayと共有されるのは頂点12だけとなる。
    // 閉ループの始終点はこのWay内で2回出現するため、既に保護されている。
    fixture.nodes.push(Node {
        id: -1,
        lon: (NATIONAL_LOOP[12].1 + 100) as f64 * 1e-9,
        lat: NATIONAL_LOOP[12].2 as f64 * 1e-9,
    });
    fixture.ways = vec![
        road(
            1511000773,
            NATIONAL_LOOP.iter().map(|&(id, _, _)| id).collect(),
            "footway",
        ),
        road(-1, vec![NATIONAL_LOOP[12].0, -1], "residential"),
    ];
    fixture.dense = true;
    fixture.zlib = true;
    fixture.ways_first = true;
    fixture.write(&options.input);

    let report = import::run(&options)?;
    assert_eq!(report.metadata.feature_count, 2);
    assert_eq!(report.metadata.original_point_count, 19);
    let store = Store::open(&options.store)?;
    let keys = store.query_candidates(store.metadata().bbox, 18)?;
    let target = keys
        .iter()
        .find(|key| key.osm_way_id == 1511000773)
        .unwrap();
    let original = store.load_geometry(target.feature_id, 18)?;
    assert_eq!(geometry_sha256(&original), NATIONAL_LOOP_SHA256);
    assert_eq!(original, national_loop_points()?);
    for zoom in 6..=15 {
        let lod = store.load_geometry(target.feature_id, zoom)?;
        let expected: Vec<_> = national_loop_lod_indices(zoom)
            .iter()
            .map(|&index| original[index])
            .collect();
        assert_eq!(
            lod, expected,
            "Imported retained vertices changed at z{zoom}"
        );
        assert_eq!(
            report.metadata.lod_point_counts[&zoom],
            expected.len() as u64 + 2
        );
    }
    Ok(())
}
