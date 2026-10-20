use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportLayers {
    pub layer_name: String,
    pub is_master: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportMarkers {
    pub marker_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub detail: String,
    pub layer: ImportLayers,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportShapes {
    pub shape_type: String,
    pub name: Option<String>,
    pub geojson: Value,
    pub layer: ImportLayers,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImportPackage {
    pub version: Option<u32>,
    pub markers: Vec<ImportMarkers>,
    #[serde(default)]
    pub shapes: Vec<ImportShapes>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn import_package_accepts_legacy_exported_ids() {
        let legacy_json = json!({
            "version": 2,
            "markers": [{
                "id": "018f4f43-7a8c-7000-8000-000000000001",
                "user_id": "018f4f43-7a8c-7000-8000-000000000002",
                "layer_id": "018f4f43-7a8c-7000-8000-000000000003",
                "marker_name": "marker",
                "latitude": 35.0,
                "longitude": 139.0,
                "detail": "detail",
                "layer": {
                    "id": "018f4f43-7a8c-7000-8000-000000000003",
                    "user_id": "018f4f43-7a8c-7000-8000-000000000002",
                    "layer_name": "layer",
                    "is_master": false
                }
            }],
            "shapes": [{
                "id": "018f4f43-7a8c-7000-8000-000000000004",
                "user_id": "018f4f43-7a8c-7000-8000-000000000002",
                "layer_id": "018f4f43-7a8c-7000-8000-000000000003",
                "shape_type": "polygon",
                "name": "shape",
                "geojson": {"type": "Feature", "properties": {}, "geometry": null},
                "layer": {
                    "id": "018f4f43-7a8c-7000-8000-000000000003",
                    "user_id": "018f4f43-7a8c-7000-8000-000000000002",
                    "layer_name": "layer",
                    "is_master": false
                }
            }]
        });

        let package: ImportPackage =
            serde_json::from_value(legacy_json).expect("legacy export remains importable");

        assert_eq!(package.markers[0].layer.layer_name, "layer");
        assert_eq!(package.shapes[0].layer.layer_name, "layer");
    }
}
