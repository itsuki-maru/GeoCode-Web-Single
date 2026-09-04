use axum::{
    Json,
    extract::{Extension, Path},
    http::StatusCode,
};
use chrono::Utc;
use sqlx::{FromRow, SqlitePool};

use crate::{
    config::CONFIG,
    error::AppError,
    model::{LiveLocationPositionPayload, LiveLocationSessionResponse},
};

#[derive(FromRow)]
struct SessionGuard {
    sequence_no: i64,
    received_at: chrono::DateTime<Utc>,
}

fn validate_position(payload: &LiveLocationPositionPayload) -> Result<(), AppError> {
    if !payload.latitude.is_finite()
        || !(-90.0..=90.0).contains(&payload.latitude)
        || !payload.longitude.is_finite()
        || !(-180.0..=180.0).contains(&payload.longitude)
        || payload
            .accuracy_m
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        || payload
            .heading_deg
            .is_some_and(|value| !value.is_finite() || !(0.0..=360.0).contains(&value))
        || payload
            .speed_mps
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        || payload.sequence_no < 0
    {
        return Err(AppError::Validation(
            "Invalid live location payload.".into(),
        ));
    }

    let clock_skew = (Utc::now() - payload.observed_at).num_hours().abs();
    if clock_skew > 24 {
        return Err(AppError::Validation(
            "Location timestamp is outside the accepted range.".into(),
        ));
    }
    Ok(())
}

async fn sharing_is_allowed(pool: &SqlitePool, user_id: &str) -> Result<bool, AppError> {
    sqlx::query_scalar::<_, bool>(
        "SELECT can_share_live_location FROM user_model WHERE id = $1 AND is_locked = false",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Forbidden("Live location sharing is not available.".into()))
}

pub async fn create_live_location_session_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<LiveLocationPositionPayload>,
) -> Result<Json<LiveLocationSessionResponse>, AppError> {
    validate_position(&payload)?;
    if !sharing_is_allowed(&pool, &user_id).await? {
        return Err(AppError::Forbidden(
            "Live location sharing is not permitted for this account.".into(),
        ));
    }

    let session_id = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        r#"
        INSERT INTO live_location_session (
            user_id,
            session_id,
            latitude,
            longitude,
            accuracy_m,
            heading_deg,
            speed_mps,
            sequence_no,
            observed_at,
            received_at,
            started_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET
            session_id = EXCLUDED.session_id,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            accuracy_m = EXCLUDED.accuracy_m,
            heading_deg = EXCLUDED.heading_deg,
            speed_mps = EXCLUDED.speed_mps,
            sequence_no = 0,
            observed_at = EXCLUDED.observed_at,
            received_at = CURRENT_TIMESTAMP,
            started_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(&user_id)
    .bind(&session_id)
    .bind(payload.latitude)
    .bind(payload.longitude)
    .bind(payload.accuracy_m)
    .bind(payload.heading_deg)
    .bind(payload.speed_mps)
    .bind(payload.observed_at)
    .execute(&pool)
    .await?;

    Ok(Json(LiveLocationSessionResponse {
        session_id,
        upload_interval_ms: CONFIG.live_location_upload_interval_seconds * 1000,
    }))
}

pub async fn update_live_location_session_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(session_id): Path<String>,
    Json(payload): Json<LiveLocationPositionPayload>,
) -> Result<StatusCode, AppError> {
    validate_position(&payload)?;
    if !sharing_is_allowed(&pool, &user_id).await? {
        return Err(AppError::Forbidden(
            "Live location sharing is not permitted for this account.".into(),
        ));
    }

    let guard = sqlx::query_as::<_, SessionGuard>(
        "SELECT sequence_no, received_at FROM live_location_session WHERE user_id = $1 AND session_id = $2",
    )
    .bind(&user_id)
    .bind(&session_id)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::Conflict)?;
    if payload.sequence_no <= guard.sequence_no {
        return Err(AppError::Conflict);
    }
    if (Utc::now() - guard.received_at).num_milliseconds() < 1000 {
        return Err(AppError::TooManyRequests(
            "Live location updates are limited to one per second.".into(),
        ));
    }

    let result = sqlx::query(
        r#"
        UPDATE live_location_session
        SET latitude = $1,
            longitude = $2,
            accuracy_m = $3,
            heading_deg = $4,
            speed_mps = $5,
            sequence_no = $6,
            observed_at = $7,
            received_at = CURRENT_TIMESTAMP
        WHERE user_id = $8 AND session_id = $9 AND sequence_no < $6
        "#,
    )
    .bind(payload.latitude)
    .bind(payload.longitude)
    .bind(payload.accuracy_m)
    .bind(payload.heading_deg)
    .bind(payload.speed_mps)
    .bind(payload.sequence_no)
    .bind(payload.observed_at)
    .bind(&user_id)
    .bind(&session_id)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::Conflict);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_session(
    pool: &SqlitePool,
    user_id: &str,
    session_id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM live_location_session WHERE user_id = $1 AND session_id = $2")
        .bind(user_id)
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_live_location_session_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, AppError> {
    delete_session(&pool, &user_id, &session_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn stop_live_location_session_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, AppError> {
    delete_session(&pool, &user_id, &session_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(latitude: f64, longitude: f64) -> LiveLocationPositionPayload {
        LiveLocationPositionPayload {
            latitude,
            longitude,
            accuracy_m: Some(5.0),
            heading_deg: Some(180.0),
            speed_mps: Some(10.0),
            observed_at: Utc::now(),
            sequence_no: 1,
        }
    }

    #[test]
    fn accepts_valid_position() {
        assert!(validate_position(&payload(35.0, 139.0)).is_ok());
    }

    #[test]
    fn rejects_invalid_coordinates() {
        assert!(validate_position(&payload(91.0, 139.0)).is_err());
        assert!(validate_position(&payload(35.0, f64::NAN)).is_err());
    }
}
