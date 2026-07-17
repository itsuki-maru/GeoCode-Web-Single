use crate::config::CONFIG;
use crate::error::AppError;
use crate::model::{Token, TokenPair};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use jsonwebtoken::{
    DecodingKey, EncodingKey, Header, Validation, decode, encode, errors::ErrorKind,
};

pub fn create_token(
    user_id: &String,
    minutes: i64,
    token_type: &str,
    auth_version: i64,
) -> Result<String, jsonwebtoken::errors::Error> {
    let expiration = chrono::Utc::now()
        .checked_add_signed(
            chrono::Duration::try_minutes(minutes).expect("Failed to create duration"),
        )
        .expect("valid timestamp")
        .timestamp();

    let token = Token {
        token_type: token_type.to_string(),
        exp: expiration as usize,
        sub: user_id.clone(),
        auth_version,
    };

    encode(
        &Header::default(),
        &token,
        &EncodingKey::from_secret(CONFIG.secret_key.as_ref()),
    )
}

pub fn verify_access_token(token: &str) -> Result<Token, ErrorKind> {
    let validation = Validation::default();
    match decode::<Token>(
        token,
        &DecodingKey::from_secret(CONFIG.secret_key.as_ref()),
        &validation,
    ) {
        Ok(data) if data.claims.token_type == "access_token" => Ok(data.claims),
        Ok(_) => Err(ErrorKind::InvalidToken),
        Err(err) => {
            if let ErrorKind::ExpiredSignature = err.kind() {
                return Err(ErrorKind::ExpiredSignature);
            }
            Err(ErrorKind::InvalidToken)
        },
    }
}

pub fn refresh_access_token(
    user_id: String,
    auth_version: i64,
) -> Result<TokenPair, jsonwebtoken::errors::Error> {
    let access_token = create_token(
        &user_id,
        CONFIG.access_token_exp_minutes,
        "access_token",
        auth_version,
    )?;
    let refresh_token = create_token(
        &user_id,
        CONFIG.refresh_token_exp_minutes,
        "refresh_token",
        auth_version,
    )?;
    Ok(TokenPair {
        access_token,
        refresh_token,
    })
}

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

pub fn build_clear_auth_cookie_response() -> Result<Response<axum::body::Body>, AppError> {
    let secure = if CONFIG.secure_cookie { " Secure;" } else { "" };
    let access_cookie = format!(
        "access_token=;{} HttpOnly; SameSite=Strict; Max-Age=0; Path=/",
        secure
    );
    let refresh_cookie = format!(
        "refresh_token=;{} HttpOnly; SameSite=Strict; Max-Age=0; Path=/account/refresh",
        secure
    );
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(axum::body::Body::empty())
        .map_err(|_| AppError::InternalServerError)?;
    response.headers_mut().append(
        "Set-Cookie",
        HeaderValue::from_str(&access_cookie).map_err(|_| AppError::InternalServerError)?,
    );
    response.headers_mut().append(
        "Set-Cookie",
        HeaderValue::from_str(&refresh_cookie).map_err(|_| AppError::InternalServerError)?,
    );
    Ok(response)
}
pub fn verify_refresh_token(token: &str) -> Result<Token, jsonwebtoken::errors::Error> {
    let data = decode::<Token>(
        token,
        &DecodingKey::from_secret(CONFIG.secret_key.as_ref()),
        &Validation::default(),
    )?;
    if data.claims.token_type != "refresh_token" {
        return Err(jsonwebtoken::errors::Error::from(ErrorKind::InvalidToken));
    }
    Ok(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn initialize_test_config() {
        let values = [
            ("APP_TITLE", "GeoCode Test"),
            ("CREATEDATABASE_PATH", "./ci.sqlite"),
            ("DATABASE_URL", "sqlite:./ci.sqlite"),
            ("ACCESS_TOKEN_EXP_MINUTUES", "30"),
            ("REFRESH_TOKEN_EXP_MINUTUES", "1440"),
            ("SECRET_KEY", "test-secret-key-at-least-32-characters"),
            ("ADMIN_USERNAME", "admin"),
            ("ADMIN_PASSWORD", "test-password-123"),
            ("FAILED_ACCOUNT_LOCK", "5"),
            ("NEXT_CHALLENGE_MINUTES", "5"),
            ("CHALLENGE_LIMIT_TIME_FAILEDCOUNT", "3"),
            ("IMAGE_FILES_PATH", "./images"),
            ("UPLOAD_FILE_PATH", "./images"),
            ("CACHE_CONTROL", "no-store"),
            ("SECURE_COOKIE", "false"),
            ("SERVICE_NAME", "GeoCode Test"),
            ("ALLOW_USER_CREATE_ACCOUNT", "true"),
            ("ALLOW_USER_UPDATE_PASSWORD", "true"),
            ("ALLOW_ORIGINS", "http://localhost:5173"),
        ];
        unsafe {
            for (key, value) in values {
                std::env::set_var(key, value);
            }
        }
    }

    #[test]
    fn rejects_refresh_token_as_access_token() {
        initialize_test_config();
        let user_id = Uuid::now_v7().to_string();
        let token = create_token(&user_id, 5, "refresh_token", 0).unwrap();
        assert!(verify_access_token(&token).is_err());
    }

    #[test]
    fn rejects_access_token_as_refresh_token() {
        initialize_test_config();
        let user_id = Uuid::now_v7().to_string();
        let token = create_token(&user_id, 5, "access_token", 0).unwrap();
        assert!(verify_refresh_token(&token).is_err());
    }
}
