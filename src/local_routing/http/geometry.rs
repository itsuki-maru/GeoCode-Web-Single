use super::Failure;
use crate::{
    local_routing::{Coord, RouteResult},
    tilegen::{geometry::Point, simplify::simplify_with_check},
};
use serde_json::json;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

pub(super) fn response(
    start: Coord,
    end: Coord,
    route: &RouteResult,
    check: &dyn Fn() -> Result<(), Failure>,
) -> Result<Vec<u8>, Failure> {
    overview(start, end, route, check, MAX_RESPONSE_BYTES)
}

fn overview(
    start: Coord,
    end: Coord,
    route: &RouteResult,
    check: &dyn Fn() -> Result<(), Failure>,
    limit: usize,
) -> Result<Vec<u8>, Failure> {
    // 元の経緯度を使い、形状を簡略化しても経路の両端を元の位置に保つ。
    let points: Vec<Point> = route
        .geometry
        .iter()
        .map(|p| Point { x: p.lon, y: p.lat })
        .collect();
    let mut fixed = vec![false; points.len()];
    for (i, pair) in points.windows(2).enumerate() {
        if (pair[1].x - pair[0].x).abs() > 180. {
            fixed[i] = true;
            fixed[i + 1] = true;
        }
    }
    let waypoint = |input: Coord, snapped: Coord| {
        json!({
            "location": [snapped.lon, snapped.lat], "name": "", "distance": input.distance(snapped),
        })
    };
    let waypoints = [
        waypoint(start, route.snapped_start),
        waypoint(end, route.snapped_end),
    ];
    // 線分からのずれを約2 mまで許容して簡略化を始める。
    // 許容値を広げても両端を残し、距離と所要時間は元の経路の値を返す。
    let mut tolerance = 2.0 / 111_320.0;
    while tolerance <= 360. {
        let simplified =
            simplify_with_check(&points, &fixed, tolerance, || check().map_err(Into::into))
                .map_err(|error| {
                    error
                        .downcast_ref::<Failure>()
                        .copied()
                        .unwrap_or(Failure::Unavailable)
                })?;
        let geometry = polyline(&simplified);
        if geometry.len() < limit {
            let bytes = serde_json::to_vec(&json!({
                "code": "Ok", "waypoints": waypoints,
                "routes": [{"distance": route.distance_m, "duration": route.duration_s, "geometry": geometry}]
            })).map_err(|_| Failure::Unavailable)?;
            if bytes.len() <= limit {
                return Ok(bytes);
            }
        }
        tolerance *= 2.;
    }
    Err(Failure::TooBig)
}

fn polyline(points: &[Point]) -> String {
    fn delta(out: &mut String, value: i32) {
        let mut bits = ((value << 1) ^ (value >> 31)) as u32;
        while bits >= 0x20 {
            out.push(((bits & 0x1f) as u8 + 0x20 + 63) as char);
            bits >>= 5;
        }
        out.push((bits as u8 + 63) as char);
    }
    let mut result = String::new();
    let (mut previous_lat, mut previous_lon) = (0, 0);
    for p in points {
        let lat = (p.y * 1e5).round() as i32;
        let lon = (p.x * 1e5).round() as i32;
        delta(&mut result, lat - previous_lat);
        delta(&mut result, lon - previous_lon);
        previous_lat = lat;
        previous_lon = lon;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn osrm_polyline_precision_and_axis_order() {
        let points = [
            Point { x: -120.2, y: 38.5 },
            Point {
                x: -120.95,
                y: 40.7,
            },
            Point {
                x: -126.453,
                y: 43.252,
            },
        ];
        assert_eq!(polyline(&points), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
        assert_eq!(polyline(&[points[0], points[0]]), "_p~iF~ps|U??");
    }

    #[test]
    fn a_large_overview_fits_the_wire_budget_and_keeps_its_endpoints() {
        let points: Vec<_> = (0..1000)
            .map(|i| Coord {
                lon: 139. + f64::from(i) * 0.001,
                lat: 37. + f64::from(i % 2) * 0.0001,
            })
            .collect();
        let (start, end) = (points[0], points[points.len() - 1]);
        let result = RouteResult {
            geometry: points,
            distance_m: 12500.,
            duration_s: 700.,
            snapped_start: start,
            snapped_end: end,
        };
        let wire = overview(start, end, &result, &|| Ok(()), 350).unwrap();
        assert!(wire.len() <= 350);
        let json: Value = serde_json::from_slice(&wire).unwrap();
        let expected = polyline(&[
            Point {
                x: start.lon,
                y: start.lat,
            },
            Point {
                x: end.lon,
                y: end.lat,
            },
        ]);
        assert_eq!(json["routes"][0]["geometry"], expected);
        assert_eq!(json["routes"][0]["distance"], 12500.);
    }
}
