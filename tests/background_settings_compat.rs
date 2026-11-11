//! 背景の登録・編集・種別変更後も、既存ラスタと保存済み共有の内容を保持する。
#[allow(dead_code)]
mod common;

use axum::{
    Extension, Json,
    body::to_bytes,
    extract::{Path, Query},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use geocode_web_single::{
    handler::{
        background_maps::{BackgroundMapInput, admin_create, admin_update},
        onetime_url::{generate_url_handler, temporary_map_get_handler},
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

fn definition(kind: &str, style: Option<&str>) -> Value {
    json!({
        "layer_name":"managed background", "label":"管理した背景",
        "url":"/fallback/{z}/{x}/{y}.png", "attribution":"管理した出典",
        "kind":kind, "style_url":style, "include_foreign_tiles":true,
        "min_zoom":0, "max_zoom":22
    })
}

fn input(value: Value) -> BackgroundMapInput {
    serde_json::from_value(value).unwrap()
}

async fn seed_existing_raster(pool: &SqlitePool) -> Value {
    sqlx::query(
        "INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, include_foreign_tiles,
            min_zoom, max_zoom, create_at, updated_at
         ) VALUES (
            1, 'existing raster', '既存ラスタ', '/old/{z}/{x}/{y}.png',
            '旧出典', false, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )",
    )
    .execute(pool)
    .await
    .unwrap();
    current_background(pool, 1).await
}

async fn owner_with_marker(pool: &SqlitePool, name: &str) -> (String, String, String) {
    let owner = common::create_test_user(pool, name).await;
    let layer = common::master_layer_id(pool, &owner).await;
    let marker = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO marker_info_model (
            id, user_id, layer_id, marker_name, latitude, longitude, detail, create_at, update_at
         ) VALUES ($1, $2, $3, '共有対象', 35, 139, '共有本文', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(&marker)
    .bind(&owner)
    .bind(&layer)
    .execute(pool)
    .await
    .unwrap();
    (owner, layer, marker)
}

fn snapshot(owner: &str, layer: &str, marker: &str, version: i32, tiles: Value, id: &str) -> Value {
    json!({
        "version":version,
        "state":{
            "view":{"latitude":35.25,"longitude":139.25,"zoom":12},
            "tileServerId":id, "overlays":{},
            "markersVisible":true,"shapesVisible":true,"shapeNamesVisible":true,
            "layerIds":[layer],"markerIds":[marker],"shapeIds":[],
            "clusteringEnabled":false,"clusteringAllowed":true
        },
        "layers":{layer:{
            "id":layer,"user_id":owner,"layer_name":"共有時のグループ","is_master":true,
            "marker_icon_id":null,"marker_icon_filename":null
        }},
        "markers":{marker:{
            "id":marker,"layer_id":layer,"marker_name":"共有時の対象","detail":"共有時の本文",
            "latitude":35.25,"longitude":139.25
        }},
        "shapes":[],"tileServers":tiles,"tileOverlays":[]
    })
}

fn payload(layer: &str, snapshot: Option<Value>, update: bool) -> GenarateUrlPayload {
    GenarateUrlPayload {
        minutes: 60,
        layers: vec![layer.to_owned()],
        update_url: update,
        share_password: None,
        include_shapes: true,
        include_tile_overlays: false,
        snapshot,
    }
}

async fn create_share(
    pool: &SqlitePool,
    owner: &str,
    layer: &str,
    snapshot: Option<Value>,
) -> CreateUpdatedTemporaryUrlResponse {
    generate_url_handler(
        Extension(owner.to_owned()),
        Extension(pool.clone()),
        Json(payload(layer, snapshot, false)),
    )
    .await
    .unwrap()
    .0
}

async fn saved_share(pool: &SqlitePool, owner: &str) -> Value {
    let row = sqlx::query_as::<_, TemporaryUrlFromDB>(
        "SELECT id, user_id, url, expiration, password_hash, layers, markers, shapes,
            include_tile_overlays, map_snapshot, create_at
         FROM temporary_urls WHERE user_id=$1",
    )
    .bind(owner)
    .fetch_one(pool)
    .await
    .unwrap();
    let mut saved = serde_json::to_value(row).unwrap();
    for key in ["layers", "markers", "shapes", "map_snapshot"] {
        if let Some(value) = saved[key].as_str() {
            saved[key] = serde_json::from_str(value).unwrap();
        }
    }
    saved
}

async fn current_background(pool: &SqlitePool, id: i64) -> Value {
    let row = sqlx::query_as::<_, TileServers>(
        "SELECT id, layer_name, label, url, kind, style_url, attribution,
            include_foreign_tiles, min_zoom, max_zoom, create_at, updated_at
         FROM tileserver_model WHERE id=$1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap();
    serde_json::to_value(row).unwrap()
}

async fn rendered(pool: &SqlitePool, id: &str, mobile: bool) -> Value {
    let mut tera = Tera::default();
    for (name, mobile) in [
        ("temporary-map.html", false),
        ("temporary-map-mobile.html", true),
    ] {
        tera.add_raw_template(
            name,
            &format!(
                "{{\"mobile\":{mobile},\"snapshot\":{{{{ shareSnapshot | json_encode() | safe }}}},\"tiles\":{{{{ tileServers | json_encode() | safe }}}},\"markers\":{{{{ markersObj | json_encode() | safe }}}},\"latitude\":{{{{ latitude }}}},\"zoom\":{{{{ zoom }}}}}}"
            ),
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
        Query(serde_json::from_value(json!({"lat":35.5,"lng":139.5,"zoom":11})).unwrap()),
        Ok(Path(id.to_owned())),
    )
    .await
    .unwrap()
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let output: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 2_000_000).await.unwrap()).unwrap();
    assert_eq!(output["mobile"], mobile);
    output
}

#[tokio::test]
async fn editing_a_managed_raster_preserves_archived_v1_url_and_definition() {
    let pool = common::test_pool().await;
    let mut raster = seed_existing_raster(&pool).await;
    raster.as_object_mut().unwrap().remove("kind");
    raster.as_object_mut().unwrap().remove("style_url");
    let (owner, layer, marker) = owner_with_marker(&pool, "background-v1-owner").await;
    let admin = common::create_test_admin(&pool, "background-v1-admin").await;
    let shared = create_share(
        &pool,
        &owner,
        &layer,
        Some(snapshot(
            &owner,
            &layer,
            &marker,
            1,
            json!({"1":raster}),
            "1",
        )),
    )
    .await;
    let before = saved_share(&pool, &owner).await;
    assert!(
        before["map_snapshot"]["tileServers"]["1"]
            .get("kind")
            .is_none()
    );
    assert!(
        before["map_snapshot"]["tileServers"]["1"]
            .get("style_url")
            .is_none()
    );

    let mut changed = definition("raster", None);
    changed["url"] = json!("/new/{z}/{x}/{y}.png");
    changed["min_zoom"] = Value::Null;
    changed["max_zoom"] = Value::Null;
    let updated = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(1),
        Json(input(changed)),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(updated.id, 1);
    assert_eq!(updated.url, "/new/{z}/{x}/{y}.png");
    assert!(updated.min_zoom.is_none() && updated.max_zoom.is_none());
    assert_eq!(saved_share(&pool, &owner).await, before);
    for mobile in [false, true] {
        let page = rendered(&pool, &shared.id, mobile).await;
        assert_eq!(page["snapshot"], before["map_snapshot"]);
        assert_eq!(page["tiles"]["1"]["url"], "/old/{z}/{x}/{y}.png");
        assert_eq!(page["markers"], before["markers"]);
    }
}

#[tokio::test]
async fn editing_vector_style_or_kind_keeps_saved_v2_frozen_and_failed_updates_keep_the_url() {
    let pool = common::test_pool().await;
    let raster = seed_existing_raster(&pool).await;
    let (owner, layer, marker) = owner_with_marker(&pool, "background-v2-owner").await;
    let admin = common::create_test_admin(&pool, "background-v2-admin").await;
    let vector = admin_create(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Json(input(definition("vector", Some("/styles/captured.json")))),
    )
    .await
    .unwrap()
    .0;
    assert_ne!(vector.id, 1);
    let id = vector.id;
    let id_key = id.to_string();
    let captured = snapshot(
        &owner,
        &layer,
        &marker,
        2,
        json!({"1":raster, id_key.clone():serde_json::to_value(vector).unwrap()}),
        &id_key,
    );
    let shared = create_share(&pool, &owner, &layer, Some(captured.clone())).await;
    let before = saved_share(&pool, &owner).await;

    let mut changed = definition("vector", Some("/styles/current.json"));
    changed["url"] = json!("/current/{z}/{x}/{y}.png");
    let _ = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(id),
        Json(input(changed.clone())),
    )
    .await
    .unwrap();
    let current = current_background(&pool, id).await;
    assert_eq!(current["style_url"], "/styles/current.json");
    assert_eq!(current["url"], "/current/{z}/{x}/{y}.png");

    let mut invalid = changed;
    invalid["style_url"] = json!("http://invalid.test/style.json?token=private");
    let error = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(id),
        Json(input(invalid)),
    )
    .await
    .unwrap_err()
    .into_response();
    assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    assert_eq!(current_background(&pool, id).await, current);
    assert_eq!(saved_share(&pool, &owner).await, before);
    // 作成/更新時の現在定義との照合は維持し、失敗しても既存共有を置換しない。
    assert!(
        generate_url_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Json(payload(&layer, Some(captured), true)),
        )
        .await
        .is_err()
    );
    assert_eq!(saved_share(&pool, &owner).await, before);

    for convert_to_raster in [false, true] {
        if convert_to_raster {
            let _ = admin_update(
                Extension(admin.clone()),
                Extension(pool.clone()),
                Path(id),
                Json(input(definition("raster", None))),
            )
            .await
            .unwrap();
            assert_eq!(current_background(&pool, id).await["kind"], "raster");
        }
        assert_eq!(saved_share(&pool, &owner).await, before);
        for mobile in [false, true] {
            let page = rendered(&pool, &shared.id, mobile).await;
            assert_eq!(page["snapshot"], before["map_snapshot"]);
            assert_eq!(page["tiles"][&id_key]["kind"], "vector");
            assert_eq!(page["tiles"][&id_key]["style_url"], "/styles/captured.json");
            assert_eq!(page["tiles"][&id_key]["url"], "/fallback/{z}/{x}/{y}.png");
            assert_eq!(page["markers"], before["markers"]);
        }
    }
}

