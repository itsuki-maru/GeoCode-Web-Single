//! Rust と SQLite で OSM の道路を取り込み、ネットワーク接続なしで経路を求める。
mod build;
pub(crate) mod catalog;
pub mod config;
pub(crate) mod http;
mod profile;
mod restrictions;
mod search;

use anyhow::{Result, ensure};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub use build::build;
pub(crate) use build::build_with_progress;
pub use search::{search, search_with_check, search_with_radii};

const SCHEMA: u32 = 1;
const PROFILE_VERSION: &str = "car-foot-jp-v1";
const APPLICATION_ID: i64 = 0x47575254;
pub(crate) const SNAP_RADIUS_M: f64 = 500.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TravelMode {
    Car,
    Foot,
}

impl TravelMode {
    fn number(self) -> i32 {
        match self {
            Self::Car => 0,
            Self::Foot => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Coord {
    pub lat: f64,
    pub lon: f64,
}

impl Coord {
    fn validate(self) -> Result<()> {
        ensure!(
            (-90.0..=90.0).contains(&self.lat) && (-180.0..=180.0).contains(&self.lon),
            "緯度・経度が範囲外です"
        );
        Ok(())
    }

    fn distance(self, other: Self) -> f64 {
        let h = ((other.lat - self.lat).to_radians() / 2.0).sin().powi(2)
            + self.lat.to_radians().cos()
                * other.lat.to_radians().cos()
                * ((other.lon - self.lon).to_radians() / 2.0).sin().powi(2);
        12_742_017.6 * h.clamp(0.0, 1.0).sqrt().asin()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphInfo {
    pub schema_version: u32,
    pub profile_version: String,
    pub source_sha256: String,
    pub node_count: u64,
    pub edge_count: u64,
    pub restriction_count: u64,
    pub excluded_restriction_count: u64,
    #[serde(default)]
    pub outside_restriction_count: u64,
    pub conditional_way_count: u64,
    pub conditional_node_count: u64,
    pub bounds: Bounds,
    pub attribution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteResult {
    pub geometry: Vec<Coord>,
    pub distance_m: f64,
    pub duration_s: f64,
    pub snapped_start: Coord,
    pub snapped_end: Coord,
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("指定位置の近くに通行可能な道路がありません")]
    NoSnap,
    #[error("出発地点から到着地点まで通行可能な経路がありません")]
    NoRoute,
}

fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let id: i64 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        id == APPLICATION_ID && version == SCHEMA,
        "対応する経路データではありません"
    );
    Ok(conn)
}

pub fn inspect(path: &Path) -> Result<GraphInfo> {
    let conn = open(path)?;
    let json: String = conn.query_row("SELECT info FROM metadata WHERE id=1", [], |r| r.get(0))?;
    let info: GraphInfo = serde_json::from_str(&json)?;
    ensure!(
        info.schema_version == SCHEMA
            && info.profile_version == PROFILE_VERSION
            && info.edge_count > 0
            && info.node_count > 0,
        "経路データのメタ情報が不正です"
    );
    Ok(info)
}

#[cfg(test)]
mod tests;
