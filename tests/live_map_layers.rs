#[allow(dead_code)]
mod common;

use axum::{
    Json,
    extract::{Extension, Path, Query},
    http::HeaderMap,
};
use chrono::{Duration, Utc};
use geocode_web_single::{
    handler::{live_map::*, live_map_layers::*},
    model::CreateLiveMapPayload,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

async fn layer(pool: &SqlitePool, owner: &str, name: &str) -> String {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO layer_model(id,user_id,layer_name,is_master,create_at,update_at) VALUES($1,$2,$3,false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
        .bind(&id).bind(owner).bind(name).execute(pool).await.unwrap();
    id
}
fn payload(member: &str, selection: Option<Vec<String>>) -> CreateLiveMapPayload {
    let mut value = json!({"name":"公開地図","expires_at":Utc::now()+Duration::hours(1),"members":[{"user_id":member,"display_name":"共有者","marker_color":"#123456"}]});
    if let Some(ids) = selection {
        value["layer_ids"] = json!(ids);
    }
    serde_json::from_value(value).unwrap()
}
async fn update(
    pool: &SqlitePool,
    admin: &str,
    map: &str,
    member: &str,
    ids: Option<Vec<String>>,
) -> Result<axum::http::StatusCode, geocode_web_single::error::AppError> {
    update_live_map_handler(
        Extension(admin.into()),
        Extension(pool.clone()),
        Extension(None),
        Path(map.into()),
        Json(payload(member, ids)),
    )
    .await
}
async fn contents(pool: &SqlitePool, public: &str) -> Value {
    serde_json::to_value(published(pool, public).await.unwrap()).unwrap()
}
async fn publisher(pool: &SqlitePool, name: &str) -> String {
    let id = common::create_test_admin(pool, name).await;
    sqlx::query("UPDATE user_model SET can_share_live_location=true WHERE id=$1")
        .bind(&id)
        .execute(pool)
        .await
        .unwrap();
    id
}

#[tokio::test]
async fn selection_is_owned_explicit_atomic_and_excludes_master() {
    let pool = common::test_pool().await;
    let first = publisher(&pool, "first").await;
    let second = publisher(&pool, "second").await;
    let ordinary = common::create_test_user(&pool, "ordinary").await;
    let a = layer(&pool, &first, "A").await;
    let b = layer(&pool, &second, "B").await;
    let master = common::master_layer_id(&pool, &first).await;
    let Json(options) = candidates(Extension(first.clone()), Extension(pool.clone()))
        .await
        .unwrap();
    assert_eq!(
        options.iter().map(|l| l.id.clone()).collect::<Vec<_>>(),
        vec![a.clone()]
    );
    assert!(
        candidates(Extension(ordinary), Extension(pool.clone()))
            .await
            .is_err()
    );
    let Json(map) = create_live_map_handler(
        Extension(first.clone()),
        Extension(pool.clone()),
        Extension(None),
        Json(payload(&first, Some(vec![a.clone()]))),
    )
    .await
    .unwrap();
    let public = map.share_url.rsplit('/').next().unwrap();
    for invalid in [
        vec![master],
        vec![b.clone()],
        vec![Uuid::new_v4().to_string()],
        vec![a.clone(), a.clone()],
    ] {
        assert!(
            update(&pool, &first, &map.id, &first, Some(invalid))
                .await
                .is_err()
        );
        assert_eq!(contents(&pool, public).await["layers"][0]["id"], json!(a));
    }
    let Json(summary) = list_live_maps_handler(Extension(second.clone()), Extension(pool.clone()))
        .await
        .unwrap();
    assert!(summary[0].layers_configured_by_other);
    assert!(summary[0].layer_ids.is_empty());
    update(&pool, &second, &map.id, &first, None).await.unwrap();
    assert_eq!(contents(&pool, public).await["layers"][0]["id"], json!(a));
    update(&pool, &second, &map.id, &first, Some(vec![b.clone()]))
        .await
        .unwrap();
    assert_eq!(contents(&pool, public).await["layers"][0]["id"], json!(b));
    let creator: String = sqlx::query_scalar("SELECT created_by FROM live_map WHERE id=$1")
        .bind(&map.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(creator, first);
    update(&pool, &second, &map.id, &first, Some(vec![]))
        .await
        .unwrap();
    assert_eq!(contents(&pool, public).await["layers"], json!([]));
}

#[tokio::test]
async fn public_page_uses_latest_objects_and_respects_access_and_deletion() {
    let pool = common::test_pool().await;
    let admin = publisher(&pool, "publisher").await;
    let chosen = layer(&pool, &admin, "選択レイヤ").await;
    let master = common::master_layer_id(&pool, &admin).await;
    for id in [&chosen, &master] {
        sqlx::query("INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) VALUES($1,$2,$3,'marker',35,139,'memo',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            .bind(Uuid::new_v4().to_string()).bind(&admin).bind(id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO shape_model(id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at) VALUES($1,$2,$3,'circle','circle',$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            .bind(Uuid::new_v4().to_string()).bind(&admin).bind(id).bind(json!({"type":"Feature","geometry":{"type":"Point","coordinates":[139,35]},"properties":{"radius":100}}).to_string()).execute(&pool).await.unwrap();
    }
    let Json(map) = create_live_map_handler(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(None),
        Json(payload(&admin, Some(vec![chosen.clone()]))),
    )
    .await
    .unwrap();
    let public = map.share_url.rsplit('/').next().unwrap();
    let data = contents(&pool, public).await;
    assert_eq!(data["markers"].as_array().unwrap().len(), 1);
    assert_eq!(data["shapes"].as_array().unwrap().len(), 1);
    sqlx::query("UPDATE marker_info_model SET detail='latest' WHERE layer_id=$1")
        .bind(&chosen)
        .execute(&pool)
        .await
        .unwrap();
    let tera = geocode_web_single::build_tera_extension().unwrap();
    tera.lock()
        .await
        .add_raw_template(
            "live-map.html",
            "{{ publishedLayers | json_encode_for_html | safe }}",
        )
        .unwrap();
    let response = live_map_page_handler(
        HeaderMap::new(),
        Extension(tera.clone()),
        Extension(pool.clone()),
        Path(public.into()),
        Query(Default::default()),
    )
    .await
    .unwrap();
    let html = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    assert!(std::str::from_utf8(&html).unwrap().contains("latest"));
    let Json(rotated) = rotate_live_map_url_handler(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(None),
        Path(map.id.clone()),
    )
    .await
    .unwrap();
    let new_public = rotated.share_url.rsplit('/').next().unwrap();
    assert_eq!(
        contents(&pool, new_public).await["layers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(contents(&pool, public).await["layers"], json!([]));
    let mut protected = payload(&admin, None);
    protected.password_action = geocode_web_single::model::LiveMapPasswordAction::Set;
    protected.share_password = Some("secret".into());
    update_live_map_handler(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(None),
        Path(map.id.clone()),
        Json(protected),
    )
    .await
    .unwrap();
    let response = live_map_page_handler(
        HeaderMap::new(),
        Extension(tera.clone()),
        Extension(pool.clone()),
        Path(new_public.into()),
        Query(Default::default()),
    )
    .await
    .unwrap();
    let html = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    assert!(!std::str::from_utf8(&html).unwrap().contains("latest"));
    sqlx::query("UPDATE live_map SET expires_at=$2, password_hash=NULL WHERE id=$1")
        .bind(&map.id)
        .bind(Utc::now() - Duration::minutes(1))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(contents(&pool, new_public).await["layers"], json!([]));
    let expired = live_map_page_handler(
        HeaderMap::new(),
        Extension(tera),
        Extension(pool.clone()),
        Path(new_public.into()),
        Query(Default::default()),
    )
    .await
    .unwrap();
    let html = axum::body::to_bytes(expired.into_body(), 1_000_000)
        .await
        .unwrap();
    assert!(!std::str::from_utf8(&html).unwrap().contains("latest"));

    sqlx::query("DELETE FROM layer_model WHERE id=$1")
        .bind(&chosen)
        .execute(&pool)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM live_map_layer")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn tile_usage_is_saved_and_query_cannot_override_it() {
    use geocode_web_single::handler::tile_overlays::*;
    let pool = common::test_pool().await;
    let owner = publisher(&pool, "tile-owner").await;
    let editor = publisher(&pool, "tile-editor").await;
    let Json(tile)=admin_create(Extension(owner.clone()),Extension(pool.clone()),Json(serde_json::from_value(json!({"name":"洪水","url":"https://example.com/{z}/{x}/{y}.png","attribution":"","min_zoom":0,"max_zoom":18,"opacity":1.0,"sort_order":0,"enabled":true})).unwrap())).await.unwrap();
    let _ = user_select(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        Json(serde_json::from_value(json!({"selected":true})).unwrap()),
    )
    .await
    .unwrap();
    let Json(map) = create_live_map_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Extension(None),
        Json(payload(&owner, None)),
    )
    .await
    .unwrap();
    let public = map.share_url.rsplit('/').next().unwrap();
    let tera = geocode_web_single::build_tera_extension().unwrap();
    tera.lock()
        .await
        .add_raw_template(
            "live-map.html",
            "{{ tileOverlays | length }}|{{ isCheckOverlay }}",
        )
        .unwrap();
    for enabled in [true, false, true] {
        let mut p = payload(&owner, None);
        p.use_tile_overlays = enabled;
        update_live_map_handler(
            Extension(editor.clone()),
            Extension(pool.clone()),
            Extension(None),
            Path(map.id.clone()),
            Json(p),
        )
        .await
        .unwrap();
        let Json(maps) = list_live_maps_handler(Extension(editor.clone()), Extension(pool.clone()))
            .await
            .unwrap();
        assert_eq!(maps[0].use_tile_overlays, enabled);
        let response = live_map_page_handler(
            HeaderMap::new(),
            Extension(tera.clone()),
            Extension(pool.clone()),
            Path(public.into()),
            Query(LiveMapViewParams {
                is_check_overlay: Some("true".into()),
            }),
        )
        .await
        .unwrap();
        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        assert_eq!(
            std::str::from_utf8(&body).unwrap(),
            if enabled { "1|true" } else { "0|true" }
        );
    }
}

#[tokio::test]
async fn selection_waits_for_concurrent_layer_deletion() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::time::Duration;
    let path = common::test_files_dir().join(format!("live-layer-race-{}.sqlite", Uuid::new_v4()));
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    let admin = publisher(&pool, "race-admin").await;
    let a = layer(&pool, &admin, "kept").await;
    let b = layer(&pool, &admin, "deleted").await;
    let Json(map) = create_live_map_handler(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(None),
        Json(payload(&admin, Some(vec![a.clone()]))),
    )
    .await
    .unwrap();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("DELETE FROM layer_model WHERE id=$1")
        .bind(&b)
        .execute(&mut *tx)
        .await
        .unwrap();
    let worker_pool = pool.clone();
    let map_id = map.id.clone();
    let worker =
        tokio::spawn(
            async move { update(&worker_pool, &admin, &map_id, &admin, Some(vec![b])).await },
        );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!worker.is_finished());
    tx.commit().await.unwrap();
    assert!(worker.await.unwrap().is_err());
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT layer_id FROM live_map_layer WHERE map_id=$1")
            .bind(&map.id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(ids, vec![a]);
    pool.close().await;
    for attempt in 0..50 {
        match std::fs::remove_file(&path) {
            Ok(()) => break,
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(32 | 33))
                    && attempt < 49 =>
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            },
            Err(error) => panic!("failed to remove test database {}: {error}", path.display()),
        }
    }
}