#[tokio::test]
async fn legacy_share_without_a_snapshot_keeps_its_url_and_reads_current_managed_backgrounds() {
    let pool = common::test_pool().await;
    seed_existing_raster(&pool).await;
    let (owner, layer, _) = owner_with_marker(&pool, "background-legacy-owner").await;
    let admin = common::create_test_admin(&pool, "background-legacy-admin").await;
    let shared = create_share(&pool, &owner, &layer, None).await;
    let before = saved_share(&pool, &owner).await;
    assert!(before["map_snapshot"].is_null());
    let vector = admin_create(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Json(input(definition("vector", Some("/styles/latest.json")))),
    )
    .await
    .unwrap()
    .0;
    let mut raster = definition("raster", None);
    raster["layer_name"] = json!("latest raster");
    raster["url"] = json!("/latest/{z}/{x}/{y}.png");
    let _ = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(1),
        Json(input(raster)),
    )
    .await
    .unwrap();

    assert_eq!(saved_share(&pool, &owner).await, before);
    for mobile in [false, true] {
        let page = rendered(&pool, &shared.id, mobile).await;
        assert!(page["snapshot"].is_null());
        assert_eq!(page["tiles"]["1"]["url"], "/latest/{z}/{x}/{y}.png");
        assert_eq!(page["tiles"][vector.id.to_string()]["kind"], "vector");
        assert_eq!(
            page["tiles"][vector.id.to_string()]["style_url"],
            "/styles/latest.json"
        );
        assert_eq!(page["markers"], before["markers"]);
        assert_eq!(page["latitude"], 35.5);
        assert_eq!(page["zoom"], 11);
    }
}

