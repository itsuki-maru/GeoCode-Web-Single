//! 保存条件の文字列照合に必要な断片を、SQLite の LIKE と同じ規則で小文字化する。
use crate::error::AppError;
use axum::{
    Json,
    extract::Extension,
    http::{HeaderMap, header},
    response::IntoResponse,
};
use serde::Deserialize;
use sqlx::SqlitePool;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextFragments {
    fragments: Vec<String>,
}

pub async fn fold_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
    Json(request): Json<TextFragments>,
) -> Result<impl IntoResponse, AppError> {
    super::answer_map_presets::validate_optional_account(&user, &headers)?;
    if request.fragments.len() > 2048 || request.fragments.iter().any(|s| s.contains('\0')) {
        return Err(AppError::Validation("照合用の文字列が不正です。".into()));
    }
    let fragments =
        serde_json::to_string(&request.fragments).map_err(|_| AppError::InternalServerError)?;
    let folded = sqlx::query_scalar::<_, String>(
        "SELECT lower(value) FROM json_each($1) ORDER BY CAST(key AS INTEGER)",
    )
    .bind(fragments)
    .fetch_all(&pool)
    .await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(folded)))
}
