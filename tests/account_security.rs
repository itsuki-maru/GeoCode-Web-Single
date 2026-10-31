#[allow(dead_code)]
#[path = "support/uuid_fixtures.rs"]
mod common;

use axum::{
    Extension, Json,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header::SET_COOKIE},
    response::{IntoResponse, Response},
};
use chrono::{NaiveDateTime, Utc};
use geocode_web_single::{
    auth::{create_token, verify_access_token, verify_refresh_token},
    handler::account::*,
    model::{
        LoginPayload, SignupPayload, UpdateAccountPasswordPayload, UpdateAccountPrivacyPayload,
    },
};
use serde_json::Value;
use sqlx::SqlitePool;
use tower::ServiceExt;
use uuid::Uuid;

fn past() -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339("2020-01-01T00:00:00Z")
        .unwrap()
        .naive_utc()
}
async fn login(pool: &SqlitePool, username: &str, password: &str) -> Response {
    match token_handler(
        Extension(pool.clone()),
        Json(LoginPayload {
            username: username.into(),
            password: password.into(),
        }),
    )
    .await
    {
        Ok(response) => response.into_response(),
        Err(error) => error.into_response(),
    }
}
async fn error(response: Response, status: StatusCode, message: &str) {
    assert_eq!(response.status(), status);
    assert!(
        response.headers().get(SET_COOKIE).is_none(),
        "a rejected request must not issue auth cookies"
    );
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["error"], message);
}
async fn state(pool: &SqlitePool, id: Uuid) -> (i64, bool, i64, NaiveDateTime) {
    sqlx::query_as(
        r#"
        SELECT
            failed_count,
            is_locked,
            auth_version,
            next_challenge_time
        FROM user_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn settings(pool: &SqlitePool, values: &[(&str, &str)]) {
    for (key, value) in values {
        sqlx::query(
            r#"
            INSERT INTO application_settings (
                id,
                setting_key,
                setting_value,
                create_at,
                updated_at
            ) VALUES ($3, $1, $2, $4, $4)
            ON CONFLICT (setting_key) DO UPDATE SET
                setting_value = EXCLUDED.setting_value
            "#,
        )
        .bind(key)
        .bind(value)
        .bind(Uuid::new_v4().to_string())
        .bind(past())
        .execute(pool)
        .await
        .unwrap();
    }
}
fn cookie(response: &Response, name: &str) -> String {
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|value| {
            value
                .strip_prefix(&format!("{name}="))
                .and_then(|rest| rest.split(';').next())
                .map(str::to_owned)
        })
        .unwrap()
}
async fn authenticated_status(pool: &SqlitePool, token: &str) -> StatusCode {
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    app.oneshot(
        Request::builder()
            .uri("/account/auth")
            .header("cookie", format!("access_token={token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap()
    .status()
}

#[tokio::test]
async fn lockout_and_retry_windows_preserve_state_and_revoke_old_sessions() {
    let pool = common::test_pool().await;
    {
        let name = "lockout-user";
        settings(
            &pool,
            &[
                ("login_attempts_limit", "4"),
                ("challenge_limit_start", "2"),
                ("next_challenge_minutes", "30"),
            ],
        )
        .await;
        let id = common::create_test_user(&pool, name).await;
        sqlx::query(
            r#"
            UPDATE user_model
            SET
                next_challenge_time = $1
            WHERE id = $2
            "#,
        )
        .bind(past())
        .bind(id.to_string())
        .execute(&pool)
        .await
        .unwrap();
        let token = create_token(&id.to_string(), 30, "access_token", 0).unwrap();
        error(
            login(&pool, name, "wrong").await,
            StatusCode::UNAUTHORIZED,
            "unauthorized error: Unauthorized",
        )
        .await;
        assert_eq!(state(&pool, id).await, (1, false, 0, past()));
        let reference = Utc::now().naive_utc();
        error(
            login(&pool, name, "wrong").await,
            StatusCode::UNAUTHORIZED,
            "unauthorized error: UnauthorizedPleaseWait",
        )
        .await;
        let after = state(&pool, id).await;
        assert_eq!((after.0, after.1, after.2), (2, false, 0));
        // 本番は実際の時計を使うため、時刻の完全一致や秒の境界ではなく、広い許容範囲で確認する。
        assert!(after.3 > reference + chrono::Duration::minutes(20));
        assert!(after.3 < reference + chrono::Duration::minutes(40));
        error(
            login(&pool, name, "password123").await,
            StatusCode::UNAUTHORIZED,
            "unauthorized error: PleaseWait",
        )
        .await;
        assert_eq!(
            state(&pool, id).await,
            after,
            "waiting must not change the lockout state"
        );
        sqlx::query(
            r#"
            UPDATE user_model
            SET
                failed_count = 3,
                next_challenge_time = $1
            WHERE id = $2
            "#,
        )
        .bind(past())
        .bind(id.to_string())
        .execute(&pool)
        .await
        .unwrap();
        error(
            login(&pool, name, "password123").await,
            StatusCode::UNAUTHORIZED,
            "unauthorized error: Locked",
        )
        .await;
        assert_eq!(state(&pool, id).await, (0, true, 1, past()));
        assert_eq!(
            authenticated_status(&pool, &token).await,
            StatusCode::UNAUTHORIZED
        );
        error(
            login(&pool, name, "password123").await,
            StatusCode::UNAUTHORIZED,
            "unauthorized error: LockedAccount",
        )
        .await;
        assert_eq!(state(&pool, id).await, (0, true, 1, past()));
        pool.close().await;
    }
}

#[tokio::test]
async fn successful_login_resets_failures_and_issues_versioned_cookie_pairs() {
    let pool = common::test_pool().await;
    let id = common::create_test_user(&pool, "login-success").await;
    sqlx::query(
        r#"
        UPDATE user_model
        SET
            failed_count = 2,
            auth_version = 7,
            next_challenge_time = $1
        WHERE id = $2
        "#,
    )
    .bind(past())
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let response = login(&pool, "login-success", "password123").await;
    assert_eq!(response.status(), StatusCode::OK);
    let access = verify_access_token(&cookie(&response, "access_token")).unwrap();
    let refresh = verify_refresh_token(&cookie(&response, "refresh_token")).unwrap();
    assert_eq!((access.sub, access.auth_version), (id.to_string(), 7));
    assert_eq!((refresh.sub, refresh.auth_version), (id.to_string(), 7));
    assert_eq!(state(&pool, id).await, (0, false, 7, past()));
    for value in response.headers().get_all(SET_COOKIE) {
        let value = value.to_str().unwrap();
        assert!(value.contains("HttpOnly") && value.contains("SameSite=Strict"));
    }
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["success"], true);
    assert_eq!(body["totp_required"], false);
    assert_eq!(body["id"], id.to_string());
    error(
        login(&pool, "missing-user", "password123").await,
        StatusCode::UNAUTHORIZED,
        "unauthorized error: Unauthorized",
    )
    .await;
}

#[tokio::test]
async fn invalid_or_unavailable_login_settings_use_defaults() {
    let pool = common::test_pool().await;
    let id = common::create_test_user(&pool, "default-settings").await;
    settings(
        &pool,
        &[
            ("login_attempts_limit", "invalid"),
            ("challenge_limit_start", "invalid"),
            ("next_challenge_minutes", "invalid"),
            ("unrelated", "ignored"),
        ],
    )
    .await;
    sqlx::query(
        r#"
        UPDATE user_model
        SET
            failed_count = 4,
            next_challenge_time = $1
        WHERE id = $2
        "#,
    )
    .bind(past())
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let reference = Utc::now().naive_utc();
    error(
        login(&pool, "default-settings", "wrong").await,
        StatusCode::UNAUTHORIZED,
        "unauthorized error: UnauthorizedPleaseWait",
    )
    .await;
    let after = state(&pool, id).await;
    assert_eq!((after.0, after.1, after.2), (5, false, 0));
    assert!(after.3 > reference + chrono::Duration::minutes(2));
    assert!(after.3 < reference + chrono::Duration::minutes(8));
    sqlx::query(
        r#"
        DROP TABLE application_settings
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE user_model
        SET
            failed_count = 0,
            next_challenge_time = $1
        WHERE id = $2
        "#,
    )
    .bind(past())
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        login(&pool, "default-settings", "password123")
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn malformed_password_hash_does_not_modify_credentials_or_issue_cookies() {
    let pool = common::test_pool().await;
    let id = common::create_test_user(&pool, "broken-hash").await;
    sqlx::query(
        r#"
        UPDATE user_model
        SET
            password = 'invalid-hash'
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let before = state(&pool, id).await;
    error(
        login(&pool, "broken-hash", "password123").await,
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal server error",
    )
    .await;
    let response = account_password_update_handler(
        Extension(id.to_string()),
        Extension(pool.clone()),
        Json(UpdateAccountPasswordPayload {
            current_password: "password123".into(),
            new_password: "new-password123".into(),
        }),
    )
    .await
    .err()
    .unwrap()
    .into_response();
    error(
        response,
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal server error",
    )
    .await;
    assert_eq!(state(&pool, id).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT
                password
            FROM user_model
            WHERE id = $1
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        "invalid-hash"
    );
}

#[tokio::test]
async fn password_change_rejects_invalid_requests_and_revokes_previous_sessions() {
    let pool = common::test_pool().await;
    let id = common::create_test_user(&pool, "change-password").await;
    let old_token = create_token(&id.to_string(), 30, "access_token", 0).unwrap();
    let original = sqlx::query_scalar::<_, String>(
        r#"
        SELECT
            password
        FROM user_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    for (user, current, new, status) in [
        (id, "password123", "short", StatusCode::BAD_REQUEST),
        (id, "wrong", "new-password123", StatusCode::UNAUTHORIZED),
        (
            Uuid::nil(),
            "password123",
            "new-password123",
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let response = account_password_update_handler(
            Extension(user.to_string()),
            Extension(pool.clone()),
            Json(UpdateAccountPasswordPayload {
                current_password: current.into(),
                new_password: new.into(),
            }),
        )
        .await
        .err()
        .unwrap()
        .into_response();
        assert_eq!(response.status(), status);
        assert!(response.headers().get(SET_COOKIE).is_none());
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                r#"
                SELECT
                    password
                FROM user_model
                WHERE id = $1
                "#,
            )
            .bind(id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap(),
            original
        );
        assert_eq!(state(&pool, id).await.2, 0);
    }
    let response = account_password_update_handler(
        Extension(id.to_string()),
        Extension(pool.clone()),
        Json(UpdateAccountPasswordPayload {
            current_password: "password123".into(),
            new_password: "new-password123".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookies: Vec<_> = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect();
    assert_eq!(cookies.len(), 2);
    assert!(cookies.iter().all(|v| v.contains("Max-Age=0")));
    let new_hash = sqlx::query_scalar::<_, String>(
        r#"
        SELECT
            password
        FROM user_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(new_hash, original);
    assert!(bcrypt::verify("new-password123", &new_hash).unwrap());
    assert!(!bcrypt::verify("password123", &new_hash).unwrap());
    assert_eq!(state(&pool, id).await.2, 1);
    assert_eq!(
        authenticated_status(&pool, &old_token).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        authenticated_status(
            &pool,
            &create_token(&id.to_string(), 30, "access_token", 1).unwrap()
        )
        .await,
        StatusCode::OK
    );
    sqlx::query(
        r#"
        UPDATE user_model
        SET
            is_locked = true
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    error(
        account_password_update_handler(
            Extension(id.to_string()),
            Extension(pool.clone()),
            Json(UpdateAccountPasswordPayload {
                current_password: "new-password123".into(),
                new_password: "another-password123".into(),
            }),
        )
        .await
        .err()
        .unwrap()
        .into_response(),
        StatusCode::UNAUTHORIZED,
        "unauthorized error: Invalid credentials",
    )
    .await;
}

#[tokio::test]
async fn missing_accounts_and_closed_database_return_errors_without_credentials() {
    let pool = common::test_pool().await;
    common::init_test_env();
    let id = Uuid::nil();
    error(
        refresh_token_handler(Extension(id.to_string()), Extension(pool.clone()))
            .await
            .err()
            .unwrap()
            .into_response(),
        StatusCode::UNAUTHORIZED,
        "unauthorized error: Unauthorized",
    )
    .await;
    error(
        disable_token(Extension(id.to_string()), Extension(pool.clone()))
            .await
            .err()
            .unwrap()
            .into_response(),
        StatusCode::UNAUTHORIZED,
        "unauthorized error: Unauthorized",
    )
    .await;
    error(
        account_privacy_update_handler(
            Extension(id.to_string()),
            Extension(pool.clone()),
            Json(UpdateAccountPrivacyPayload { is_private: false }),
        )
        .await
        .err()
        .unwrap()
        .into_response(),
        StatusCode::BAD_REQUEST,
        "bad request",
    )
    .await;
    pool.close().await;
    let responses = vec![
        signup_handler(
            Extension(pool.clone()),
            Json(SignupPayload {
                username: "closed-db".into(),
                password: "password123".into(),
            }),
        )
        .await
        .err()
        .unwrap()
        .into_response(),
        login(&pool, "closed-db", "password123").await,
        auth_check_handler(Extension(id.to_string()), Extension(pool.clone()))
            .await
            .err()
            .unwrap()
            .into_response(),
        get_account_info_handler(Extension(id.to_string()), Extension(pool.clone()))
            .await
            .err()
            .unwrap()
            .into_response(),
        refresh_token_handler(Extension(id.to_string()), Extension(pool.clone()))
            .await
            .err()
            .unwrap()
            .into_response(),
        disable_token(Extension(id.to_string()), Extension(pool.clone()))
            .await
            .err()
            .unwrap()
            .into_response(),
        account_password_update_handler(
            Extension(id.to_string()),
            Extension(pool.clone()),
            Json(UpdateAccountPasswordPayload {
                current_password: "password123".into(),
                new_password: "new-password123".into(),
            }),
        )
        .await
        .err()
        .unwrap()
        .into_response(),
        account_privacy_update_handler(
            Extension(id.to_string()),
            Extension(pool.clone()),
            Json(UpdateAccountPrivacyPayload { is_private: false }),
        )
        .await
        .err()
        .unwrap()
        .into_response(),
    ];
    for response in responses {
        error(
            response,
            StatusCode::INTERNAL_SERVER_ERROR,
            "database error",
        )
        .await;
    }
}
