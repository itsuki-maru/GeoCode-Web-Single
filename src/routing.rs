use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore, SemaphorePermit};

mod osrm;
pub(crate) mod osrm_origins;

pub use osrm::{LocalRoutingListener, Osrm};
pub(crate) use osrm::{compute_osrm, osrm_admin_check, osrm_admin_get, osrm_admin_update};

const MAX_REQUESTS_PER_ACCOUNT: u32 = 10;
const CONCURRENT_REQUESTS: usize = 8;

pub(crate) struct RouteLimits {
    requests: Mutex<HashMap<Option<String>, (Instant, u32)>>,
    concurrent: Semaphore,
}

impl Default for RouteLimits {
    fn default() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            concurrent: Semaphore::new(CONCURRENT_REQUESTS),
        }
    }
}

impl RouteLimits {
    pub(crate) async fn acquire(
        &self,
        account: String,
        maximum: u32,
    ) -> Result<SemaphorePermit<'_>, AppError> {
        let permit = self.concurrent.try_acquire().map_err(|_| {
            AppError::TooManyRequests(
                "経路検索が混雑しています。時間をおいて再試行してください。".into(),
            )
        })?;
        let now = Instant::now();
        let mut limits = self.requests.lock().await;
        limits.retain(|_, (start, _)| {
            now.saturating_duration_since(*start) < Duration::from_secs(60)
        });
        let buckets = [
            (None, maximum),
            (Some(account), maximum.min(MAX_REQUESTS_PER_ACCOUNT)),
        ];
        if buckets
            .iter()
            .any(|(bucket, cap)| limits.get(bucket).is_some_and(|(_, count)| count >= cap))
        {
            return Err(AppError::TooManyRequests(
                "経路検索の利用上限に達しました。時間をおいて再試行してください。".into(),
            ));
        }
        for (bucket, _) in buckets {
            limits.entry(bucket).or_insert((now, 0)).1 += 1;
        }
        Ok(permit)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Coordinate {
    pub(crate) lat: f64,
    pub(crate) lng: f64,
}

impl Coordinate {
    fn valid(&self) -> bool {
        (-90.0..=90.0).contains(&self.lat) && (-180.0..=180.0).contains(&self.lng)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TravelMode {
    Drive,
    Walk,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeInput {
    pub(crate) background_id: i64,
    pub(crate) origin: Coordinate,
    pub(crate) destination: Coordinate,
    pub(crate) travel_mode: TravelMode,
}

impl ComputeInput {
    pub(crate) fn validate_coordinates(&self) -> Result<(), AppError> {
        if !self.origin.valid() || !self.destination.valid() {
            return Err(AppError::BadRequest);
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteResult {
    pub(crate) duration_seconds: f64,
    pub(crate) distance_meters: u32,
    pub(crate) encoded_polyline: String,
    pub(crate) warnings: Vec<String>,
}

impl RouteResult {
    pub(crate) fn new(
        duration_seconds: f64,
        distance_meters: u32,
        encoded_polyline: String,
        warnings: Vec<String>,
    ) -> Result<Self, AppError> {
        if !duration_seconds.is_finite()
            || duration_seconds < 0.0
            || encoded_polyline.is_empty()
            || !encoded_polyline
                .bytes()
                .all(|byte| (63..=126).contains(&byte))
        {
            return Err(AppError::BadGateway);
        }
        Ok(Self {
            duration_seconds,
            distance_meters,
            encoded_polyline,
            warnings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // アカウント別・全体の回数と、同時実行数の上限を確認する。
    #[tokio::test]
    async fn limits_bound_each_account_all_requests_and_concurrency() {
        let limits = RouteLimits::default();
        let account = Uuid::new_v4().to_string();
        let maximum = 2 * MAX_REQUESTS_PER_ACCOUNT;
        for _ in 0..MAX_REQUESTS_PER_ACCOUNT {
            drop(limits.acquire(account.clone(), maximum).await.unwrap());
        }
        assert!(matches!(
            limits.acquire(account.clone(), maximum).await,
            Err(AppError::TooManyRequests(_))
        ));
        for _ in 0..MAX_REQUESTS_PER_ACCOUNT {
            drop(
                limits
                    .acquire(Uuid::new_v4().to_string(), maximum)
                    .await
                    .unwrap(),
            );
        }
        assert!(matches!(
            limits.acquire(Uuid::new_v4().to_string(), maximum).await,
            Err(AppError::TooManyRequests(_))
        ));

        let limits = RouteLimits::default();
        let mut permits = Vec::new();
        for _ in 0..CONCURRENT_REQUESTS {
            permits.push(limits.acquire(account.clone(), maximum).await.unwrap());
        }
        assert!(matches!(
            limits.acquire(account.clone(), maximum).await,
            Err(AppError::TooManyRequests(_))
        ));
        drop(permits.pop());
        assert!(limits.acquire(account.clone(), maximum).await.is_ok());
    }
}
