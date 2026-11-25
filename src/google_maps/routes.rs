//! 基本経路を取得する認証済みのサーバー中継。
use super::{GoogleMaps, load_settings, read_response, settings};
use crate::{
    db::{BasemapScope, tiles::load_google_tile_type},
    error::AppError,
    handler::live_map::require_superuser,
    routing::{Coordinate, RouteLimits, RouteResult, TravelMode},
};
use axum::{
    Json,
    extract::Extension,
    http::{HeaderValue, header},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Sqlite, SqlitePool};
use std::sync::Arc;
use uuid::Uuid;

pub use crate::routing::ComputeInput;

const ROUTES_URL: &str = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ROUTE_FIELDS: &str =
    "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.warnings";

pub(super) struct RoutesService {
    url: String,
    limits: RouteLimits,
}

impl Default for RoutesService {
    fn default() -> Self {
        Self {
            url: ROUTES_URL.into(),
            limits: RouteLimits::default(),
        }
    }
}

#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutesSettings {
    revision: String,
    enabled: bool,
    requests_per_minute: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutesSettingsInput {
    revision: Uuid,
    enabled: bool,
    requests_per_minute: i32,
}

async fn routes_settings<'e>(
    executor: impl sqlx::Executor<'e, Database = Sqlite>,
) -> Result<RoutesSettings, AppError> {
    Ok(sqlx::query_as(
        r#"
        SELECT
            revision,
            enabled,
            requests_per_minute
        FROM google_routes_settings
        WHERE id = 1
        "#,
    )
    .fetch_one(executor)
    .await?)
}

pub(super) async fn enabled(pool: &SqlitePool) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar(
        r#"
        SELECT
            enabled
        FROM google_routes_settings
        WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await?)
}

pub async fn admin_get(
    Extension(account): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&account, &pool).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(routes_settings(&pool).await?),
    ))
}

pub async fn admin_update(
    Extension(account): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
    Json(input): Json<RoutesSettingsInput>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&account, &pool).await?;
    if !(1..=3000).contains(&input.requests_per_minute) {
        return Err(AppError::Validation(
            "経路検索の利用上限は1〜3000回/分で指定してください。".into(),
        ));
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut next = routes_settings(&mut *tx).await?;
    if next.revision != input.revision.to_string() {
        return Err(AppError::Conflict);
    }
    if input.enabled && !next.enabled {
        let google = load_settings(&mut *tx).await?;
        if google.encrypted_tiles_key.is_none() {
            return Err(AppError::Validation(
                "先にGoogle Maps APIキーを登録してください。".into(),
            ));
        }
        service.api_key(&google).map_err(|_| {
            AppError::Validation("暗号鍵を確認し、Google Maps APIキーを再入力してください。".into())
        })?;
    }
    next.revision = Uuid::new_v4().to_string();
    next.enabled = input.enabled;
    next.requests_per_minute = input.requests_per_minute;
    sqlx::query(
        r#"
        UPDATE google_routes_settings
        SET
            revision = $1,
            enabled = $2,
            requests_per_minute = $3
        WHERE id = 1
        "#,
    )
    .bind(&next.revision)
    .bind(next.enabled)
    .bind(next.requests_per_minute)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(next)))
}

fn waypoint(coordinate: &Coordinate) -> Value {
    json!({ "location": { "latLng": { "latitude": coordinate.lat, "longitude": coordinate.lng } } })
}

