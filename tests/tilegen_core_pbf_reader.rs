#[path = "tilegen_support/mod.rs"]
mod support;

use geocode_web_single::tilegen::pbf::{self, Object};
use sha2::{Digest, Sha256};
use std::io::Write;
use support::{Fixture, block, bytes, frame, integer, raw_frame};

fn read_bytes(input: &[u8]) -> anyhow::Result<(pbf::ScanReport, Vec<Object>)> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("fixture.osm.pbf");
    std::fs::write(&path, input)?;
    let mut objects = Vec::new();
    let report = pbf::scan(&path, |object| {
        objects.push(object);
        Ok(())
    })?;
    Ok((report, objects))
}

fn probe_bytes(input: &[u8]) -> anyhow::Result<pbf::HeaderProbe> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("probe.osm.pbf");
    std::fs::write(&path, input)?;
    let before = std::fs::metadata(&path)?.modified()?;
    let result = pbf::probe_header(&path);
    assert_eq!(std::fs::read(&path)?, input, "probe changed the input");
    assert_eq!(std::fs::metadata(&path)?.modified()?, before);
    result
}

#[test]
fn header_probe_preserves_optional_metadata_and_missing_timestamp_for_raw_and_zlib() {
    for zlib in [false, true] {
        for timestamp in [None, Some(1_794_172_860_u64)] {
            let mut header = Vec::new();
            bytes(&mut header, 4, b"OsmSchema-V0.6");
            bytes(&mut header, 4, b"DenseNodes");
            bytes(&mut header, 5, b"Sort.Type_then_ID");
            bytes(&mut header, 16, b"fixture encoder");
            bytes(&mut header, 17, b"independent fixture");
            if let Some(value) = timestamp {
                integer(&mut header, 32, value);
            }
            let first = frame("OSMHeader", &header, zlib);
            let mut input = first.clone();
            input.extend(frame("OSMData", &block(&[String::new()], &[]), false));
            let probe = probe_bytes(&input).unwrap();
            assert_eq!(probe.scope, "first_osm_header_only");
            assert_eq!(probe.file_bytes, input.len() as u64);
            assert_eq!(probe.header_bytes_read, first.len() as u64);
            assert_eq!(probe.header_sha256, format!("{:x}", Sha256::digest(&first)));
            assert_eq!(probe.required_features, ["OsmSchema-V0.6", "DenseNodes"]);
            assert_eq!(probe.optional_features, ["Sort.Type_then_ID"]);
            assert_eq!(
                probe.replication_timestamp_unix,
                timestamp.map(|n| n as i64)
            );
            assert_eq!(probe.writing_program.as_deref(), Some("fixture encoder"));
            assert_eq!(probe.source.as_deref(), Some("independent fixture"));
            assert_eq!(probe.build_id.len(), 64);
            let document = serde_json::to_value(&probe).unwrap();
            assert_eq!(
                document["replication_timestamp_unix"],
                serde_json::json!(timestamp)
            );
            assert_eq!(
                read_bytes(&input).unwrap().0.timestamp,
                timestamp.map(|n| n.to_string())
            );
        }
    }
}

#[test]
fn header_probe_does_not_validate_or_read_trailing_data() {
    let mut header = Vec::new();
    bytes(&mut header, 4, b"OsmSchema-V0.6");
    let first = frame("OSMHeader", &header, true);
    let mut input = first.clone();
    input.extend([0, 1, 2]);
    let probe = probe_bytes(&input).unwrap();
    assert_eq!(probe.header_bytes_read, first.len() as u64);
    assert!(probe.header_bytes_read < probe.file_bytes);
    assert_eq!(probe.writing_program, None);
    assert_eq!(probe.source, None);
    assert!(
        read_bytes(&input).is_err(),
        "full scan must reject truncated trailing frames"
    );
}

#[test]
fn header_probe_rejects_missing_or_nonfirst_header_without_changing_scan_compatibility() {
    for input in [
        Vec::new(),
        frame("OSMData", &block(&[String::new()], &[]), false),
    ] {
        assert!(probe_bytes(&input).is_err());
    }
    let mut input = frame("Extension", b"ignored by full scan", false);
    input.extend(Fixture::sample().bytes());
    let error = probe_bytes(&input).unwrap_err();
    assert!(format!("{error:#}").contains("first PBF frame is Extension"));
    assert_eq!(read_bytes(&input).unwrap().1.len(), 4);
}

#[test]
fn header_probe_shares_required_feature_and_history_rejections() {
    for features in [
        Vec::new(),
        vec!["OsmSchema-V0.6", "SomeFutureFeature"],
        vec!["OsmSchema-V0.6", "HistoricalInformation"],
    ] {
        let mut header = Vec::new();
        for feature in features {
            bytes(&mut header, 4, feature.as_bytes());
        }
        let input = frame("OSMHeader", &header, false);
        assert!(probe_bytes(&input).is_err());
        assert!(read_bytes(&input).is_err());
    }
}

