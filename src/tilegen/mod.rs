//! GeoCode-Web-Singleが管理するオフラインOSM取り込みとラスタ生成。
//! OSM-Tile-Generatorのコミット5d96058296f891af32f23690d02cbae6de11c533から移植した。

pub mod cancel;
pub mod dataset;
pub mod execution;
pub mod geometry;
pub mod identity;
pub mod import;
pub mod metrics;
pub mod operation;
pub mod pbf;
pub mod render_spec;
pub mod renderer;
pub mod simplify;
pub mod standard;
pub mod store;
pub mod style;
pub mod tile;

#[cfg(test)]
pub(crate) mod test_support;
