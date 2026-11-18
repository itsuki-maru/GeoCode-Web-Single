#[allow(dead_code)]
mod common;

use axum::{
    Extension, Json,
    body::to_bytes,
    extract::{Path, Query},
    http::HeaderMap,
    response::IntoResponse,
};
use geocode_web_single::{
    handler::{
        admin::{MapDisplaySettings, update_map_display_settings},
        onetime_url::{
            current_url_handler, generate_url_handler, invalidate_url_handler,
            temporary_map_get_handler,
        },
        tile_overlays::TileOverlay,
    },
    model::{
        CreateUpdatedTemporaryUrlResponse, GenarateUrlPayload, TemporaryUrlFromDB, TileServers,
    },
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::sync::Arc;
use tera::Tera;
use tokio::sync::Mutex;
use uuid::Uuid;

fn payload(layer: &str, snapshot: Option<Value>, update: bool) -> GenarateUrlPayload {
    GenarateUrlPayload {
        minutes: 60,
        layers: vec![layer.to_owned()],
        update_url: update,
        share_password: None,
        include_shapes: true,
        include_tile_overlays: true,
        snapshot,
    }
}

async fn create(
    pool: &SqlitePool,
    user: &str,
    p: GenarateUrlPayload,
) -> CreateUpdatedTemporaryUrlResponse {
    generate_url_handler(
        Extension(user.to_owned()),
        Extension(pool.clone()),
        None,
        Json(p),
    )
    .await
    .unwrap()
    .0
}

async fn saved(pool: &SqlitePool, user: &str) -> Value {
    let row = sqlx::query_as::<_, TemporaryUrlFromDB>(
        r#"
        SELECT
            id,
            user_id,
            url,
            expiration,
            password_hash,
            layers,
            markers,
            shapes,
            include_tile_overlays,
            map_snapshot,
            create_at
        FROM temporary_urls
        WHERE user_id = $1
        "#,
    )
    .bind(user)
    .fetch_one(pool)
    .await
    .unwrap();
    let mut value = serde_json::to_value(row).unwrap();
    for key in ["layers", "markers", "shapes", "map_snapshot"] {
        if let Some(text) = value[key].as_str() {
            value[key] = serde_json::from_str(text).unwrap();
        }
    }
    value
}

async fn fixture(pool: &SqlitePool) -> (String, String, String, String, Value) {
    let user = common::create_test_user(pool, "snapshot-owner").await;
    let layer = common::master_layer_id(pool, &user).await;
    let marker = Uuid::new_v4().to_string();
    let excluded = Uuid::new_v4().to_string();
    for (id, name) in [
        (marker.as_str(), "kept"),
        (excluded.as_str(), "excluded-private-data"),
    ] {
        sqlx::query(
            r#"
            INSERT INTO marker_info_model (
                id,
                user_id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail,
                create_at,
                update_at
            ) VALUES (
                $1,
                $2,
                $3,
                $4,
                35,
                139,
                $4,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
            "#,
        )
        .bind(id)
        .bind(&user)
        .bind(&layer)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        r#"
        INSERT INTO tileserver_model (
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
        ) VALUES (
            1,
            'fixture',
            '標準地図',
            '/tiles/{z}/{x}/{y}.png',
            '出典',
            false,
            0,
            22,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    let tile = sqlx::query_as::<_, TileServers>(
        r#"
        SELECT *
        FROM tileserver_model
        ORDER BY id
        LIMIT 1
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap();
    let tile = serde_json::to_value(tile).unwrap();
    let tile_id = tile["id"].to_string();
    let snapshot = json!({
        "version":1,
        "state":{
            "view":{"latitude":35.5,"longitude":139.5,"zoom":12},
            "tileServerId":tile_id,"overlays":{},
            "markersVisible":true,"shapesVisible":true,"shapeNamesVisible":true,
            "layerIds":[layer], "markerIds":[marker], "shapeIds":[],
            "clusteringEnabled":false,"clusteringAllowed":true,
            "objectQuery":"kept",
            "coloring":{"version":1,"rules":[{"id":"red","label":"分類","color":"#ff0000"}],
                "targets":{format!("marker:{marker}"):"red"}}
        },
        "layers":{layer.to_string():{
            "id":layer,"user_id":user,"layer_name":"captured layer","is_master":true,
            "restrict_free_text":false,"marker_icon_id":null,"marker_icon_filename":null
        }},
        "markers":{marker.to_string():{
            "id":marker,"layer_id":layer,"marker_name":"captured kept","detail":"captured body",
            "latitude":35.25,"longitude":139.25
        }},
        "shapes":[],"tileServers":{tile_id:tile},"tileOverlays":[]
    });
    (user, layer, marker, excluded, snapshot)
}

async fn vector_tile(pool: &SqlitePool, style_url: &str) -> Value {
    sqlx::query(
        "INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, include_foreign_tiles,
            min_zoom, max_zoom, create_at, updated_at, kind, style_url
         ) VALUES (
            2, 'vector fixture', 'ベクタ地図', '/fallback/{z}/{x}/{y}.png',
            'ベクタ出典', false, 0, 22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
            'vector', $1
         )",
    )
    .bind(style_url)
    .execute(pool)
    .await
    .unwrap();
    let tile = sqlx::query_as::<_, TileServers>(
        r#"
        SELECT *
        FROM tileserver_model
        WHERE id = 2
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap();
    serde_json::to_value(tile).unwrap()
}

#[tokio::test]
async fn legacy_snapshot_strips_raster_defaults_and_ignores_unselected_vector_rows() {
    let pool = common::test_pool().await;
    let (user, layer, _, _, snapshot) = fixture(&pool).await;
    vector_tile(&pool, "/styles/vector.json").await;
    // 新しいbootstrap由来の冗長な既定値でも、保存するv1形式は従来のままにする。
    assert_eq!(snapshot["tileServers"]["1"]["kind"], "raster");
    assert!(snapshot["tileServers"]["1"]["style_url"].is_null());
    let id = create(&pool, &user, payload(&layer, Some(snapshot), false))
        .await
        .id;
    let data = saved(&pool, &user).await;
    let metadata = &data["map_snapshot"];
    assert_eq!(metadata["version"], 1);
    assert!(metadata["tileServers"]["1"].get("kind").is_none());
    assert!(metadata["tileServers"]["1"].get("style_url").is_none());
    assert!(metadata["tileServers"].get("2").is_none());
    assert_eq!(rendered(&pool, &id, false).await["snapshot"], *metadata);
}

#[tokio::test]
async fn vector_snapshot_preserves_style_and_rejects_definition_changes_without_replacing_share() {
    let pool = common::test_pool().await;
    let (user, layer, _, _, mut snapshot) = fixture(&pool).await;
    let tile = vector_tile(&pool, "/styles/captured.json").await;
    snapshot["version"] = json!(2);
    snapshot["state"]["tileServerId"] = json!("2");
    snapshot["tileServers"]["2"] = tile;
    let original = create(&pool, &user, payload(&layer, Some(snapshot.clone()), false)).await;
    let before = saved(&pool, &user).await;
    let metadata = &before["map_snapshot"];
    assert_eq!(metadata["version"], 2);
    assert_eq!(metadata["tileServers"]["1"]["kind"], "raster");
    assert!(metadata["tileServers"]["1"]["style_url"].is_null());
    assert_eq!(metadata["tileServers"]["2"]["kind"], "vector");
    assert_eq!(
        metadata["tileServers"]["2"]["style_url"],
        "/styles/captured.json"
    );
    assert_eq!(
        metadata["tileServers"]["2"]["url"],
        "/fallback/{z}/{x}/{y}.png"
    );

    let mut changed_style = snapshot.clone();
    changed_style["tileServers"]["2"]["style_url"] = json!("/styles/arbitrary.json");
    let mut changed_kind = snapshot.clone();
    changed_kind["tileServers"]["2"]["kind"] = json!("raster");
    changed_kind["tileServers"]["2"]["style_url"] = Value::Null;
    let mut unknown_kind = snapshot.clone();
    unknown_kind["tileServers"]["2"]["kind"] = json!("unknown");
    let mut unknown_version = snapshot.clone();
    unknown_version["version"] = json!(4);
    for bad in [changed_style, changed_kind, unknown_kind, unknown_version] {
        assert!(
            generate_url_handler(
                Extension(user.clone()),
                Extension(pool.clone()),
                None,
                Json(payload(&layer, Some(bad), true)),
            )
            .await
            .is_err()
        );
        assert_eq!(saved(&pool, &user).await, before);
    }
    sqlx::query("UPDATE tileserver_model SET style_url = '/styles/changed.json' WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        generate_url_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            None,
            Json(payload(&layer, Some(snapshot), true)),
        )
        .await
        .is_err()
    );
    assert_eq!(saved(&pool, &user).await, before);
    // 利用可能なうちは保存時のスタイルを維持し、削除後は代替背景へ切り替える。
    assert_eq!(
        rendered(&pool, &original.id, false).await["tiles"]["2"]["style_url"],
        "/styles/captured.json"
    );
    sqlx::query("DELETE FROM tileserver_model WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();
    for mobile in [false, true] {
        let output = rendered(&pool, &original.id, mobile).await;
        assert_eq!(output["snapshot"]["state"]["tileServerId"], "1");
        assert_eq!(
            output["snapshot"]["state"]["view"],
            metadata["state"]["view"]
        );
        assert!(output["tiles"].get("2").is_none());
        assert_eq!(output["tiles"], output["snapshot"]["tileServers"]);
    }
    assert_eq!(saved(&pool, &user).await, before);
}

#[tokio::test]
async fn temporary_background_policy_replaces_archived_and_new_snapshot_selection() {
    let pool = common::test_pool().await;
    let (user, layer, _, _, mut snapshot) = fixture(&pool).await;
    let selected = vector_tile(&pool, "/styles/captured.json").await;
    snapshot["version"] = json!(2);
    snapshot["state"]["tileServerId"] = json!("2");
    snapshot["tileServers"]["2"] = selected;
    let original = create(&pool, &user, payload(&layer, Some(snapshot.clone()), false)).await;
    assert!(!original.background_replaced);
    let before = saved(&pool, &user).await;

    sqlx::query(
        r#"
        INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, include_foreign_tiles, create_at, updated_at
        ) VALUES (
            5, 'temporary-fallback', '共有の代替背景', '/temporary/{z}/{x}/{y}', '', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO background_map_fallbacks (id, temporary_id)
        VALUES (1, 5)
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE tileserver_model
        SET allow_temporary_share = false
        WHERE id IN (1, 2)
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    for mobile in [false, true] {
        let page = rendered(&pool, &original.id, mobile).await;
        assert_eq!(page["fallback"], "5");
        assert_eq!(page["tiles"].as_object().unwrap().len(), 1);
        assert_eq!(page["tiles"]["5"]["url"], "/temporary/{z}/{x}/{y}");
        assert_eq!(page["snapshot"]["tileServers"], page["tiles"]);
        assert_eq!(page["snapshot"]["state"]["tileServerId"], "5");
        assert_eq!(
            page["snapshot"]["state"]["view"],
            before["map_snapshot"]["state"]["view"]
        );
        assert_eq!(page["markers"], before["markers"]);
    }
    assert_eq!(saved(&pool, &user).await, before);

    sqlx::query(
        r#"
        UPDATE tileserver_model
        SET allow_temporary_share = true
        WHERE id = 2
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let restored = rendered(&pool, &original.id, false).await;
    assert_eq!(restored["snapshot"]["state"]["tileServerId"], "2");
    assert_eq!(restored["tiles"]["2"]["style_url"], "/styles/captured.json");

    sqlx::query(
        r#"
        UPDATE tileserver_model
        SET enabled = false
        WHERE id = 2
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let updated = create(&pool, &user, payload(&layer, Some(snapshot), true)).await;
    assert_eq!(updated.id, original.id);
    assert!(updated.background_replaced);
    let after = saved(&pool, &user).await;
    assert_eq!(after["map_snapshot"]["state"]["tileServerId"], "5");
    assert_eq!(
        after["map_snapshot"]["tileServers"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn google_v3_snapshot_checks_the_registered_provider_and_map_type() {
    let pool = common::test_pool().await;
    let (user, layer, _, _, mut snapshot) = fixture(&pool).await;
    let tile = sqlx::query_as::<_, TileServers>(
        r#"
        INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, create_at, updated_at, provider, google_map_type
        ) VALUES (
            2, 'google', 'Google道路地図', '/google-maps/tiles/{z}/{x}/{y}', '',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'google', 'roadmap'
        )
        RETURNING *
        "#,
    ).fetch_one(&pool).await.unwrap();
    snapshot["version"] = json!(3);
    snapshot["state"]["tileServerId"] = json!("2");
    snapshot["tileServers"]["2"] = serde_json::to_value(tile).unwrap();
    let original = create(&pool, &user, payload(&layer, Some(snapshot.clone()), false)).await;
    let page = rendered(&pool, &original.id, false).await;
    assert_eq!(page["snapshot"]["version"], 3);
    assert_eq!(page["tiles"]["2"]["provider"], "google");
    assert_eq!(page["tiles"]["2"]["google_map_type"], "roadmap");
    let saved_before = saved(&pool, &user).await;

    // 共有要求からGoogleの地図種別を差し替えても、中継対象を変更できない。
    snapshot["tileServers"]["2"]["google_map_type"] = json!("terrain");
    let result = generate_url_handler(
        Extension(user.clone()),
        Extension(pool.clone()),
        None,
        Json(payload(&layer, Some(snapshot), true)),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(saved(&pool, &user).await, saved_before);
}

#[tokio::test]
async fn legacy_snapshot_cannot_authorize_vector_background_as_raster() {
    let pool = common::test_pool().await;
    let (user, layer, _, _, mut snapshot) = fixture(&pool).await;
    create(&pool, &user, payload(&layer, Some(snapshot.clone()), false)).await;
    let before = saved(&pool, &user).await;
    let mut tile = vector_tile(&pool, "https://tiles.example/style.json").await;
    // レンダラー属性を省略しても、DB上のvector定義とv1のraster定義は一致しない。
    tile.as_object_mut().unwrap().remove("kind");
    tile.as_object_mut().unwrap().remove("style_url");
    snapshot["tileServers"]["2"] = tile;
    snapshot["state"]["tileServerId"] = json!("2");
    assert!(
        generate_url_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            None,
            Json(payload(&layer, Some(snapshot), true)),
        )
        .await
        .is_err()
    );
    assert_eq!(saved(&pool, &user).await, before);
}

async fn rendered(pool: &SqlitePool, id: &str, mobile: bool) -> Value {
    let mut tera = Tera::default();
    for name in ["temporary-map.html", "temporary-map-mobile.html"] {
        tera.add_raw_template(
            name,
            r#"{
                "snapshot": {{ shareSnapshot | json_encode() | safe }},
                "fallback": {{ fallbackTileServerId | json_encode() | safe }},
                "markers": {{ markersObj | json_encode() | safe }},
                "shapes": {{ shapesObj | json_encode() | safe }},
                "tiles": {{ tileServers | json_encode() | safe }},
                "overlays": {{ tileOverlays | json_encode() | safe }}
                {% if clusteringMinZoom is defined %},"clusteringMinZoom": {{ clusteringMinZoom }}{% endif %}
            }"#,
        )
        .unwrap();
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        "user-agent",
        if mobile { "Fixture Mobile" } else { "Desktop" }
            .parse()
            .unwrap(),
    );
    let response = temporary_map_get_handler(
        headers,
        Extension(pool.clone()),
        Extension(Arc::new(Mutex::new(tera))),
        Query(serde_json::from_value(json!({})).unwrap()),
        Ok(Path(id.to_owned())),
    )
    .await
    .unwrap()
    .into_response();
    assert_eq!(response.headers()["cache-control"], "no-store");
    serde_json::from_slice(&to_bytes(response.into_body(), 2_000_000).await.unwrap()).unwrap()
}

#[tokio::test]
async fn save_fetched_maps_and_color_rules_without_exposing_excluded_data() {
    let pool = common::test_pool().await;
    let (user, layer, marker, excluded, snapshot) = fixture(&pool).await;
    let id = create(&pool, &user, payload(&layer, Some(snapshot.clone()), false))
        .await
        .id;
    let data = saved(&pool, &user).await;
    assert_eq!(
        data["markers"][marker.to_string()]["detail"],
        "captured body"
    );
    assert_eq!(data["markers"][marker.to_string()]["latitude"], 35.25);
    assert_eq!(data["layers"][&layer]["is_master"], true);
    assert_eq!(data["layers"][&layer]["restrict_free_text"], false);
    assert_eq!(data["map_snapshot"]["state"]["clusteringEnabled"], false);
    assert_eq!(data["map_snapshot"]["state"]["clusteringAllowed"], true);
    assert_eq!(
        data["map_snapshot"]["tileServers"]["1"]["include_foreign_tiles"],
        false
    );
    assert_eq!(
        data["layers"][layer.to_string()]["layer_name"],
        "captured layer"
    );
    assert!(!data.to_string().contains(&excluded.to_string()));
    assert!(!data.to_string().contains("excluded-private-data"));
    for key in ["latitude", "longitude", "zoom"] {
        assert_eq!(
            data["map_snapshot"]["state"]["view"][key].as_f64(),
            snapshot["state"]["view"][key].as_f64()
        );
    }
    assert_eq!(
        data["map_snapshot"]["state"]["coloring"],
        snapshot["state"]["coloring"]
    );
    sqlx::query(
        r#"
        UPDATE marker_info_model
        SET
            detail = 'changed after share'
        WHERE id = $1
        "#,
    )
    .bind(&marker)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE tileserver_model
        SET
            label = 'changed after share'
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    // 共有作成後の管理設定を、PC・モバイルの閲覧時に反映する。
    let admin = common::create_test_admin(&pool, "snapshot-map-settings-admin").await;
    let _ = update_map_display_settings(
        Extension(admin),
        Extension(pool.clone()),
        Json(MapDisplaySettings {
            clustering_min_zoom: 17,
        }),
    )
    .await
    .unwrap();
    for mobile in [false, true] {
        let output = rendered(&pool, &id, mobile).await;
        assert_eq!(output["clusteringMinZoom"], 17);
        assert_eq!(output["snapshot"], data["map_snapshot"]);
        assert_eq!(output["tiles"], data["map_snapshot"]["tileServers"]);
        assert_eq!(output["markers"], data["markers"]);
        assert_eq!(output["shapes"], data["shapes"]);
        assert!(!output.to_string().contains("changed after share"));
        assert!(!output.to_string().contains(&excluded.to_string()));
    }
    // 同じURLを通常共有へ更新した際、以前の表示設定を残さない。
    let updated = create(&pool, &user, payload(&layer, None, true)).await;
    assert_eq!(updated.id, id);
    let normal = saved(&pool, &user).await;
    assert!(normal["map_snapshot"].is_null());
    assert_eq!(normal["markers"].as_object().unwrap().len(), 2);
}

#[tokio::test]
async fn reject_foreign_targets_exclusions_and_unmanaged_tiles_without_changing_existing_shares() {
    let pool = common::test_pool().await;
    let (user, layer, marker, excluded, snapshot) = fixture(&pool).await;
    let original = create(&pool, &user, payload(&layer, Some(snapshot.clone()), false)).await;
    let before = saved(&pool, &user).await;
    let other = common::create_test_user(&pool, "snapshot-other").await;
    let foreign_layer = common::master_layer_id(&pool, &other).await;
    let foreign = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        ) VALUES (
            $1,
            $2,
            $3,
            'foreign',
            35,
            139,
            'secret',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(&foreign)
    .bind(&other)
    .bind(&foreign_layer)
    .execute(&pool)
    .await
    .unwrap();
    let mut bad_states = Vec::new();
    let mut bad = snapshot.clone();
    bad["markers"][marker.to_string()]["id"] = json!(foreign);
    let record = bad["markers"]
        .as_object_mut()
        .unwrap()
        .remove(&marker.to_string())
        .unwrap();
    bad["markers"][foreign.to_string()] = record;
    bad["state"]["markerIds"] = json!([foreign]);
    bad["state"]["coloring"] = Value::Null;
    bad_states.push(bad);
    let mut bad = snapshot.clone();
    bad["state"]["markerIds"] = json!([marker, excluded]);
    bad_states.push(bad);
    let mut bad = snapshot.clone();
    bad["state"]["coloring"]["targets"][format!("marker:{excluded}")] = json!("red");
    bad_states.push(bad);
    let mut bad = snapshot.clone();
    let tile_id = snapshot["state"]["tileServerId"].as_str().unwrap();
    bad["tileServers"][tile_id]["url"] = json!("https://unmanaged.invalid/{z}/{x}/{y}.png");
    bad_states.push(bad);
    let mut bad = snapshot.clone();
    bad["state"]["view"]["latitude"] = json!(91);
    bad_states.push(bad);
    let mut bad = snapshot.clone();
    bad["state"]["markersVisible"] = json!(false);
    bad_states.push(bad);
    let mut bad = snapshot.clone();
    bad["privateExtra"] = json!({excluded.to_string():"private"});
    bad_states.push(bad);
    for bad in bad_states {
        assert!(
            generate_url_handler(
                Extension(user.to_owned()),
                Extension(pool.clone()),
                None,
                Json(payload(&layer, Some(bad), false))
            )
            .await
            .is_err()
        );
        assert_eq!(saved(&pool, &user).await, before);
    }
    assert_eq!(saved(&pool, &user).await["id"], original.id.to_string());
}

#[tokio::test]
async fn share_empty_maps_and_preserve_existing_shares_when_new_issuance_fails() {
    let pool = common::test_pool().await;
    let (user, layer, _, _, mut snapshot) = fixture(&pool).await;
    snapshot["markers"] = json!({});
    snapshot["layers"] = json!({});
    snapshot["state"]["layerIds"] = json!([]);
    snapshot["state"]["markerIds"] = json!([]);
    snapshot["state"]["coloring"] = Value::Null;
    let mut p = payload(&layer, Some(snapshot.clone()), false);
    p.layers.clear();
    let original = create(&pool, &user, p).await;
    let before = saved(&pool, &user).await;
    assert_eq!(before["markers"], json!({}));
    sqlx::query(
        r#"
        CREATE TRIGGER reject_rotation
        BEFORE INSERT ON temporary_urls
        FOR EACH ROW
        BEGIN
            SELECT RAISE(ABORT, 'reject rotation');
        END
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut p = payload(&layer, Some(snapshot.clone()), false);
    p.layers.clear();
    assert!(
        generate_url_handler(
            Extension(user.to_owned()),
            Extension(pool.clone()),
            None,
            Json(p)
        )
        .await
        .is_err()
    );
    assert_eq!(saved(&pool, &user).await, before);
    assert_eq!(saved(&pool, &user).await["id"], original.id.to_string());
    sqlx::query(
        r#"
        DROP TRIGGER reject_rotation
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER reject_update
        BEFORE UPDATE ON temporary_urls
        FOR EACH ROW
        BEGIN
            SELECT RAISE(ABORT, 'reject update');
        END
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut p = payload(&layer, Some(snapshot), true);
    p.layers.clear();
    assert!(
        generate_url_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            None,
            Json(p)
        )
        .await
        .is_err()
    );
    assert_eq!(saved(&pool, &user).await, before);
}

#[tokio::test]
async fn serialize_normal_shares_snapshot_shares_and_stops_into_one_slot_across_connections() {
    let (pool, path) = common::file_test_pool().await;
    let (user, layer, _, _, snapshot) = fixture(&pool).await;
    let mut jobs = Vec::new();
    for i in 0..8 {
        let pool = pool.clone();
        let user = user.clone();
        let layer = layer.clone();
        let snapshot = (i % 2 == 0).then(|| snapshot.clone());
        jobs.push(tokio::spawn(async move {
            create(&pool, &user, payload(&layer, snapshot, i % 3 == 0)).await
        }));
    }
    for job in jobs {
        job.await.unwrap();
    }
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM temporary_urls
        WHERE user_id = $1
        "#,
    )
    .bind(&user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let (stopped, created) = tokio::join!(
        invalidate_url_handler(Extension(user.to_owned()), Extension(pool.clone())),
        generate_url_handler(
            Extension(user.to_owned()),
            Extension(pool.clone()),
            None,
            Json(payload(&layer, Some(snapshot), false))
        ),
    );
    stopped.unwrap();
    let _ = created.unwrap();
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM temporary_urls
        WHERE user_id = $1
        "#,
    )
    .bind(&user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count <= 1);
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn preserve_japanese_text_decimal_map_state_booleans_and_timestamp_semantics_after_reconnection()
 {
    let (pool, path) = common::file_test_pool().await;
    let (user, layer, marker, _, mut snapshot) = fixture(&pool).await;
    snapshot["markers"][&marker]["marker_name"] = json!("保存する地点🗺️");
    snapshot["markers"][&marker]["detail"] = json!("日本語の本文💧\n0・false・未入力を区別する");
    snapshot["state"]["objectQuery"] = json!("日本語");
    snapshot["state"]["view"]["latitude"] = json!(35.123456789);
    snapshot["state"]["view"]["longitude"] = json!(139.987654321);
    snapshot["state"]["view"]["zoom"] = json!(12.5);
    snapshot["state"]["shapeNamesVisible"] = json!(false);
    let created = create(&pool, &user, payload(&layer, Some(snapshot.clone()), false)).await;
    let before = saved(&pool, &user).await;
    assert_eq!(before["markers"][&marker], snapshot["markers"][&marker]);
    assert_eq!(
        before["map_snapshot"]["state"]["view"],
        snapshot["state"]["view"]
    );
    assert_eq!(before["map_snapshot"]["state"]["shapeNamesVisible"], false);
    let types: (String, String, String, String, String) = sqlx::query_as(
        r#"
        SELECT
            typeof(id),
            typeof(user_id),
            typeof(markers),
            typeof(map_snapshot),
            typeof(include_tile_overlays)
        FROM temporary_urls
        WHERE user_id = $1
        "#,
    )
    .bind(&user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        types,
        (
            "text".to_owned(),
            "text".to_owned(),
            "text".to_owned(),
            "text".to_owned(),
            "integer".to_owned()
        )
    );
    let expiration =
        chrono::NaiveDateTime::parse_from_str(&created.expiration, "%Y-%m-%d %H:%M:%S%.f").unwrap();
    let remaining = expiration - chrono::Utc::now().naive_utc();
    assert!(remaining > chrono::Duration::minutes(59));
    assert!(remaining <= chrono::Duration::minutes(60));
    pool.close().await;
    drop(pool);

    // 一時ファイルを再度開き、メモリ上の値ではなく保存済みTEXTから復元する。
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .busy_timeout(std::time::Duration::from_secs(5)),
        )
        .await
        .unwrap();
    assert_eq!(saved(&pool, &user).await, before);
    let current = current_url_handler(Extension(user.clone()), Extension(pool.clone()))
        .await
        .unwrap()
        .0;
    assert_eq!(current.id, created.id);
    assert!(!current.is_password_protected);
    for mobile in [false, true] {
        let output = rendered(&pool, &created.id, mobile).await;
        assert_eq!(output["markers"], before["markers"]);
        assert_eq!(output["snapshot"], before["map_snapshot"]);
    }
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn preserve_saved_definitions_and_visibility_after_source_shapes_and_overlays_change() {
    let pool = common::test_pool().await;
    let (user, layer, _, _, mut snapshot) = fixture(&pool).await;
    snapshot["state"]["objectQuery"] = json!("");
    let shape = Uuid::new_v4().to_string();
    let geometry = json!({"type":"Feature","properties":{"radius":10,"memo":"captured shape"},"geometry":{"type":"Point","coordinates":[139,35]}});
    sqlx::query(
        r#"
        INSERT INTO shape_model (
            id,
            user_id,
            layer_id,
            shape_type,
            name,
            geojson,
            created_at,
            updated_at
        ) VALUES (
            $1,
            $2,
            $3,
            'circle',
            'shape',
            $4,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(&shape)
    .bind(&user)
    .bind(&layer)
    .bind(&geometry)
    .execute(&pool)
    .await
    .unwrap();
    let mut captured_geometry = geometry;
    captured_geometry["properties"]["radius"] = json!(25);
    snapshot["shapes"] = json!([{"id":shape,"user_id":user,"layer_id":layer,"shape_type":"circle","name":"captured shape","geojson":captured_geometry}]);
    snapshot["state"]["shapeIds"] = json!([shape]);
    snapshot["state"]["coloring"]["targets"][format!("shape:{shape}")] = json!("red");
    let overlay_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO tile_overlay_model (
            id,
            name,
            url,
            attribution,
            min_zoom,
            max_zoom,
            opacity,
            sort_order,
            enabled
        ) VALUES (
            $1,
            '洪水',
            'https://tiles.example/{z}/{x}/{y}.png',
            '出典',
            0,
            18,
            0.7,
            0,
            true
        )
        "#,
    )
    .bind(&overlay_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO user_tile_overlay_model (
            user_id,
            tile_overlay_id
        ) VALUES (
            $1,
            $2
        )
        "#,
    )
    .bind(&user)
    .bind(&overlay_id)
    .execute(&pool)
    .await
    .unwrap();
    let overlay = sqlx::query_as::<_, TileOverlay>(
        r#"
        SELECT
            id,
            name,
            url,
            attribution,
            min_zoom,
            max_zoom,
            opacity,
            sort_order,
            enabled
        FROM tile_overlay_model
        WHERE id = $1
        "#,
    )
    .bind(&overlay_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    snapshot["tileOverlays"] = json!([overlay]);
    snapshot["state"]["overlays"][overlay_id.to_string()] = json!(false);
    let created = create(&pool, &user, payload(&layer, Some(snapshot.clone()), false)).await;
    let before = saved(&pool, &user).await;
    assert_eq!(
        before["shapes"][shape.to_string()]["geojson"],
        captured_geometry
    );
    assert_eq!(
        before["map_snapshot"]["state"]["overlays"][overlay_id.to_string()],
        false
    );
    let mut tampered = snapshot;
    tampered["tileOverlays"][0]["url"] = json!("https://unmanaged.invalid/{z}/{x}/{y}.png");
    assert!(
        generate_url_handler(
            Extension(user.to_owned()),
            Extension(pool.clone()),
            None,
            Json(payload(&layer, Some(tampered), true))
        )
        .await
        .is_err()
    );
    assert_eq!(saved(&pool, &user).await, before);
    sqlx::query(
        r#"
        UPDATE tile_overlay_model
        SET
            enabled = false,
            url = 'https://changed.invalid/{z}/{x}/{y}.png'
        WHERE id = $1
        "#,
    )
    .bind(&overlay_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        DELETE FROM user_tile_overlay_model
        WHERE user_id = $1
        "#,
    )
    .bind(&user)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE shape_model
        SET
            name = 'changed after share'
        WHERE id = $1
        "#,
    )
    .bind(&shape)
    .execute(&pool)
    .await
    .unwrap();
    for mobile in [false, true] {
        let output = rendered(&pool, &created.id, mobile).await;
        assert_eq!(output["overlays"], before["map_snapshot"]["tileOverlays"]);
        assert_eq!(output["snapshot"], before["map_snapshot"]);
        assert_eq!(output["shapes"], before["shapes"]);
        assert!(!output.to_string().contains("changed.invalid"));
    }
}
