//! GeoCode-WebのOSRMクライアントが使う、2地点の車・徒歩経路。
use super::{Coord, SNAP_RADIUS_M, SearchError, TravelMode, catalog, search_with_radii};
use axum::{
    Extension, Json, Router,
    extract::{
        ConnectInfo, Path, Query, Request, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::{HeaderValue, StatusCode, header},
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::get,
};
use hmac::digest::CtOutput;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use tower_http::set_header::SetResponseHeaderLayer;

mod geometry;
#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) use tests::app_with_graph;

const MAX_CONCURRENT: usize = 2;
// 両方の上流クライアントが応答の転送を含めて10秒でタイムアウトするため、検索には9.5秒を割り当てる。
const SEARCH_BUDGET: Duration = Duration::from_millis(9500);

struct Service {
    root: PathBuf,
    dataset_name: String,
    api_key: Option<CtOutput<Sha256>>,
    searches: Arc<Semaphore>,
}

pub(crate) fn router(dataset_root: PathBuf, name: String, api_key: Option<String>) -> Router {
    let service = Arc::new(Service {
        root: dataset_root,
        dataset_name: name,
        api_key: api_key.map(|key| Sha256::digest(key.as_bytes()).into()),
        searches: Arc::new(Semaphore::new(MAX_CONCURRENT)),
    });
    let routes = Router::new()
        .route(
            "/car/route/v1/driving/{coordinates}",
            get(route).layer(Extension(TravelMode::Car)),
        )
        .route(
            "/foot/route/v1/foot/{coordinates}",
            get(route).layer(Extension(TravelMode::Foot)),
        )
        .fallback(|| async { Failure::InvalidRoute })
        .layer(from_fn_with_state(service.clone(), authenticate))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .with_state(service);
    Router::new().nest("/local-routing", routes)
}

async fn authenticate(
    State(service): State<Arc<Service>>,
    request: Request,
    next: Next,
) -> Response {
    let allowed = match &service.api_key {
        Some(expected) => {
            let mut headers = request.headers().get_all("x-api-key").iter();
            headers.next().is_some_and(|key| {
                headers.next().is_none()
                    && CtOutput::<Sha256>::new(Sha256::digest(key.as_bytes())) == *expected
            })
        },
        None => request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .is_some_and(|peer| peer.ip().to_canonical().is_loopback()),
    };
    if !allowed {
        return Failure::Unauthorized.into_response();
    }
    next.run(request).await
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    alternatives: bool,
    steps: bool,
    annotations: bool,
    generate_hints: bool,
    geometries: Option<String>,
    overview: Option<String>,
    radiuses: Option<String>,
}

impl Options {
    fn radii(&self) -> Result<[f64; 2], Failure> {
        if self.alternatives
            || self.steps
            || self.annotations
            || self.generate_hints
            || self
                .geometries
                .as_deref()
                .is_some_and(|value| value != "polyline")
            || self
                .overview
                .as_deref()
                .is_some_and(|value| value != "simplified")
        {
            return Err(Failure::InvalidOptions);
        }
        let Some(radii) = &self.radiuses else {
            return Ok([SNAP_RADIUS_M; 2]);
        };
        let (a, b) = radii.split_once(';').ok_or(Failure::InvalidOptions)?;
        let radius = |value: &str| {
            value
                .parse::<f64>()
                .ok()
                .filter(|n| (0.0..=SNAP_RADIUS_M).contains(n))
                .ok_or(Failure::InvalidOptions)
        };
        Ok([radius(a)?, radius(b)?])
    }
}

fn coordinates(input: &str) -> Result<[Coord; 2], Failure> {
    let (a, b) = input.split_once(';').ok_or(Failure::InvalidQuery)?;
    let parse = |pair: &str| {
        let (lon, lat) = pair.split_once(',').ok_or(Failure::InvalidQuery)?;
        let point = Coord {
            lat: lat.parse().map_err(|_| Failure::InvalidQuery)?,
            lon: lon.parse().map_err(|_| Failure::InvalidQuery)?,
        };
        point.validate().map_err(|_| Failure::InvalidQuery)?;
        Ok(point)
    };
    Ok([parse(a)?, parse(b)?])
}

async fn route(
    State(service): State<Arc<Service>>,
    Extension(mode): Extension<TravelMode>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Options>, QueryRejection>,
) -> Result<Response, Failure> {
    let Path(raw) = path.map_err(|_| Failure::InvalidQuery)?;
    let [start, end] = coordinates(&raw)?;
    let Query(options) = query.map_err(|_| Failure::InvalidOptions)?;
    let radii = options.radii()?;
    let permit = service
        .searches
        .clone()
        .try_acquire_owned()
        .map_err(|_| Failure::Busy)?;
    let bytes = run_search(permit, SEARCH_BUDGET, move |check| {
        let graph = catalog::latest_graph(&service.root, &service.dataset_name)
            .map_err(|_| Failure::Unavailable)?;
        check()?;
        let result = search_with_radii(&graph, mode, start, end, radii, || {
            check().map_err(Into::into)
        })
        .map_err(|error| match error.downcast_ref::<SearchError>() {
            Some(SearchError::NoSnap) => Failure::NoSegment,
            Some(SearchError::NoRoute) => Failure::NoRoute,
            None => error
                .downcast_ref::<Failure>()
                .copied()
                .unwrap_or(Failure::Unavailable),
        })?;
        geometry::response(start, end, &result, check)
    })
    .await?;
    Ok((
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        bytes,
    )
        .into_response())
}

// クライアントが切断すると、このリクエストのワーカーに取消を通知する。
// ワーカーが終了するまで同時実行枠を保持し、次の検索はその解放を待つ。
async fn run_search<T: Send + 'static>(
    permit: OwnedSemaphorePermit,
    budget: Duration,
    work: impl FnOnce(&dyn Fn() -> Result<(), Failure>) -> Result<T, Failure> + Send + 'static,
) -> Result<T, Failure> {
    let deadline = Instant::now() + budget;
    let cancelled = CancellationToken::new();
    let _on_drop = cancelled.clone().drop_guard();
    let worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let check = || {
            if cancelled.is_cancelled() || Instant::now() >= deadline {
                Err(Failure::Timeout)
            } else {
                Ok(())
            }
        };
        check()?;
        work(&check)
    });
    tokio::time::timeout_at(deadline.into(), worker)
        .await
        .map_err(|_| Failure::Timeout)?
        .map_err(|_| Failure::Unavailable)?
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, thiserror::Error)]
#[error("{self:?}")]
enum Failure {
    InvalidRoute,
    InvalidQuery,
    InvalidOptions,
    NoSegment,
    NoRoute,
    TooBig,
    Unauthorized,
    Busy,
    Unavailable,
    Timeout,
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::InvalidRoute => (StatusCode::NOT_FOUND, "InvalidService"),
            Self::InvalidQuery => (StatusCode::BAD_REQUEST, "InvalidQuery"),
            Self::InvalidOptions => (StatusCode::BAD_REQUEST, "InvalidOptions"),
            Self::NoSegment => (StatusCode::BAD_REQUEST, "NoSegment"),
            Self::NoRoute => (StatusCode::BAD_REQUEST, "NoRoute"),
            Self::TooBig => (StatusCode::BAD_REQUEST, "TooBig"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized"),
            Self::Busy => (StatusCode::TOO_MANY_REQUESTS, "TooManyRequests"),
            Self::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable"),
            Self::Timeout => (StatusCode::GATEWAY_TIMEOUT, "Timeout"),
        };
        (status, Json(json!({"code": code}))).into_response()
    }
}
