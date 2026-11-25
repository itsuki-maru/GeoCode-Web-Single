//! 日本の普通乗用車と徒歩向けの、時刻に依存しない通行条件と推定速度。
use super::TravelMode;
use std::collections::BTreeMap;

type Tags = BTreeMap<String, String>;

struct AccessKey {
    base: &'static str,
    directional: [&'static str; 2],
    conditional: &'static str,
    conditional_directional: [&'static str; 2],
}

macro_rules! access_key {
    ($key:literal) => {
        AccessKey {
            base: $key,
            directional: [concat!($key, ":forward"), concat!($key, ":backward")],
            conditional: concat!($key, ":conditional"),
            conditional_directional: [
                concat!($key, ":forward:conditional"),
                concat!($key, ":backward:conditional"),
            ],
        }
    };
}

const CAR_KEYS: &[AccessKey] = &[
    access_key!("motorcar"),
    access_key!("motor_vehicle"),
    access_key!("vehicle"),
    access_key!("access"),
];
const FOOT_KEYS: &[AccessKey] = &[access_key!("foot"), access_key!("access")];

fn allowed(value: &str) -> bool {
    matches!(
        value,
        "yes" | "designated" | "permissive" | "official" | "public"
    )
}

/// 条件付きの許可だけでは通行を許さない。禁止が適用され得るときは常時除外する。
fn access(tags: &Tags, mode: TravelMode, direction: Option<usize>, default: bool) -> bool {
    let keys = match mode {
        TravelMode::Car => CAR_KEYS,
        TravelMode::Foot => FOOT_KEYS,
    };
    for key in keys {
        let conditional = direction
            .and_then(|d| tags.get(key.conditional_directional[d]))
            .or_else(|| tags.get(key.conditional));
        if conditional.is_some_and(|rules| {
            rules.split(';').any(|rule| {
                rule.split_once('@')
                    .is_none_or(|(value, _)| !allowed(value.trim()))
            })
        }) {
            return false;
        }
        let value = direction
            .and_then(|d| tags.get(key.directional[d]))
            .or_else(|| tags.get(key.base));
        if let Some(value) = value {
            // access=yes は歩道への普通車進入など、道路種別固有の制限を解除しない。
            return allowed(value) && (default || key.base != "access");
        }
    }
    default
}

fn tag<'a>(tags: &'a Tags, key: &str) -> &'a str {
    tags.get(key).map_or("", String::as_str)
}

fn open_all_day(tags: &Tags) -> bool {
    matches!(tag(tags, "opening_hours"), "" | "24/7") && tag(tags, "locked") != "yes"
}

pub(super) fn passable(tags: &Tags, mode: TravelMode) -> bool {
    if tags.is_empty() {
        return true;
    }
    // 明示的な通行許可があれば、通常閉じているゲート等も車種別に通せる。
    let barrier = tag(tags, "barrier");
    let default = match mode {
        TravelMode::Car => matches!(
            barrier,
            "" | "no" | "entrance" | "toll_booth" | "border_control" | "cattle_grid"
        ),
        TravelMode::Foot => matches!(
            barrier,
            "" | "no"
                | "entrance"
                | "gate"
                | "lift_gate"
                | "swing_gate"
                | "bollard"
                | "block"
                | "cycle_barrier"
                | "stile"
                | "kissing_gate"
                | "turnstile"
                | "cattle_grid"
                | "border_control"
                | "sally_port"
        ),
    };
    let public_gate =
        matches!(barrier, "gate" | "lift_gate" | "swing_gate") && allowed(tag(tags, "access"));
    (barrier.is_empty() || open_all_day(tags)) && access(tags, mode, None, default || public_gate)
}

fn road_speeds(highway: &str) -> Option<(f64, f64)> {
    Some(match highway {
        "motorway" => (90., 0.),
        "motorway_link" => (45., 0.),
        "trunk" => (55., 4.5),
        "primary" | "secondary" => (45., 4.5),
        "tertiary" | "unclassified" => (35., 4.5),
        "trunk_link" | "primary_link" | "secondary_link" | "tertiary_link" | "residential"
        | "road" => (25., 4.5),
        "living_street" | "service" => (15., 4.5),
        "track" => (10., 4.),
        "steps" => (0., 2.5),
        "footway" | "pedestrian" | "path" | "corridor" => (0., 4.5),
        "cycleway" | "bridleway" | "busway" | "bus_guideway" => (0., 0.),
        _ => return None,
    })
}

