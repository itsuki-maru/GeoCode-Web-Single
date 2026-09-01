use crate::config::CONFIG;
use axum::{
    Extension, Json,
    http::{HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
};
use bcrypt::{DEFAULT_COST, hash, verify};
use chrono::{NaiveDateTime, TimeDelta, Utc};
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use sqlx::{query, query_as};

use crate::auth::{
    build_auth_cookie_response, build_clear_auth_cookie_response, create_token,
    refresh_access_token, with_cleared_auth_cookies,
};
use crate::db::create_user_with_master_layer;
use crate::error::AppError;
use crate::model::{
    AccountPrivacyInfo, AuthenticatedUser, IsExists, LoginPayload, MessageApi, ReturningId,
    SignupPayload, UpdateAccountPasswordPayload, UpdateAccountPrivacyPayload, UserAccountModel,
};
use crate::utils::validate_password;

// SIGNUP USER API
pub async fn signup_handler(
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<SignupPayload>,
) -> Result<Json<ReturningId>, AppError> {
    validate_password(&payload.password)?;

    // 既に同名のユーザーが存在するか確認
    let user_exists = query_as!(
        IsExists,
        r#"
        SELECT EXISTS(
            SELECT 1 FROM user_model WHERE username = $1
        ) as exists_flag
        "#,
        payload.username
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Sqlx(e))?;

    // `i64`を`bool`に変換
    let user_exists = user_exists.exists_flag != 0;

    // 同名のユーザーが既に存在する場合はエラーを返す
    if user_exists {
        return Err(AppError::Conflict);
    }

    // パスワードをハッシュ化(ソルト値はハッシュ値に組み込んで管理)
    let hashed_password =
        hash(payload.password, DEFAULT_COST).map_err(|_| AppError::InternalServerError)?;

    let returning_user_id =
        create_user_with_master_layer(&pool, &payload.username, &hashed_password, false).await?;

    Ok(Json(returning_user_id))
}

// ログインハンドラー
pub async fn token_handler(
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<LoginPayload>,
) -> Result<impl IntoResponse, AppError> {
    // application_settingsの値を格納する構造体
    struct ApplicationSettings {
        setting_key: String,
        setting_value: String,
    }

    let result_settings = query_as!(
        ApplicationSettings,
        r#"
        SELECT
            setting_key,
            setting_value
        FROM application_settings
        "#,
    )
    .fetch_all(&pool)
    .await;

    let mut parsed_login_limit = 15;
    let mut parsed_minutes = 5;
    let mut parsed_challenge_limit_start = 5;
    if let Ok(setting) = result_settings {
        for row in setting {
            if row.setting_key == "login_attempts_limit" {
                let login_attempts_limit = row.setting_value;
                parsed_login_limit = parsed_i64_to_string(login_attempts_limit).unwrap_or(15);
            } else if row.setting_key == "next_challenge_minutes" {
                let next_challenge_minutes = row.setting_value;
                parsed_minutes = parsed_i64_to_string(next_challenge_minutes).unwrap_or(5);
            } else if row.setting_key == "challenge_limit_start" {
                let challenge_limit_start = row.setting_value;
                parsed_challenge_limit_start =
                    parsed_i64_to_string(challenge_limit_start).unwrap_or(5);
            }
        }
    }

    // ユーザー名からユーザーを取得
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
            totp_temp_secret,
            auth_version
        FROM user_model
        WHERE username = $1
        "#,
        payload.username
    )
    .fetch_optional(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "failed to commit transaction");
        AppError::Sqlx(e)
    })?;

    let user = match user {
        Some(user) => user,
        None => return Err(AppError::Unauthorized("Unauthorized".into())),
    };

    // アカウントがロックされている場合はエラーレスポンス
    if user.is_locked {
        return Err(AppError::Unauthorized("LockedAccount".into()));
    }

    // すでに設定回数以上失敗し、次にチャレンジできる時間に達していなければエラーレスポンス
    let current_datetime = Utc::now().naive_utc();
    // SQLiteでの文字列から日付型に戻す
    match parse_naive_datetime(&user.next_challenge_time) {
        Some(next) if next > current_datetime => {
            return Err(AppError::Unauthorized("PleaseWait".into()));
        },
        Some(_) => {},
        None => {
            return Err(AppError::Unauthorized("Parse Error.".into()));
        },
    }

    // ログイン失敗回数が上限に達している場合はアカウントをロックしてエラーレスポンス（カウントリセット）
    if user.failed_count == parsed_login_limit as i64 - 1 {
        query!(
            r#"
            UPDATE user_model
            SET is_locked = $1, failed_count = $2, auth_version = auth_version + 1
            WHERE id = $3
            "#,
            true,
            0,
            user.id
        )
        .execute(&pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "database error.");
            AppError::Sqlx(e)
        })?;

        return Err(AppError::Unauthorized("Locked".into()));
    }

    // パスワード検証（ユーザー存在確認済）
    if verify(&payload.password, &user.password).map_err(|_e| {
        return AppError::InternalServerError;
    })? == false
    {
        let failed_count = user.failed_count;
        let failed_count = failed_count + 1;

        // 失敗が設定回数に達したら次にチャレンジできる時間を設定
        if failed_count >= parsed_challenge_limit_start as i64 {
            let now = Utc::now().naive_utc();
            let five_minutes_later: NaiveDateTime;
            match TimeDelta::try_minutes(parsed_minutes.into()) {
                Some(five_min_delta) => {
                    five_minutes_later = now + five_min_delta;
                    query!(
                        r#"
                        UPDATE user_model
                        SET failed_count = $1, next_challenge_time = $2
                        WHERE id = $3
                        "#,
                        failed_count,
                        five_minutes_later,
                        user.id
                    )
                    .execute(&pool)
                    .await
                    .map_err(|e| {
                        tracing::error!(error = %e, "database error.");
                        AppError::Sqlx(e)
                    })?;

                    return Err(AppError::Unauthorized("UnauthorizedPleaseWait".into()));
                },
                None => {
                    tracing::error!("five_min_delta Get Error.");
                    return Err(AppError::InternalServerError);
                },
            }
        }

        // 認証に失敗したらカウントアップしエラーレスポンス
        query!(
            r#"
            UPDATE user_model
            SET failed_count = $1
            WHERE id = $2
            "#,
            failed_count,
            user.id
        )
        .execute(&pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "database error.");
            AppError::Sqlx(e)
        })?;

        return Err(AppError::Unauthorized("Unauthorized".into()));
    }

    // TOTPが有効であれば、一回限りの短時間チャレンジを要求
    if user.totp_secret != "" {
        let challenge_id = uuid::Uuid::now_v7().to_string();
        let challenge_expires_at = Utc::now().naive_utc()
            + TimeDelta::try_minutes(3).ok_or(AppError::InternalServerError)?;
        query!(
            r#"
            UPDATE user_model
            SET totp_challenge_id = $1,
                totp_challenge_expires_at = $2,
                totp_challenge_attempts = 0,
                is_basic_authed = false
            WHERE id = $3
            "#,
            challenge_id,
            challenge_expires_at,
            user.id
        )
        .execute(&pool)
        .await?;

        let body = json!({
            "success": false,
            "user": payload.username,
            "challenge_id": challenge_id,
            "totp_required": true,
        })
        .to_string();
        let response = Response::builder()
            .status(StatusCode::OK)
            .body(axum::body::Body::from(body))
            .map_err(|_e| AppError::InternalServerError)?;
        return Ok(response);
    // TOTPが有効でなければそのままログイン成功
    } else {
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
            "access_token",
            user.auth_version,
        )
        .map_err(|_e| AppError::InternalServerError)?;

        // リフレッシュトークン生成
        let refresh_token = create_token(
            &user.id,
            CONFIG.refresh_token_exp_minutes,
            "refresh_token",
            user.auth_version,
        )
        .map_err(|_e| AppError::InternalServerError)?;

        let body = json!({
            "success": true,
            "user": payload.username,
            "id": user.id,
            "totp_required": false,
        })
        .to_string();

        let response = build_auth_cookie_response(
            &access_token,
            &refresh_token,
            StatusCode::OK,
            axum::body::Body::from(body),
        )?;
        Ok(response)
    }
}

