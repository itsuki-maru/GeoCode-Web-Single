use crate::auth::{
    build_auth_cookie_response, create_token, refresh_access_token, with_auth_cookies,
};
use crate::config::CONFIG;
use crate::error::AppError;
use crate::model::{
    GetUserNameFromDb, MessageApi, TotpLoginPayload, TotpSetupResponse, TotpTempSecret,
    TotpVerifyRequest,
};
use axum::{
    Json,
    extract::Extension,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base32::Alphabet;
use chrono::Utc;
use rand::Rng;
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use sqlx::{query, query_as};
use totp_rs::{Algorithm, TOTP};

// TOTP有効化ハンドラー
pub async fn totp_setup_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<impl IntoResponse, AppError> {
    let secret_bytes: [u8; 20] = rand::thread_rng().r#gen(); // 2024 Editionで `gen` は予約語であるため修正
    let secret_base32 = base32::encode(Alphabet::RFC4648 { padding: false }, &secret_bytes);

    let user = query_as!(
        GetUserNameFromDb,
        r#"
        SELECT username
        FROM user_model
        WHERE id = $1
        "#,
        user_id,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret_base32.clone().into(),
        CONFIG.service_name.clone().into(),
        user.username.clone(),
    )
    .map_err(|_e| AppError::InternalServerError);

    match totp {
        Ok(totp) => {
            let url = totp.get_url();
            let query_result = query!(
                r#"
                UPDATE user_model
                SET totp_temp_secret = $1
                WHERE id = $2
                "#,
                secret_base32,
                user_id,
            )
            .execute(&pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "database error.");
                AppError::Sqlx(e)
            })?;

            let affected_rows = query_result.rows_affected();
            if affected_rows > 0 {
                Ok(Json(TotpSetupResponse {
                    otpauth_url: url,
                    secret_base32,
                }))
            } else {
                Err(AppError::BadRequest)
            }
        },
        Err(_) => Err(AppError::BadRequest),
    }
}

// TOTP有効化検証ハンドラー
pub async fn totp_verify_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<TotpVerifyRequest>,
) -> Result<Response, AppError> {
    let result = query_as!(
        TotpTempSecret,
        r#"
        SELECT totp_temp_secret
        FROM user_model
        WHERE id = $1
        "#,
        user_id,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Unauthorized("Unauthorized".into())
    })?;

    if result.totp_temp_secret == "" {
        return Err(AppError::Unauthorized("Unauthorized".into()));
    };

    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        result.totp_temp_secret.clone().into(),
        CONFIG.service_name.clone().into(),
        user_id.to_string().into(),
    )
    .map_err(|_e| AppError::Unauthorized("Unauthorized".into()))?;

    if !totp.check_current(&payload.token).unwrap_or(false) {
        return Err(AppError::Unauthorized("Unauthorized".into()));
    };

    // 検証成功時は本番用に昇格し、現在のセッション用トークンを更新する。
    let mut transaction = pool.begin().await?;
    let auth_version = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE user_model
        SET totp_secret = $1, totp_temp_secret = '',
            auth_version = auth_version + 1,
            totp_challenge_id = NULL,
            totp_challenge_expires_at = NULL,
            totp_challenge_attempts = 0
        WHERE id = $2 AND totp_temp_secret = $1 AND totp_temp_secret <> ''
        RETURNING auth_version
        "#,
    )
    .bind(&result.totp_temp_secret)
    .bind(&user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?
    .ok_or(AppError::BadRequest)?;

    let new_tokens =
        refresh_access_token(user_id, auth_version).map_err(|_| AppError::InternalServerError)?;
    let response = with_auth_cookies(
        Json(MessageApi {
            message: "Success TOTP 2FA enabled.".to_string(),
        })
        .into_response(),
        &new_tokens.access_token,
        &new_tokens.refresh_token,
    )?;
    transaction.commit().await?;
    Ok(response)
}

