use axum::{Json, extract::Extension};
use chrono::Utc;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

const DEFAULT_EXTERNAL_SITE_URL: &str = "https://project.geocode-web.com";
const MAX_EXTERNAL_SITE_URL_LENGTH: usize = 2048;

#[derive(Serialize)]
pub struct ExternalSiteUrlResponse {
    pub url: String,
}

#[derive(Deserialize)]
pub struct ExternalSiteUrlPayload {
    pub url: String,
}

pub async fn get_external_site_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<ExternalSiteUrlResponse>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT url
        FROM external_site_urls
        WHERE user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&pool)
    .await?;

    let url = row
        .and_then(|row| row.try_get::<String, _>("url").ok())
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EXTERNAL_SITE_URL.to_string());

    Ok(Json(ExternalSiteUrlResponse { url }))
}

pub async fn update_external_site_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<ExternalSiteUrlPayload>,
) -> Result<Json<ExternalSiteUrlResponse>, AppError> {
    let url = validate_external_site_url(&payload.url)?;
    let now = Utc::now().naive_utc();

    sqlx::query(
        r#"
        INSERT INTO external_site_urls (
            user_id,
            url,
            create_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id)
        DO UPDATE SET
            url = EXCLUDED.url,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(user_id)
    .bind(&url)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await?;

    Ok(Json(ExternalSiteUrlResponse { url }))
}

fn validate_external_site_url(raw_url: &str) -> Result<String, AppError> {
    let url = raw_url.trim();
    if url.is_empty() {
        return Err(AppError::Validation("no input".to_string()));
    }

    if url.len() > MAX_EXTERNAL_SITE_URL_LENGTH {
        return Err(AppError::Validation("over length".to_string()));
    }

    let parsed_url =
        Url::parse(url).map_err(|_| AppError::Validation("invalid url".to_string()))?;

    match parsed_url.scheme() {
        "http" | "https" => Ok(parsed_url.to_string()),
        _ => Err(AppError::Validation(
            "http or https scheme required".to_string(),
        )),
    }
}