// 認証確認ハンドラー
pub async fn auth_check_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<AuthenticatedUser>, AppError> {
    // SQLクエリの実行
    let user = query_as!(
        AuthenticatedUser,
        r#"
        SELECT id, username FROM user_model WHERE id = $1
        "#,
        user_id
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Sqlx(e))?;

    Ok(Json(user))
}

fn parsed_i64_to_string(string_int: String) -> Result<i64, std::num::ParseIntError> {
    match string_int.parse::<i64>() {
        Ok(parsed_int) => return Ok(parsed_int),
        Err(e) => return Err(e),
    };
}

// リフレッシュトークンの再取得ハンドラ
pub async fn refresh_token_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<impl IntoResponse, AppError> {
    let auth_version = sqlx::query_scalar::<_, i64>(
        "SELECT auth_version FROM user_model WHERE id = $1 AND is_locked = false",
    )
    .bind(&user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Unauthorized".into()))?;

    match refresh_access_token(user_id, auth_version) {
        Ok(new_tokens) => {
            let response = build_auth_cookie_response(
                &new_tokens.access_token,
                &new_tokens.refresh_token,
                StatusCode::OK,
                axum::body::Body::empty(),
            )?;
            Ok(response)
        },
        Err(err) => {
            tracing::error!("{}", err);
            return Err(AppError::InternalServerError);
        },
    }
}
// アカウントの非公開・非公開設定ハンドラー
pub async fn account_privacy_update_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<UpdateAccountPrivacyPayload>,
) -> Result<Json<MessageApi>, AppError> {
    let result = query!(
        r#"
        UPDATE user_model
        SET is_private = $1
        WHERE id = $2
        "#,
        payload.is_private,
        user_id,
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let affected_rows = result.rows_affected();
    if affected_rows > 0 {
        return Ok(Json(MessageApi {
            message: "User privacy successfully updated.".to_string(),
        }));
    } else {
        return Err(AppError::BadRequest);
    }
}

// アカウントのパスワード更新ハンドラー
pub async fn account_password_update_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<UpdateAccountPasswordPayload>,
) -> Result<Response, AppError> {
    validate_password(&payload.new_password)?;

    let current_hash = sqlx::query_scalar::<_, String>(
        "SELECT password FROM user_model WHERE id = $1 AND is_locked = false",
    )
    .bind(&user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Invalid credentials".into()))?;
    if !verify(&payload.current_password, &current_hash)
        .map_err(|_| AppError::InternalServerError)?
    {
        return Err(AppError::Unauthorized("Invalid credentials".into()));
    }

    let hashed_password =
        hash(payload.new_password, DEFAULT_COST).map_err(|_| AppError::InternalServerError)?;

    let result = query!(
        r#"
        UPDATE user_model
        SET password = $1, auth_version = auth_version + 1
        WHERE id = $2 AND password = $3
        "#,
        hashed_password,
        user_id,
        current_hash,
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    if result.rows_affected() > 0 {
        let response = Json(MessageApi {
            message: "Password successfully updated.".to_string(),
        })
        .into_response();
        with_cleared_auth_cookies(response)
    } else {
        Err(AppError::BadRequest)
    }
}

// アカウント情報取得ハンドラー
pub async fn get_account_info_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<impl IntoResponse, AppError> {
    struct AccountPrivacyRow {
        is_private: bool,
        is_totp_enabled: bool,
    }

    let user_info = query_as!(
        AccountPrivacyRow,
        r#"
        SELECT
            is_private,
            totp_secret <> '' AS "is_totp_enabled!: bool"
        FROM user_model WHERE id = $1
        "#,
        user_id,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let response = AccountPrivacyInfo {
        is_private: user_info.is_private,
        is_totp_enabled: user_info.is_totp_enabled,
        legacy_totp_status: if user_info.is_totp_enabled {
            "configured".to_string()
        } else {
            String::new()
        },
    };

    Ok((
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(response),
    ))
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

// サーバー側で全セッションを失効させ、認証Cookieを削除
pub async fn disable_token(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<impl IntoResponse, AppError> {
    let updated = sqlx::query_scalar::<_, i64>(
        "UPDATE user_model SET auth_version = auth_version + 1 WHERE id = $1 RETURNING auth_version",
    )
    .bind(user_id)
    .fetch_optional(&pool)
    .await?;
    if updated.is_none() {
        return Err(AppError::Unauthorized("Unauthorized".into()));
    }
    build_clear_auth_cookie_response()
}
