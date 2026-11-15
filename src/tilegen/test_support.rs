#![allow(dead_code)]

use crate::tilegen::pbf::{MemberKind, Node, Relation, Way};
use flate2::{Compression, write::ZlibEncoder};
use std::{collections::BTreeMap, io::Write, path::Path};

/// 本番の読み取り処理とは独立して符号化する、小さなPBF試験データ。
pub struct Fixture {
    pub nodes: Vec<Node>,
    pub node_tags: BTreeMap<i64, BTreeMap<String, String>>,
    pub ways: Vec<Way>,
    pub relations: Vec<Relation>,
    pub relations_first: bool,
    pub dense: bool,
    pub ways_first: bool,
    pub zlib: bool,
    pub required_features: Vec<String>,
}

impl Fixture {
    pub fn sample() -> Self {
        Self {
            node_tags: BTreeMap::new(),
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
            relations: Vec::new(),
            relations_first: false,
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
        if self.relations_first && !self.relations.is_empty() {
            result.extend(frame("OSMData", &self.relation_block(), self.zlib));
        }
        let nodes = frame("OSMData", &self.node_block(), self.zlib);
        let ways = frame("OSMData", &self.way_block(), self.zlib);
        if self.ways_first {
            result.extend(ways);
            result.extend(nodes);
        } else {
            result.extend(nodes);
            result.extend(ways);
        }
        if !self.relations_first && !self.relations.is_empty() {
            result.extend(frame("OSMData", &self.relation_block(), self.zlib));
        }
        result
    }

    pub fn write(&self, path: &Path) {
        std::fs::write(path, self.bytes()).expect("write fixture");
    }

    fn node_block(&self) -> Vec<u8> {
        let mut group = Vec::new();
        let mut strings = vec![String::new()];
        if self.dense {
            let mut dense = Vec::new();
            let mut ids = Vec::new();
            let mut lons = Vec::new();
            let mut lats = Vec::new();
            let mut keys_vals = Vec::new();
            let (mut old_id, mut old_lon, mut old_lat) = (0, 0, 0);
            for node in &self.nodes {
                let lon = (node.lon * 1e7).round() as i64;
                let lat = (node.lat * 1e7).round() as i64;
                varint(&mut ids, zigzag(node.id - old_id));
                varint(&mut lons, zigzag(lon - old_lon));
                varint(&mut lats, zigzag(lat - old_lat));
                (old_id, old_lon, old_lat) = (node.id, lon, lat);
                if !self.node_tags.is_empty() {
                    if let Some(tags) = self.node_tags.get(&node.id) {
                        for (key, value) in tags {
                            varint(&mut keys_vals, strings.len() as u64);
                            strings.push(key.clone());
                            varint(&mut keys_vals, strings.len() as u64);
                            strings.push(value.clone());
                        }
                    }
                    varint(&mut keys_vals, 0);
                }
            }
            bytes(&mut dense, 1, &ids);
            bytes(&mut dense, 8, &lats);
            bytes(&mut dense, 9, &lons);
            if !keys_vals.is_empty() {
                bytes(&mut dense, 10, &keys_vals);
            }
            bytes(&mut group, 2, &dense);
        } else {
            for node in &self.nodes {
                let mut raw = Vec::new();
                integer(&mut raw, 1, zigzag(node.id));
                integer(&mut raw, 8, zigzag((node.lat * 1e7).round() as i64));
                integer(&mut raw, 9, zigzag((node.lon * 1e7).round() as i64));
                if let Some(tags) = self.node_tags.get(&node.id) {
                    let (mut keys, mut values) = (Vec::new(), Vec::new());
                    for (key, value) in tags {
                        varint(&mut keys, strings.len() as u64);
                        strings.push(key.clone());
                        varint(&mut values, strings.len() as u64);
                        strings.push(value.clone());
                    }
                    bytes(&mut raw, 2, &keys);
                    bytes(&mut raw, 3, &values);
                }
                bytes(&mut group, 1, &raw);
            }
        }
        block(&strings, &group)
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

    fn relation_block(&self) -> Vec<u8> {
        let mut group = Vec::new();
        let mut strings = vec![String::new()];
        for relation in &self.relations {
            let mut raw = Vec::new();
            integer(&mut raw, 1, relation.id as u64);
            let (mut keys, mut vals) = (Vec::new(), Vec::new());
            for (key, value) in &relation.tags {
                varint(&mut keys, strings.len() as u64);
                strings.push(key.clone());
                varint(&mut vals, strings.len() as u64);
                strings.push(value.clone());
            }
            bytes(&mut raw, 2, &keys);
            bytes(&mut raw, 3, &vals);
            let (mut roles, mut ids, mut types) = (Vec::new(), Vec::new(), Vec::new());
            let mut previous = 0;
            for member in &relation.members {
                varint(&mut roles, strings.len() as u64);
                strings.push(member.role.clone());
                varint(&mut ids, zigzag(member.id - previous));
                previous = member.id;
                varint(
                    &mut types,
                    match member.kind {
                        MemberKind::Node => 0,
                        MemberKind::Way => 1,
                        MemberKind::Relation => 2,
                    },
                );
            }
            bytes(&mut raw, 8, &roles);
            bytes(&mut raw, 9, &ids);
            bytes(&mut raw, 10, &types);
            bytes(&mut group, 4, &raw);
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
