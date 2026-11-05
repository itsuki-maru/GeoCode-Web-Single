//! 全画面地図が保持している対象と表示設定を、追加検索せず共有用に固定する。
use crate::{
    error::AppError,
    model::{LayerObjectFromRow, MarkerObjectFromRow, ShapeObject, TileServers},
    shape_validation::validate_shape_geojson,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Sqlite, Transaction};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(super) const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OBJECTS: usize = 10_000;
const MAX_LAYERS: usize = 10_000;

pub(super) struct Snapshot {
    pub layers: HashMap<String, LayerObjectFromRow>,
    pub markers: HashMap<String, MarkerObjectFromRow>,
    pub shapes: HashMap<String, ShapeObject>,
    pub metadata: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    version: u8,
    state: State,
    layers: HashMap<String, Value>,
    markers: HashMap<String, Value>,
    shapes: Vec<Value>,
    tile_servers: HashMap<String, Value>,
    tile_overlays: Vec<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct State {
    view: View,
    tile_server_id: String,
    overlays: HashMap<Uuid, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    coloring: Option<Coloring>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    object_query: Option<String>,
    markers_visible: bool,
    shapes_visible: bool,
    shape_names_visible: bool,
    layer_ids: Option<Vec<Uuid>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    marker_ids: Option<Vec<Uuid>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shape_ids: Option<Vec<Uuid>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clustering_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clustering_allowed: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct View {
    latitude: f64,
    longitude: f64,
    zoom: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Coloring {
    version: u8,
    rules: Vec<ColorRule>,
    targets: HashMap<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ColorRule {
    id: String,
    label: String,
    color: String,
}

fn invalid() -> AppError {
    AppError::Validation("共有する地図の状態が不正です。地図を開き直してください。".into())
}

fn bounded_text(text: &str, max: usize) -> bool {
    text.chars().count() <= max
}

fn fields(value: &Value, allowed: &[&str]) -> Result<(), AppError> {
    if !value
        .as_object()
        .is_some_and(|o| o.keys().all(|key| allowed.contains(&key.as_str())))
    {
        return Err(invalid());
    }
    Ok(())
}

fn parse_id(key: &str, id: &str) -> Result<(), AppError> {
    if key != id {
        return Err(invalid());
    }
    Ok(())
}

// SQLiteのTEXT列へUUIDをBLOBとして渡さないよう、正規文字列へ揃える。
fn canonical_id(id: &str) -> Result<String, AppError> {
    Uuid::parse_str(id)
        .map(|id| id.to_string())
        .map_err(|_| invalid())
}

fn record_ids<'a>(ids: impl Iterator<Item = &'a String>) -> Result<HashSet<Uuid>, AppError> {
    ids.map(|id| Uuid::parse_str(id).map_err(|_| invalid()))
        .collect()
}

fn validate_ids(ids: &Option<Vec<Uuid>>, allowed: &HashSet<Uuid>) -> Result<(), AppError> {
    if let Some(ids) = ids {
        let unique: HashSet<_> = ids.iter().copied().collect();
        if unique.len() != ids.len() || &unique != allowed {
            return Err(invalid());
        }
    }
    Ok(())
}

/// 受信データを既存の共有保存型に変換する。未知の付随情報を公開へ持ち込まない。
pub(super) fn parse(value: Value, user: &str) -> Result<Snapshot, AppError> {
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid())?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::PayloadTooLarge(
            "共有する地図が32MiBを超えています。条件を絞ってください。".into(),
        ));
    }
    let mut input: Input = serde_json::from_value(value).map_err(|_| invalid())?;
    if input.markers.len() + input.shapes.len() > MAX_OBJECTS {
        return Err(AppError::Validation(
            "共有対象はマーカーと図形を合わせて10,000件以内にしてください。".into(),
        ));
    }
    if input.version != 1
        || input.layers.len() > MAX_LAYERS
        || input.tile_servers.len() > 1000
        || input.tile_overlays.len() > 1000
    {
        return Err(invalid());
    }
    let state = &mut input.state;
    let view = &state.view;
    if !view.latitude.is_finite()
        || !(-90.0..=90.0).contains(&view.latitude)
        || !view.longitude.is_finite()
        || !(-180.0..=180.0).contains(&view.longitude)
        || !view.zoom.is_finite()
        || !(0.0..=30.0).contains(&view.zoom)
        || state
            .object_query
            .as_ref()
            .is_some_and(|s| !bounded_text(s, 10_000))
        || (!state.markers_visible && !input.markers.is_empty())
        || (!state.shapes_visible && !input.shapes.is_empty())
    {
        return Err(invalid());
    }
    let mut layers = HashMap::new();
    for (key, value) in input.layers {
        fields(
            &value,
            &[
                "id",
                "user_id",
                "layer_name",
                "is_master",
                "restrict_free_text",
                "marker_icon_id",
                "marker_icon_filename",
            ],
        )?;
        let mut layer: LayerObjectFromRow = serde_json::from_value(value).map_err(|_| invalid())?;
        layer.id = canonical_id(&layer.id)?;
        layer.user_id = canonical_id(&layer.user_id)?;
        layer.marker_icon_id = layer
            .marker_icon_id
            .map(|id| canonical_id(&id))
            .transpose()?;
        parse_id(&key, &layer.id)?;
        if layer.user_id != user || !bounded_text(&layer.layer_name, 1000) {
            return Err(invalid());
        }
        layers.insert(layer.id.clone(), layer);
    }
    let layer_ids = record_ids(layers.keys())?;
    validate_ids(&state.layer_ids, &layer_ids)?;
    if state
        .layer_ids
        .as_ref()
        .is_some_and(|ids| ids.len() != layer_ids.len())
    {
        return Err(invalid());
    }
    let mut selected_layers: Vec<_> = layer_ids.iter().copied().collect();
    selected_layers.sort_unstable();
    state.layer_ids = Some(selected_layers);
    let mut markers = HashMap::new();
    for (key, value) in input.markers {
        fields(
            &value,
            &[
                "id",
                "layer_id",
                "marker_name",
                "latitude",
                "longitude",
                "detail",
                "update_at",
            ],
        )?;
        let mut marker: MarkerObjectFromRow =
            serde_json::from_value(value).map_err(|_| invalid())?;
        marker.id = canonical_id(&marker.id)?;
        marker.layer_id = marker.layer_id.map(|id| canonical_id(&id)).transpose()?;
        parse_id(&key, &marker.id)?;
        if !marker
            .layer_id
            .as_ref()
            .is_some_and(|id| layers.contains_key(id))
            || !marker.latitude.is_finite()
            || !(-90.0..=90.0).contains(&marker.latitude)
            || !marker.longitude.is_finite()
            || !(-180.0..=180.0).contains(&marker.longitude)
            || !bounded_text(&marker.marker_name, 10_000)
            || !bounded_text(&marker.detail, 1_000_000)
        {
            return Err(invalid());
        }
        markers.insert(marker.id.clone(), marker);
    }
    let mut shapes = HashMap::new();
    for mut value in input.shapes {
        fields(
            &value,
            &[
                "id",
                "user_id",
                "layer_id",
                "shape_type",
                "name",
                "geojson",
                "created_at",
                "updated_at",
            ],
        )?;
        // 通常の取得結果には日時・所有者が含まれる。省略可能な転送型も正規化する。
        let object = value.as_object_mut().ok_or_else(invalid)?;
        object.entry("user_id").or_insert(json!(user));
        let now = json!(chrono::Utc::now().naive_utc());
        object.entry("created_at").or_insert(now.clone());
        object.entry("updated_at").or_insert(now);
        let mut shape: ShapeObject = serde_json::from_value(value).map_err(|_| invalid())?;
        shape.id = canonical_id(&shape.id)?;
        shape.user_id = canonical_id(&shape.user_id)?;
        shape.layer_id = canonical_id(&shape.layer_id)?;
        if shape.user_id != user
            || !layers.contains_key(&shape.layer_id)
            || shape
                .name
                .as_ref()
                .is_some_and(|s| !bounded_text(s, 10_000))
            || shapes.contains_key(&shape.id)
        {
            return Err(invalid());
        }
        validate_shape_geojson(&shape.shape_type, &shape.geojson)?;
        shapes.insert(shape.id.clone(), shape);
    }
    let marker_ids = record_ids(markers.keys())?;
    let shape_ids = record_ids(shapes.keys())?;
    validate_ids(&state.marker_ids, &marker_ids)?;
    validate_ids(&state.shape_ids, &shape_ids)?;
    // 保存対象の外に依存する許可リストを残さず、解除後も対象が増えないよう固定する。
    let mut selected_markers: Vec<_> = marker_ids.iter().copied().collect();
    let mut selected_shapes: Vec<_> = shape_ids.iter().copied().collect();
    selected_markers.sort_unstable();
    selected_shapes.sort_unstable();
    state.marker_ids = Some(selected_markers);
    state.shape_ids = Some(selected_shapes);
    if let Some(coloring) = &state.coloring {
        if coloring.version != 1 || coloring.rules.is_empty() || coloring.rules.len() > 20 {
            return Err(invalid());
        }
        let mut rules = HashSet::new();
        for rule in &coloring.rules {
            if rule.id.trim().is_empty()
                || !bounded_text(&rule.id, 100)
                || rule.label.trim().is_empty()
                || !bounded_text(&rule.label, 100)
                || rule.color.len() != 7
                || !rule.color.starts_with('#')
                || !rule.color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                || !rules.insert(&rule.id)
            {
                return Err(invalid());
            }
        }
        for (key, rule) in &coloring.targets {
            let (kind, id) = key.split_once(':').ok_or_else(invalid)?;
            let id = Uuid::parse_str(id).map_err(|_| invalid())?;
            let allowed = match kind {
                "marker" => marker_ids.contains(&id),
                "shape" => shape_ids.contains(&id),
                _ => false,
            };
            if !allowed || key != &format!("{kind}:{id}") || !rules.contains(rule) {
                return Err(invalid());
            }
        }
    }
    if !input.tile_servers.contains_key("1")
        || !input.tile_servers.contains_key(&state.tile_server_id)
    {
        return Err(invalid());
    }
    let mut tile_servers = HashMap::new();
    for (key, value) in input.tile_servers {
        fields(
            &value,
            &[
                "id",
                "layer_name",
                "label",
                "url",
                "attribution",
                "include_foreign_tiles",
                "min_zoom",
                "max_zoom",
                "create_at",
                "updated_at",
            ],
        )?;
        let id = value["id"].as_i64().ok_or_else(invalid)?;
        if key != id.to_string() {
            return Err(invalid());
        }
        tile_servers.insert(key, public_tile_server(&value));
    }
    let mut overlay_ids = HashSet::new();
    let mut tile_overlays = Vec::new();
    for value in input.tile_overlays {
        fields(
            &value,
            &[
                "id",
                "name",
                "url",
                "attribution",
                "min_zoom",
                "max_zoom",
                "opacity",
                "sort_order",
                "enabled",
            ],
        )?;
        let id = value["id"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or_else(invalid)?;
        if !overlay_ids.insert(id) {
            return Err(invalid());
        }
        tile_overlays.push(public_tile_overlay(&value));
    }
    if state.overlays.keys().copied().collect::<HashSet<_>>() != overlay_ids {
        return Err(invalid());
    }
    Ok(Snapshot {
        layers,
        markers,
        shapes,
        metadata: json!({"version":1,"state":state,"tileServers":tile_servers,"tileOverlays":tile_overlays}),
    })
}

fn public_tile_server(value: &Value) -> Value {
    json!({
        "id":value["id"], "layer_name":value["layer_name"], "label":value["label"],
        "url":value["url"], "attribution":value["attribution"],
        "include_foreign_tiles":value["include_foreign_tiles"],
        "min_zoom":value["min_zoom"], "max_zoom":value["max_zoom"],
    })
}

fn public_tile_overlay(value: &Value) -> Value {
    json!({
        "id":value["id"], "name":value["name"], "url":value["url"], "attribution":value["attribution"],
        "min_zoom":value["min_zoom"], "max_zoom":value["max_zoom"],
        "opacity":value["opacity"], "sort_order":value["sort_order"],
    })
}

/// BEGIN IMMEDIATEで確保した同一接続上で、所有権と管理済み定義を検証する。
pub(super) async fn authorize(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    snapshot: &Snapshot,
) -> Result<(), AppError> {
    let layer_ids: Vec<_> = snapshot.layers.keys().collect();
    let layers: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        r#"
        SELECT
            l.id,
            l.marker_icon_id,
            m.uuid_filename
        FROM layer_model l
        LEFT JOIN marker_icon_model m ON m.id = l.marker_icon_id
        WHERE l.user_id = $1
            AND l.id IN (SELECT value FROM json_each($2))
        "#,
    )
    .bind(user)
    .bind(json_ids(&layer_ids)?)
    .fetch_all(&mut **tx)
    .await?;
    if layers.len() != snapshot.layers.len() {
        return Err(invalid());
    }
    for (id, icon, filename) in layers {
        let layer = &snapshot.layers[&id];
        if layer.marker_icon_id != icon || layer.marker_icon_filename != filename {
            return Err(invalid());
        }
    }
    let marker_ids: Vec<_> = snapshot.markers.keys().collect();
    let markers: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT
            id,
            layer_id
        FROM marker_info_model
        WHERE user_id = $1
            AND id IN (SELECT value FROM json_each($2))
        "#,
    )
    .bind(user)
    .bind(json_ids(&marker_ids)?)
    .fetch_all(&mut **tx)
    .await?;
    if markers.len() != snapshot.markers.len()
        || markers
            .iter()
            .any(|(id, layer)| snapshot.markers[id].layer_id != *layer)
    {
        return Err(invalid());
    }
    let shape_ids: Vec<_> = snapshot.shapes.keys().collect();
    let shapes: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT
            id,
            layer_id
        FROM shape_model
        WHERE user_id = $1
            AND id IN (SELECT value FROM json_each($2))
        "#,
    )
    .bind(user)
    .bind(json_ids(&shape_ids)?)
    .fetch_all(&mut **tx)
    .await?;
    if shapes.len() != snapshot.shapes.len()
        || shapes
            .iter()
            .any(|(id, layer)| snapshot.shapes[id].layer_id != *layer)
    {
        return Err(invalid());
    }
    let server_rows: Vec<TileServers> = sqlx::query_as(
        r#"
        SELECT
            id,
            layer_name,
            label,
            url,
            attribution,
            include_foreign_tiles,
            min_zoom,
            max_zoom,
            create_at,
            updated_at
        FROM tileserver_model
        "#,
    )
    .fetch_all(&mut **tx)
    .await?;
    let servers: HashMap<_, _> = server_rows
        .into_iter()
        .map(|server| {
            let id = server.id.to_string();
            let value = serde_json::to_value(server).map_err(|_| AppError::InternalServerError)?;
            Ok((id, public_tile_server(&value)))
        })
        .collect::<Result<_, AppError>>()?;
    for (id, tile) in snapshot.metadata["tileServers"]
        .as_object()
        .ok_or_else(invalid)?
    {
        if !servers
            .get(id)
            .is_some_and(|current| super::super::answer_sqlite::json_equal(current, tile))
        {
            return Err(AppError::Validation(
                "背景地図の設定が変更されています。地図を開き直してください。".into(),
            ));
        }
    }
    // SQLiteの整数bool・REALをRustの公開型へ戻してから、数値表記も含めて照合する。
    let overlay_rows: Vec<super::super::tile_overlays::TileOverlay> = sqlx::query_as(
        r#"
        SELECT
            t.id,
            t.name,
            t.url,
            t.attribution,
            t.min_zoom,
            t.max_zoom,
            t.opacity,
            t.sort_order,
            t.enabled
        FROM tile_overlay_model t
        JOIN user_tile_overlay_model u ON u.tile_overlay_id = t.id
        WHERE u.user_id = $1
            AND t.enabled
        "#,
    )
    .bind(user)
    .fetch_all(&mut **tx)
    .await?;
    let overlays: HashMap<_, _> = overlay_rows
        .into_iter()
        .map(|overlay| {
            let id = overlay.id.clone();
            let value = serde_json::to_value(overlay).map_err(|_| AppError::InternalServerError)?;
            Ok((id, public_tile_overlay(&value)))
        })
        .collect::<Result<_, AppError>>()?;
    for tile in snapshot.metadata["tileOverlays"]
        .as_array()
        .ok_or_else(invalid)?
    {
        let id = tile["id"].as_str().ok_or_else(invalid)?;
        if !overlays
            .get(id)
            .is_some_and(|current| super::super::answer_sqlite::json_equal(current, tile))
        {
            return Err(AppError::Validation(
                "重ねるタイルレイヤの設定が変更されています。地図を開き直してください。".into(),
            ));
        }
    }
    Ok(())
}

