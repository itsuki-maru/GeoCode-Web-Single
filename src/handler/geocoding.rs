use crate::{
    auth::verify_access_token,
    config::CONFIG,
    error::AppError,
    geocoding::{GeocoderConfig, SearchResult},
    middleware::{extract_cookie_value, token_is_active},
    model::TemporaryUrlFromDB,
};
use axum::{
    Json,
    extract::Extension,
    http::{HeaderMap, header::CACHE_CONTROL},
    response::IntoResponse,
};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct GeocoderClient(pub reqwest::Client);

impl Default for GeocoderClient {
    fn default() -> Self {
        Self(GeocoderConfig::client())
    }
}

#[derive(Deserialize)]
pub struct SearchRequest {
    address: String,
    share_token: Option<String>,
}

#[derive(Serialize)]
struct SearchResponse {
    results: Vec<SearchResult>,
}

#[derive(Serialize, Deserialize)]
struct ShareClaims {
    purpose: String,
    id: String,
    exp: usize,
    revision: String,
}

fn share_revision(password_hash: Option<&str>) -> String {
    format!(
        "{:x}",
        Sha256::digest(password_hash.unwrap_or("").as_bytes())
    )
}

// Issued only after the existing shared-map password check has succeeded.
pub(crate) fn share_token(map: &TemporaryUrlFromDB) -> Result<String, AppError> {
    let claims = ShareClaims {
        purpose: "address_search".into(),
        id: map.id.clone(),
        exp: parse_expiration(&map.expiration)?
            .and_utc()
            .timestamp()
            .try_into()
            .map_err(|_| AppError::Unauthorized("map_access_required".into()))?,
        revision: share_revision(map.password_hash.as_deref()),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(CONFIG.secret_key.as_bytes()),
    )
    .map_err(|_| AppError::InternalServerError)
}

async fn authorize(
    pool: &SqlitePool,
    headers: &HeaderMap,
    request: &SearchRequest,
) -> Result<(), AppError> {
    if let Some(token) = request.share_token.as_deref() {
        return authorize_share(pool, token, CONFIG.secret_key.as_bytes()).await;
    }
    if let Some(token) = extract_cookie_value(headers, "access_token") {
        if let Ok(claims) = verify_access_token(token) {
            if token_is_active(pool, &claims.sub, claims.auth_version).await {
                return Ok(());
            }
        }
    }
    Err(AppError::Unauthorized("map_access_required".into()))
}

fn parse_expiration(value: &str) -> Result<chrono::NaiveDateTime, AppError> {
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .map_err(|_| AppError::Unauthorized("map_access_required".into()))
}

async fn authorize_share(pool: &SqlitePool, token: &str, secret: &[u8]) -> Result<(), AppError> {
    let claims = decode_share_token(token, secret)?;
    let row = sqlx::query_as::<_, (Option<String>, String)>(
        "SELECT password_hash, expiration FROM temporary_urls WHERE id = ?",
    )
    .bind(&claims.id)
    .fetch_optional(pool)
    .await?;
    if let Some((password_hash, expiration)) = row {
        if parse_expiration(&expiration)? > chrono::Utc::now().naive_utc()
            && share_revision(password_hash.as_deref()) == claims.revision
        {
            return Ok(());
        }
    }
    Err(AppError::Unauthorized("map_access_required".into()))
}

fn decode_share_token(token: &str, secret: &[u8]) -> Result<ShareClaims, AppError> {
    let claims = decode::<ShareClaims>(
        token,
        &DecodingKey::from_secret(secret),
        &Validation::default(),
    )
    .map_err(|_| AppError::Unauthorized("map_access_required".into()))?
    .claims;
    if claims.purpose != "address_search" {
        return Err(AppError::Unauthorized("map_access_required".into()));
    }
    Ok(claims)
}

