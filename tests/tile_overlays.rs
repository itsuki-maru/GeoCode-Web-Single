#[allow(dead_code)]
mod common;

use axum::{
    Json,
    extract::{Extension, Path},
};
use geocode_web_single::handler::tile_overlays::*;
use serde_json::json;

fn definition(enabled: bool) -> TileOverlayInput {
    serde_json::from_value(json!({"name":"洪水", "url":"https://example.com/{z}/{x}/{y}.png", "attribution":"出典", "min_zoom":0,"max_zoom":18,"opacity":0.7,"sort_order":0,"enabled":enabled})).unwrap()
}
fn selection(selected: bool) -> Json<SelectionInput> {
    Json(serde_json::from_value(json!({"selected":selected})).unwrap())
}

async fn html(response: impl axum::response::IntoResponse) -> String {
    let response = response.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    String::from_utf8(
        axum::body::to_bytes(response.into_body(), 2_000_000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn all_map_pages_load_their_owners_latest_tiles() {
    let pool = common::test_pool().await;
    use axum::{extract::Query, http::HeaderMap};
    use geocode_web_single::handler::{
        live_map::live_map_page_handler,
        map::{map_another_get_handler, map_get_handler},
        onetime_url::temporary_map_get_handler,
    };
    use uuid::Uuid;
    let owner = common::create_test_admin(&pool, "map-tile-owner").await;
    let other = common::create_test_admin(&pool, "other-tile-admin").await;
    let Json(tile) = admin_create(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Json(definition(true)),
    )
    .await
    .unwrap();
    let other_definition = definition(true);
    // Distinct IDs prove the shared map follows its creator, not all admins.
    let Json(other_tile) = admin_create(
        Extension(other.clone()),
        Extension(pool.clone()),
        Json(other_definition),
    )
    .await
    .unwrap();
    let _ = user_select(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        selection(true),
    )
    .await
    .unwrap();
    let _ = user_select(
        Extension(other.clone()),
        Extension(pool.clone()),
        Path(other_tile.id.clone()),
        selection(true),
    )
    .await
    .unwrap();
    let tera = geocode_web_single::build_tera_extension().unwrap();
    // Exercise current source templates even if the distribution bundle is older.
    {
        let mut templates = tera.lock().await;
        for name in [
            "map",
            "map-mobile",
            "map-anather",
            "temporary-map",
            "temporary-map-mobile",
            "live-map",
        ] {
            let path = format!("src/templates/{name}.html");
            templates
                .add_raw_template(
                    &format!("{name}.html"),
                    &std::fs::read_to_string(path).unwrap(),
                )
                .unwrap();
        }
    }
    let temp_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO temporary_urls(id,user_id,url,expiration,layers,markers,shapes,include_tile_overlays,create_at) VALUES($1,$2,'/test',datetime('now', '+1 hour'),'{}','{}','{}',1,CURRENT_TIMESTAMP)")
        .bind(&temp_id).bind(&owner).execute(&pool).await.unwrap();
    let public_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO live_map(id,public_id,name,created_by,expires_at) VALUES($1,$2,'test',$3,datetime('now', '+1 hour'))")
        .bind(Uuid::new_v4().to_string()).bind(&public_id).bind(&owner).execute(&pool).await.unwrap();
    let mut pages = Vec::new();
    for agent in ["Desktop", "Mobile"] {
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", agent.parse().unwrap());
        pages.push(
            html(
                map_get_handler(
                    Extension(owner.clone()),
                    Extension(pool.clone()),
                    Extension(tera.clone()),
                    Query(serde_json::from_value(json!({})).unwrap()),
                    headers.clone(),
                )
                .await
                .unwrap(),
            )
            .await,
        );
        pages.push(
            html(
                temporary_map_get_handler(
                    headers,
                    Extension(pool.clone()),
                    Extension(tera.clone()),
                    Query(serde_json::from_value(json!({})).unwrap()),
                    Ok(Path(temp_id.clone())),
                )
                .await
                .unwrap(),
            )
            .await,
        );
    }
    pages.push(
        html(
            map_another_get_handler(
                Extension(owner.clone()),
                Extension(pool.clone()),
                Extension(tera.clone()),
                Query(serde_json::from_value(json!({})).unwrap()),
            )
            .await
            .unwrap(),
        )
        .await,
    );
    pages.push(
        html(
            live_map_page_handler(
                HeaderMap::new(),
                Extension(tera.clone()),
                Extension(pool.clone()),
                Path(public_id.to_string()),
                axum::extract::Query(Default::default()),
            )
            .await
            .unwrap(),
        )
        .await,
    );
    for (index, page) in pages.into_iter().enumerate() {
        assert!(
            page.contains(&tile.id.to_string()),
            "page {index} must contain owner tile"
        );
        assert!(!page.contains(&other_tile.id.to_string()));
    }
    let _ = user_select(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        selection(false),
    )
    .await
    .unwrap();
    let refreshed = html(
        live_map_page_handler(
            HeaderMap::new(),
            Extension(tera),
            Extension(pool),
            Path(public_id.to_string()),
            axum::extract::Query(Default::default()),
        )
        .await
        .unwrap(),
    )
    .await;
    assert!(!refreshed.contains(&tile.id.to_string()));
}

#[tokio::test]
async fn permissions_selection_isolation_and_definition_lifecycle() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "tile-admin").await;
    let user = common::create_test_user(&pool, "tile-user").await;
    assert!(
        admin_create(
            Extension(user.clone()),
            Extension(pool.clone()),
            Json(definition(true))
        )
        .await
        .is_err()
    );
    assert!(
        admin_list(Extension(user.clone()), Extension(pool.clone()))
            .await
            .is_err()
    );
    let Json(tile) = admin_create(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Json(definition(true)),
    )
    .await
    .unwrap();
    assert!(
        admin_update(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(tile.id.clone()),
            Json(definition(false))
        )
        .await
        .is_err()
    );
    assert!(
        admin_delete(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(tile.id.clone())
        )
        .await
        .is_err()
    );
    for _ in 0..2 {
        let Json(selected) = user_select(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(tile.id.clone()),
            selection(true),
        )
        .await
        .unwrap();
        assert_eq!(selected.len(), 1);
    }
    assert!(selected_tiles(&pool, &admin).await.unwrap().is_empty());
    // Another account cannot remove this user's selection.
    let _ = user_select(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        selection(false),
    )
    .await
    .unwrap();
    assert_eq!(selected_tiles(&pool, &user).await.unwrap().len(), 1);
    let _ = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        Json(definition(false)),
    )
    .await
    .unwrap();
    assert!(selected_tiles(&pool, &user).await.unwrap().is_empty());
    assert!(
        user_select(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(tile.id.clone()),
            selection(true)
        )
        .await
        .is_err()
    );
    let _ = admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        Json(definition(true)),
    )
    .await
    .unwrap();
    assert_eq!(selected_tiles(&pool, &user).await.unwrap().len(), 1);
    let _ = user_select(
        Extension(user.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        selection(false),
    )
    .await
    .unwrap();
    assert!(selected_tiles(&pool, &user).await.unwrap().is_empty());
    let _ = user_select(
        Extension(user.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        selection(true),
    )
    .await
    .unwrap();
    let _ = admin_delete(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
    )
    .await
    .unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_tile_overlay_model")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn upgrade_preserves_existing_data_and_cascades_user_deletion() {
    let pool = common::test_pool().await;
    let user = common::create_test_admin(&pool, "upgrade-tile-user").await;
    // Recreate the schema immediately before this feature's migration.
    sqlx::raw_sql("DROP TABLE user_tile_overlay_model; DROP TABLE tile_overlay_model; DELETE FROM schema_migrations WHERE version=11;")
        .execute(&pool).await.unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    let Json(tile) = admin_create(
        Extension(user.clone()),
        Extension(pool.clone()),
        Json(definition(true)),
    )
    .await
    .unwrap();
    let _ = user_select(
        Extension(user.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        selection(true),
    )
    .await
    .unwrap();
    assert_eq!(selected_tiles(&pool, &user).await.unwrap().len(), 1);
    sqlx::query("DELETE FROM user_model WHERE id=$1")
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_tile_overlay_model")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let invalid = sqlx::query("UPDATE tile_overlay_model SET opacity=2 WHERE id=$1")
        .bind(&tile.id)
        .execute(&pool)
        .await;
    assert!(invalid.is_err());
}

#[tokio::test]
async fn selection_waits_for_concurrent_disable() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::time::Duration;
    let path = common::test_files_dir().join(format!("tile-race-{}.sqlite", uuid::Uuid::new_v4()));
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
    let user = common::create_test_admin(&pool, "race-user").await;
    let Json(tile) = admin_create(
        Extension(user.clone()),
        Extension(pool.clone()),
        Json(definition(true)),
    )
    .await
    .unwrap();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("UPDATE tile_overlay_model SET enabled=false WHERE id=$1")
        .bind(&tile.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let worker_pool = pool.clone();
    let task = tokio::spawn(async move {
        user_select(
            Extension(user),
            Extension(worker_pool),
            Path(tile.id),
            selection(true),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    tx.commit().await.unwrap();
    assert!(matches!(
        task.await.unwrap(),
        Err(geocode_web_single::error::AppError::NotFound)
    ));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_tile_overlay_model")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    pool.close().await;
    // Windows can briefly retain a file handle after the pool closes. Retry
    // only sharing/lock violations; never hide other errors or a lasting lock.
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

#[tokio::test]
async fn live_map_query_controls_initial_overlay_visibility() {
    use axum::extract::Query;
    use geocode_web_single::handler::live_map::live_map_page_handler;
    let pool = common::test_pool().await;
    let owner = common::create_test_admin(&pool, "query-owner").await;
    let public_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO live_map(id,public_id,name,created_by,expires_at) VALUES($1,$2,'query-test',$3,datetime('now','+1 hour'))")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&public_id).bind(owner).execute(&pool).await.unwrap();
    let tera = geocode_web_single::build_tera_extension().unwrap();
    tera.lock()
        .await
        .add_raw_template(
            "live-map.html",
            &std::fs::read_to_string("src/templates/live-map.html").unwrap(),
        )
        .unwrap();
    for (query, expected) in [
        ("", false),
        ("?is_check_overlay=true", true),
        ("?is_check_overlay=false", false),
        ("?is_check_overlay=invalid", false),
    ] {
        let uri = format!("/live/{public_id}{query}").parse().unwrap();
        let page = html(
            live_map_page_handler(
                axum::http::HeaderMap::new(),
                Extension(tera.clone()),
                Extension(pool.clone()),
                Path(public_id.clone()),
                Query::try_from_uri(&uri).unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert!(page.contains(&format!("isCheckOverlay: {expected}")));
    }
}

#[tokio::test]
async fn temporary_overlay_sharing_is_opt_in_and_query_only_controls_visibility() {
    let pool = common::test_pool().await;
    use axum::{Form, extract::Query, http::HeaderMap};
    use geocode_web_single::handler::onetime_url::{
        generate_url_handler, temporary_map_auth_handler, temporary_map_get_handler,
    };
    use geocode_web_single::model::OnetimePasswordForm;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    let owner = common::create_test_admin(&pool, "temporary-overlay-owner").await;
    let layer = common::master_layer_id(&pool, &owner).await;
    let Json(tile) = admin_create(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Json(definition(true)),
    )
    .await
    .unwrap();
    let _ = user_select(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Path(tile.id.clone()),
        selection(true),
    )
    .await
    .unwrap();
    let mut tera = tera::Tera::default();
    for name in ["temporary-map.html", "temporary-map-mobile.html"] {
        tera.add_raw_template(
            name,
            "{{ tileOverlays | length }}|{{ isOverlayTile }}|{{ isChecked }}",
        )
        .unwrap();
    }
    tera.add_raw_template("temporary-password.html", "{{ mapStateQuery }}")
        .unwrap();
    let tera = Arc::new(Mutex::new(tera));
    let mut previous_id: Option<String> = None;
    for enabled in [false, true, false] {
        let Json(created) = generate_url_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Json(
                serde_json::from_value(json!({
                    "minutes": 60, "layers": [layer], "update_url": previous_id.is_some(),
                    "include_tile_overlays": enabled
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        if let Some(ref id) = previous_id {
            assert_eq!(&created.id, id);
        }
        previous_id = Some(created.id.clone());
        let saved: bool =
            sqlx::query_scalar("SELECT include_tile_overlays FROM temporary_urls WHERE id=$1")
                .bind(&created.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(saved, enabled);
        for agent in ["Desktop", "Mobile"] {
            for (query, visible) in [
                (None, true),
                (Some("true"), true),
                (Some("false"), false),
                (Some("FALSE"), false),
                (Some("invalid"), true),
            ] {
                let mut headers = HeaderMap::new();
                headers.insert("user-agent", agent.parse().unwrap());
                let params = || {
                    Query(
                        serde_json::from_value(
                            json!({"is_overlay_tile": query, "is_checked":"false"}),
                        )
                        .unwrap(),
                    )
                };
                let body = html(
                    temporary_map_get_handler(
                        headers.clone(),
                        Extension(pool.clone()),
                        Extension(tera.clone()),
                        params(),
                        Ok(Path(created.id.clone())),
                    )
                    .await
                    .unwrap(),
                )
                .await;
                assert_eq!(body, format!("{}|{}|false", usize::from(enabled), visible));
                // The same selection survives password prompts, failed retries and successful authentication.
                sqlx::query("UPDATE temporary_urls SET password_hash=$1 WHERE id=$2")
                    .bind(bcrypt::hash("pass1234", 4).unwrap())
                    .bind(&created.id)
                    .execute(&pool)
                    .await
                    .unwrap();
                let prompt = html(
                    temporary_map_get_handler(
                        headers.clone(),
                        Extension(pool.clone()),
                        Extension(tera.clone()),
                        params(),
                        Ok(Path(created.id.clone())),
                    )
                    .await
                    .unwrap(),
                )
                .await;
                assert!(prompt.contains(&format!("is_overlay_tile={visible}")));
                let failed = html(
                    temporary_map_auth_handler(
                        headers.clone(),
                        Extension(pool.clone()),
                        Extension(tera.clone()),
                        params(),
                        Path(created.id.clone()),
                        Form(OnetimePasswordForm {
                            password: "wrong".into(),
                        }),
                    )
                    .await
                    .unwrap(),
                )
                .await;
                assert_eq!(failed, prompt);
                let authenticated = html(
                    temporary_map_auth_handler(
                        headers,
                        Extension(pool.clone()),
                        Extension(tera.clone()),
                        params(),
                        Path(created.id.clone()),
                        Form(OnetimePasswordForm {
                            password: "pass1234".into(),
                        }),
                    )
                    .await
                    .unwrap(),
                )
                .await;
                assert_eq!(authenticated, body);
                sqlx::query("UPDATE temporary_urls SET password_hash=NULL WHERE id=$1")
                    .bind(&created.id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        }
    }
}
