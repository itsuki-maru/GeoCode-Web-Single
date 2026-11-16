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
    #[error("{0}")]
    AiUpstream(String),
    #[error("{0}")]
    ServiceUnavailable(String),
    #[error("conflict")]
    Conflict,
    #[error(
        "同じ取り込み要求IDに異なるJSONファイルが指定されています。新しい取り込みとして実行してください。"
    )]
    IdempotencyConflict,
    #[error("ログイン中のアカウントが変わりました。画面を再読み込みしてから再試行してください。")]
    ImportAccountConflict,
    #[error("ai_account_changed")]
    AiAccountConflict,
    #[error("要求された操作は許可されていません。")]
    AiOperationNotAllowed,
    #[error("unauthorized error: {0}")]
    Unauthorized(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("bad request")]
    BadRequest,
    #[error("too many requests: {0}")]
    TooManyRequests(String),
}

#[derive(Serialize)]
struct ErrBody {
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

impl AppError {
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::Validation(_) => StatusCode::BAD_REQUEST,
            AppError::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::InternalServerError => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::BadGateway | AppError::AiUpstream(_) => StatusCode::BAD_GATEWAY,
            AppError::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            AppError::Conflict
            | AppError::IdempotencyConflict
            | AppError::ImportAccountConflict
            | AppError::AiAccountConflict => StatusCode::CONFLICT,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) | AppError::AiOperationNotAllowed => StatusCode::FORBIDDEN,
            AppError::Sqlx(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::BadRequest => StatusCode::BAD_REQUEST,
            AppError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
        }
    }

    fn client_message(&self) -> String {
        match self {
            // バリデーションはそのまま返却
            AppError::Validation(_)
            | AppError::PayloadTooLarge(_)
            | AppError::Unauthorized(_)
            | AppError::Forbidden(_)
            | AppError::IdempotencyConflict
            | AppError::ImportAccountConflict
            | AppError::AiAccountConflict
            | AppError::AiOperationNotAllowed
            | AppError::AiUpstream(_)
            | AppError::TooManyRequests(_) => self.to_string(),

            AppError::ServiceUnavailable(_) => self.to_string(),

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
            code: matches!(self, AppError::AiOperationNotAllowed)
                .then_some("ai_operation_not_allowed"),
        };
        (status, Json(body)).into_response()
    }
}
