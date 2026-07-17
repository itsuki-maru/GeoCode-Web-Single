pub mod cookie_validator; // アクセストークン検証用
pub mod flexible_cookie_validator; // アクセストークンがある場合はこれを検証し、ない場合も内部サービスへ引き継ぐ処理
pub mod print_req_res;
pub mod refresh_cookie_validator; // リフレッシュトークン検証用
pub mod security;

use axum::http::HeaderMap;
use sqlx::SqlitePool;

// Cookieヘッダーから指定された名前のCookie値を取得するヘルパー関数
pub fn extract_cookie_value<'a>(headers: &'a HeaderMap, cookie_name: &str) -> Option<&'a str> {
    let cookies_str = headers
        .get(axum::http::header::COOKIE)
        .and_then(|header_value| header_value.to_str().ok())
        .unwrap_or("");

    for cookie in cookies_str.split(';') {
        let parts: Vec<&str> = cookie.split('=').map(|part| part.trim()).collect();
        if parts.len() == 2 && parts[0] == cookie_name {
            return Some(parts[1]);
        }
    }
    None
}

pub async fn token_is_active(pool: &SqlitePool, user_id: &str, auth_version: i64) -> bool {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM user_model
            WHERE id = $1 AND auth_version = $2 AND is_locked = false
        )
        "#,
    )
    .bind(user_id)
    .bind(auth_version)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}
