use crate::auth::{build_auth_cookie_response, create_token};
use crate::config::CONFIG;
use crate::error::AppError;
use crate::model::{
    GetUserNameFromDb, MessageApi, TotpLoginPayload, TotpSetupResponse, TotpTempSecret,
    TotpVerifyRequest, UserAccountModel,
};
use axum::{Json, extract::Extension, http::StatusCode, response::IntoResponse};
use base32::Alphabet;
use chrono::{Duration, NaiveDateTime, Utc};
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
) -> Result<Json<MessageApi>, AppError> {
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

    // 検証成功時は本番用に昇格
    let blank_text = "".to_string();
    query!(
        r#"
        UPDATE user_model
        SET totp_secret = $1, totp_temp_secret = $2
        WHERE id = $3
        "#,
        result.totp_temp_secret,
        blank_text,
        user_id,
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    Ok(Json(MessageApi {
        message: "Success TOTP 2FA enabled.".to_string(),
    }))
}

// TOTPによるログインハンドラー
pub async fn token_totp_handler(
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<TotpLoginPayload>,
) -> Result<impl IntoResponse, AppError> {
    // ユーザーIDからユーザーを取得
    let user = query_as!(
        UserAccountModel,
        r#"
        SELECT
            id,
            username,
            password,
            create_at,
            is_superuser,
            failed_count,
            next_challenge_time,
            is_locked,
            is_private,
            is_basic_authed,
            is_basic_authed_at,
            totp_secret,
            totp_temp_secret
        FROM user_model
        WHERE id = $1
        "#,
        payload.user_id
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // パスワードベーシック認証を成功していなければエラーレスポンス
    if !user.is_basic_authed {
        return Err(AppError::Unauthorized("NoBasicAuth".into()));
    }

    // 3分以内か検証
    if let Some(expiry) = Duration::try_minutes(3) {
        // SQLiteでの文字列から日付型に戻す
        match parse_naive_datetime(&user.is_basic_authed_at) {
            Some(next) if Utc::now().naive_utc() - next > expiry => {
                return Err(AppError::Unauthorized("Time Over.".into()));
            },
            Some(_) => {},
            None => {
                return Err(AppError::Validation("Parse Error.".into()));
            },
        }
    }

    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        user.totp_secret.into(),
        CONFIG.service_name.clone().into(),
        payload.user_id.clone().to_string(),
    )
    .map_err(|_e| AppError::InternalServerError)?;

    if !totp.check_current(&payload.totp_token).unwrap_or(false) {
        return Err(AppError::Unauthorized("NoAuth".into()));
    }

    // ログインに成功したらfailed_countをリセット
    query!(
        r#"
        UPDATE user_model
        SET failed_count = $1
        WHERE id = $2
        "#,
        0,
        user.id
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // アクセストークン生成
    let access_token = create_token(
        &user.id,
        CONFIG.access_token_exp_minutes,
        "access_token".to_string(),
    )
    .map_err(|_e| AppError::InternalServerError)?;

    // リフレッシュトークン生成
    let refresh_token = create_token(
        &user.id,
        CONFIG.refresh_token_exp_minutes,
        "refresh_token".to_string(),
    )
    .map_err(|_e| AppError::InternalServerError)?;

    // レスポンスボディの情報
    let body = json!({
        "success": true,
        "user": user.username,
        "id": user.id,
        "totp_required": false,
    })
    .to_string();

    // ベーシック認証確認済みのフラグのフラグをfalseへ初期化
    query!(
        r#"
        UPDATE user_model
        SET is_basic_authed = $1
        WHERE id = $2
        "#,
        false,
        user.id
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let response = build_auth_cookie_response(
        &access_token,
        &refresh_token,
        StatusCode::OK,
        axum::body::Body::from(body),
    )?;
    Ok(response)
}

// TOTP無効化ハンドラー
pub async fn totp_disable_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<MessageApi>, AppError> {
    // 無効化
    let blank_text = "".to_string();
    let query_result = query!(
        r#"
        UPDATE user_model
        SET totp_secret = $1, totp_temp_secret = $2
        WHERE id = $3
        "#,
        blank_text,
        blank_text,
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
        Ok(Json(MessageApi {
            message: "Success TOTP 2FA disabled.".to_string(),
        }))
    } else {
        Err(AppError::Unauthorized("Failed TOTP 2FA disable.".into()))
    }
}

fn parse_naive_datetime(s: &str) -> Option<NaiveDateTime> {
    // 小数秒あり/なし、スペース/T 区切りの両方を許容
    let fmts: [&str; 4] = [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
    ];
    for f in fmts {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Some(dt);
        }
    }
    None
}