#[test]
fn header_probe_rejects_truncated_and_oversized_first_frame_before_large_allocations() {
    let input = Fixture::sample().bytes();
    let header_len = u32::from_be_bytes(input[..4].try_into().unwrap()) as usize;
    for cut in [1, 3, 4, 4 + header_len - 1, 4 + header_len] {
        assert!(probe_bytes(&input[..cut]).is_err());
    }
    for size in [0_u32, 65_536] {
        assert!(probe_bytes(&size.to_be_bytes()).is_err());
    }
    let mut blob_header = Vec::new();
    bytes(&mut blob_header, 1, b"OSMHeader");
    integer(&mut blob_header, 3, 40 * 1024 * 1024);
    let mut oversized = (blob_header.len() as u32).to_be_bytes().to_vec();
    oversized.extend(blob_header);
    let error = probe_bytes(&oversized).unwrap_err();
    assert!(format!("{error:#}").contains("invalid Blob length"));
}

#[test]
fn header_probe_rejects_unsupported_compression_and_false_zlib_sizes() {
    let mut unsupported = Vec::new();
    bytes(&mut unsupported, 6, b"unsupported LZ4");
    assert!(probe_bytes(&raw_frame("OSMHeader", &unsupported)).is_err());
    let mut header = Vec::new();
    bytes(&mut header, 4, b"OsmSchema-V0.6");
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&header).unwrap();
    let compressed = encoder.finish().unwrap();
    for declared in [header.len() - 1, header.len() + 1, 32 * 1024 * 1024] {
        let mut blob = Vec::new();
        integer(&mut blob, 2, declared as u64);
        bytes(&mut blob, 3, &compressed);
        assert!(probe_bytes(&raw_frame("OSMHeader", &blob)).is_err());
    }
}

#[test]
fn raw_zlib_simple_dense_and_arbitrary_block_order() {
    for dense in [false, true] {
        for zlib in [false, true] {
            for ways_first in [false, true] {
                let mut fixture = Fixture::sample();
                fixture.dense = dense;
                fixture.zlib = zlib;
                fixture.ways_first = ways_first;
                let input = fixture.bytes();
                let (report, objects) = read_bytes(&input).unwrap();
                assert_eq!(report.bytes, input.len() as u64);
                assert_eq!(
                    report.source_sha256,
                    format!("{:x}", Sha256::digest(&input))
                );
                let nodes: Vec<_> = objects
                    .iter()
                    .filter_map(|object| match object {
                        Object::Node(n) => Some(n),
                        _ => None,
                    })
                    .collect();
                assert_eq!(nodes.len(), 3);
                assert_eq!(nodes[0].id, 1);
                assert!((nodes[0].lon - 139.699).abs() < 1e-10);
                assert!((nodes[2].lat - 35.701).abs() < 1e-10);
                let ways: Vec<_> = objects
                    .iter()
                    .filter_map(|object| match object {
                        Object::Way(w) => Some(w),
                        _ => None,
                    })
                    .collect();
                assert_eq!(ways, vec![&fixture.ways[0]]);
                assert_eq!(matches!(objects[0], Object::Way(_)), ways_first);
            }
        }
    }
}

#[test]
fn rejects_history_unknown_required_features_and_missing_schema() {
    for feature in ["HistoricalInformation", "SomeFutureFeature"] {
        let mut fixture = Fixture::sample();
        fixture.required_features.push(feature.into());
        assert!(read_bytes(&fixture.bytes()).is_err());
    }
    let mut fixture = Fixture::sample();
    fixture.required_features.clear();
    assert!(read_bytes(&fixture.bytes()).is_err());
}

#[test]
fn detects_partial_prefix_and_truncated_bodies() {
    let valid = Fixture::sample().bytes();
    for extra in 1..=3 {
        let mut input = valid.clone();
        input.extend(vec![0_u8; extra]);
        let error = read_bytes(&input).unwrap_err();
        assert!(format!("{error:#}").contains("truncated PBF frame length"));
    }
    for trim in [1, 4, 10] {
        assert!(read_bytes(&valid[..valid.len() - trim]).is_err());
    }
    assert!(read_bytes(&65_536_u32.to_be_bytes()).is_err());
    assert!(read_bytes(&[]).is_err());
}

