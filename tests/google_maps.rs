#[allow(dead_code)]
mod common;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, Request, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use geocode_web_single::{
    auth::create_token,
    google_maps::{self, GoogleMaps},
    handler::{background_maps, live_map::live_map_page_handler},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

#[derive(Default)]
struct Calls {
    sessions: usize,
    tiles: usize,
    viewports: usize,
    session_bodies: Vec<Value>,
}
async fn mock_session(
    State(state): State<Arc<Mutex<Calls>>>,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert_eq!(query["key"], "test-google-key");
    let mut state = state.lock().unwrap();
    state.sessions += 1;
    state.session_bodies.push(body);
    Json(
        json!({"session":"private-google-session","expiry":(chrono::Utc::now().timestamp()+3600).to_string(),"tileWidth":256,"tileHeight":256,"imageFormat":"png"}),
    )
}
async fn mock_tile(
    State(state): State<Arc<Mutex<Calls>>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    assert_eq!(query["session"], "private-google-session");
    assert_eq!(query["key"], "test-google-key");
    state.lock().unwrap().tiles += 1;
    (
        [(header::CONTENT_TYPE, "image/png")],
        b"\x89PNG\r\n\x1a\nfixture".to_vec(),
    )
}
async fn mock_viewport(
    State(state): State<Arc<Mutex<Calls>>>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<Value> {
    assert_eq!(query["zoom"], "10");
    assert_eq!(query["session"], "private-google-session");
    state.lock().unwrap().viewports += 1;
    Json(
        json!({"copyright":"Map data ©Google, Example","maxZoomRects":[{"north":90,"south":-90,"west":-180,"east":180,"maxZoom":19}]}),
    )
}
async fn body(response: impl IntoResponse) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_response().into_body(), 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

fn grant_headers(grant: &Value) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", grant["grant"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    headers
}

async fn render_access(response: impl IntoResponse) -> String {
    String::from_utf8(
        to_bytes(response.into_response().into_body(), 65536)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn google_relay_verifies_current_background_and_view_access_before_contacting_upstream() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "google-admin").await;
    let user = common::create_test_user(&pool, "google-user").await;
    let calls = Arc::new(Mutex::new(Calls::default()));
    let app = Router::new()
        .route("/v1/createSession", post(mock_session))
        .route("/v1/2dtiles/{z}/{x}/{y}", get(mock_tile))
        .route("/tile/v1/viewport", get(mock_viewport))
        .with_state(calls.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let service = Arc::new(GoogleMaps::new(
        base,
        Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
    ));
    let enable_routes = || {
        Json(
            serde_json::from_value(json!({
                "revision": uuid::Uuid::nil(), "enabled": true, "requestsPerMinute": 60,
            }))
            .unwrap(),
        )
    };
    let without_key = google_maps::routes::admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(service.clone()),
        enable_routes(),
    )
    .await;
    assert!(matches!(
        without_key,
        Err(geocode_web_single::error::AppError::Validation(_))
    ));
    let setting = json!({"revision":uuid::Uuid::nil(),"enabled":true,"apiKey":"test-google-key","language":"ja-JP","region":"JP","requestsPerMinute":1200});
    assert!(
        google_maps::admin_update(
            Extension(user.clone()),
            Extension(pool.clone()),
            Extension(service.clone()),
            Json(serde_json::from_value(setting.clone()).unwrap())
        )
        .await
        .is_err()
    );
    let result = google_maps::admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(service.clone()),
        Json(serde_json::from_value(setting).unwrap()),
    )
    .await
    .unwrap();
    let settings = body(result).await;
    assert_eq!(settings["hasApiKey"], true);
    assert!(!settings.to_string().contains("test-google-key"));
    let encrypted: Vec<u8> =
        sqlx::query_scalar("SELECT encrypted_tiles_key FROM google_maps_settings")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted).contains("test-google-key"));

    sqlx::query(
        r#"
        INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, create_at, updated_at, provider, google_map_type
        ) VALUES
            (1, 'default', 'default', '/tile/{z}/{x}/{y}.png', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'generic', NULL),
            (2, 'google', 'Google', '/google-maps/tiles/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'google', 'terrain'),
            (3, 'other', 'Other Google', '/google-maps/tiles/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'google', 'terrain')
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let input = || Json(serde_json::from_value(json!({"backgroundId":2})).unwrap());
    let rejected = google_maps::context(
        Extension(pool.clone()),
        Extension(service.clone()),
        HeaderMap::new(),
        input(),
    )
    .await;
    assert_eq!(
        rejected.unwrap_err_response_status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(calls.lock().unwrap().sessions, 0);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        format!(
            "access_token={}",
            create_token(&user, 30, "access_token", 0).unwrap()
        )
        .parse()
        .unwrap(),
    );
    let response = google_maps::context(
        Extension(pool.clone()),
        Extension(service.clone()),
        headers.clone(),
        input(),
    )
    .await
    .unwrap();
    let grant = body(response).await;
    assert_eq!(grant["routesEnabled"], false);
    assert!(!grant.to_string().contains("test-google-key"));
    assert!(!grant.to_string().contains("private-google-session"));
    let authorized = grant_headers(&grant);
    let response = google_maps::tile(
        Extension(pool.clone()),
        Extension(service.clone()),
        authorized.clone(),
        Path((10, 900, 400)),
    )
    .await
    .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    let viewport =
        serde_json::from_value(json!({"zoom":10,"north":36,"south":35,"east":140,"west":139}))
            .unwrap();
    let response = google_maps::viewport(
        Extension(pool.clone()),
        Extension(service.clone()),
        authorized.clone(),
        Query(viewport),
    )
    .await
    .unwrap();
    assert_eq!(
        body(response).await["copyright"],
        "Map data ©Google, Example"
    );
    google_maps::context(
        Extension(pool.clone()),
        Extension(service.clone()),
        headers.clone(),
        input(),
    )
    .await
    .unwrap();
    {
        let calls = calls.lock().unwrap();
        assert_eq!(calls.sessions, 1);
        assert_eq!(calls.tiles, 1);
        assert_eq!(calls.viewports, 1);
        assert_eq!(
            calls.session_bodies[0]["layerTypes"],
            json!(["layerRoadmap"])
        );
    }
    assert_eq!(
        google_maps::routes::admin_get(Extension(user.clone()), Extension(pool.clone()))
            .await
            .unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    let routes = google_maps::routes::admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(service.clone()),
        enable_routes(),
    )
    .await
    .unwrap();
    let routes = body(routes).await;
    assert_eq!(
        routes,
        json!({"revision": routes["revision"], "enabled": true, "requestsPerMinute": 60})
    );
    let routes_readback =
        google_maps::routes::admin_get(Extension(admin.clone()), Extension(pool.clone()))
            .await
            .unwrap();
    assert_eq!(body(routes_readback).await, routes);
    let stale = google_maps::routes::admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(service.clone()),
        enable_routes(),
    )
    .await;
    assert_eq!(stale.unwrap_err_response_status(), StatusCode::CONFLICT);
    let enabled_grant = google_maps::context(
        Extension(pool.clone()),
        Extension(service.clone()),
        headers.clone(),
        input(),
    )
    .await
    .unwrap();
    assert_eq!(body(enabled_grant).await["routesEnabled"], true);

    // 公開ページの閲覧権限を使い、設定変更後の中継を確認する。
    let layer = common::master_layer_id(&pool, &user).await;
    let created = geocode_web_single::handler::onetime_url::generate_url_handler(
        Extension(user.clone()),
        Extension(pool.clone()),
        None,
        Json(
            serde_json::from_value(json!({"minutes":60,"layers":[layer],"update_url":false}))
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .0;
    let mut tera = tera::Tera::default();
    tera.add_raw_template("temporary-map.html", "{{ googleMapsAccess }}")
        .unwrap();
    tera.add_raw_template("live-map.html", "{{ googleMapsAccess }}")
        .unwrap();
    let tera = Arc::new(tokio::sync::Mutex::new(tera));
    let response = geocode_web_single::handler::onetime_url::temporary_map_get_handler(
        HeaderMap::new(),
        Extension(pool.clone()),
        Extension(tera.clone()),
        Query(serde_json::from_value(json!({})).unwrap()),
        Ok(Path(created.id.clone())),
    )
    .await
    .unwrap();
    let access = render_access(response).await;
    let shared_context =
        || Json(serde_json::from_value(json!({"backgroundId":2,"access":access})).unwrap());
    let response = google_maps::context(
        Extension(pool.clone()),
        Extension(service.clone()),
        HeaderMap::new(),
        shared_context(),
    )
    .await
    .unwrap();
    let shared_grant = body(response).await;
    assert_eq!(shared_grant["routesEnabled"], false);
    let shared_headers = grant_headers(&shared_grant);
    google_maps::tile(
        Extension(pool.clone()),
        Extension(service.clone()),
        shared_headers.clone(),
        Path((10, 900, 400)),
    )
    .await
    .unwrap();
    let public_id = uuid::Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO live_map (id, public_id, name, created_by, expires_at)
        VALUES ($1, $2, 'live', $3, datetime('now', '+1 hour'))
        "#,
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(public_id.to_string())
    .bind(&user)
    .execute(&pool)
    .await
    .unwrap();
    let live_access = render_access(
        live_map_page_handler(
            HeaderMap::new(),
            Extension(tera),
            Extension(pool.clone()),
            Path(public_id.to_string()),
            Query(Default::default()),
        )
        .await
        .unwrap(),
    )
    .await;
    let live_grant = google_maps::context(
        Extension(pool.clone()),
        Extension(service.clone()),
        HeaderMap::new(),
        Json(serde_json::from_value(json!({"backgroundId":2,"access":live_access})).unwrap()),
    )
    .await
    .unwrap();
    let live_grant = body(live_grant).await;
    assert_eq!(live_grant["routesEnabled"], false);
    let live_headers = grant_headers(&live_grant);
    let update_availability =
        |enabled, share, live| {
            background_maps::admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Path(2),
            None,
            Json(serde_json::from_value(json!({
                "layer_name":"google","label":"Google","url":"","attribution":"",
                "include_foreign_tiles":false,"provider":"google","google_map_type":"terrain",
                "enabled":enabled,"allow_temporary_share":share,"allow_live_map":live,
            })).unwrap()),
        )
        };
    let tile_status = |headers: HeaderMap| {
        google_maps::tile(
            Extension(pool.clone()),
            Extension(service.clone()),
            headers,
            Path((10, 900, 400)),
        )
    };
    let Json(_) = update_availability(true, false, true).await.unwrap();
    assert_eq!(
        tile_status(shared_headers.clone())
            .await
            .unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    let viewport =
        serde_json::from_value(json!({"zoom":10,"north":36,"south":35,"east":140,"west":139}))
            .unwrap();
    assert_eq!(
        google_maps::viewport(
            Extension(pool.clone()),
            Extension(service.clone()),
            shared_headers.clone(),
            Query(viewport)
        )
        .await
        .unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    // ログイン中の閲覧者も、共有トークンを提示した場合は共有側の設定に従う。
    assert_eq!(
        google_maps::context(
            Extension(pool.clone()),
            Extension(service.clone()),
            headers.clone(),
            shared_context()
        )
        .await
        .unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    tile_status(live_headers.clone()).await.unwrap();
    let Json(_) = update_availability(true, true, false).await.unwrap();
    assert_eq!(
        tile_status(live_headers).await.unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    tile_status(shared_headers.clone()).await.unwrap();

    let Json(_) = update_availability(false, true, true).await.unwrap();
    assert_eq!(
        tile_status(authorized.clone())
            .await
            .unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    let other = google_maps::context(
        Extension(pool.clone()),
        Extension(service.clone()),
        headers.clone(),
        Json(serde_json::from_value(json!({"backgroundId":3})).unwrap()),
    )
    .await
    .unwrap();
    tile_status(grant_headers(&body(other).await))
        .await
        .unwrap();
    let Json(_) = update_availability(true, true, true).await.unwrap();
    background_maps::admin_delete(Extension(admin.clone()), Extension(pool.clone()), Path(2))
        .await
        .unwrap();
    assert_eq!(
        tile_status(authorized.clone())
            .await
            .unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        tile_status(shared_headers.clone())
            .await
            .unwrap_err_response_status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE temporary_urls SET password_hash='changed' WHERE id=$1")
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        google_maps::tile(
            Extension(pool.clone()),
            Extension(service.clone()),
            shared_headers,
            Path((10, 900, 400))
        )
        .await
        .unwrap_err_response_status(),
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE user_model SET auth_version=auth_version+1 WHERE id=$1")
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        google_maps::tile(
            Extension(pool.clone()),
            Extension(service.clone()),
            authorized,
            Path((10, 900, 400))
        )
        .await
        .unwrap_err_response_status(),
        StatusCode::UNAUTHORIZED
    );
    let calls = calls.lock().unwrap();
    assert_eq!(calls.tiles, 5);
    assert_eq!(calls.sessions, 1);
    assert_eq!(calls.viewports, 1);
    server.abort();
}

// 実際のHTTPルートで、認証、背景の制約、本文上限とno-storeを検証する。
#[tokio::test]
async fn routes_compute_requires_account_access_and_an_enabled_google_background() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "route-user").await;
    let token = create_token(&user, 30, "access_token", 0).unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO google_maps_settings (id, revision, enabled) VALUES (1, 'route-test', true);
        UPDATE google_routes_settings SET enabled = true WHERE id = 1;
        INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, create_at, updated_at, provider
        ) VALUES (1, 'default', 'default', '/tile/{z}/{x}/{y}.png', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'generic');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let app = geocode_web_single::router::build_router(
        pool,
        Arc::new(tokio::sync::Mutex::new(tera::Tera::default())),
        None,
    );
    let valid = json!({
        "backgroundId": 1, "travelMode": "DRIVE",
        "origin": {"lat": 35, "lng": 139}, "destination": {"lat": 36, "lng": 140},
    });
    let mut invalid = valid.clone();
    invalid["origin"]["lat"] = json!(91);
    for (authenticated, body, expected) in [
        (false, valid.to_string(), StatusCode::UNAUTHORIZED),
        (true, valid.to_string(), StatusCode::FORBIDDEN),
        (true, invalid.to_string(), StatusCode::BAD_REQUEST),
        (true, " ".repeat(4097), StatusCode::PAYLOAD_TOO_LARGE),
    ] {
        let mut request = Request::post("/google-maps/routes/compute")
            .header(header::CONTENT_TYPE, "application/json");
        if authenticated {
            request = request.header(header::COOKIE, format!("access_token={token}"));
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
}

trait ErrorStatus {
    fn unwrap_err_response_status(self) -> StatusCode;
}
impl<T> ErrorStatus for Result<T, geocode_web_single::error::AppError> {
    fn unwrap_err_response_status(self) -> StatusCode {
        match self {
            Err(error) => error.into_response().status(),
            Ok(_) => panic!("request should fail"),
        }
    }
}
