#[allow(dead_code)]
mod common;

use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::post,
};
use geocode_web_single::{
    handler::background_maps::admin_create,
    local_tiles::{
        LocalTiles,
        catalog::{self, DatasetRecord, ProfileRecord},
        config::LocalTileConfig,
    },
};
use serde_json::json;
use std::time::Duration;
use tower::ServiceExt;

#[tokio::test]
async fn background_http_rejects_normalized_local_alias_without_opening_the_catalog() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "local-alias-admin").await;
    let root = tempfile::tempdir().unwrap();
    let config = LocalTileConfig::defaults(root.path());
    let service = LocalTiles::new(config.clone(), pool.clone());
    let router = Router::new()
        .route("/backgrounds", post(admin_create))
        .layer(Extension(admin))
        .layer(Extension(pool.clone()))
        .layer(Extension(service.clone()));
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backgrounds")
                .header("content-type", "application/json")
                .body(Body::from(json!({
                    "layer_name":"alias", "label":"alias",
                    "url":format!("/other/%2e%2e/local-tiles/{}/{}/{{z}}/{{x}}/{{y}}.png", "a".repeat(64), "b".repeat(64)),
                    "attribution":"", "include_foreign_tiles":false,
                    "min_zoom":0, "max_zoom":22
                }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("登録済みタイルURL"));
    assert!(!config.catalog_database_path.exists());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tileserver_model")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    service.shutdown().await;
    pool.close().await;
}

#[tokio::test]
async fn first_local_background_request_initializes_before_taking_a_single_app_connection() {
    let root = tempfile::tempdir().unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(root.path().join("app.sqlite"))
        .create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_millis(500))
        .connect_with(options)
        .await
        .unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    let admin = common::create_test_admin(&pool, "single-connection-local-admin").await;
    let config = LocalTileConfig::defaults(root.path());
    let former = LocalTiles::new(config.clone(), pool.clone());
    let dataset_id = "a".repeat(64);
    let profile_id = "b".repeat(64);
    catalog::insert_dataset_with_profile(
        &former.catalog,
        &DatasetRecord {
            id: dataset_id.clone(),
            name: "sample".into(),
            storage_kind: "external".into(),
            database_path: root
                .path()
                .join("dataset.sqlite")
                .to_string_lossy()
                .into_owned(),
            dataset_key: dataset_id.clone(),
            info_json: "{}".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
            retired: false,
        },
        &ProfileRecord {
            id: profile_id.clone(),
            dataset_id: dataset_id.clone(),
            build_id: "test".into(),
            info_json: "{}".into(),
            retired: false,
        },
    )
    .await
    .unwrap();
    former.shutdown().await;
    let service = LocalTiles::new(config, pool.clone());
    assert!(
        service.catalog.path().is_none(),
        "the new process is still lazy"
    );
    let router = Router::new()
        .route("/backgrounds", post(admin_create))
        .layer(Extension(admin))
        .layer(Extension(pool.clone()))
        .layer(Extension(service.clone()));
    let response = tokio::time::timeout(
        Duration::from_secs(3),
        router.oneshot(
            Request::builder()
                .method("POST")
                .uri("/backgrounds")
                .header("content-type", "application/json")
                .body(Body::from(json!({
                    "layer_name":"local", "label":"local",
                    "url":format!("/local-tiles/{dataset_id}/{profile_id}/{{z}}/{{x}}/{{y}}.png"),
                    "attribution":"", "include_foreign_tiles":false,
                    "min_zoom":0, "max_zoom":22
                }).to_string()))
                .unwrap(),
        ),
    )
    .await
    .expect("catalog initialization must not wait on the occupied app pool")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(service.catalog.path().is_some());
    service.shutdown().await;
    pool.close().await;
}