fn json_ids(ids: &[&String]) -> Result<String, AppError> {
    serde_json::to_string(ids).map_err(|_| AppError::InternalServerError)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> Value {
        json!({
            "version":1,"state":{
                "view":{"latitude":35,"longitude":139,"zoom":10},
                "tileServerId":"1","overlays":{},"markersVisible":true,
                "shapesVisible":true,"shapeNamesVisible":false,"layerIds":null
            },
            "layers":{},"markers":{},"shapes":[],
            "tileServers":{"1":{"id":1}},"tileOverlays":[]
        })
    }

    #[test]
    // 省略した許可リストは保存対象だけへ正規化し、未知の対象を追加しない。
    fn omitted_allow_lists_are_normalized_without_adding_targets() {
        let parsed = parse(empty(), &Uuid::nil().to_string()).unwrap();
        for key in ["layerIds", "markerIds", "shapeIds"] {
            assert_eq!(parsed.metadata["state"][key], json!([]));
        }
        let mut invalid = empty();
        invalid["state"]["markerIds"] = json!([Uuid::new_v4()]);
        assert!(parse(invalid, &Uuid::nil().to_string()).is_err());
    }

    #[test]
    // レコードの詳細を検査する前に、容量と対象件数の上限を適用する。
    fn bounds_snapshot_bytes_and_object_count_before_validating_records() {
        let oversized = json!({"extra":"x".repeat(MAX_SNAPSHOT_BYTES)});
        assert!(matches!(
            parse(oversized, &Uuid::nil().to_string()),
            Err(AppError::PayloadTooLarge(_))
        ));
        let mut too_many = empty();
        too_many["shapes"] = json!(vec![json!({}); MAX_OBJECTS + 1]);
        let error = parse(too_many, &Uuid::nil().to_string()).err().unwrap();
        assert!(error.to_string().contains("10,000"));
    }
}