fn directions(tags: &Tags, mode: TravelMode, highway: &str) -> [bool; 2] {
    let keys: &[&str] = match mode {
        TravelMode::Car => &[
            "oneway:motorcar",
            "oneway:motor_vehicle",
            "oneway:vehicle",
            "oneway",
        ],
        TravelMode::Foot => &["oneway:foot"],
    };
    let conditional: &[&str] = match mode {
        TravelMode::Car => &[
            "oneway:motorcar:conditional",
            "oneway:motor_vehicle:conditional",
            "oneway:vehicle:conditional",
            "oneway:conditional",
        ],
        TravelMode::Foot => &["oneway:foot:conditional"],
    };
    if conditional.iter().any(|key| tags.contains_key(*key)) {
        return [false, false];
    }
    let explicit = keys
        .iter()
        .find_map(|key| tags.get(*key).map(String::as_str));
    match explicit {
        Some("yes" | "true" | "1") => [true, false],
        Some("-1" | "reverse") => [false, true],
        Some("no" | "false" | "0") => [true, true],
        Some(_) => [false, false], // reversible・alternating・未知の値
        None => match mode {
            TravelMode::Car if highway == "motorway" || tag(tags, "junction") == "roundabout" => {
                [true, false]
            },
            TravelMode::Foot if highway == "steps" => match tag(tags, "conveying") {
                "forward" => [true, false],
                "backward" => [false, true],
                _ => [true, true],
            },
            _ => [true, true],
        },
    }
}

fn speed_limit(value: &str) -> Option<f64> {
    let (number, factor) = if let Some(number) = value.strip_suffix("mph") {
        (number, 1.609344)
    } else {
        (value.strip_suffix("km/h").unwrap_or(value), 1.)
    };
    let speed = number.trim().parse::<f64>().ok()? * factor;
    (speed.is_finite() && speed > 0.).then_some(speed)
}

/// OSM wayの順方向、逆方向に割り当てる km/h。0 は通行不可。
pub(super) fn speeds(tags: &Tags, mode: TravelMode) -> [f64; 2] {
    let highway = tag(tags, "highway");
    let Some((car, foot)) = road_speeds(highway) else {
        return [0.; 2];
    };
    if tag(tags, "area") == "yes"
        || !open_all_day(tags)
        || tags.contains_key("construction") && tag(tags, "construction") != "no"
    {
        return [0.; 2];
    }
    let base = match mode {
        TravelMode::Car => car,
        TravelMode::Foot if tag(tags, "motorroad") == "yes" => 0.,
        TravelMode::Foot => foot,
    };
    let direction = directions(tags, mode, highway);
    std::array::from_fn(|d| {
        if !direction[d] || !access(tags, mode, Some(d), base > 0.) {
            return 0.;
        }
        match mode {
            TravelMode::Car => {
                let estimate = if base == 0. { 10. } else { base };
                let key = ["maxspeed:forward", "maxspeed:backward"][d];
                tags.get(key)
                    .or_else(|| tags.get("maxspeed"))
                    .and_then(|value| speed_limit(value))
                    .map_or(estimate, |limit| estimate.min(limit))
            },
            TravelMode::Foot => {
                if base == 0. {
                    4.5
                } else {
                    base
                }
            },
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use TravelMode::{Car, Foot};

    fn tags(pairs: &[(&str, &str)]) -> Tags {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn applies_oneway_and_access_to_each_mode_and_direction() {
        let road = tags(&[
            ("highway", "residential"),
            ("oneway", "-1"),
            ("foot:forward", "no"),
        ]);
        assert_eq!(speeds(&road, Car), [0., 25.]);
        assert_eq!(speeds(&road, Foot), [0., 4.5]);
        let steps = tags(&[
            ("highway", "steps"),
            ("access", "yes"),
            ("oneway:foot", "yes"),
        ]);
        assert_eq!(speeds(&steps, Car), [0., 0.]);
        assert_eq!(speeds(&steps, Foot), [2.5, 0.]);
        let motorway = tags(&[("highway", "motorway"), ("oneway", "no")]);
        assert_eq!(speeds(&motorway, Car), [90., 90.]);
        assert_eq!(speeds(&motorway, Foot), [0., 0.]);
    }

    #[test]
    fn respects_specific_permissions_barriers_and_static_speed_caps() {
        let road = tags(&[
            ("highway", "primary"),
            ("access", "private"),
            ("motor_vehicle", "yes"),
            ("maxspeed:forward", "10 mph"),
        ]);
        assert!((speeds(&road, Car)[0] - 16.09344).abs() < 0.001);
        assert_eq!(speeds(&road, Foot), [0., 0.]);
        let bollard = tags(&[("barrier", "bollard")]);
        assert!(!passable(&bollard, Car));
        assert!(passable(&bollard, Foot));
        assert!(!passable(
            &tags(&[("barrier", "bollard"), ("access", "yes")]),
            Car
        ));
        assert!(passable(
            &tags(&[("barrier", "gate"), ("access", "yes")]),
            Car
        ));
        assert!(passable(
            &tags(&[("shop", "bakery"), ("opening_hours", "Mo-Fr 09:00-18:00")]),
            Foot
        ));
        let conditional = tags(&[
            ("highway", "residential"),
            ("motor_vehicle:conditional", "no @ (Mo-Fr)"),
            ("oneway", "yes"),
        ]);
        assert_eq!(speeds(&conditional, Car), [0., 0.]);
        assert_eq!(speeds(&conditional, Foot), [4.5, 4.5]);
    }
}
