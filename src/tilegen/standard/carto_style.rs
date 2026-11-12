//! OSM標準風の地図専用の配色と線幅。従来の描画設定とは独立して識別する。

use crate::tilegen::{
    identity::IdentityHasher,
    render_spec::RenderSpec,
    style::{RoadAttributes, RoadClass, Style},
};

use super::model::FeatureKind;

pub const STYLE_VERSION: &str = "osm-like-v1";
pub const BACKGROUND: [u8; 4] = [242, 239, 233, 255];
pub const SEA: [u8; 4] = [170, 211, 223, 255];
pub const BUILDING_OUTLINE: [u8; 4] = [172, 163, 154, 255];
pub const BRIDGE_CASING: [u8; 4] = [102, 102, 102, 255];
pub const TUNNEL_CASING: [u8; 4] = [153, 153, 153, 255];
const STRUCTURE_MIN_ZOOM: u8 = 13;

pub fn feature_color(kind: FeatureKind) -> [u8; 4] {
    match kind {
        FeatureKind::Land => BACKGROUND,
        FeatureKind::Forest => [173, 209, 158, 255],
        FeatureKind::Grass => [205, 235, 176, 255],
        FeatureKind::Park => [200, 250, 204, 255],
        FeatureKind::Farmland => [238, 240, 213, 255],
        FeatureKind::Residential => [224, 223, 223, 255],
        FeatureKind::Commercial => [242, 218, 217, 255],
        FeatureKind::Industrial => [235, 219, 232, 255],
        FeatureKind::Sand => [245, 233, 198, 255],
        FeatureKind::BareRock => [238, 229, 220, 255],
        FeatureKind::Wetland => [205, 229, 210, 255],
        FeatureKind::Water => SEA,
        FeatureKind::Building => [217, 208, 201, 255],
        FeatureKind::Waterway => [115, 182, 210, 255],
        FeatureKind::Railway => [112, 112, 112, 255],
        FeatureKind::Contour => [177, 149, 119, 255],
    }
}

fn effective_road_attributes(mut attributes: RoadAttributes, zoom: u8) -> RoadAttributes {
    // 低ズームの短い橋・トンネルを太い丸点として強調しない。
    // 取り込み属性と描画順は保持し、配色・寸法・破線の判定だけ通常道路に揃える。
    if zoom < STRUCTURE_MIN_ZOOM {
        attributes.structure_rank = 1;
    }
    attributes
}

pub fn road_color(attributes: RoadAttributes, zoom: u8, casing: bool) -> [u8; 4] {
    let attributes = effective_road_attributes(attributes, zoom);
    if casing && attributes.structure_rank == 2 {
        return BRIDGE_CASING;
    }
    if casing && attributes.structure_rank == 0 {
        return TUNNEL_CASING;
    }
    let (edge, fill) = match attributes.road_class {
        RoadClass::Motorway => ([195, 98, 116, 255], [233, 144, 160, 255]),
        RoadClass::Trunk => ([208, 147, 90, 255], [249, 178, 156, 255]),
        RoadClass::Primary => ([187, 155, 92, 255], [252, 214, 164, 255]),
        RoadClass::Secondary => ([170, 161, 106, 255], [247, 250, 191, 255]),
        RoadClass::Tertiary => ([187, 187, 187, 255], [255, 255, 255, 255]),
        RoadClass::Residential | RoadClass::Service => ([189, 189, 189, 255], [255, 255, 255, 255]),
        RoadClass::Path => ([250, 249, 247, 255], [177, 137, 119, 255]),
    };
    if casing {
        edge
    } else if attributes.structure_rank == 0 {
        // トンネル内側は同じ道路分類の色を明るくして地上部と区別する。
        [
            ((u16::from(fill[0]) + 255) / 2) as u8,
            ((u16::from(fill[1]) + 255) / 2) as u8,
            ((u16::from(fill[2]) + 255) / 2) as u8,
            255,
        ]
    } else {
        fill
    }
}

