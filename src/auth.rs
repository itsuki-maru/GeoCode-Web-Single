use crate::config::CONFIG;
use crate::error::AppError;
use crate::model::{Token, TokenPair};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use chrono;
use jsonwebtoken::{
    DecodingKey, EncodingKey, Header, Validation, decode, encode, errors::ErrorKind,
};

// アクセストークン・リフレッシュトークン作成
pub fn create_token(
    user_id: &String,
    minutes: i64,
    token_type: String,
) -> Result<String, jsonwebtoken::errors::Error> {
    let expiration = chrono::Utc::now()
        .checked_add_signed(
            chrono::Duration::try_minutes(minutes).expect("Failed to create duration"),
        )
        .expect("valid timestamp")
        .timestamp();

    let access_token = Token {
        token_type,
        exp: expiration as usize,
        sub: user_id.clone(),
    };

    encode(
        &Header::default(),
        &access_token,
        &EncodingKey::from_secret(CONFIG.secret_key.as_ref()),
    )
}

// アクセストークン検証
pub fn verify_access_token(token: &str) -> Result<Token, ErrorKind> {
    let validation = Validation::default();

    match decode::<Token>(
        token,
        &DecodingKey::from_secret(CONFIG.secret_key.as_ref()),
        &validation,
    ) {
        Ok(data) => Ok(data.claims), // 有効なトークン
        Err(err) => {
            if let ErrorKind::ExpiredSignature = err.kind() {
                // 期限切れでも `sub` を取得するためにデコードを試みる
                let decoded = decode::<Token>(
                    token,
                    &DecodingKey::from_secret(CONFIG.secret_key.as_ref()),
                    &Validation {
                        validate_exp: false, // 有効期限の検証を無視
                        ..Validation::default()
                    },
                );

                if let Ok(_data) = decoded {
                    return Err(ErrorKind::ExpiredSignature); // `sub` は取得できるので、後続処理で利用
                }
            }
            Err(ErrorKind::InvalidToken) // 不正なトークン
        },
    }
}

// 新しいアクセストークンを発行し、リフレッシュトークンを更新する
pub fn refresh_access_token(user_id: String) -> Result<TokenPair, jsonwebtoken::errors::Error> {
    let access_token = create_token(
        &user_id,
        CONFIG.access_token_exp_minutes,
        "access_token".to_string(),
    )?;
    let refresh_token = create_token(
        &user_id,
        CONFIG.refresh_token_exp_minutes,
        "refresh_token".to_string(),
    )?;
    Ok(TokenPair {
        access_token,
        refresh_token,
    })
}

// Cookie文字列のペアを生成
fn build_cookie_strings(access_token: &str, refresh_token: &str) -> (String, String) {
    let secure = if CONFIG.secure_cookie { " Secure;" } else { "" };
    let access_token_cookie = format!(
        "access_token={};{} HttpOnly; SameSite=Strict; max-age={}; Path=/",
        access_token,
        secure,
        CONFIG.access_token_exp_minutes * 60
    );
    let refresh_token_cookie = format!(
        "refresh_token={};{} HttpOnly; SameSite=Strict; max-age={}; Path=/account/refresh",
        refresh_token,
        secure,
        CONFIG.refresh_token_exp_minutes * 60
    );
    (access_token_cookie, refresh_token_cookie)
}

// Set-CookieヘッダーにアクセストークンとリフレッシュトークンのCookieを付与したResponseを生成
pub fn build_auth_cookie_response(
    access_token: &str,
    refresh_token: &str,
    status: StatusCode,
    body: axum::body::Body,
) -> Result<Response<axum::body::Body>, AppError> {
    let (access_cookie, refresh_cookie) = build_cookie_strings(access_token, refresh_token);
    let access_header =
        HeaderValue::from_str(&access_cookie).map_err(|_| AppError::InternalServerError)?;
    let refresh_header =
        HeaderValue::from_str(&refresh_cookie).map_err(|_| AppError::InternalServerError)?;

    let mut builder = Response::builder();
    if let Some(headers) = builder.headers_mut() {
        headers.append("Set-Cookie", access_header);
        headers.append("Set-Cookie", refresh_header);
    }
    builder
        .status(status)
        .body(body)
        .map_err(|_| AppError::InternalServerError)
}

// リフレッシュトークン検証
pub fn verify_refresh_token(token: &str) -> Result<Token, jsonwebtoken::errors::Error> {
    decode::<Token>(
        token,
        &DecodingKey::from_secret(CONFIG.secret_key.as_ref()),
        &Validation::default(),
    )
    .map(|data| data.claims)
}
