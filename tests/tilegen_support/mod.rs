#![allow(dead_code)]

use flate2::{Compression, write::ZlibEncoder};
use geocode_web_single::tilegen::pbf::{Node, Way};
use std::{collections::BTreeMap, io::Write, path::Path};

/// 本番の読取処理とは独立して符号化した、小さな検証用PBFデータ。
pub struct Fixture {
    pub nodes: Vec<Node>,
    pub ways: Vec<Way>,
    pub dense: bool,
    pub ways_first: bool,
    pub zlib: bool,
    pub required_features: Vec<String>,
}

impl Fixture {
    pub fn sample() -> Self {
        Self {
            nodes: vec![
                Node {
                    id: 1,
                    lon: 139.699,
                    lat: 35.7,
                },
                Node {
                    id: 2,
                    lon: 139.7,
                    lat: 35.7,
                },
                Node {
                    id: 3,
                    lon: 139.701,
                    lat: 35.701,
                },
            ],
            ways: vec![Way {
                id: 10,
                nodes: vec![1, 2, 3],
                tags: BTreeMap::from([("highway".into(), "residential".into())]),
            }],
            dense: false,
            ways_first: false,
            zlib: false,
            required_features: vec!["OsmSchema-V0.6".into(), "DenseNodes".into()],
        }
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut header = Vec::new();
        for feature in &self.required_features {
            bytes(&mut header, 4, feature.as_bytes());
        }
        let mut result = frame("OSMHeader", &header, self.zlib);
        let nodes = frame("OSMData", &self.node_block(), self.zlib);
        let ways = frame("OSMData", &self.way_block(), self.zlib);
        if self.ways_first {
            result.extend(ways);
            result.extend(nodes);
        } else {
            result.extend(nodes);
            result.extend(ways);
        }
        result
    }

    pub fn write(&self, path: &Path) {
        std::fs::write(path, self.bytes()).expect("write fixture");
    }

    fn node_block(&self) -> Vec<u8> {
        let mut group = Vec::new();
        if self.dense {
            let mut dense = Vec::new();
            let mut ids = Vec::new();
            let mut lons = Vec::new();
            let mut lats = Vec::new();
            let (mut old_id, mut old_lon, mut old_lat) = (0, 0, 0);
            for node in &self.nodes {
                let lon = (node.lon * 1e7).round() as i64;
                let lat = (node.lat * 1e7).round() as i64;
                varint(&mut ids, zigzag(node.id - old_id));
                varint(&mut lons, zigzag(lon - old_lon));
                varint(&mut lats, zigzag(lat - old_lat));
                (old_id, old_lon, old_lat) = (node.id, lon, lat);
            }
            bytes(&mut dense, 1, &ids);
            bytes(&mut dense, 8, &lats);
            bytes(&mut dense, 9, &lons);
            bytes(&mut group, 2, &dense);
        } else {
            for node in &self.nodes {
                let mut raw = Vec::new();
                integer(&mut raw, 1, zigzag(node.id));
                integer(&mut raw, 8, zigzag((node.lat * 1e7).round() as i64));
                integer(&mut raw, 9, zigzag((node.lon * 1e7).round() as i64));
                bytes(&mut group, 1, &raw);
            }
        }
        block(&[String::new()], &group)
    }

    fn way_block(&self) -> Vec<u8> {
        let mut group = Vec::new();
        let mut strings = vec![String::new()];
        for way in &self.ways {
            let mut raw = Vec::new();
            integer(&mut raw, 1, way.id as u64);
            let mut keys = Vec::new();
            let mut vals = Vec::new();
            for (key, value) in &way.tags {
                varint(&mut keys, strings.len() as u64);
                strings.push(key.clone());
                varint(&mut vals, strings.len() as u64);
                strings.push(value.clone());
            }
            bytes(&mut raw, 2, &keys);
            bytes(&mut raw, 3, &vals);
            let mut refs = Vec::new();
            let mut old_id = 0;
            for id in &way.nodes {
                varint(&mut refs, zigzag(id - old_id));
                old_id = *id;
            }
            bytes(&mut raw, 8, &refs);
            bytes(&mut group, 3, &raw);
        }
        block(&strings, &group)
    }
}

pub fn block(strings: &[String], group: &[u8]) -> Vec<u8> {
    let mut string_table = Vec::new();
    for value in strings {
        bytes(&mut string_table, 1, value.as_bytes());
    }
    let mut block = Vec::new();
    bytes(&mut block, 1, &string_table);
    bytes(&mut block, 2, group);
    block
}

pub fn frame(kind: &str, payload: &[u8], zlib: bool) -> Vec<u8> {
    let mut blob = Vec::new();
    if zlib {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(payload).unwrap();
        integer(&mut blob, 2, payload.len() as u64);
        bytes(&mut blob, 3, &encoder.finish().unwrap());
    } else {
        bytes(&mut blob, 1, payload);
    }
    raw_frame(kind, &blob)
}

pub fn raw_frame(kind: &str, blob: &[u8]) -> Vec<u8> {
    let mut header = Vec::new();
    bytes(&mut header, 1, kind.as_bytes());
    integer(&mut header, 3, blob.len() as u64);
    let mut result = (header.len() as u32).to_be_bytes().to_vec();
    result.extend(header);
    result.extend(blob);
    result
}

pub fn bytes(out: &mut Vec<u8>, tag: u64, value: &[u8]) {
    varint(out, tag * 8 + 2);
    varint(out, value.len() as u64);
    out.extend(value);
}

pub fn integer(out: &mut Vec<u8>, tag: u64, value: u64) {
    varint(out, tag * 8);
    varint(out, value);
}

pub fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        out.push(value as u8 | 128);
        value >>= 7;
    }
    out.push(value as u8);
}

pub fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}
