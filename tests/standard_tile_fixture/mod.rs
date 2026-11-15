//! ローカル地図のAPI・実exe試験で共用する、小さな入力資料。

#[path = "../tilegen_support/mod.rs"]
mod support;

use geocode_web_single::tilegen::pbf::{Node, Way};
use std::{collections::BTreeMap, path::Path};

pub fn write_inputs(pbf: &Path, dem: &Path) {
    let mut fixture = support::Fixture::sample();
    fixture.dense = true;
    fixture.ways_first = true;
    fixture.zlib = true;
    fixture.nodes.extend([
        Node {
            id: 20,
            lon: 139.6998,
            lat: 35.6998,
        },
        Node {
            id: 21,
            lon: 139.7002,
            lat: 35.6998,
        },
        Node {
            id: 22,
            lon: 139.7002,
            lat: 35.7002,
        },
        Node {
            id: 23,
            lon: 139.6998,
            lat: 35.7002,
        },
    ]);
    fixture.ways.push(Way {
        id: 20,
        nodes: vec![20, 21, 22, 23, 20],
        tags: BTreeMap::from([("building".into(), "yes".into())]),
    });
    fixture.write(pbf);
    let cells = (0..8)
        .flat_map(|y| (0..8).map(move |x| format!("地表面,{}", 100 + 20 * x + 10 * y)))
        .collect::<Vec<_>>()
        .join("\n");
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM>
<gml:boundedBy><gml:Envelope srsName="fguuid:jgd2024.bl">
<gml:lowerCorner>{:.15} {:.15}</gml:lowerCorner><gml:upperCorner>{:.15} {:.15}</gml:upperCorner>
</gml:Envelope></gml:boundedBy><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>7 7</gml:high></gml:GridEnvelope>
<gml:sequenceRule order="+x-y">Linear</gml:sequenceRule><gml:startPoint>0 0</gml:startPoint>
<gml:tupleList>{cells}</gml:tupleList></DEM></Dataset>"#,
        35.7 - 4.0 / 3600.0,
        139.7 - 4.0 / 3600.0,
        35.7 + 4.0 / 3600.0,
        139.7 + 4.0 / 3600.0
    );
    std::fs::write(dem, xml).unwrap();
}
