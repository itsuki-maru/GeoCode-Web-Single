use std::str::FromStr;

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use crate::tilegen::geometry::{MAX_LAT, Point, Rect, project};

pub const TILE_SIZE: u32 = 256;
pub const MAX_ZOOM: u8 = 22;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileId {
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

impl TileId {
    pub fn new(z: u8, x: u32, y: u32) -> Result<Self> {
        ensure!(z <= MAX_ZOOM, "zoom must be <= {MAX_ZOOM}");
        let n = 1_u32 << z;
        ensure!(x < n && y < n, "invalid XYZ tile {z}/{x}/{y}");
        Ok(Self { z, x, y })
    }

    pub fn bounds(self) -> Rect {
        let n = 2_f64.powi(self.z.into());
        Rect {
            min_x: f64::from(self.x) / n,
            max_x: (f64::from(self.x) + 1.0) / n,
            min_y: f64::from(self.y) / n,
            max_y: (f64::from(self.y) + 1.0) / n,
        }
    }

    pub fn from_lon_lat(z: u8, lon: f64, lat: f64) -> Result<Self> {
        ensure!(z <= MAX_ZOOM, "zoom must be <= {MAX_ZOOM}");
        let point = project(lon, lat)?;
        let n = 1_u32 << z;
        Self::new(
            z,
            (point.x * f64::from(n))
                .floor()
                .clamp(0.0, f64::from(n - 1)) as u32,
            (point.y * f64::from(n))
                .floor()
                .clamp(0.0, f64::from(n - 1)) as u32,
        )
    }
}

impl std::fmt::Display for TileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}/{}", self.z, self.x, self.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GeoBbox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl GeoBbox {
    pub fn new(west: f64, south: f64, east: f64, north: f64) -> Result<Self> {
        ensure!(
            [west, south, east, north].iter().all(|v| v.is_finite()),
            "bbox values must be finite"
        );
        ensure!(
            -180.0 <= west && west < east && east <= 180.0,
            "bbox requires -180 <= west < east <= 180; antimeridian crossing is unsupported"
        );
        ensure!(
            -MAX_LAT <= south && south < north && north <= MAX_LAT,
            "bbox requires -{MAX_LAT} <= south < north <= {MAX_LAT}"
        );
        Ok(Self {
            west,
            south,
            east,
            north,
        })
    }

    pub fn projected(self) -> Result<Rect> {
        Self::new(self.west, self.south, self.east, self.north)?;
        let Point { x: min_x, y: min_y } = project(self.west, self.north)?;
        let Point { x: max_x, y: max_y } = project(self.east, self.south)?;
        Rect::new(min_x, max_x, min_y, max_y)
    }
}

impl FromStr for GeoBbox {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        let parts: Vec<f64> = s
            .split(',')
            .map(str::trim)
            .map(str::parse)
            .collect::<std::result::Result<_, _>>()?;
        ensure!(parts.len() == 4, "bbox must be west,south,east,north");
        Self::new(parts[0], parts[1], parts[2], parts[3])
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ZoomCount {
    pub zoom: u8,
    pub count: u64,
}

#[derive(Debug, Clone, Copy)]
struct TileRange {
    z: u8,
    min_x: u32,
    max_x: u32,
    min_y: u32,
    max_y: u32,
}

#[derive(Debug, Clone)]
pub struct TilePlan {
    ranges: Vec<TileRange>,
    total: u64,
}

impl TilePlan {
    pub fn new(bbox: GeoBbox, min_zoom: u8, max_zoom: u8) -> Result<Self> {
        ensure!(
            min_zoom <= max_zoom && max_zoom <= MAX_ZOOM,
            "require 0 <= min-zoom <= max-zoom <= {MAX_ZOOM}"
        );
        let rect = bbox.projected()?;
        let mut ranges = Vec::new();
        let mut total = 0_u64;
        for z in min_zoom..=max_zoom {
            let n = 1_u32 << z;
            let (min_x, max_x) =
                axis_range(rect.min_x * f64::from(n), rect.max_x * f64::from(n), n);
            let (min_y, max_y) =
                axis_range(rect.min_y * f64::from(n), rect.max_y * f64::from(n), n);
            let count = u64::from(max_x - min_x + 1)
                .checked_mul(u64::from(max_y - min_y + 1))
                .ok_or_else(|| anyhow::anyhow!("tile count overflow"))?;
            total = total
                .checked_add(count)
                .ok_or_else(|| anyhow::anyhow!("tile count overflow"))?;
            ranges.push(TileRange {
                z,
                min_x,
                max_x,
                min_y,
                max_y,
            });
        }
        Ok(Self { ranges, total })
    }

    pub fn count(&self) -> u64 {
        self.total
    }

    pub fn contains(&self, tile: TileId) -> bool {
        self.ranges.iter().any(|range| {
            range.z == tile.z
                && range.min_x <= tile.x
                && tile.x <= range.max_x
                && range.min_y <= tile.y
                && tile.y <= range.max_y
        })
    }

