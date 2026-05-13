use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("validation error: {0}")]
    Validation(String),
    #[error("payload too large: {0}")]
    PayloadTooLarge(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    #[error("internal server error")]
    InternalServerError,
    #[error("bad gateway")]
    BadGateway,
    #[error("conflict")]
    Conflict,
    #[error("unauthorized error: {0}")]
    Unauthorized(String),
    #[error("bad request")]
    BadRequest,
}

#[derive(Serialize)]
struct ErrBody {
    error: String,
}

impl AppError {
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::Validation(_) => StatusCode::BAD_REQUEST,
            AppError::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::InternalServerError => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::BadGateway => StatusCode::BAD_GATEWAY,
            AppError::Conflict => StatusCode::CONFLICT,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::Sqlx(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::BadRequest => StatusCode::BAD_REQUEST,
        }
    }

    fn client_message(&self) -> String {
        match self {
            // バリデーションはそのまま返却
            AppError::Validation(_) | AppError::PayloadTooLarge(_) | AppError::Unauthorized(_) => {
                self.to_string()
            },

            // 内部エラーは隠す
            AppError::Sqlx(_) => "database error".to_string(),
            AppError::InternalServerError | AppError::BadGateway => self.to_string(),

            // その他は enum の Display をそのまま
            AppError::NotFound | AppError::Conflict | AppError::BadRequest => self.to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let status = self.status_code();
        let body = ErrBody {
            error: self.client_message(),
        };
        (status, Json(body)).into_response()
    }
}
