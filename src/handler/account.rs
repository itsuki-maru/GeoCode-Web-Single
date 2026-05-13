use crate::config::CONFIG;
use axum::{
    Extension, Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use bcrypt::{DEFAULT_COST, hash, verify};
use chrono::{NaiveDateTime, TimeDelta, Utc};
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use sqlx::{query, query_as};

use crate::auth::{build_auth_cookie_response, create_token, refresh_access_token};
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
            totp_temp_secret
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
            SET is_locked = $1, failed_count = $2
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

    // TOTPが有効であれば要求
    if user.totp_secret != "" {
        let now = Utc::now().naive_utc().to_string();
        // ベーシック認証確認済みのフラグ
        query!(
            r#"
            UPDATE user_model
            SET is_basic_authed = $1, is_basic_authed_at = $2
            WHERE id = $3
            "#,
            true,
            now,
            user.id
        )
        .execute(&pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "database error.");
            AppError::Sqlx(e)
        })?;

        let body = json!({
            "success": false,
            "user": payload.username,
            "id": user.id,
            "totp_required": true,
        })
        .to_string();
        // レスポンスの生成
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
) -> Result<impl IntoResponse, AppError> {
    match refresh_access_token(user_id) {
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
) -> Result<Json<MessageApi>, AppError> {
    validate_password(&payload.new_password)?;

    let hashed_password =
        hash(payload.new_password, DEFAULT_COST).map_err(|_| AppError::InternalServerError)?;

    let result = query!(
        r#"
        UPDATE user_model
        SET password = $1
        WHERE id = $2
        "#,
        hashed_password,
        user_id,
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    if result.rows_affected() > 0 {
        Ok(Json(MessageApi {
            message: "Password successfully updated.".to_string(),
        }))
    } else {
        Err(AppError::BadRequest)
    }
}

// アカウント情報取得ハンドラー
pub async fn get_account_info_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<AccountPrivacyInfo>, AppError> {
    let user_info = query_as!(
        AccountPrivacyInfo,
        r#"
        SELECT
            is_private,
            totp_secret
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

    Ok(Json(user_info))
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

// 期限0の無効トークンを発行し、既存のトークンを上書き
pub async fn disable_token(
    Extension(user_id): Extension<String>,
) -> Result<impl IntoResponse, AppError> {
    // アクセストークン生成
    let access_token = create_token(&user_id, 0, "access_token".to_string())
        .map_err(|_e| AppError::InternalServerError)?;

    // リフレッシュトークン生成
    let refresh_token = create_token(&user_id, 0, "refresh_token".to_string())
        .map_err(|_e| AppError::InternalServerError)?;

    build_auth_cookie_response(
        &access_token,
        &refresh_token,
        StatusCode::OK,
        axum::body::Body::empty(),
    )
}
