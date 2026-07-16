use crate::config::CONFIG;
use crate::error::AppError;
use crate::image::marker_icon::{MAX_MARKER_ICON_FILE_SIZE_BYTES, process_marker_icon};
use crate::model::{
    MarkerIconData, MarkerIconDeleteResponse, MarkerIconDeleted, MarkerIconSearchParams,
    MarkerIconUploadResponse,
};
use crate::utils::ensure_dir;
use axum::{
    Json,
    extract::{Extension, Path, Query},
};
use chrono::Utc;
use sqlx::sqlite::SqlitePool;
use std::path::{Path as StdPath, PathBuf};
use uuid::Uuid;

fn marker_icons_dir() -> PathBuf {
    PathBuf::from(&CONFIG.images_path).join("marker-icons")
}

fn escape_like_query(query: &str) -> String {
    let mut escaped = String::new();
    for ch in query.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    format!("%{}%", escaped)
}

fn validate_original_filename(filename: &str) -> Result<(), AppError> {
    if filename.is_empty() || filename.chars().count() > 100 {
        return Err(AppError::Validation(
            "marker icon filename must be between 1 and 100 characters".to_string(),
        ));
    }
    let extension = StdPath::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(AppError::Validation(
            "marker icon must be PNG, JPEG, GIF, or WebP".to_string(),
        ));
    }
    Ok(())
}

pub async fn get_marker_icons_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<Vec<MarkerIconData>>, AppError> {
    let icons = sqlx::query_as::<_, MarkerIconData>(
        r#"
        SELECT
            id,
            user_id,
            filename,
            uuid_filename
        FROM marker_icon_model
        WHERE user_id = $1
        ORDER BY create_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(icons))
}

pub async fn search_marker_icons_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(params): Query<MarkerIconSearchParams>,
) -> Result<Json<Vec<MarkerIconData>>, AppError> {
    let query = escape_like_query(params.query.trim());
    let icons = sqlx::query_as::<_, MarkerIconData>(
        r#"
        SELECT
            id,
            user_id,
            filename,
            uuid_filename
        FROM marker_icon_model
        WHERE user_id = $1 AND filename ILIKE $2 ESCAPE '\'
        ORDER BY create_at DESC
        "#,
    )
    .bind(user_id)
    .bind(query)
    .fetch_all(&pool)
    .await?;
    Ok(Json(icons))
}

pub async fn upload_marker_icon_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    mut payload: axum::extract::Multipart,
) -> Result<Json<MarkerIconUploadResponse>, AppError> {
    let mut field = payload
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest)?
        .ok_or(AppError::BadRequest)?;
    if field.name() != Some("upload_file") {
        return Err(AppError::BadRequest);
    }
    let original_filename = field.file_name().unwrap_or_default().to_string();
    validate_original_filename(&original_filename)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|_| AppError::BadRequest)? {
        if bytes.len() + chunk.len() > MAX_MARKER_ICON_FILE_SIZE_BYTES {
            return Err(AppError::PayloadTooLarge(
                "marker icon must be 5MB or smaller".to_string(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let png = process_marker_icon(&bytes)?;
    let icon_id = Uuid::now_v7().to_string();
    let uuid_filename = format!("{}.png", Uuid::now_v7());
    let directory = marker_icons_dir();
    ensure_dir(&directory)
        .await
        .map_err(|_| AppError::InternalServerError)?;
    let file_path = directory.join(&uuid_filename);
    tokio::fs::write(&file_path, png)
        .await
        .map_err(|_| AppError::InternalServerError)?;

    let insert_result = sqlx::query(
        r#"
        INSERT INTO marker_icon_model
        (id, user_id, filename, uuid_filename, create_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(&icon_id)
    .bind(&user_id)
    .bind(&original_filename)
    .bind(&uuid_filename)
    .bind(Utc::now().naive_utc())
    .execute(&pool)
    .await;
    if let Err(error) = insert_result {
        let _ = tokio::fs::remove_file(file_path).await;
        return Err(AppError::Sqlx(error));
    }

    Ok(Json(MarkerIconUploadResponse {
        id: icon_id,
        user_id,
        filename: original_filename,
        uuid_filename,
    }))
}

pub async fn delete_marker_icon_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(icon_id): Path<String>,
) -> Result<Json<MarkerIconDeleteResponse>, AppError> {
    let deleted = sqlx::query_as::<_, MarkerIconDeleted>(
        r#"
        DELETE FROM marker_icon_model
        WHERE id = $1 AND user_id = $2
        RETURNING id, uuid_filename
        "#,
    )
    .bind(icon_id)
    .bind(user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let file_path = marker_icons_dir().join(&deleted.uuid_filename);
    if let Err(error) = tokio::fs::remove_file(file_path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %error, "failed to delete marker icon file");
        }
    }
    Ok(Json(MarkerIconDeleteResponse {
        id: deleted.id,
        message: "Marker icon deleted.".to_string(),
    }))
}
