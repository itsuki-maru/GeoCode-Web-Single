use crate::error::AppError;
use serde_json::Value;

type Coordinate = (f64, f64);
const SHAPE_MEMO_MAX_LENGTH: usize = 10_000;

fn validation_error(message: &str) -> AppError {
    AppError::Validation(message.to_string())
}

pub fn validate_shape_geojson(shape_type: &str, geojson: &Value) -> Result<(), AppError> {
    let expected_geometry_type = match shape_type {
        "polygon" | "rectangle" => "Polygon",
        "polyline" => "LineString",
        "circle" => "Point",
        _ => return Err(validation_error("対応していない図形種別です。")),
    };

    let feature = geojson
        .as_object()
        .ok_or_else(|| validation_error("GeoJSON Featureが不正です。"))?;
    if feature.get("type").and_then(Value::as_str) != Some("Feature") {
        return Err(validation_error(
            "GeoJSONのtypeはFeatureである必要があります。",
        ));
    }

    let geometry = feature
        .get("geometry")
        .and_then(Value::as_object)
        .ok_or_else(|| validation_error("GeoJSON geometryが不正です。"))?;
    if geometry.get("type").and_then(Value::as_str) != Some(expected_geometry_type) {
        return Err(validation_error(
            "図形種別とGeoJSON geometry.typeが一致しません。",
        ));
    }
    let coordinates = geometry
        .get("coordinates")
        .ok_or_else(|| validation_error("GeoJSON coordinatesがありません。"))?;

    validate_shape_memo(feature.get("properties"))?;

    match shape_type {
        "polygon" => validate_polygon(coordinates, false),
        "rectangle" => validate_polygon(coordinates, true),
        "polyline" => validate_polyline(coordinates),
        "circle" => validate_circle(coordinates, feature.get("properties")),
        _ => unreachable!(),
    }
}

fn validate_shape_memo(properties: Option<&Value>) -> Result<(), AppError> {
    let Some(memo) = properties
        .and_then(Value::as_object)
        .and_then(|properties| properties.get("memo"))
    else {
        return Ok(());
    };

    if memo.is_null() {
        return Ok(());
    }
    let memo = memo
        .as_str()
        .ok_or_else(|| validation_error("図形メモは文字列で指定してください。"))?;
    if memo.chars().count() > SHAPE_MEMO_MAX_LENGTH {
        return Err(validation_error(
            "図形メモは10000文字以内で入力してください。",
        ));
    }
    Ok(())
}

fn validate_position(value: &Value) -> Result<Coordinate, AppError> {
    let position = value
        .as_array()
        .filter(|position| position.len() >= 2)
        .ok_or_else(|| validation_error("座標は経度と緯度の配列である必要があります。"))?;
    let longitude = position[0]
        .as_f64()
        .filter(|value| value.is_finite() && (-180.0..=180.0).contains(value))
        .ok_or_else(|| validation_error("経度は-180から180の範囲で指定してください。"))?;
    let latitude = position[1]
        .as_f64()
        .filter(|value| value.is_finite() && (-90.0..=90.0).contains(value))
        .ok_or_else(|| validation_error("緯度は-90から90の範囲で指定してください。"))?;
    Ok((longitude, latitude))
}

fn validate_polyline(coordinates: &Value) -> Result<(), AppError> {
    let positions = coordinates
        .as_array()
        .ok_or_else(|| validation_error("折れ線の座標が不正です。"))?;
    if positions.len() < 2 {
        return Err(validation_error("折れ線は2頂点以上必要です。"));
    }
    for position in positions {
        validate_position(position)?;
    }
    Ok(())
}

fn validate_polygon(coordinates: &Value, is_rectangle: bool) -> Result<(), AppError> {
    let rings = coordinates
        .as_array()
        .filter(|rings| !rings.is_empty())
        .ok_or_else(|| validation_error("ポリゴンの座標リングがありません。"))?;
    if is_rectangle && rings.len() != 1 {
        return Err(validation_error(
            "矩形は1つの座標リングで指定してください。",
        ));
    }

    for ring in rings {
        let positions = ring
            .as_array()
            .ok_or_else(|| validation_error("ポリゴンの座標リングが不正です。"))?;
        if positions.len() < 4 {
            return Err(validation_error("ポリゴンは3頂点以上必要です。"));
        }
        if is_rectangle && positions.len() != 5 {
            return Err(validation_error("矩形は4頂点で指定してください。"));
        }

        let parsed_positions = positions
            .iter()
            .map(validate_position)
            .collect::<Result<Vec<_>, _>>()?;
        if parsed_positions.first() != parsed_positions.last() {
            return Err(validation_error("ポリゴンの座標リングが閉じていません。"));
        }

        let mut unique_vertices = Vec::new();
        for position in &parsed_positions[..parsed_positions.len() - 1] {
            if !unique_vertices.contains(position) {
                unique_vertices.push(*position);
            }
        }
        let required_vertices = if is_rectangle { 4 } else { 3 };
        if unique_vertices.len() < required_vertices {
            return Err(validation_error(if is_rectangle {
                "矩形は異なる4頂点が必要です。"
            } else {
                "ポリゴンは異なる3頂点以上が必要です。"
            }));
        }
    }
    Ok(())
}