// TOTPによるログインハンドラー
pub async fn token_totp_handler(
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<TotpLoginPayload>,
) -> Result<impl IntoResponse, AppError> {
    struct TotpLoginUser {
        id: String,
        username: String,
        totp_secret: String,
        auth_version: i64,
    }

    let challenge_now = Utc::now().naive_utc();
    let user = query_as!(
        TotpLoginUser,
        r#"
        SELECT id, username, totp_secret, auth_version
        FROM user_model
        WHERE totp_challenge_id = $1
          AND totp_challenge_expires_at > $2
          AND totp_challenge_attempts < 5
          AND is_locked = false
        "#,
        payload.challenge_id,
        challenge_now,
    )
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Time Over.".into()))?;

    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        user.totp_secret.clone().into(),
        CONFIG.service_name.clone().into(),
        user.id.to_string(),
    )
    .map_err(|_| AppError::InternalServerError)?;

    if !totp.check_current(&payload.totp_token).unwrap_or(false) {
        query!(
            r#"
            UPDATE user_model
            SET totp_challenge_attempts = totp_challenge_attempts + 1,
                totp_challenge_id = CASE
                    WHEN totp_challenge_attempts + 1 >= 5 THEN NULL
                    ELSE totp_challenge_id
                END,
                totp_challenge_expires_at = CASE
                    WHEN totp_challenge_attempts + 1 >= 5 THEN NULL
                    ELSE totp_challenge_expires_at
                END
            WHERE id = $1 AND totp_challenge_id = $2
            "#,
            user.id,
            payload.challenge_id,
        )
        .execute(&pool)
        .await?;
        return Err(AppError::Unauthorized("NoAuth".into()));
    }

    let consumed = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE user_model
        SET failed_count = 0,
            totp_challenge_id = NULL,
            totp_challenge_expires_at = NULL,
            totp_challenge_attempts = 0,
            is_basic_authed = false
        WHERE id = $1 AND totp_challenge_id = $2
        RETURNING id
        "#,
    )
    .bind(&user.id)
    .bind(payload.challenge_id)
    .fetch_optional(&pool)
    .await?;
    if consumed.is_none() {
        return Err(AppError::Unauthorized("NoAuth".into()));
    }

    let access_token = create_token(
        &user.id,
        CONFIG.access_token_exp_minutes,
        "access_token",
        user.auth_version,
    )
    .map_err(|_| AppError::InternalServerError)?;
    let refresh_token = create_token(
        &user.id,
        CONFIG.refresh_token_exp_minutes,
        "refresh_token",
        user.auth_version,
    )
    .map_err(|_| AppError::InternalServerError)?;

    let body = json!({
        "success": true,
        "user": user.username,
        "totp_required": false,
    })
    .to_string();

    build_auth_cookie_response(
        &access_token,
        &refresh_token,
        StatusCode::OK,
        axum::body::Body::from(body),
    )
}
// TOTP無効化ハンドラー
pub async fn totp_disable_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<TotpVerifyRequest>,
) -> Result<Response, AppError> {
    let (username, current_secret) = sqlx::query_as::<_, (String, String)>(
        "SELECT username, totp_secret FROM user_model WHERE id = $1 AND is_locked = false",
    )
    .bind(&user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Failed TOTP 2FA disable.".into()))?;
    if current_secret.is_empty() {
        return Err(AppError::BadRequest);
    }
    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        current_secret.clone().into(),
        CONFIG.service_name.clone().into(),
        username,
    )
    .map_err(|_| AppError::InternalServerError)?;
    if !totp.check_current(&payload.token).unwrap_or(false) {
        return Err(AppError::Unauthorized("Invalid TOTP token.".into()));
    }

    let mut transaction = pool.begin().await?;
    let auth_version = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE user_model
        SET totp_secret = '', totp_temp_secret = '',
            auth_version = auth_version + 1,
            totp_challenge_id = NULL,
            totp_challenge_expires_at = NULL,
            totp_challenge_attempts = 0
        WHERE id = $1 AND totp_secret = $2 AND is_locked = false
        RETURNING auth_version
        "#,
    )
    .bind(&user_id)
    .bind(&current_secret)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?
    .ok_or_else(|| AppError::Unauthorized("Failed TOTP 2FA disable.".into()))?;

    let new_tokens =
        refresh_access_token(user_id, auth_version).map_err(|_| AppError::InternalServerError)?;
    let response = with_auth_cookies(
        Json(MessageApi {
            message: "Success TOTP 2FA disabled.".to_string(),
        })
        .into_response(),
        &new_tokens.access_token,
        &new_tokens.refresh_token,
    )?;
    transaction.commit().await?;

    Ok(response)
}
