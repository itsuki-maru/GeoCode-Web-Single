use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};

pub const MAX_LAT: f64 = 85.051_128_779_806_6;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

impl Rect {
    pub fn new(min_x: f64, max_x: f64, min_y: f64, max_y: f64) -> Result<Self> {
        ensure!(
            [min_x, max_x, min_y, max_y].iter().all(|n| n.is_finite())
                && min_x <= max_x
                && min_y <= max_y,
            "invalid projected rectangle"
        );
        Ok(Self {
            min_x,
            max_x,
            min_y,
            max_y,
        })
    }

    pub fn from_points(points: &[Point]) -> Result<Self> {
        let Some(first) = points.first() else {
            bail!("empty geometry");
        };
        let mut rect = Self::new(first.x, first.x, first.y, first.y)?;
        for point in points.iter().skip(1) {
            ensure!(
                point.x.is_finite() && point.y.is_finite(),
                "non-finite geometry coordinate"
            );
            rect.min_x = rect.min_x.min(point.x);
            rect.max_x = rect.max_x.max(point.x);
            rect.min_y = rect.min_y.min(point.y);
            rect.max_y = rect.max_y.max(point.y);
        }
        Ok(rect)
    }

    pub fn expand(self, amount: f64) -> Self {
        Self {
            min_x: self.min_x - amount,
            max_x: self.max_x + amount,
            min_y: self.min_y - amount,
            max_y: self.max_y + amount,
        }
    }

    pub fn intersects(self, other: Self) -> bool {
        self.max_x >= other.min_x
            && self.min_x <= other.max_x
            && self.max_y >= other.min_y
            && self.min_y <= other.max_y
    }

    pub fn contains(self, point: Point) -> bool {
        point.x >= self.min_x
            && point.x <= self.max_x
            && point.y >= self.min_y
            && point.y <= self.max_y
    }
}

pub fn project(lon: f64, lat: f64) -> Result<Point> {
    ensure!(
        lon.is_finite() && lat.is_finite(),
        "longitude and latitude must be finite"
    );
    ensure!(
        (-180.0..=180.0).contains(&lon),
        "longitude must be in [-180, 180]"
    );
    ensure!(
        (-90.0..=90.0).contains(&lat),
        "latitude must be in [-90, 90]"
    );
    // 超越関数の計算には、すべてのOSで同じソフトウェア実装を使う。
    // ここで1 ULP異なるだけでも、対称な閉じたWayの基準点の選択が変わり得る。
    let phi = lat.clamp(-MAX_LAT, MAX_LAT) * (std::f64::consts::PI / 180.0);
    Ok(Point {
        x: (lon + 180.0) / 360.0,
        y: ((1.0 - libm::asinh(libm::tan(phi)) / std::f64::consts::PI) / 2.0).clamp(0.0, 1.0),
    })
}

pub fn crosses_antimeridian(longitudes: &[f64]) -> bool {
    longitudes
        .windows(2)
        .any(|pair| (pair[0] - pair[1]).abs() > 180.0)
}

/// 局所ラスタ座標へ変換する前に、f64でLiang-Barsky法による切り抜きを行う。
pub fn clip_segment(a: Point, b: Point, rect: Rect) -> Option<(Point, Point)> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut enter: f64 = 0.0;
    let mut exit: f64 = 1.0;
    for (p, q) in [
        (-dx, a.x - rect.min_x),
        (dx, rect.max_x - a.x),
        (-dy, a.y - rect.min_y),
        (dy, rect.max_y - a.y),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                enter = enter.max(t);
            } else {
                exit = exit.min(t);
            }
            if enter > exit {
                return None;
            }
        }
    }
    let interpolate = |t: f64| {
        if t == 0.0 {
            a
        } else if t == 1.0 {
            b
        } else {
            Point {
                x: a.x + t * dx,
                y: a.y + t * dy,
            }
        }
    };
    Some((interpolate(enter), interpolate(exit)))
}

/// つながっていない可視区間を、それぞれ独立した部分パスとして保持する。
pub fn clip_polyline(points: &[Point], rect: Rect) -> Vec<Vec<Point>> {
    let mut paths = Vec::new();
    let mut current = Vec::new();
    for pair in points.windows(2) {
        if let Some((a, b)) = clip_segment(pair[0], pair[1], rect) {
            if current.last().is_some_and(|last| *last != a) {
                paths.push(std::mem::take(&mut current));
            }
            if current.is_empty() {
                current.push(a);
            }
            current.push(b);
        } else if !current.is_empty() {
            paths.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        paths.push(current);
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_edges_and_invalid_values() {
        assert_eq!(project(0.0, 0.0).unwrap(), Point { x: 0.5, y: 0.5 });
        assert_eq!(project(-180.0, 0.0).unwrap().x, 0.0);
        assert_eq!(project(180.0, 0.0).unwrap().x, 1.0);
        assert!(project(0.0, MAX_LAT).unwrap().y < 1e-15);
        assert!((project(0.0, -MAX_LAT).unwrap().y - 1.0).abs() < 1e-15);
        assert_eq!(project(0.0, 90.0).unwrap(), project(0.0, MAX_LAT).unwrap());
        assert!(project(f64::NAN, 1.0).is_err());
        assert!(project(181.0, 1.0).is_err());
        assert!(project(0.0, 91.0).is_err());
        assert!(crosses_antimeridian(&[179.9, -179.9]));
        assert!(!crosses_antimeridian(&[139.0, 140.0]));
    }

    #[test]
    fn clips_crossing_line_without_inside_vertices() {
        let rect = Rect::new(0.0, 1.0, 0.0, 1.0).unwrap();
        let paths = clip_polyline(&[Point { x: -2.0, y: 0.5 }, Point { x: 3.0, y: 0.5 }], rect);
        assert_eq!(
            paths,
            vec![vec![Point { x: 0.0, y: 0.5 }, Point { x: 1.0, y: 0.5 }]]
        );
        assert!(clip_segment(Point { x: 2.0, y: -1.0 }, Point { x: 2.0, y: 2.0 }, rect).is_none());
    }

    #[test]
    fn disjoint_intervals_are_not_connected() {
        let rect = Rect::new(0.0, 1.0, 0.0, 1.0).unwrap();
        let paths = clip_polyline(
            &[
                Point { x: -1.0, y: 0.2 },
                Point { x: 2.0, y: 0.2 },
                Point { x: 2.0, y: 0.8 },
                Point { x: -1.0, y: 0.8 },
            ],
            rect,
        );
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].last().unwrap().y, 0.2);
        assert_eq!(paths[1][0].y, 0.8);
    }
}