fn validate_circle(coordinates: &Value, properties: Option<&Value>) -> Result<(), AppError> {
    validate_position(coordinates)?;
    properties
        .and_then(Value::as_object)
        .and_then(|properties| properties.get("radius"))
        .and_then(Value::as_f64)
        .filter(|radius| radius.is_finite() && *radius > 0.0)
        .ok_or_else(|| validation_error("円の半径は正の数で指定してください。"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_shape_geojson;
    use serde_json::json;

    #[test]
    fn accepts_valid_supported_shapes() {
        let cases = [
            (
                "polygon",
                json!({
                    "type": "Feature",
                    "properties": {},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 35.0]]]
                    }
                }),
            ),
            (
                "polyline",
                json!({
                    "type": "Feature",
                    "properties": {},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[139.0, 35.0], [140.0, 36.0]]
                    }
                }),
            ),
            (
                "rectangle",
                json!({
                    "type": "Feature",
                    "properties": {},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[
                            [139.0, 35.0],
                            [140.0, 35.0],
                            [140.0, 36.0],
                            [139.0, 36.0],
                            [139.0, 35.0]
                        ]]
                    }
                }),
            ),
            (
                "circle",
                json!({
                    "type": "Feature",
                    "properties": {"radius": 100.0},
                    "geometry": {"type": "Point", "coordinates": [139.0, 35.0]}
                }),
            ),
        ];

        for (shape_type, geojson) in cases {
            assert!(validate_shape_geojson(shape_type, &geojson).is_ok());
        }
    }

    #[test]
    fn rejects_shapes_below_minimum_vertex_count() {
        let polygon = json!({
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[139.0, 35.0], [140.0, 36.0], [139.0, 35.0]]]
            }
        });
        let polyline = json!({
            "type": "Feature",
            "properties": {},
            "geometry": {"type": "LineString", "coordinates": [[139.0, 35.0]]}
        });

        assert!(validate_shape_geojson("polygon", &polygon).is_err());
        assert!(validate_shape_geojson("polyline", &polyline).is_err());
    }

    #[test]
    fn rejects_unclosed_polygon_and_invalid_coordinate_range() {
        let unclosed = json!({
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 36.0]]]
            }
        });
        let invalid_coordinate = json!({
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "LineString",
                "coordinates": [[181.0, 35.0], [140.0, 36.0]]
            }
        });

        assert!(validate_shape_geojson("polygon", &unclosed).is_err());
        assert!(validate_shape_geojson("polyline", &invalid_coordinate).is_err());
    }

    #[test]
    fn rejects_mismatched_geometry_and_invalid_circle_radius() {
        let mismatched = json!({
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "LineString",
                "coordinates": [[139.0, 35.0], [140.0, 36.0]]
            }
        });
        let invalid_circle = json!({
            "type": "Feature",
            "properties": {"radius": 0},
            "geometry": {"type": "Point", "coordinates": [139.0, 35.0]}
        });

        assert!(validate_shape_geojson("polygon", &mismatched).is_err());
        assert!(validate_shape_geojson("circle", &invalid_circle).is_err());
    }

    #[test]
    fn accepts_markdown_shape_memo_and_null_memo() {
        for memo in [json!("## メモ\n\n- 項目"), json!(null)] {
            let geojson = json!({
                "type": "Feature",
                "properties": {"memo": memo},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[139.0, 35.0], [140.0, 36.0]]
                }
            });
            assert!(validate_shape_geojson("polyline", &geojson).is_ok());
        }
    }

    #[test]
    fn rejects_non_string_and_overlong_shape_memo() {
        for memo in [json!({"text": "memo"}), json!("a".repeat(10_001))] {
            let geojson = json!({
                "type": "Feature",
                "properties": {"memo": memo},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[139.0, 35.0], [140.0, 36.0]]
                }
            });
            assert!(validate_shape_geojson("polyline", &geojson).is_err());
        }
    }
}