    pub fn zoom_counts(&self) -> Vec<ZoomCount> {
        self.ranges
            .iter()
            .map(|r| ZoomCount {
                zoom: r.z,
                count: u64::from(r.max_x - r.min_x + 1) * u64::from(r.max_y - r.min_y + 1),
            })
            .collect()
    }

    pub fn iter(&self) -> TileIter<'_> {
        let first = self.ranges.first();
        TileIter {
            ranges: &self.ranges,
            index: 0,
            x: first.map_or(0, |r| r.min_x),
            y: first.map_or(0, |r| r.min_y),
        }
    }
}

fn snap(value: f64) -> f64 {
    let integer = value.round();
    let ulp = (value.abs().next_up() - value.abs()).max(integer.abs().next_up() - integer.abs());
    if (value - integer).abs() <= 4.0 * ulp {
        integer
    } else {
        value
    }
}

fn axis_range(min: f64, max: f64, n: u32) -> (u32, u32) {
    let (mut a, mut b) = (snap(min), snap(max));
    // 丸め精度より狭くても、幅が正の区間はタイルを覆う。
    if a >= b {
        a = min;
        b = max;
    }
    let first = a.floor().clamp(0.0, f64::from(n - 1)) as u32;
    let last = (b.ceil() - 1.0).clamp(0.0, f64::from(n - 1)) as u32;
    // 度で表した有効な区間が、投影後には1つのf64座標へ潰れる場合がある。
    // 枚数計算をアンダーフローさせず、空でない安全側のタイル範囲を保持する。
    (first, last.max(first))
}

pub struct TileIter<'a> {
    ranges: &'a [TileRange],
    index: usize,
    x: u32,
    y: u32,
}

impl Iterator for TileIter<'_> {
    type Item = TileId;

    fn next(&mut self) -> Option<Self::Item> {
        let range = self.ranges.get(self.index)?;
        let tile = TileId {
            z: range.z,
            x: self.x,
            y: self.y,
        };
        if self.y < range.max_y {
            self.y += 1;
        } else if self.x < range.max_x {
            self.x += 1;
            self.y = range.min_y;
        } else {
            self.index += 1;
            if let Some(next) = self.ranges.get(self.index) {
                self.x = next.min_x;
                self.y = next.min_y;
            }
        }
        Some(tile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_ulp_bbox_still_selects_a_tile_without_count_underflow() {
        let bbox = GeoBbox::new(0.0, 0.0, 1e-20, 1e-20).unwrap();
        let plan = TilePlan::new(bbox, 14, 14).unwrap();
        assert_eq!(plan.count(), 1);
        assert_eq!(plan.iter().count(), 1);
        assert!(plan.contains(plan.iter().next().unwrap()));
    }

    #[test]
    fn validates_tiles_and_world_edges() {
        assert!(TileId::new(23, 0, 0).is_err());
        assert!(TileId::new(1, 2, 0).is_err());
        assert_eq!(
            TileId::from_lon_lat(22, 180.0, -MAX_LAT).unwrap(),
            TileId::new(22, (1 << 22) - 1, (1 << 22) - 1).unwrap()
        );
        assert_eq!(
            TileId::from_lon_lat(0, -180.0, MAX_LAT).unwrap(),
            TileId::new(0, 0, 0).unwrap()
        );
    }

    #[test]
    fn exact_boundaries_and_lazy_order() {
        let bbox = GeoBbox::new(-180.0, 0.0, 0.0, MAX_LAT).unwrap();
        let plan = TilePlan::new(bbox, 1, 1).unwrap();
        assert_eq!(plan.count(), 1);
        assert_eq!(
            plan.iter().collect::<Vec<_>>(),
            vec![TileId::new(1, 0, 0).unwrap()]
        );
        let world = TilePlan::new(
            GeoBbox::new(-180.0, -MAX_LAT, 180.0, MAX_LAT).unwrap(),
            0,
            22,
        )
        .unwrap();
        assert_eq!(world.count(), (4_u64.pow(23) - 1) / 3);
        assert_eq!(
            world.iter().take(3).collect::<Vec<_>>(),
            vec![
                TileId::new(0, 0, 0).unwrap(),
                TileId::new(1, 0, 0).unwrap(),
                TileId::new(1, 0, 1).unwrap()
            ]
        );
    }

    #[test]
    fn japan_count_and_invalid_bbox() {
        let bbox: GeoBbox = "122,20,154,46".parse().unwrap();
        assert_eq!(TilePlan::new(bbox, 14, 14).unwrap().count(), 2_090_795);
        assert_eq!(TilePlan::new(bbox, 16, 16).unwrap().count(), 33_417_936);
        assert!("170,20,-170,40".parse::<GeoBbox>().is_err());
        assert!("1,2,3".parse::<GeoBbox>().is_err());
        assert!(TilePlan::new(bbox, 16, 15).is_err());
    }
}
