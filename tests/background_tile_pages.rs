//! 回答・ライブ・従来共有ページへ、背景の種別とスタイルURLが渡ることを確認する。
#[allow(dead_code)]
mod common;

use axum::{
    Form, Json,
    body::to_bytes,
    extract::{Extension, Path, Query},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use geocode_web_single::{
    handler::{
        answer_map::{AnswerMapRequest, answer_map_handler},
        live_map::live_map_page_handler,
        onetime_url::{generate_url_handler, temporary_map_get_handler},
    },
    model::GenarateUrlPayload,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::sync::Arc;
use tera::Tera;
use tokio::sync::Mutex;
use uuid::Uuid;

async fn fixture(pool: &SqlitePool) -> (String, Arc<Mutex<Tera>>) {
    let user = common::create_test_user(pool, "background-page-owner").await;
    sqlx::query(
        "INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, include_foreign_tiles,
            min_zoom, max_zoom, create_at, updated_at, kind, style_url
         ) VALUES
            (1, 'raster', '従来背景', '/tile/{z}/{x}/{y}.png', '出典', false,
             5, 18, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'raster', NULL),
            (2, 'vector', '新背景', '/fallback/{z}/{x}/{y}.png', '出典', false,
             5, 18, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'vector', '/styles/v1.json')",
    )
    .execute(pool)
    .await
    .unwrap();
    let mut tera = Tera::default();
    for name in [
        "form-answer-map.html",
        "live-map.html",
        "temporary-map.html",
        "temporary-map-mobile.html",
    ] {
        tera.add_raw_template(name, "{{ tileServers | json_encode() | safe }}")
            .unwrap();
    }
    tera.add_raw_template("form-answer-map-error.html", "{{ message }}")
        .unwrap();
    (user, Arc::new(Mutex::new(tera)))
}

async fn assert_background_metadata(response: Response) {
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let tiles: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(tiles.as_object().unwrap().len(), 2);
    assert_eq!(tiles["1"]["kind"], "raster");
    assert!(tiles["1"]["style_url"].is_null());
    assert_eq!(tiles["1"]["url"], "/tile/{z}/{x}/{y}.png");
    assert_eq!(tiles["2"]["kind"], "vector");
    assert_eq!(tiles["2"]["style_url"], "/styles/v1.json");
    assert_eq!(tiles["2"]["url"], "/fallback/{z}/{x}/{y}.png");
}

#[tokio::test]
async fn answer_map_page_receives_background_rendering_metadata() {
    let pool = common::test_pool().await;
    let (user, tera) = fixture(&pool).await;
    let layer = common::master_layer_id(&pool, &user).await;
    let marker = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO marker_info_model (
            id, user_id, layer_id, marker_name, latitude, longitude,
            detail, create_at, update_at
         ) VALUES ($1, $2, $3, '回答対象', 35, 139, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(&marker)
    .bind(&user)
    .bind(&layer)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO marker_form_submission_model (
            id, marker_id, create_at, submitted_values, rendered_markdown, form_snapshot
         ) VALUES ($1, $2, datetime('now', '-1 second'), '{}', '',
                   '{\"form_title\":\"記録\",\"form_schema\":{\"fields\":[]}}')",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&marker)
    .execute(&pool)
    .await
    .unwrap();
    let response = answer_map_handler(
        Extension(user),
        Extension(pool),
        Extension(tera),
        Form(AnswerMapRequest {
            query: json!({"mode":"latest", "target_type":"marker", "target_id":marker}).to_string(),
            parent_origin: "http://localhost:3000".into(),
            request_id: "background-metadata".into(),
            analysis: None,
            initial_view: None,
        }),
    )
    .await
    .unwrap();
    assert_background_metadata(response).await;
}

#[tokio::test]
async fn live_map_page_receives_background_rendering_metadata() {
    let pool = common::test_pool().await;
    let (user, tera) = fixture(&pool).await;
    let public_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO live_map (id, public_id, name, created_by, expires_at)
         VALUES ($1, $2, 'background metadata', $3, datetime('now', '+1 hour'))",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&public_id)
    .bind(&user)
    .execute(&pool)
    .await
    .unwrap();
    let response = live_map_page_handler(
        HeaderMap::new(),
        Extension(tera),
        Extension(pool),
        Path(public_id.to_string()),
        Query(Default::default()),
    )
    .await
    .unwrap();
    assert_background_metadata(response).await;
}

#[tokio::test]
async fn nonsnapshot_share_pages_receive_current_background_metadata_on_desktop_and_mobile() {
    let pool = common::test_pool().await;
    let (user, tera) = fixture(&pool).await;
    let layer = common::master_layer_id(&pool, &user).await;
    let Json(created) = generate_url_handler(
        Extension(user),
        Extension(pool.clone()),
        Json(GenarateUrlPayload {
            minutes: 60,
            layers: vec![layer],
            update_url: false,
            share_password: None,
            include_shapes: true,
            include_tile_overlays: true,
            snapshot: None,
        }),
    )
    .await
    .unwrap();
    let metadata: Option<String> =
        sqlx::query_scalar("SELECT map_snapshot FROM temporary_urls WHERE id = $1")
            .bind(&created.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(metadata.is_none());
    for agent in ["Desktop", "Mobile"] {
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", agent.parse().unwrap());
        let response = temporary_map_get_handler(
            headers,
            Extension(pool.clone()),
            Extension(tera.clone()),
            Query(serde_json::from_value(json!({})).unwrap()),
            Ok(Path(created.id.clone())),
        )
        .await
        .unwrap()
        .into_response();
        assert_background_metadata(response).await;
    }
}
