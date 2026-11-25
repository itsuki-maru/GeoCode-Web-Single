use super::{ComputeInput, Coordinate, RouteLimits, RouteResult, TravelMode};
use crate::{db::tiles::is_enabled_generic_background, error::AppError};
use axum::{
    Json,
    extract::Extension,
    http::{HeaderValue, StatusCode, header},
    response::IntoResponse,
};
use reqwest::Url;
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use std::sync::{Arc, LazyLock};

mod settings;
mod upstream;

pub(crate) use settings::{osrm_admin_check, osrm_admin_get, osrm_admin_update};
use upstream::UpstreamPolicy;

const REQUESTS_PER_MINUTE: u32 = 60;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
// 上流の道路データがない地点を離れた道路に吸着させないよう、両端を100 mに制限する。
const ROUTE_QUERY: &str = "alternatives=false&steps=false&geometries=polyline&overview=simplified&annotations=false&radiuses=100;100&generate_hints=false";

pub struct Osrm {
    upstream: UpstreamPolicy,
    limits: RouteLimits,
    cipher: Option<settings::ApiKeyCipher>,
}

impl Osrm {
    fn new(upstream: UpstreamPolicy, encryption_key: Option<&str>) -> Self {
        Self {
            upstream,
            limits: RouteLimits::default(),
            cipher: encryption_key.and_then(settings::ApiKeyCipher::from_base64),
        }
    }

    pub fn configured() -> Arc<Self> {
        static OSRM: LazyLock<Arc<Osrm>> = LazyLock::new(|| {
            Arc::new(Osrm::new(
                UpstreamPolicy::from_env(),
                std::env::var("OSRM_ENCRYPTION_KEY").ok().as_deref(),
            ))
        });
        Arc::clone(&OSRM)
    }

    pub async fn available_modes(&self, pool: &SqlitePool) -> Result<Vec<TravelMode>, AppError> {
        settings::available_modes(pool, self).await
    }

    async fn fetch_route(
        &self,
        endpoint: &Url,
        mode: TravelMode,
        origin: &Coordinate,
        destination: &Coordinate,
        api_key: Option<HeaderValue>,
    ) -> Result<Option<RouteResult>, RouteFetchError> {
        let client = self
            .upstream
            .client(endpoint)
            .map_err(|_| AppError::BadGateway)?;
        let url = route_url(endpoint, mode, origin, destination)?;
        let mut request = client.get(url);
        if let Some(api_key) = api_key {
            request = request.header("X-API-Key", api_key);
        }
        let mut response = request.send().await.map_err(|_| AppError::BadGateway)?;
        let status = response.status();
        match status {
            StatusCode::OK | StatusCode::BAD_REQUEST => (),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(RouteFetchError::Authentication);
            },
            StatusCode::TOO_MANY_REQUESTS => {
                return Err(AppError::TooManyRequests(
                    "経路検索が混雑しています。時間をおいて再試行してください。".into(),
                )
                .into());
            },
            _ => return Err(AppError::BadGateway.into()),
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(AppError::BadGateway.into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| AppError::BadGateway)? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(AppError::BadGateway.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let reply: OsrmResponse =
            serde_json::from_slice(&bytes).map_err(|_| AppError::BadGateway)?;
        match (status, reply.code.as_str()) {
            (StatusCode::OK, "Ok") => {
                let route = reply
                    .routes
                    .into_iter()
                    .next()
                    .ok_or(AppError::BadGateway)?;
                Ok(Some(route.try_into()?))
            },
            (StatusCode::BAD_REQUEST, "NoRoute" | "NoSegment") => Ok(None),
            _ => Err(AppError::BadGateway.into()),
        }
    }
}

#[derive(Debug)]
enum RouteFetchError {
    Authentication,
    Request(AppError),
}

impl From<AppError> for RouteFetchError {
    fn from(error: AppError) -> Self {
        Self::Request(error)
    }
}

impl RouteFetchError {
    fn into_route_error(self) -> AppError {
        match self {
            Self::Authentication => AppError::BadGateway,
            Self::Request(error) => error,
        }
    }

    fn into_check_error(self) -> AppError {
        match self {
            Self::Authentication => {
                AppError::Validation("OSRMの認証に失敗しました。APIキーを確認してください。".into())
            },
            Self::Request(error) => error,
        }
    }
}

fn route_url(
    endpoint: &Url,
    mode: TravelMode,
    origin: &Coordinate,
    destination: &Coordinate,
) -> Result<Url, AppError> {
    let profile = match mode {
        TravelMode::Drive => "driving",
        TravelMode::Walk => "foot",
    };
    let coordinates = format!(
        "{:.6},{:.6};{:.6},{:.6}",
        origin.lng, origin.lat, destination.lng, destination.lat
    );
    let mut url = endpoint.clone();
    url.path_segments_mut()
        .map_err(|_| AppError::InternalServerError)?
        .pop_if_empty()
        .extend(["route", "v1", profile, &coordinates]);
    url.set_query(Some(ROUTE_QUERY));
    Ok(url)
}

#[derive(Deserialize)]
struct OsrmResponse {
    code: String,
    #[serde(default)]
    routes: Vec<OsrmRoute>,
}

#[derive(Deserialize)]
struct OsrmRoute {
    distance: f64,
    duration: f64,
    geometry: String,
}

impl TryFrom<OsrmRoute> for RouteResult {
    type Error = AppError;

    fn try_from(route: OsrmRoute) -> Result<Self, AppError> {
        let rounded_distance = route.distance.round();
        if route.distance < 0.0 || !(0.0..=f64::from(u32::MAX)).contains(&rounded_distance) {
            return Err(AppError::BadGateway);
        }
        Self::new(
            route.duration,
            rounded_distance as u32,
            route.geometry,
            Vec::new(),
        )
    }
}

pub(crate) async fn compute_osrm(
    Extension(account): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<Osrm>>,
    Json(input): Json<ComputeInput>,
) -> Result<impl IntoResponse, AppError> {
    input.validate_coordinates()?;
    if !is_enabled_generic_background(&pool, input.background_id).await? {
        return Err(AppError::Forbidden(
            "この背景地図では経路を検索できません。".into(),
        ));
    }
    let (endpoint, api_key) = settings::load_endpoint(&pool, &service, input.travel_mode)
        .await?
        .ok_or_else(|| AppError::Forbidden("この移動手段では経路を検索できません。".into()))?;
    let _permit = service.limits.acquire(account, REQUESTS_PER_MINUTE).await?;
    let route = service
        .fetch_route(
            &endpoint,
            input.travel_mode,
            &input.origin,
            &input.destination,
            api_key,
        )
        .await
        .map_err(RouteFetchError::into_route_error)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"route": route})),
    ))
}

#[cfg(test)]
mod tests;
