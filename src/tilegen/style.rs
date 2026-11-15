use std::collections::BTreeMap;

use super::identity::IdentityHasher;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

pub const IMPORT_RULES_VERSION: &str = "roads-import-v2-project-libm-0.2.16-soft";
pub const STYLE_VERSION: &str = "roads-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(u8)]
pub enum RoadClass {
    Path = 10,
    Service = 20,
    Residential = 30,
    Tertiary = 40,
    Secondary = 50,
    Primary = 60,
    Trunk = 70,
    Motorway = 80,
}

impl RoadClass {
    pub const ALL: [Self; 8] = [
        Self::Path,
        Self::Service,
        Self::Residential,
        Self::Tertiary,
        Self::Secondary,
        Self::Primary,
        Self::Trunk,
        Self::Motorway,
    ];

    pub fn from_code(value: i64) -> Result<Self> {
        match value {
            10 => Ok(Self::Path),
            20 => Ok(Self::Service),
            30 => Ok(Self::Residential),
            40 => Ok(Self::Tertiary),
            50 => Ok(Self::Secondary),
            60 => Ok(Self::Primary),
            70 => Ok(Self::Trunk),
            80 => Ok(Self::Motorway),
            _ => bail!("unknown road class code {value}"),
        }
    }

    pub fn priority(self) -> u8 {
        self as u8
    }

