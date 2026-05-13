use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TilePathParams {
    pub z: u32,
    pub x: u32,
    pub y_png: String,
}