#[test]
fn checks_compression_and_actual_expansion_length() {
    let mut header = Vec::new();
    bytes(&mut header, 4, b"OsmSchema-V0.6");
    let mut unsupported_blob = Vec::new();
    bytes(&mut unsupported_blob, 6, b"unsupported LZ4");
    assert!(read_bytes(&raw_frame("OSMHeader", &unsupported_blob)).is_err());
    let mut blob = Vec::new();
    integer(&mut blob, 2, 32 * 1024 * 1024);
    bytes(&mut blob, 3, b"not a zlib stream");
    assert!(read_bytes(&raw_frame("OSMHeader", &blob)).is_err());
    let mut mixed = Vec::new();
    bytes(&mut mixed, 1, &header);
    bytes(&mut mixed, 3, b"zlib");
    assert!(read_bytes(&raw_frame("OSMHeader", &mixed)).is_err());

    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&header).unwrap();
    let compressed = encoder.finish().unwrap();
    for declared in [header.len() - 1, header.len() + 1] {
        let mut wrong_size = Vec::new();
        integer(&mut wrong_size, 2, declared as u64);
        bytes(&mut wrong_size, 3, &compressed);
        assert!(read_bytes(&raw_frame("OSMHeader", &wrong_size)).is_err());
    }
    for payload in [
        compressed[..compressed.len() - 2].to_vec(),
        [compressed.as_slice(), &[0, 0]].concat(),
    ] {
        let mut bad_stream = Vec::new();
        integer(&mut bad_stream, 2, header.len() as u64);
        bytes(&mut bad_stream, 3, &payload);
        assert!(read_bytes(&raw_frame("OSMHeader", &bad_stream)).is_err());
    }
}

#[test]
fn preserves_nanodegrees_offsets_and_metadata_without_visibility() {
    let mut header = Vec::new();
    bytes(&mut header, 4, b"OsmSchema-V0.6");
    integer(&mut header, 32, 1_700_000_000);
    let mut info = Vec::new();
    integer(&mut info, 1, 1);
    let mut node = Vec::new();
    integer(&mut node, 1, support::zigzag(1));
    integer(&mut node, 8, support::zigzag(3));
    integer(&mut node, 9, support::zigzag(1));
    bytes(&mut node, 4, &info);
    let mut group = Vec::new();
    bytes(&mut group, 1, &node);
    let mut block = block(&[String::new()], &group);
    integer(&mut block, 17, 1);
    integer(&mut block, 19, 2_000_000_000);
    integer(&mut block, 20, 1_000_000_000);
    let mut input = frame("OSMHeader", &header, false);
    input.extend(frame("OSMData", &block, true));
    let (report, objects) = read_bytes(&input).unwrap();
    assert_eq!(report.timestamp.as_deref(), Some("1700000000"));
    let Object::Node(node) = &objects[0] else {
        panic!("expected Node")
    };
    assert!((node.lon - 1.000_000_001).abs() < 1e-14);
    assert!((node.lat - 2.000_000_003).abs() < 1e-14);
}

#[test]
fn rejects_dense_delta_overflow() {
    let mut header = Vec::new();
    bytes(&mut header, 4, b"OsmSchema-V0.6");
    bytes(&mut header, 4, b"DenseNodes");
    let mut ids = Vec::new();
    support::varint(&mut ids, support::zigzag(i64::MAX));
    support::varint(&mut ids, support::zigzag(1));
    let mut dense = Vec::new();
    bytes(&mut dense, 1, &ids);
    bytes(&mut dense, 8, &[0, 0]);
    bytes(&mut dense, 9, &[0, 0]);
    let mut group = Vec::new();
    bytes(&mut group, 2, &dense);
    let mut input = frame("OSMHeader", &header, false);
    input.extend(frame("OSMData", &block(&[String::new()], &group), false));
    let error = read_bytes(&input).unwrap_err();
    assert!(format!("{error:#}").contains("DenseNode ID overflow"));
}

#[test]
fn rejects_bad_string_indices_and_mismatched_dense_arrays() {
    let mut header = Vec::new();
    bytes(&mut header, 4, b"OsmSchema-V0.6");
    bytes(&mut header, 4, b"DenseNodes");
    let start = frame("OSMHeader", &header, false);
    let mut way = Vec::new();
    integer(&mut way, 1, 10);
    bytes(&mut way, 2, &[100]);
    bytes(&mut way, 3, &[0]);
    let mut group = Vec::new();
    bytes(&mut group, 3, &way);
    let mut input = start.clone();
    input.extend(frame("OSMData", &block(&[String::new()], &group), false));
    assert!(read_bytes(&input).is_err());

    let mut dense = Vec::new();
    bytes(&mut dense, 1, &[2]);
    bytes(&mut dense, 8, &[]);
    bytes(&mut dense, 9, &[0]);
    let mut group = Vec::new();
    bytes(&mut group, 2, &dense);
    let mut input = start;
    input.extend(frame("OSMData", &block(&[String::new()], &group), false));
    assert!(read_bytes(&input).is_err());
}

#[test]
fn enforces_header_order_and_feature_declaration() {
    assert!(read_bytes(&frame("OSMData", &block(&[String::new()], &[]), false)).is_err());
    let mut fixture = Fixture::sample();
    fixture.dense = true;
    fixture.required_features = vec!["OsmSchema-V0.6".into()];
    assert!(read_bytes(&fixture.bytes()).is_err());
}

#[test]
fn propagates_visitor_errors() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("input.osm.pbf");
    Fixture::sample().write(&path);
    let error = pbf::scan(&path, |_| anyhow::bail!("visitor stopped")).unwrap_err();
    assert!(format!("{error:#}").contains("visitor stopped"));
}