    fn parameters(self) -> (u8, [f32; 3]) {
        match self {
            Self::Motorway => (6, [2.5, 5.0, 9.0]),
            Self::Trunk => (7, [2.0, 4.5, 8.0]),
            Self::Primary => (8, [1.8, 4.0, 7.0]),
            Self::Secondary => (9, [1.5, 3.0, 6.0]),
            Self::Tertiary => (10, [1.2, 2.5, 5.0]),
            Self::Residential => (12, [1.0, 2.0, 4.0]),
            Self::Service => (14, [0.8, 1.2, 2.5]),
            Self::Path => (14, [0.6, 0.8, 1.5]),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoadAttributes {
    pub road_class: RoadClass,
    pub is_link: bool,
    pub effective_layer: i16,
    pub structure_rank: u8,
}

/// 属性の正規化は取り込み時の規則であり、線幅や表示条件から独立している。
/// 取り込み操作は、操作モニターを通じて警告を取得できる。
pub fn normalize_tags(tags: &BTreeMap<String, String>) -> Option<RoadAttributes> {
    normalize_tags_with_diagnostics(tags, |_| {})
}

pub(crate) fn normalize_tags_with_diagnostics(
    tags: &BTreeMap<String, String>,
    mut warn: impl FnMut(&str),
) -> Option<RoadAttributes> {
    if tags.get("area").is_some_and(|value| value == "yes") {
        return None;
    }
    let highway = tags.get("highway")?.as_str();
    let (road_class, is_link) = match highway {
        "motorway" => (RoadClass::Motorway, false),
        "motorway_link" => (RoadClass::Motorway, true),
        "trunk" => (RoadClass::Trunk, false),
        "trunk_link" => (RoadClass::Trunk, true),
        "primary" => (RoadClass::Primary, false),
        "primary_link" => (RoadClass::Primary, true),
        "secondary" => (RoadClass::Secondary, false),
        "secondary_link" => (RoadClass::Secondary, true),
        "tertiary" => (RoadClass::Tertiary, false),
        "tertiary_link" => (RoadClass::Tertiary, true),
        "unclassified" | "residential" => (RoadClass::Residential, false),
        "living_street" | "service" => (RoadClass::Service, false),
        "pedestrian" | "footway" | "cycleway" | "path" | "track" | "steps" => {
            (RoadClass::Path, false)
        },
        _ => return None,
    };
    let present = |key: &str| {
        tags.get(key)
            .is_some_and(|value| !value.is_empty() && value != "no")
    };
    let bridge = present("bridge");
    let tunnel = present("tunnel");
    let structure_rank = match (bridge, tunnel) {
        (true, false) => 2,
        (false, true) => 0,
        _ => 1,
    };
    if bridge && tunnel {
        warn("bridge and tunnel are both set; using ordinary structure rank");
    }
    let explicit_layer = tags
        .get("layer")
        .and_then(|value| match value.trim().parse::<i16>() {
            Ok(layer) => Some(layer),
            Err(_) => {
                // 制御文字はデバッグ用エスケープで長くなる場合があり、タグ値にも
                // 任意の長さがあり得るため、整形前に入力の長さを制限する。
                const SAMPLE_BYTES: usize = 48;
                let mut end = value.len().min(SAMPLE_BYTES);
                while !value.is_char_boundary(end) {
                    end -= 1;
                }
                let sample = &value[..end];
                let truncated = if end < value.len() {
                    " (sample truncated)"
                } else {
                    ""
                };
                warn(&format!(
                    "invalid layer {sample:?}{truncated}; applying renderer default"
                ));
                None
            },
        });
    let effective_layer = explicit_layer.unwrap_or(match (bridge, tunnel) {
        (true, false) => 1,
        (false, true) => -1,
        _ => 0,
    });
    Some(RoadAttributes {
        road_class,
        is_link,
        effective_layer,
        structure_rank,
    })
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Style;

/// 描画と識別の両方が参照する設定。演算順序の変更は描画互換性版で管理する。
struct StyleSpec {
    background: [u8; 4],
    casing: [u8; 4],
    road: [u8; 4],
    path: [u8; 4],
    link_width_scale: f32,
    casing_width: f32,
    width_zoom_knots: [u8; 3],
    link_visibility_delay: u8,
    antialias_margin: u32,
}

const ROAD_STYLE: StyleSpec = StyleSpec {
    background: [245, 244, 239, 255],
    casing: [187, 170, 153, 255],
    road: [225, 165, 105, 255],
    path: [183, 173, 161, 255],
    link_width_scale: 0.8,
    casing_width: 1.0,
    width_zoom_knots: [10, 14, 18],
    link_visibility_delay: 1,
    antialias_margin: 2,
};

impl Style {
    pub const BACKGROUND: [u8; 4] = ROAD_STYLE.background;
    pub const CASING: [u8; 4] = ROAD_STYLE.casing;
    pub const ROAD: [u8; 4] = ROAD_STYLE.road;
    pub const PATH: [u8; 4] = ROAD_STYLE.path;

    pub fn roads_v1() -> Self {
        Self
    }

    pub fn visible(&self, attributes: RoadAttributes, zoom: u8) -> bool {
        let min_zoom = attributes.road_class.parameters().0
            + if attributes.is_link {
                ROAD_STYLE.link_visibility_delay
            } else {
                0
            };
        zoom >= min_zoom
    }

    pub fn width(&self, attributes: RoadAttributes, zoom: u8) -> f32 {
        let (_, widths) = attributes.road_class.parameters();
        let [first, second, third] = ROAD_STYLE.width_zoom_knots;
        let width = if zoom <= first {
            widths[0]
        } else if zoom <= second {
            widths[0]
                + (widths[1] - widths[0]) * f32::from(zoom - first) / f32::from(second - first)
        } else if zoom < third {
            widths[1]
                + (widths[2] - widths[1]) * f32::from(zoom - second) / f32::from(third - second)
        } else {
            widths[2]
        };
        if attributes.is_link {
            width * ROAD_STYLE.link_width_scale
        } else {
            width
        }
    }

    pub fn outer_width(&self, attributes: RoadAttributes, zoom: u8) -> f32 {
        self.width(attributes, zoom) + ROAD_STYLE.casing_width
    }

    pub fn max_outer_width(&self, zoom: u8) -> f32 {
        RoadClass::ALL
            .into_iter()
            .filter_map(|road_class| {
                let attributes = RoadAttributes {
                    road_class,
                    is_link: false,
                    effective_layer: 0,
                    structure_rank: 1,
                };
                self.visible(attributes, zoom)
                    .then(|| self.outer_width(attributes, zoom))
            })
            .fold(0.0, f32::max)
    }

    pub fn buffer(&self, zoom: u8) -> u32 {
        let max = self.max_outer_width(zoom);
        if max == 0.0 {
            0
        } else {
            (max / 2.0).ceil() as u32 + ROAD_STYLE.antialias_margin
        }
    }

    pub fn color(&self, attributes: RoadAttributes, casing: bool) -> [u8; 4] {
        if casing {
            Self::CASING
        } else if attributes.road_class == RoadClass::Path {
            Self::PATH
        } else {
            Self::ROAD
        }
    }

    pub fn hash(&self) -> String {
        let mut hash = IdentityHasher::new("geocode-road-style-v2");
        hash.text(STYLE_VERSION);
        for class in RoadClass::ALL {
            let (min_zoom, widths) = class.parameters();
            hash.u8(class as u8);
            hash.u8(min_zoom);
            for width in widths {
                hash.f32(width);
            }
        }
        for color in [
            ROAD_STYLE.background,
            ROAD_STYLE.casing,
            ROAD_STYLE.road,
            ROAD_STYLE.path,
        ] {
            hash.bytes(&color);
        }
        hash.f32(ROAD_STYLE.link_width_scale);
        hash.f32(ROAD_STYLE.casing_width);
        hash.bytes(&ROAD_STYLE.width_zoom_knots);
        hash.u8(ROAD_STYLE.link_visibility_delay);
        hash.u32(ROAD_STYLE.antialias_margin);
        hash.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(highway: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("highway".into(), highway.into())])
    }

    #[test]
    fn extraction_is_explicit_and_links_keep_parent_class() {
        for value in ["construction", "proposed", "raceway", "other"] {
            assert!(normalize_tags(&tags(value)).is_none());
        }
        let mut area = tags("pedestrian");
        area.insert("area".into(), "yes".into());
        assert!(normalize_tags(&area).is_none());
        let link = normalize_tags(&tags("primary_link")).unwrap();
        assert_eq!(link.road_class, RoadClass::Primary);
        assert!(link.is_link);
        let style = Style::roads_v1();
        assert!(!style.visible(link, 8));
        assert!(style.visible(link, 9));
        assert!((style.width(link, 14) - 3.2).abs() < 1e-6);
    }

    #[test]
    fn layer_policy_is_explicit_and_deterministic() {
        let mut t = tags("motorway");
        t.insert("bridge".into(), "yes".into());
        let bridge = normalize_tags(&t).unwrap();
        assert_eq!((bridge.effective_layer, bridge.structure_rank), (1, 2));
        t.insert("layer".into(), "-2".into());
        assert_eq!(normalize_tags(&t).unwrap().effective_layer, -2);
        t.insert("layer".into(), "invalid".into());
        assert_eq!(normalize_tags(&t).unwrap().effective_layer, 1);
        t.insert("tunnel".into(), "yes".into());
        let conflict = normalize_tags(&t).unwrap();
        assert_eq!((conflict.effective_layer, conflict.structure_rank), (0, 1));
    }

    #[test]
    fn normalization_diagnostics_preserve_the_silent_api_attributes() {
        let mut tags = tags("motorway_link");
        tags.insert("bridge".into(), "yes".into());
        tags.insert("tunnel".into(), "yes".into());
        tags.insert("layer".into(), "invalid".into());
        let mut warnings = Vec::new();
        let attributes =
            normalize_tags_with_diagnostics(&tags, |warning| warnings.push(warning.to_owned()));
        assert_eq!(attributes, normalize_tags(&tags));
        assert_eq!(
            attributes,
            Some(RoadAttributes {
                road_class: RoadClass::Motorway,
                is_link: true,
                effective_layer: 0,
                structure_rank: 1,
            })
        );
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("bridge and tunnel are both set"));
        assert_eq!(
            warnings[1],
            "invalid layer \"invalid\"; applying renderer default"
        );

        tags.insert("layer".into(), " -2 ".into());
        tags.remove("tunnel");
        let attributes = normalize_tags_with_diagnostics(&tags, |_| {
            panic!("valid layers and a single structure do not emit warnings")
        })
        .unwrap();
        assert_eq!(
            (attributes.effective_layer, attributes.structure_rank),
            (-2, 2)
        );
        assert_eq!(Some(attributes), normalize_tags(&tags));
    }

    #[test]
    fn layer_diagnostic_samples_are_bounded_before_escaping() {
        let mut tags = tags("primary");
        for value in [
            "\0".repeat(10_000),
            format!("{}{}", "a".repeat(47), "あ".repeat(10_000)),
        ] {
            tags.insert("layer".into(), value);
            let mut warnings = Vec::new();
            let attributes =
                normalize_tags_with_diagnostics(&tags, |warning| warnings.push(warning.to_owned()))
                    .unwrap();
            assert_eq!(
                (attributes.effective_layer, attributes.structure_rank),
                (0, 1)
            );
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("(sample truncated)"));
            assert!(warnings[0].len() < 400);
            assert!(!warnings[0].contains('\0'));
        }
    }

    #[test]
    fn zoom_widths_and_buffer() {
        let attrs = normalize_tags(&tags("motorway")).unwrap();
        let style = Style::roads_v1();
        assert_eq!(style.width(attrs, 6), 2.5);
        assert_eq!(style.width(attrs, 12), 3.75);
        assert_eq!(style.width(attrs, 16), 7.0);
        assert_eq!(style.width(attrs, 22), 9.0);
        assert_eq!(style.buffer(5), 0);
        assert_eq!(style.buffer(18), 7);
        assert_eq!(style.hash().len(), 64);
    }
}