pub async fn search_handler(
    Extension(pool): Extension<SqlitePool>,
    Extension(client): Extension<GeocoderClient>,
    headers: HeaderMap,
    Json(request): Json<SearchRequest>,
) -> Result<impl IntoResponse, AppError> {
    let address = request.address.trim();
    if address.is_empty() || address.chars().count() > 100 {
        return Err(AppError::Validation(
            "住所は1〜100文字で入力してください。".into(),
        ));
    }
    authorize(&pool, &headers, &request).await?;
    let results = CONFIG.geocoder.search(&client.0, address).await?;
    Ok((
        [(CACHE_CONTROL, "no-store")],
        Json(SearchResponse { results }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geocoding_share_tokens_reject_wrong_purpose_signature_and_expiry() {
        let secret = b"geocoding-test-secret";
        let mut claims = ShareClaims {
            purpose: "address_search".into(),
            id: uuid::Uuid::new_v4().to_string(),
            exp: (chrono::Utc::now().timestamp() + 300) as usize,
            revision: share_revision(Some("hash")),
        };
        let sign = |claims: &ShareClaims| {
            encode(
                &Header::default(),
                claims,
                &EncodingKey::from_secret(secret),
            )
            .unwrap()
        };
        assert!(decode_share_token(&sign(&claims), secret).is_ok());
        assert!(decode_share_token(&sign(&claims), b"wrong-secret").is_err());
        claims.purpose = "access_token".into();
        assert!(decode_share_token(&sign(&claims), secret).is_err());
        claims.purpose = "address_search".into();
        claims.exp = 1;
        assert!(decode_share_token(&sign(&claims), secret).is_err());
        assert_ne!(
            share_revision(Some("old-password-hash")),
            share_revision(Some("new-password-hash"))
        );
    }

    #[tokio::test]
    async fn sqlite_share_authorization_checks_current_expiry_password_and_deletion() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE temporary_urls (id TEXT PRIMARY KEY, password_hash TEXT, expiration TEXT NOT NULL)")
            .execute(&pool).await.unwrap();
        let future = (chrono::Utc::now() + chrono::Duration::minutes(10))
            .naive_utc()
            .to_string();
        let secret = b"share-test-secret";
        for password in [None, Some("password-hash")] {
            sqlx::query("INSERT OR REPLACE INTO temporary_urls VALUES (?, ?, ?)")
                .bind("shared-map")
                .bind(password)
                .bind(&future)
                .execute(&pool)
                .await
                .unwrap();
            let claims = ShareClaims {
                purpose: "address_search".into(),
                id: "shared-map".into(),
                exp: (chrono::Utc::now().timestamp() + 600) as usize,
                revision: share_revision(password),
            };
            let token = encode(
                &Header::default(),
                &claims,
                &EncodingKey::from_secret(secret),
            )
            .unwrap();
            assert!(authorize_share(&pool, &token, secret).await.is_ok());
            sqlx::query("UPDATE temporary_urls SET password_hash = 'changed'")
                .execute(&pool)
                .await
                .unwrap();
            assert!(matches!(
                authorize_share(&pool, &token, secret).await,
                Err(AppError::Unauthorized(_))
            ));
            sqlx::query("UPDATE temporary_urls SET password_hash = ?")
                .bind(password)
                .execute(&pool)
                .await
                .unwrap();
            for expiration in ["2000-01-01 00:00:00", "invalid-date"] {
                sqlx::query("UPDATE temporary_urls SET expiration = ?")
                    .bind(expiration)
                    .execute(&pool)
                    .await
                    .unwrap();
                assert!(matches!(
                    authorize_share(&pool, &token, secret).await,
                    Err(AppError::Unauthorized(_))
                ));
            }
            sqlx::query("DELETE FROM temporary_urls")
                .execute(&pool)
                .await
                .unwrap();
            assert!(matches!(
                authorize_share(&pool, &token, secret).await,
                Err(AppError::Unauthorized(_))
            ));
        }
    }

    #[tokio::test]
    async fn unauthenticated_search_is_rejected_before_upstream_or_database_access() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_lazy("sqlite::memory:")
            .unwrap();
        let response = search_handler(
            Extension(pool),
            Extension(GeocoderClient::default()),
            HeaderMap::new(),
            Json(SearchRequest {
                address: "東京都".into(),
                share_token: None,
            }),
        )
        .await;
        assert!(matches!(response, Err(AppError::Unauthorized(_))));
    }
}