#[tokio::test]
async fn registering_a_new_vector_preserves_existing_backgrounds_and_all_share_versions() {
    let pool = common::test_pool().await;
    let raster = seed_existing_raster(&pool).await;
    sqlx::query(
        "INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, include_foreign_tiles,
            min_zoom, max_zoom, create_at, updated_at
         ) VALUES (
            17, 'other raster', '別のラスタ', '/other/{z}/{x}/{y}.png',
            '<span>既存の出典</span>', true, 3, 20,
            '2024-01-02 03:04:05', '2024-02-03 04:05:06'
         )",
    )
    .execute(&pool)
    .await
    .unwrap();
    let additional_raster = current_background(&pool, 17).await;
    let original_tiles = json!({"1":raster,"17":additional_raster});
    let mut legacy_tiles = original_tiles.clone();
    for tile in legacy_tiles.as_object_mut().unwrap().values_mut() {
        tile.as_object_mut().unwrap().remove("kind");
        tile.as_object_mut().unwrap().remove("style_url");
    }

    // 既存URLを更新せず、v1・v2ラスタ・従来共有が混在する導入前状態を作る。
    let mut archived = Vec::new();
    for (name, version) in [
        ("rollout-v1-owner", Some(1)),
        ("rollout-v2-raster-owner", Some(2)),
        ("rollout-legacy-owner", None),
    ] {
        let (owner, layer, marker) = owner_with_marker(&pool, name).await;
        let captured = version.map(|version| {
            snapshot(
                &owner,
                &layer,
                &marker,
                version,
                if version == 1 {
                    legacy_tiles.clone()
                } else {
                    original_tiles.clone()
                },
                "1",
            )
        });
        let shared = create_share(&pool, &owner, &layer, captured).await;
        let saved = saved_share(&pool, &owner).await;
        assert_eq!(saved["url"], shared.url);
        archived.push((owner, shared.id, saved));
    }

    let admin = common::create_test_admin(&pool, "rollout-admin").await;
    let mut registration = definition("vector", Some("/styles/rollout-v1.json"));
    registration["url"] = original_tiles["1"]["url"].clone();
    let vector = admin_create(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Json(input(registration)),
    )
    .await
    .unwrap()
    .0;
    // 明示挿入済みIDを再利用せず、登録APIが返した新IDを以後の共有へ使用する。
    assert!(vector.id > 17);
    let vector_id = vector.id;
    let vector_key = vector_id.to_string();
    let mut rollout_tiles = original_tiles.clone();
    rollout_tiles[&vector_key] = serde_json::to_value(vector).unwrap();
    let (owner, layer, marker) = owner_with_marker(&pool, "rollout-vector-owner").await;
    let vector_share = create_share(
        &pool,
        &owner,
        &layer,
        Some(snapshot(
            &owner,
            &layer,
            &marker,
            2,
            rollout_tiles,
            &vector_key,
        )),
    )
    .await;
    let saved_vector_share = saved_share(&pool, &owner).await;

    // 管理一覧の切り戻しも既存v2を消さない。旧版styleは引き続き必要となる。
    for rollback in [false, true] {
        if rollback {
            let mut raster_registration = definition("raster", None);
            raster_registration["url"] = original_tiles["1"]["url"].clone();
            let restored = admin_update(
                Extension(admin.clone()),
                Extension(pool.clone()),
                Path(vector_id),
                Json(input(raster_registration)),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(restored.id, vector_id);
            assert_eq!(restored.kind, "raster");
        }
        // 日時・nullズーム・出典原文を含む既存行全体が不変。
        for id in [1, 17] {
            assert_eq!(
                current_background(&pool, id).await,
                original_tiles[id.to_string()]
            );
        }
        for (old_owner, share_id, saved) in &archived {
            assert_eq!(saved_share(&pool, old_owner).await, *saved);
            for mobile in [false, true] {
                let page = rendered(&pool, share_id, mobile).await;
                assert_eq!(page["markers"], saved["markers"]);
                if saved["map_snapshot"].is_null() {
                    assert!(page["snapshot"].is_null());
                    assert_eq!(page["tiles"].as_object().unwrap().len(), 3);
                    assert_eq!(page["tiles"]["1"]["url"], original_tiles["1"]["url"]);
                    assert_eq!(
                        page["tiles"][&vector_key]["kind"],
                        if rollback { "raster" } else { "vector" }
                    );
                } else {
                    assert_eq!(page["snapshot"], saved["map_snapshot"]);
                    assert_eq!(page["tiles"], saved["map_snapshot"]["tileServers"]);
                    assert!(page["tiles"].get(&vector_key).is_none());
                }
            }
        }
        assert_eq!(saved_share(&pool, &owner).await, saved_vector_share);
        for mobile in [false, true] {
            let page = rendered(&pool, &vector_share.id, mobile).await;
            assert_eq!(page["snapshot"], saved_vector_share["map_snapshot"]);
            assert_eq!(page["tiles"][&vector_key]["kind"], "vector");
            assert_eq!(
                page["tiles"][&vector_key]["style_url"],
                "/styles/rollout-v1.json"
            );
        }
    }
}