pub fn road_width(attributes: RoadAttributes, zoom: u8, casing: bool) -> f64 {
    let attributes = effective_road_attributes(attributes, zoom);
    let width = f64::from(Style::roads_v1().width(attributes, zoom)) * 1.25;
    width
        + if casing {
            if attributes.structure_rank == 2 {
                2.0
            } else {
                1.1
            }
        } else {
            0.0
        }
}

pub fn road_dash(attributes: RoadAttributes, zoom: u8, casing: bool) -> Option<(f64, f64)> {
    let attributes = effective_road_attributes(attributes, zoom);
    if attributes.structure_rank == 0 && casing {
        Some((5.0, 3.0))
    } else if attributes.road_class == RoadClass::Path && !casing {
        Some((3.0, 2.0))
    } else {
        None
    }
}

pub fn style_hash() -> String {
    let mut spec = RenderSpec::osm_like();
    spec.contours = true;
    spec.hillshade = true;
    style_hash_for(&spec)
}

pub fn style_hash_for(spec: &RenderSpec) -> String {
    let mut hash = IdentityHasher::new("geocode-osm-like-style-v1");
    hash.text(STYLE_VERSION);
    hash.text(&super::paint::carto_parameters_hash(spec));
    for code in [
        1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150,
    ] {
        let kind = FeatureKind::from_code(code).expect("固定した地物分類");
        if (kind == FeatureKind::Building && !spec.buildings)
            || (kind == FeatureKind::Contour && !spec.contours)
        {
            continue;
        }
        hash.bytes(&feature_color(kind));
    }
    if spec.buildings {
        hash.bytes(&BUILDING_OUTLINE);
    }
    if spec.roads {
        for class in RoadClass::ALL {
            for structure in 0..=2 {
                for is_link in [false, true] {
                    let attributes = RoadAttributes {
                        road_class: class,
                        is_link,
                        effective_layer: 0,
                        structure_rank: structure,
                    };
                    for casing in [false, true] {
                        for zoom in 0..=22 {
                            hash.u8(u8::from(Style::roads_v1().visible(attributes, zoom)));
                            hash.bytes(&road_color(attributes, zoom, casing));
                            hash.bytes(&road_width(attributes, zoom, casing).to_le_bytes());
                            if let Some((on, off)) = road_dash(attributes, zoom, casing) {
                                hash.u8(1);
                                hash.bytes(&on.to_le_bytes());
                                hash.bytes(&off.to_le_bytes());
                            } else {
                                hash.u8(0);
                            }
                        }
                    }
                }
            }
        }
    }
    hash.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 低ズームの橋とトンネルは通常道路と同色同幅同破線になる() {
        for road_class in RoadClass::ALL {
            for is_link in [false, true] {
                let ground = RoadAttributes {
                    road_class,
                    is_link,
                    effective_layer: 0,
                    structure_rank: 1,
                };
                for structure_rank in [0, 2] {
                    let structure = RoadAttributes {
                        structure_rank,
                        ..ground
                    };
                    for zoom in 0..13 {
                        for casing in [false, true] {
                            assert_eq!(
                                road_color(ground, zoom, casing),
                                road_color(structure, zoom, casing)
                            );
                            assert_eq!(
                                road_width(ground, zoom, casing),
                                road_width(structure, zoom, casing)
                            );
                            assert_eq!(
                                road_dash(ground, zoom, casing),
                                road_dash(structure, zoom, casing)
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn ズーム十三以上で橋の縁とトンネルの破線を強調する() {
        let ground = RoadAttributes {
            road_class: RoadClass::Primary,
            is_link: false,
            effective_layer: 0,
            structure_rank: 1,
        };
        let bridge = RoadAttributes {
            structure_rank: 2,
            ..ground
        };
        let tunnel = RoadAttributes {
            structure_rank: 0,
            ..ground
        };
        for zoom in 13..=22 {
            assert_eq!(road_color(bridge, zoom, true), BRIDGE_CASING);
            assert!(road_width(bridge, zoom, true) > road_width(ground, zoom, true));
            assert_eq!(road_color(tunnel, zoom, true), TUNNEL_CASING);
            assert_eq!(road_dash(tunnel, zoom, true), Some((5.0, 3.0)));
            assert_ne!(
                road_color(tunnel, zoom, false),
                road_color(ground, zoom, false)
            );
        }
    }
}