#[derive(Deserialize)]
struct GoogleResponse {
    #[serde(default)]
    routes: Vec<GoogleRoute>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleRoute {
    duration: String,
    #[serde(default)]
    distance_meters: u32,
    polyline: GooglePolyline,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GooglePolyline {
    encoded_polyline: String,
}

impl TryFrom<GoogleRoute> for RouteResult {
    type Error = AppError;

    fn try_from(route: GoogleRoute) -> Result<Self, AppError> {
        let duration_seconds = route
            .duration
            .strip_suffix('s')
            .and_then(|seconds| seconds.parse::<f64>().ok())
            .ok_or(AppError::BadGateway)?;
        Self::new(
            duration_seconds,
            route.distance_meters,
            route.polyline.encoded_polyline,
            route.warnings,
        )
    }
}

async fn fetch_route(
    service: &GoogleMaps,
    key: &str,
    input: &ComputeInput,
    language: &str,
    region: &str,
) -> Result<Option<RouteResult>, AppError> {
    let mut key = HeaderValue::from_str(key).map_err(|_| AppError::InternalServerError)?;
    key.set_sensitive(true);
    let mut body = json!({
        "origin": waypoint(&input.origin),
        "destination": waypoint(&input.destination),
        "travelMode": input.travel_mode,
        "languageCode": language,
        "regionCode": region,
    });
    if matches!(input.travel_mode, TravelMode::Drive) {
        body["routingPreference"] = json!("TRAFFIC_UNAWARE");
    }
    let response = service
        .client
        .post(&service.routes.url)
        .header("X-Goog-Api-Key", key)
        .header("X-Goog-FieldMask", ROUTE_FIELDS)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| AppError::BadGateway)?;
    let bytes = read_response(response, 1024 * 1024)
        .await
        .map_err(|error| match error {
            AppError::NotFound => AppError::BadGateway,
            error => error,
        })?;
    let response: GoogleResponse =
        serde_json::from_slice(&bytes).map_err(|_| AppError::BadGateway)?;
    response
        .routes
        .into_iter()
        .next()
        .map(RouteResult::try_from)
        .transpose()
}

pub async fn compute(
    Extension(account): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<GoogleMaps>>,
    Json(input): Json<ComputeInput>,
) -> Result<impl IntoResponse, AppError> {
    input.validate_coordinates()?;
    let google = settings(&pool).await?;
    if !google.enabled
        || load_google_tile_type(&pool, input.background_id, BasemapScope::Normal)
            .await?
            .is_none()
    {
        return Err(AppError::Forbidden(
            "この背景地図では経路を検索できません。".into(),
        ));
    }
    let routes = routes_settings(&pool).await?;
    if !routes.enabled {
        return Err(AppError::Forbidden("経路検索は無効です。".into()));
    }
    let key = service.api_key(&google)?;
    let _permit = service
        .routes
        .limits
        .acquire(account, routes.requests_per_minute as u32)
        .await?;
    let route = fetch_route(&service, &key, &input, &google.language, &google.region).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"route": route})),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::{Query, State},
        http::{HeaderMap, StatusCode},
        routing::{get, post},
    };
    use std::collections::HashMap;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn routes_requests_use_basic_driving_and_walking_options() {
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let upstream = Router::new()
            .route(
                "/directions/v2:computeRoutes",
                post(
                    |State(calls): State<Arc<Mutex<Vec<Value>>>>,
                     headers: HeaderMap,
                     Json(body): Json<Value>| async move {
                        assert_eq!(headers["x-goog-api-key"], "fixture-routes-key");
                        assert_eq!(headers["x-goog-fieldmask"], ROUTE_FIELDS);
                        let mut calls = calls.lock().await;
                        calls.push(body);
                        let response = if calls.len() < 3 {
                            json!({"routes":[{"distanceMeters":1250,"duration":"93.5s",
                                "polyline":{"encodedPolyline":"??AA"},"warnings":["fixture warning"]}]})
                        } else {
                            json!({})
                        };
                        Json(response)
                    },
                ),
            )
            .with_state(calls.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut service = GoogleMaps::new("http://127.0.0.1:9".into(), None);
        service.routes.url = format!(
            "http://{}/directions/v2:computeRoutes",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let mut input = ComputeInput {
            background_id: 1,
            origin: Coordinate {
                lat: 35.6,
                lng: 139.7,
            },
            destination: Coordinate {
                lat: 35.7,
                lng: 139.6,
            },
            travel_mode: TravelMode::Drive,
        };

        let route = fetch_route(&service, "fixture-routes-key", &input, "ja-JP", "JP")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(route.duration_seconds, 93.5);
        assert_eq!(route.distance_meters, 1250);
        assert_eq!(route.encoded_polyline, "??AA");
        assert_eq!(route.warnings, ["fixture warning"]);
        input.travel_mode = TravelMode::Walk;
        assert!(
            fetch_route(&service, "fixture-routes-key", &input, "ja-JP", "JP")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            fetch_route(&service, "fixture-routes-key", &input, "ja-JP", "JP")
                .await
                .unwrap()
                .is_none()
        );

        let calls = calls.lock().await;
        assert_eq!(
            calls[0],
            json!({
                "origin":{"location":{"latLng":{"latitude":35.6,"longitude":139.7}}},
                "destination":{"location":{"latLng":{"latitude":35.7,"longitude":139.6}}},
                "travelMode":"DRIVE","languageCode":"ja-JP","regionCode":"JP",
                "routingPreference":"TRAFFIC_UNAWARE",
            })
        );
        assert_eq!(calls[1]["travelMode"], "WALK");
        assert!(calls[1].get("routingPreference").is_none());
        server.abort();
    }

    // 既存の暗号化キーを両APIで共用し、更新後は同じ新しいキーを使う。
    #[tokio::test]
    async fn tile_and_route_requests_pick_up_the_same_key_rotation() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        type Calls = Arc<Mutex<Vec<(&'static str, String)>>>;
        let calls: Calls = Arc::new(Mutex::new(Vec::new()));
        let upstream = Router::new()
            .route("/v1/createSession", post(
                |State(calls): State<Calls>, Query(query): Query<HashMap<String, String>>| async move {
                    calls.lock().await.push(("session", query["key"].clone()));
                    Json(json!({"session":"test-session", "expiry":chrono::Utc::now().timestamp() + 300,
                        "tileWidth":256, "tileHeight":256, "imageFormat":"png"}))
                },
            ))
            .route("/v1/2dtiles/10/900/400", get(
                |State(calls): State<Calls>, Query(query): Query<HashMap<String, String>>| async move {
                    calls.lock().await.push(("tile", query["key"].clone()));
                    StatusCode::OK
                },
            ))
            .route("/directions/v2:computeRoutes", post(
                |State(calls): State<Calls>, headers: HeaderMap| async move {
                    calls.lock().await.push(("route", headers["x-goog-api-key"].to_str().unwrap().to_owned()));
                    Json(json!({}))
                },
            ))
            .with_state(calls.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mut service = GoogleMaps::new(
            base.clone(),
            Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
        );
        service.routes.url = format!("{base}/directions/v2:computeRoutes");
        let service = Arc::new(service);
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        sqlx::query(
            r#"
            INSERT INTO tileserver_model (
                id,
                layer_name,
                label,
                url,
                attribution,
                create_at,
                updated_at,
                provider,
                google_map_type
            ) VALUES (2, 'google', 'Google', '/google-maps/tiles/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'google', 'roadmap')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            UPDATE google_routes_settings
            SET enabled = true
            WHERE id = 1
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let account = Uuid::new_v4().to_string();
        for key in ["initial-shared-key", "rotated-shared-key"] {
            sqlx::query(
                r#"
                INSERT INTO google_maps_settings (
                    id,
                    revision,
                    enabled,
                    encrypted_tiles_key
                ) VALUES (1, $1, true, $2)
                ON CONFLICT (id) DO UPDATE
                SET
                    revision = $1,
                    encrypted_tiles_key = $2
                "#,
            )
            .bind(Uuid::new_v4().to_string())
            .bind(service.encrypt(key).unwrap())
            .execute(&pool)
            .await
            .unwrap();
            let google = settings(&pool).await.unwrap();
            let tile = service
                .get(
                    &google,
                    super::super::MapType::Roadmap,
                    "/v1/2dtiles/10/900/400",
                    &[],
                )
                .await
                .unwrap();
            assert_eq!(tile.status(), StatusCode::OK);
            let route = compute(
                Extension(account.clone()),
                Extension(pool.clone()),
                Extension(service.clone()),
                Json(ComputeInput {
                    background_id: 2,
                    origin: Coordinate {
                        lat: 35.6,
                        lng: 139.7,
                    },
                    destination: Coordinate {
                        lat: 35.7,
                        lng: 139.6,
                    },
                    travel_mode: TravelMode::Drive,
                }),
            )
            .await
            .unwrap()
            .into_response();
            assert_eq!(route.status(), StatusCode::OK);
        }
        let calls = calls.lock().await;
        assert_eq!(
            calls
                .iter()
                .map(|(api, key)| (*api, key.as_str()))
                .collect::<Vec<_>>(),
            [
                ("session", "initial-shared-key"),
                ("tile", "initial-shared-key"),
                ("route", "initial-shared-key"),
                ("session", "rotated-shared-key"),
                ("tile", "rotated-shared-key"),
                ("route", "rotated-shared-key"),
            ]
        );
        server.abort();
    }

    #[tokio::test]
    async fn excess_account_requests_do_not_consume_the_global_limit() {
        let service = RoutesService::default();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        for _ in 0..10 {
            drop(service.limits.acquire(first.clone(), 11).await.unwrap());
        }
        assert!(matches!(
            service.limits.acquire(first, 11).await,
            Err(AppError::TooManyRequests(_))
        ));
        drop(service.limits.acquire(second.clone(), 11).await.unwrap());
        assert!(matches!(
            service.limits.acquire(second, 11).await,
            Err(AppError::TooManyRequests(_))
        ));
    }
}
