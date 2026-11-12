//! 固定した旧実装と現在の実装へ同じ形状を渡す、描画比較用の入力。

use std::collections::BTreeMap;

use crate::tilegen::{
    geometry::Point,
    renderer::Candidate,
    style::{RoadAttributes, RoadClass},
    tile::TileId,
};

pub struct GoldenCase {
    pub name: String,
    pub tile: TileId,
    pub candidates: Vec<Candidate>,
    pub geometries: BTreeMap<i64, Vec<Point>>,
}

fn points(tile: TileId, pixels: &[(f64, f64)]) -> Vec<Point> {
    let scale = 2_f64.powi(tile.z.into());
    pixels
        .iter()
        .map(|&(x, y)| Point {
            x: (f64::from(tile.x) + x / 256.0) / scale,
            y: (f64::from(tile.y) + y / 256.0) / scale,
        })
        .collect()
}

fn add(
    case: &mut GoldenCase,
    origin: TileId,
    class: RoadClass,
    link: bool,
    layer: i16,
    rank: u8,
    path: &[(f64, f64)],
) {
    let id = case.candidates.len() as i64 + 1;
    case.candidates.push(Candidate {
        id,
        osm_way_id: 1000 - id,
        attrs: RoadAttributes {
            road_class: class,
            is_link: link,
            effective_layer: layer,
            structure_rank: rank,
        },
    });
    case.geometries.insert(id, points(origin, path));
}

fn empty(name: String, tile: TileId) -> GoldenCase {
    GoldenCase {
        name,
        tile,
        candidates: Vec::new(),
        geometries: BTreeMap::new(),
    }
}

pub fn cases() -> Vec<GoldenCase> {
    let classes = [
        RoadClass::Path,
        RoadClass::Service,
        RoadClass::Residential,
        RoadClass::Tertiary,
        RoadClass::Secondary,
        RoadClass::Primary,
        RoadClass::Trunk,
        RoadClass::Motorway,
    ];
    let mut cases = Vec::new();
    // 全クラスを各表示境界の前後で描き、線幅補間とリンクの表示条件も固定する。
    for zoom in [
        0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    ] {
        let tile = TileId::new(zoom, (1_u32 << zoom) / 2, (1_u32 << zoom) / 2).unwrap();
        let mut case = empty(format!("classes-z{zoom:02}"), tile);
        for (index, class) in classes.iter().copied().enumerate() {
            let y = 20.25 + index as f64 * 28.0;
            add(
                &mut case,
                tile,
                class,
                false,
                0,
                1,
                &[(-50.0, y), (100.125, y + 3.25), (300.0, y - 1.5)],
            );
            add(
                &mut case,
                tile,
                class,
                true,
                0,
                1,
                &[(-50.0, y + 11.0), (130.75, y + 14.5), (300.0, y + 10.5)],
            );
        }
        cases.push(case);
    }
    let tile = TileId::new(18, 131072, 131072).unwrap();
    let mut case = empty("layers-round-caps-loops".into(), tile);
    add(
        &mut case,
        tile,
        RoadClass::Motorway,
        false,
        -1,
        0,
        &[(-100.0, 128.25), (400.0, 128.25)],
    );
    add(
        &mut case,
        tile,
        RoadClass::Path,
        false,
        1,
        2,
        &[(128.5, -100.0), (128.5, 400.0)],
    );
    add(
        &mut case,
        tile,
        RoadClass::Primary,
        false,
        0,
        1,
        &[
            (25.0, 25.0),
            (95.0, 25.0),
            (95.0, 95.0),
            (25.0, 95.0),
            (25.0, 25.0),
        ],
    );
    add(
        &mut case,
        tile,
        RoadClass::Residential,
        false,
        0,
        1,
        &[(155.5, 35.25), (155.625, 35.375)],
    );
    add(
        &mut case,
        tile,
        RoadClass::Secondary,
        false,
        0,
        1,
        &[
            (30.0, 200.0),
            (95.0, 150.0),
            (95.125, 150.5),
            (30.0, 200.0),
            (100.0, 220.0),
        ],
    );
    cases.push(case);
    // 同じ世界座標の形状を隣接する4タイルで描き、境界の丸めを固定する。
    for zoom in [14, 18, 22] {
        let origin = TileId::new(zoom, (1_u32 << zoom) / 2, (1_u32 << zoom) / 2).unwrap();
        for dy in 0..2 {
            for dx in 0..2 {
                let tile = TileId::new(zoom, origin.x + dx, origin.y + dy).unwrap();
                let mut case = empty(format!("seam-z{zoom}-{dx}-{dy}"), tile);
                add(
                    &mut case,
                    origin,
                    RoadClass::Motorway,
                    false,
                    0,
                    1,
                    &[
                        (-200.0, 10.25),
                        (100.25, 140.125),
                        (450.2, 120.7),
                        (620.0, 460.0),
                    ],
                );
                add(
                    &mut case,
                    origin,
                    RoadClass::Path,
                    false,
                    1,
                    2,
                    &[(10.5, -150.0), (310.75, 620.0)],
                );
                cases.push(case);
            }
        }
    }
    for (name, x, y) in [
        ("north-west", 0, 0),
        ("south-east", (1 << 22) - 1, (1 << 22) - 1),
    ] {
        let tile = TileId::new(22, x, y).unwrap();
        let mut case = empty(format!("world-{name}"), tile);
        add(
            &mut case,
            tile,
            RoadClass::Motorway,
            false,
            0,
            1,
            &[(0.25, 20.5), (125.25, 128.5), (255.5, 235.25)],
        );
        cases.push(case);
    }
    cases.push(empty("empty-z14".into(), TileId::new(14, 0, 0).unwrap()));
    cases
}
