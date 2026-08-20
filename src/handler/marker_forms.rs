use crate::config::CONFIG;
use crate::error::AppError;
use crate::model::{
    MarkerFormConfigResponse, MarkerFormConfigUpdate, MarkerFormField, MarkerFormSchema,
    MarkerFormSubmissionRequest, MarkerFormSubmissionResponse, ShapeFormConfigResponse,
};
use crate::shape_validation::validate_shape_geojson;
use crate::utils::ensure_dir;
use axum::{
    Json,
    extract::{Extension, Multipart, Path},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};
use bcrypt::{DEFAULT_COST, hash, verify};
use chrono::{NaiveDate, Utc};
use image::{GenericImageView, ImageReader, codecs::jpeg::JpegEncoder};
use serde_json::{Value as JsonValue, json};
use sqlx::{FromRow, sqlite::SqlitePool, types::Json as SqlJson};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;
use tera::{Context, Tera};
use tokio::{fs::File, io::AsyncWriteExt, sync::Mutex, task};
use uuid::Uuid;

const MAX_FIELDS: usize = 20;
const MAX_IMAGES: usize = 3;
const MAX_MULTIPART_IMAGE_BYTES: usize = 1_500_000;
const MAX_SUBMISSION_JSON_BYTES: usize = 64 * 1024;
const MAX_INPUT_IMAGE_DIMENSION: u32 = 4_096;
const MAX_STORED_IMAGE_DIMENSION: u32 = 1_600;
const MAX_STORED_IMAGE_BYTES: usize = 1_500_000;
const MAX_THUMBNAIL_BYTES: usize = 300_000;
const MAX_SUBMISSIONS_PER_MINUTE: i64 = 30;
const SHAPE_MEMO_MAX_LENGTH: usize = 10_000;
const JPEG_QUALITIES: &[u8] = &[82, 76, 70, 64, 58, 52];
const THUMBNAIL_QUALITIES: &[u8] = &[78, 70, 62, 54, 46];

#[derive(Debug, FromRow)]
struct OwnerFormRow {
    marker_id: String,
    marker_name: String,
    public_id: Option<String>,
    enabled: Option<bool>,
    form_title: Option<String>,
    form_description: Option<String>,
    form_schema: Option<SqlJson<MarkerFormSchema>>,
    is_password_protected: Option<bool>,
}

#[derive(Debug, FromRow)]
struct PublicFormRow {
    marker_id: String,
    owner_id: String,
    public_id: String,
    enabled: bool,
    form_title: String,
    form_description: String,
    form_schema: SqlJson<MarkerFormSchema>,
    password_hash: Option<String>,
}

#[derive(Debug, FromRow)]
struct ShapeOwnerFormRow {
    shape_id: String,
    shape_name: Option<String>,
    public_id: Option<String>,
    enabled: Option<bool>,
    form_title: Option<String>,
    form_description: Option<String>,
    form_schema: Option<SqlJson<MarkerFormSchema>>,
    is_password_protected: Option<bool>,
}

#[derive(Debug, FromRow)]
struct ShapePublicFormRow {
    shape_id: String,
    owner_id: String,
    public_id: String,
    enabled: bool,
    form_title: String,
    form_description: String,
    form_schema: SqlJson<MarkerFormSchema>,
    password_hash: Option<String>,
}

struct UploadedFormImage {
    filename: String,
    bytes: Vec<u8>,
}

struct PreparedImage {
    id: String,
    filename: String,
    unique_filename: String,
    final_path: PathBuf,
    thumb_path: PathBuf,
    bytes: Vec<u8>,
    thumb_bytes: Vec<u8>,
}

/// マーカー所有者向けに、現在の入力フォーム設定を取得する。
pub async fn get_marker_form_config_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(marker_id): Path<String>,
) -> Result<Json<MarkerFormConfigResponse>, AppError> {
    let row = fetch_owner_form(&pool, &user_id, &marker_id).await?;
    Ok(Json(owner_response(row)))
}

/// マーカー所有者が送信した設定を検証し、入力フォーム設定とパスワードを保存する。
pub async fn update_marker_form_config_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(marker_id): Path<String>,
    Json(payload): Json<MarkerFormConfigUpdate>,
) -> Result<Json<MarkerFormConfigResponse>, AppError> {
    validate_config(&payload)?;
    let current = fetch_owner_form(&pool, &user_id, &marker_id).await?;
    let existing_hash = sqlx::query_scalar::<_, Option<String>>(
        "SELECT password_hash FROM marker_form_config_model WHERE marker_id = $1",
    )
    .bind(&marker_id)
    .fetch_optional(&pool)
    .await?
    .flatten();

    let password_hash = resolve_password_hash(&payload, existing_hash).await?;
    let public_id = current
        .public_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = Utc::now().naive_utc();

    sqlx::query(
        r#"
        INSERT INTO marker_form_config_model (
            marker_id,
            public_id,
            enabled,
            form_title,
            form_description,
            form_schema,
            password_hash,
            create_at,
            update_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        ON CONFLICT (marker_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            form_title = EXCLUDED.form_title,
            form_description = EXCLUDED.form_description,
            form_schema = EXCLUDED.form_schema,
            password_hash = EXCLUDED.password_hash,
            update_at = EXCLUDED.update_at
        "#,
    )
    .bind(&marker_id)
    .bind(public_id)
    .bind(payload.enabled)
    .bind(payload.form_title.trim())
    .bind(payload.form_description.trim())
    .bind(SqlJson(&payload.form_schema))
    .bind(password_hash)
    .bind(now)
    .execute(&pool)
    .await?;

    let row = fetch_owner_form(&pool, &user_id, &marker_id).await?;
    Ok(Json(owner_response(row)))
}

/// マーカーの所有権を確認し、入力フォームの公開URLを新しいIDへ更新する。
pub async fn rotate_marker_form_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(marker_id): Path<String>,
) -> Result<Json<MarkerFormConfigResponse>, AppError> {
    fetch_owner_form(&pool, &user_id, &marker_id).await?;
    let result = sqlx::query(
        r#"
        UPDATE marker_form_config_model
        SET public_id = $1, update_at = $2
        WHERE marker_id = $3
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(Utc::now().naive_utc())
    .bind(&marker_id)
    .execute(&pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::Validation(
            "フォーム設定を保存してからURLを再発行してください。".into(),
        ));
    }
    let row = fetch_owner_form(&pool, &user_id, &marker_id).await?;
    Ok(Json(owner_response(row)))
}

/// 公開IDに対応する有効な入力フォームをHTMLで表示し、利用できない場合は404ページを返す。
pub async fn public_marker_form_get_handler(
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Path(public_id): Path<String>,
) -> Result<Response, AppError> {
    let row = match fetch_public_form(&pool, &public_id).await {
        Ok(row) if row.enabled => row,
        Ok(_) | Err(AppError::NotFound) => return render_marker_form_not_found(&tera).await,
        Err(error) => return Err(error),
    };

    let mut context = Context::new();
    context.insert("form_title", &row.form_title);
    context.insert("form_description", &row.form_description);
    context.insert("form_schema", &row.form_schema.0);
    context.insert("submission_path", &format!("/forms/{}", row.public_id));
    context.insert("is_password_protected", &row.password_hash.is_some());
    let tera = tera.lock().await;
    let rendered = tera.render("marker-form.html", &context).map_err(|error| {
        tracing::error!(%error, "marker form template render failed");
        AppError::InternalServerError
    })?;
    Ok(Html(rendered).into_response())
}

/// 図形所有者向けに、現在の入力フォーム設定を取得する。
pub async fn get_shape_form_config_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
) -> Result<Json<ShapeFormConfigResponse>, AppError> {
    Ok(Json(shape_owner_response(
        fetch_shape_owner_form(&pool, &user_id, &shape_id).await?,
    )))
}

/// 図形所有者が送信した設定を検証し、入力フォーム設定とパスワードを保存する。
pub async fn update_shape_form_config_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
    Json(payload): Json<MarkerFormConfigUpdate>,
) -> Result<Json<ShapeFormConfigResponse>, AppError> {
    validate_config(&payload)?;
    let current = fetch_shape_owner_form(&pool, &user_id, &shape_id).await?;
    let existing_hash = sqlx::query_scalar::<_, Option<String>>(
        "SELECT password_hash FROM shape_form_config_model WHERE shape_id = $1",
    )
    .bind(&shape_id)
    .fetch_optional(&pool)
    .await?
    .flatten();
    let password_hash = resolve_password_hash(&payload, existing_hash).await?;
    let public_id = current
        .public_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = Utc::now().naive_utc();
    sqlx::query(
        r#"
        INSERT INTO shape_form_config_model (
            shape_id, public_id, enabled, form_title, form_description,
            form_schema, password_hash, create_at, update_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        ON CONFLICT (shape_id) DO UPDATE SET
            enabled = excluded.enabled,
            form_title = excluded.form_title,
            form_description = excluded.form_description,
            form_schema = excluded.form_schema,
            password_hash = excluded.password_hash,
            update_at = excluded.update_at
        "#,
    )
    .bind(&shape_id)
    .bind(public_id)
    .bind(payload.enabled)
    .bind(payload.form_title.trim())
    .bind(payload.form_description.trim())
    .bind(SqlJson(&payload.form_schema))
    .bind(password_hash)
    .bind(now)
    .execute(&pool)
    .await?;
    Ok(Json(shape_owner_response(
        fetch_shape_owner_form(&pool, &user_id, &shape_id).await?,
    )))
}

/// 図形の所有権を確認し、入力フォームの公開URLを新しいIDへ更新する。
pub async fn rotate_shape_form_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
) -> Result<Json<ShapeFormConfigResponse>, AppError> {
    fetch_shape_owner_form(&pool, &user_id, &shape_id).await?;
    let result = sqlx::query(
        "UPDATE shape_form_config_model SET public_id = $1, update_at = $2 WHERE shape_id = $3",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(Utc::now().naive_utc())
    .bind(&shape_id)
    .execute(&pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::Validation(
            "フォーム設定を保存してからURLを再発行してください。".into(),
        ));
    }
    Ok(Json(shape_owner_response(
        fetch_shape_owner_form(&pool, &user_id, &shape_id).await?,
    )))
}

/// 公開IDに対応する有効な図形入力フォームをHTMLで表示する。
pub async fn public_shape_form_get_handler(
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Path(public_id): Path<String>,
) -> Result<Response, AppError> {
    if Uuid::parse_str(&public_id).is_err() {
        return render_marker_form_not_found(&tera).await;
    }
    let row = match fetch_shape_public_form(&pool, &public_id).await {
        Ok(row) if row.enabled => row,
        Ok(_) | Err(AppError::NotFound) => return render_marker_form_not_found(&tera).await,
        Err(error) => return Err(error),
    };
    let mut context = Context::new();
    context.insert("form_title", &row.form_title);
    context.insert("form_description", &row.form_description);
    context.insert("form_schema", &row.form_schema.0);
    context.insert(
        "submission_path",
        &format!("/shape-forms/{}", row.public_id),
    );
    context.insert("is_password_protected", &row.password_hash.is_some());
    let tera = tera.lock().await;
    let rendered = tera.render("marker-form.html", &context).map_err(|error| {
        tracing::error!(%error, "shape form template render failed");
        AppError::InternalServerError
    })?;
    Ok(Html(rendered).into_response())
}

/// 入力フォームへアクセスできない場合の404ページをnotfound.htmlから生成する。
async fn render_marker_form_not_found(tera: &Arc<Mutex<Tera>>) -> Result<Response, AppError> {
    let mut context = Context::new();
    context.insert("viewport_content", "1.0");
    context.insert("statuscode", "Not Found");
    context.insert(
        "message",
        "入力フォームが見つかりません。フォームが無効になったか、URLが変更された可能性があります。",
    );

    let tera = tera.lock().await;
    let rendered = tera.render("notfound.html", &context).map_err(|error| {
        tracing::error!(%error, "marker form not-found template render failed");
        AppError::InternalServerError
    })?;
    Ok((StatusCode::NOT_FOUND, Html(rendered)).into_response())
}

/// 公開フォームの投稿を検証し、画像と回答履歴を保存してマーカー本文へMarkdownを追記する。
pub async fn submit_marker_form_handler(
    Extension(pool): Extension<SqlitePool>,
    Path(public_id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<MarkerFormSubmissionResponse>, AppError> {
    let form = fetch_public_form(&pool, &public_id).await?;
    if !form.enabled {
        return Err(AppError::NotFound);
    }
    check_rate_limit(&pool, &form.marker_id).await?;
    let (payload, uploaded_images) = parse_marker_form_multipart(&mut multipart).await?;
    verify_submission_password(form.password_hash.as_deref(), payload.password.as_deref()).await?;

    let schema = &form.form_schema.0;
    validate_submission_keys(schema, &payload.values)?;
    validate_uploaded_image_keys(schema, &uploaded_images)?;

    let (submitted_values, rendered_markdown, prepared_images) =
        build_submission(schema, &payload.values, &uploaded_images, &form.form_title).await?;

    let result = persist_submission(
        &pool,
        &form,
        &submitted_values,
        &rendered_markdown,
        &prepared_images,
    )
    .await;
    if let Err(error) = result {
        cleanup_images(&prepared_images).await;
        return Err(error);
    }

    Ok(Json(MarkerFormSubmissionResponse {
        message: "送信が完了しました。".to_string(),
    }))
}

/// 公開図形フォームの投稿を検証し、図形メモへMarkdownを追記する。
pub async fn submit_shape_form_handler(
    Extension(pool): Extension<SqlitePool>,
    Path(public_id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<MarkerFormSubmissionResponse>, AppError> {
    let form = fetch_shape_public_form(&pool, &public_id).await?;
    if !form.enabled {
        return Err(AppError::NotFound);
    }
    check_shape_rate_limit(&pool, &form.shape_id).await?;
    let (payload, uploaded_images) = parse_marker_form_multipart(&mut multipart).await?;
    verify_submission_password(form.password_hash.as_deref(), payload.password.as_deref()).await?;
    let schema = &form.form_schema.0;
    validate_submission_keys(schema, &payload.values)?;
    validate_uploaded_image_keys(schema, &uploaded_images)?;
    let (submitted_values, rendered_markdown, prepared_images) =
        build_submission(schema, &payload.values, &uploaded_images, &form.form_title).await?;
    if let Err(error) = persist_shape_submission(
        &pool,
        &form,
        &submitted_values,
        &rendered_markdown,
        &prepared_images,
    )
    .await
    {
        cleanup_images(&prepared_images).await;
        return Err(error);
    }
    Ok(Json(MarkerFormSubmissionResponse {
        message: "送信が完了しました。".to_string(),
    }))
}

/// 検証済みの投稿値から、保存値・Markdown・保存前画像を生成する。
async fn build_submission(
    schema: &MarkerFormSchema,
    values: &HashMap<String, JsonValue>,
    uploaded_images: &HashMap<String, UploadedFormImage>,
    form_title: &str,
) -> Result<(JsonValue, String, Vec<PreparedImage>), AppError> {
    let mut processed_fields = HashMap::new();
    for field in &schema.fields {
        if field.field_type == "image" {
            if field.required && !uploaded_images.contains_key(&field.id) {
                return Err(required_error(field));
            }
            processed_fields.insert(field.id.clone(), (JsonValue::Null, None));
            continue;
        }
        let value = values.get(&field.id).unwrap_or(&JsonValue::Null);
        processed_fields.insert(
            field.id.clone(),
            process_non_image_field_value(field, value)?,
        );
    }
    let mut prepared_images = Vec::new();
    for field in schema
        .fields
        .iter()
        .filter(|field| field.field_type == "image")
    {
        let Some(uploaded) = uploaded_images.get(&field.id) else {
            continue;
        };
        let prepared = prepare_image(uploaded.bytes.clone(), uploaded.filename.clone()).await?;
        let url = format!("/static/images/{}", prepared.unique_filename);
        let rendered = format!("![{}]({})", escape_markdown(&field.label), url);
        processed_fields.insert(
            field.id.clone(),
            (
                json!({
                    "url": url,
                    "filename": prepared.filename,
                    "content_type": "image/jpeg",
                }),
                Some(rendered),
            ),
        );
        prepared_images.push(prepared);
    }
    let mut stored_values = serde_json::Map::new();
    let mut sections = Vec::new();
    for field in &schema.fields {
        let (stored, rendered) = processed_fields
            .remove(&field.id)
            .ok_or(AppError::InternalServerError)?;
        stored_values.insert(field.id.clone(), stored);
        if let Some(rendered) = rendered {
            sections.push(format!(
                "### {}\n\n{}",
                escape_markdown(&field.label),
                rendered
            ));
        }
    }
    Ok((
        JsonValue::Object(stored_values),
        format!(
            "\n\n---\n\n## フォーム投稿: {}\n\n{}",
            escape_markdown(form_title),
            sections.join("\n\n")
        ),
        prepared_images,
    ))
}

/// 容量確認、画像保存、回答履歴登録、マーカー追記を1つのDBトランザクションとして処理する。
async fn persist_submission(
    pool: &SqlitePool,
    form: &PublicFormRow,
    submitted_values: &JsonValue,
    rendered_markdown: &str,
    prepared_images: &[PreparedImage],
) -> Result<(), AppError> {
    let now = Utc::now().naive_utc();
    let mut tx = pool.begin().await?;

    // SQLiteの書き込みロックを先に取得し、同時投稿による容量上限の超過を防ぐ。
    let owner_locked = sqlx::query("UPDATE user_model SET id = id WHERE id = $1")
        .bind(&form.owner_id)
        .execute(&mut *tx)
        .await?;
    if owner_locked.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    let still_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT enabled FROM marker_form_config_model WHERE marker_id = $1",
    )
    .bind(&form.marker_id)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);
    if !still_enabled {
        return Err(AppError::NotFound);
    }

    let current_bytes = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(stored_bytes), 0) FROM marker_form_image_model WHERE owner_id = $1",
    )
    .bind(&form.owner_id)
    .fetch_one(&mut *tx)
    .await?;
    let incoming_bytes = prepared_images.iter().try_fold(0_i64, |total, image| {
        let image_bytes = i64::try_from(image.bytes.len().saturating_add(image.thumb_bytes.len()))
            .map_err(|_| AppError::InternalServerError)?;
        total
            .checked_add(image_bytes)
            .ok_or(AppError::InternalServerError)
    })?;
    if current_bytes.saturating_add(incoming_bytes) > CONFIG.marker_form_storage_quota_bytes {
        return Err(AppError::PayloadTooLarge(
            "入力フォームから保存できる画像容量の上限を超えています。".into(),
        ));
    }

    write_prepared_images(prepared_images).await?;

    for image in prepared_images {
        sqlx::query(
            r#"
            INSERT INTO image_model (
                id, user_id, filename, uuid_filename, create_at
            ) VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(&image.id)
        .bind(&form.owner_id)
        .bind(&image.filename)
        .bind(&image.unique_filename)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        let stored_bytes = i64::try_from(image.bytes.len().saturating_add(image.thumb_bytes.len()))
            .map_err(|_| AppError::InternalServerError)?;
        sqlx::query(
            r#"
            INSERT INTO marker_form_image_model (
                image_id, owner_id, stored_bytes, create_at
            ) VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(&image.id)
        .bind(&form.owner_id)
        .bind(stored_bytes)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        r#"
        INSERT INTO marker_form_submission_model (
            id, marker_id, submitted_values, rendered_markdown, create_at
        ) VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(Uuid::now_v7().to_string())
    .bind(&form.marker_id)
    .bind(SqlJson(submitted_values))
    .bind(rendered_markdown)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    let updated = sqlx::query(
        r#"
        UPDATE marker_info_model
        SET detail = detail || $1, update_at = $2
        WHERE id = $3 AND user_id = $4
        "#,
    )
    .bind(rendered_markdown)
    .bind(now)
    .bind(&form.marker_id)
    .bind(&form.owner_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    tx.commit().await?;
    Ok(())
}

/// 容量確認、画像保存、回答履歴登録、図形メモ追記を1つのDBトランザクションで処理する。
async fn persist_shape_submission(
    pool: &SqlitePool,
    form: &ShapePublicFormRow,
    submitted_values: &JsonValue,
    rendered_markdown: &str,
    prepared_images: &[PreparedImage],
) -> Result<(), AppError> {
    let now = Utc::now().naive_utc();
    let mut tx = pool.begin().await?;
    let owner_locked = sqlx::query("UPDATE user_model SET id = id WHERE id = $1")
        .bind(&form.owner_id)
        .execute(&mut *tx)
        .await?;
    if owner_locked.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let still_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT enabled FROM shape_form_config_model WHERE shape_id = $1",
    )
    .bind(&form.shape_id)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);
    if !still_enabled {
        return Err(AppError::NotFound);
    }
    let (shape_type, mut geojson) = sqlx::query_as::<_, (String, SqlJson<JsonValue>)>(
        "SELECT shape_type, geojson FROM shape_model WHERE id = $1 AND user_id = $2",
    )
    .bind(&form.shape_id)
    .bind(&form.owner_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(|(shape_type, geojson)| (shape_type, geojson.0))
    .ok_or(AppError::NotFound)?;
    let feature = geojson
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("保存されている図形情報が不正です。".into()))?;
    let properties_value = feature.entry("properties").or_insert_with(|| json!({}));
    if !properties_value.is_object() {
        *properties_value = json!({});
    }
    let properties = properties_value
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("保存されている図形情報が不正です。".into()))?;
    let current_memo = properties
        .get("memo")
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    let next_memo = format!("{current_memo}{rendered_markdown}");
    if next_memo.chars().count() > SHAPE_MEMO_MAX_LENGTH {
        return Err(AppError::PayloadTooLarge(
            "図形メモの上限10000文字を超えるため投稿できません。".into(),
        ));
    }
    properties.insert("memo".into(), JsonValue::String(next_memo));
    validate_shape_geojson(&shape_type, &geojson)?;

    let current_bytes = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(stored_bytes), 0) FROM marker_form_image_model WHERE owner_id = $1",
    )
    .bind(&form.owner_id)
    .fetch_one(&mut *tx)
    .await?;
    let incoming_bytes = prepared_images.iter().try_fold(0_i64, |total, image| {
        let image_bytes = i64::try_from(image.bytes.len().saturating_add(image.thumb_bytes.len()))
            .map_err(|_| AppError::InternalServerError)?;
        total
            .checked_add(image_bytes)
            .ok_or(AppError::InternalServerError)
    })?;
    if current_bytes.saturating_add(incoming_bytes) > CONFIG.marker_form_storage_quota_bytes {
        return Err(AppError::PayloadTooLarge(
            "入力フォームから保存できる画像容量の上限を超えています。".into(),
        ));
    }
    write_prepared_images(prepared_images).await?;
    for image in prepared_images {
        sqlx::query(
            "INSERT INTO image_model (id, user_id, filename, uuid_filename, create_at) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&image.id)
        .bind(&form.owner_id)
        .bind(&image.filename)
        .bind(&image.unique_filename)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let stored_bytes = i64::try_from(image.bytes.len().saturating_add(image.thumb_bytes.len()))
            .map_err(|_| AppError::InternalServerError)?;
        sqlx::query(
            "INSERT INTO marker_form_image_model (image_id, owner_id, stored_bytes, create_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(&image.id)
        .bind(&form.owner_id)
        .bind(stored_bytes)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO shape_form_submission_model (id, shape_id, submitted_values, rendered_markdown, create_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(&form.shape_id)
    .bind(SqlJson(submitted_values))
    .bind(rendered_markdown)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let updated = sqlx::query(
        "UPDATE shape_model SET geojson = $1, updated_at = $2 WHERE id = $3 AND user_id = $4",
    )
    .bind(SqlJson(&geojson))
    .bind(now)
    .bind(&form.shape_id)
    .bind(&form.owner_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    tx.commit().await?;
    Ok(())
}
/// 指定ユーザーが所有するマーカーと、その入力フォーム設定をデータベースから取得する。
async fn fetch_owner_form(
    pool: &SqlitePool,
    user_id: &str,
    marker_id: &str,
) -> Result<OwnerFormRow, AppError> {
    sqlx::query_as::<_, OwnerFormRow>(
        r#"
        SELECT
            m.id AS marker_id,
            m.marker_name,
            c.public_id,
            c.enabled,
            c.form_title,
            c.form_description,
            c.form_schema,
            (c.password_hash IS NOT NULL) AS is_password_protected
        FROM marker_info_model m
        LEFT JOIN marker_form_config_model c ON c.marker_id = m.id
        WHERE m.id = $1 AND m.user_id = $2
        "#,
    )
    .bind(marker_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

/// 公開IDに対応する入力フォーム、対象マーカー、所有者情報をデータベースから取得する。
async fn fetch_public_form(pool: &SqlitePool, public_id: &str) -> Result<PublicFormRow, AppError> {
    sqlx::query_as::<_, PublicFormRow>(
        r#"
        SELECT
            c.marker_id,
            m.user_id AS owner_id,
            c.public_id,
            c.enabled,
            c.form_title,
            c.form_description,
            c.form_schema,
            c.password_hash
        FROM marker_form_config_model c
        JOIN marker_info_model m ON m.id = c.marker_id
        WHERE c.public_id = $1
        "#,
    )
    .bind(public_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

/// 所有者向けのDB取得結果を、未設定時の既定値を補ったAPIレスポンスへ変換する。
fn owner_response(row: OwnerFormRow) -> MarkerFormConfigResponse {
    let public_path = row.public_id.map(|id| format!("/forms/{id}"));
    MarkerFormConfigResponse {
        marker_id: row.marker_id,
        enabled: row.enabled.unwrap_or(false),
        form_title: row.form_title.unwrap_or(row.marker_name),
        form_description: row.form_description.unwrap_or_default(),
        form_schema: row.form_schema.map(|schema| schema.0).unwrap_or_default(),
        is_password_protected: row.is_password_protected.unwrap_or(false),
        public_path,
    }
}

/// 指定ユーザーが所有する図形と、その入力フォーム設定を取得する。
async fn fetch_shape_owner_form(
    pool: &SqlitePool,
    user_id: &str,
    shape_id: &str,
) -> Result<ShapeOwnerFormRow, AppError> {
    sqlx::query_as::<_, ShapeOwnerFormRow>(
        r#"
        SELECT s.id AS shape_id, s.name AS shape_name, c.public_id, c.enabled,
               c.form_title, c.form_description, c.form_schema,
               (c.password_hash IS NOT NULL) AS is_password_protected
        FROM shape_model s
        LEFT JOIN shape_form_config_model c ON c.shape_id = s.id
        WHERE s.id = $1 AND s.user_id = $2
        "#,
    )
    .bind(shape_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

/// 公開IDに対応する図形入力フォームと所有者を取得する。
async fn fetch_shape_public_form(
    pool: &SqlitePool,
    public_id: &str,
) -> Result<ShapePublicFormRow, AppError> {
    sqlx::query_as::<_, ShapePublicFormRow>(
        r#"
        SELECT c.shape_id, s.user_id AS owner_id, c.public_id, c.enabled,
               c.form_title, c.form_description, c.form_schema, c.password_hash
        FROM shape_form_config_model c
        JOIN shape_model s ON s.id = c.shape_id
        WHERE c.public_id = $1
        "#,
    )
    .bind(public_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

/// 未設定時の既定値を補い、図形フォーム設定APIのレスポンスへ変換する。
fn shape_owner_response(row: ShapeOwnerFormRow) -> ShapeFormConfigResponse {
    ShapeFormConfigResponse {
        shape_id: row.shape_id,
        enabled: row.enabled.unwrap_or(false),
        form_title: row
            .form_title
            .unwrap_or_else(|| row.shape_name.unwrap_or_else(|| "図形入力フォーム".into())),
        form_description: row.form_description.unwrap_or_default(),
        form_schema: row.form_schema.map(|schema| schema.0).unwrap_or_default(),
        is_password_protected: row.is_password_protected.unwrap_or(false),
        public_path: row.public_id.map(|id| format!("/shape-forms/{id}")),
    }
}

/// フォーム全体の項目数、ID重複、画像項目数などの設定内容を検証する。
fn validate_config(payload: &MarkerFormConfigUpdate) -> Result<(), AppError> {
    if payload.form_title.trim().is_empty() || payload.form_title.chars().count() > 100 {
        return Err(AppError::Validation(
            "フォーム名は1〜100文字で入力してください。".into(),
        ));
    }
    if payload.form_description.chars().count() > 1000 {
        return Err(AppError::Validation(
            "説明は1000文字以内で入力してください。".into(),
        ));
    }
    if payload.form_schema.fields.len() > MAX_FIELDS
        || (payload.enabled && payload.form_schema.fields.is_empty())
    {
        return Err(AppError::Validation(
            "有効なフォームには1〜20件の入力項目が必要です。".into(),
        ));
    }

    let mut ids = HashSet::new();
    let mut image_count = 0;
    for field in &payload.form_schema.fields {
        validate_field(field)?;
        if !ids.insert(field.id.clone()) {
            return Err(AppError::Validation("項目IDが重複しています。".into()));
        }
        if field.field_type == "image" {
            image_count += 1;
        }
    }
    if image_count > MAX_IMAGES {
        return Err(AppError::Validation(
            "画像項目は3件以内にしてください。".into(),
        ));
    }
    Ok(())
}

/// フォーム項目のID、表示名、種類、選択肢、最大文字数を検証する。
fn validate_field(field: &MarkerFormField) -> Result<(), AppError> {
    let valid_id = !field.id.is_empty()
        && field.id.len() <= 40
        && field
            .id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
    if !valid_id {
        return Err(AppError::Validation(
            "項目IDは40文字以内の半角英数字とアンダースコアで指定してください。".into(),
        ));
    }
    if field.label.trim().is_empty() || field.label.chars().count() > 80 {
        return Err(AppError::Validation(
            "項目名は1〜80文字で入力してください。".into(),
        ));
    }
    let allowed = [
        "text", "textarea", "number", "date", "select", "radio", "checkbox", "image",
    ];
    if !allowed.contains(&field.field_type.as_str()) {
        return Err(AppError::Validation("未対応の入力項目形式です。".into()));
    }
    if matches!(field.field_type.as_str(), "select" | "radio") {
        if field.choices.is_empty() || field.choices.len() > 30 {
            return Err(AppError::Validation(
                "選択項目には1〜30件の選択肢が必要です。".into(),
            ));
        }
        if field
            .choices
            .iter()
            .any(|choice| choice.trim().is_empty() || choice.chars().count() > 100)
        {
            return Err(AppError::Validation(
                "選択肢は1〜100文字で入力してください。".into(),
            ));
        }
    }
    if field
        .max_length
        .is_some_and(|length| length == 0 || length > 5000)
    {
        return Err(AppError::Validation(
            "最大文字数は1〜5000で指定してください。".into(),
        ));
    }
    Ok(())
}

/// パスワードの更新方法に応じて、既存ハッシュの維持・削除・再生成を行う。
async fn resolve_password_hash(
    payload: &MarkerFormConfigUpdate,
    existing_hash: Option<String>,
) -> Result<Option<String>, AppError> {
    match payload.password_mode.as_str() {
        "" | "keep" => Ok(existing_hash),
        "clear" => Ok(None),
        "set" => {
            let password = payload.password.as_deref().unwrap_or("").trim();
            if !(4..=64).contains(&password.chars().count()) {
                return Err(AppError::Validation(
                    "フォームパスワードは4〜64文字で設定してください。".into(),
                ));
            }
            let password = password.to_owned();
            task::spawn_blocking(move || hash(password, DEFAULT_COST))
                .await
                .map_err(|_| AppError::InternalServerError)?
                .map(Some)
                .map_err(|_| AppError::InternalServerError)
        },
        _ => Err(AppError::Validation(
            "パスワードの更新方法が不正です。".into(),
        )),
    }
}

/// パスワード保護されたフォームへの投稿パスワードを検証する。
async fn verify_submission_password(
    password_hash: Option<&str>,
    password: Option<&str>,
) -> Result<(), AppError> {
    let Some(password_hash) = password_hash.map(str::to_owned) else {
        return Ok(());
    };
    let password = password.unwrap_or("");
    if password.chars().count() > 64 {
        return Err(AppError::Unauthorized(
            "フォームのパスワードが正しくありません。".into(),
        ));
    }
    let password = password.to_owned();
    let verified = task::spawn_blocking(move || verify(password, &password_hash))
        .await
        .map_err(|_| AppError::InternalServerError)?
        .unwrap_or(false);
    if verified {
        Ok(())
    } else {
        Err(AppError::Unauthorized(
            "フォームのパスワードが正しくありません。".into(),
        ))
    }
}

/// 図形フォーム用の固定時間枠カウンターを更新する。
async fn check_shape_rate_limit(pool: &SqlitePool, shape_id: &str) -> Result<(), AppError> {
    let attempt_count = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO shape_form_rate_limit_model (shape_id, window_started_at, attempt_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (shape_id) DO UPDATE SET
            attempt_count = CASE
                WHEN shape_form_rate_limit_model.window_started_at <= excluded.window_started_at - 60
                THEN 1 ELSE shape_form_rate_limit_model.attempt_count + 1
            END,
            window_started_at = CASE
                WHEN shape_form_rate_limit_model.window_started_at <= excluded.window_started_at - 60
                THEN excluded.window_started_at ELSE shape_form_rate_limit_model.window_started_at
            END
        RETURNING attempt_count
        "#,
    )
    .bind(shape_id)
    .bind(Utc::now().timestamp())
    .fetch_one(pool)
    .await?;
    if attempt_count > MAX_SUBMISSIONS_PER_MINUTE {
        return Err(AppError::TooManyRequests(
            "投稿が集中しています。しばらく待ってから再試行してください。".into(),
        ));
    }
    Ok(())
}

/// DB上の固定時間枠カウンターを更新し、全プロセスで投稿回数を共有制限する。
async fn check_rate_limit(pool: &SqlitePool, marker_id: &str) -> Result<(), AppError> {
    let attempt_count = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO marker_form_rate_limit_model (
            marker_id, window_started_at, attempt_count
        ) VALUES ($1, $2, 1)
        ON CONFLICT (marker_id) DO UPDATE SET
            attempt_count = CASE
                WHEN marker_form_rate_limit_model.window_started_at <= EXCLUDED.window_started_at - 60
                THEN 1
                ELSE marker_form_rate_limit_model.attempt_count + 1
            END,
            window_started_at = CASE
                WHEN marker_form_rate_limit_model.window_started_at <= EXCLUDED.window_started_at - 60
                THEN EXCLUDED.window_started_at
                ELSE marker_form_rate_limit_model.window_started_at
            END
        RETURNING attempt_count
        "#,
    )
    .bind(marker_id)
    .bind(Utc::now().timestamp())
    .fetch_one(pool)
    .await?;

    if attempt_count > MAX_SUBMISSIONS_PER_MINUTE {
        return Err(AppError::TooManyRequests(
            "投稿が集中しています。しばらく待ってから再試行してください。".into(),
        ));
    }
    Ok(())
}
/// multipart/form-dataから回答JSONと画像を読み取り、形式とサイズを検証する。
async fn parse_marker_form_multipart(
    multipart: &mut Multipart,
) -> Result<
    (
        MarkerFormSubmissionRequest,
        HashMap<String, UploadedFormImage>,
    ),
    AppError,
> {
    let mut submission = None;
    let mut uploaded_images = HashMap::new();

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest)?
    {
        let field_name = field.name().ok_or(AppError::BadRequest)?.to_string();

        if field_name == "submission" {
            if submission.is_some() {
                return Err(AppError::Validation("回答データが重複しています。".into()));
            }
            let bytes = read_multipart_field(
                &mut field,
                MAX_SUBMISSION_JSON_BYTES,
                "回答データは64KB以内にしてください。",
            )
            .await?;
            submission = Some(
                serde_json::from_slice::<MarkerFormSubmissionRequest>(&bytes)
                    .map_err(|_| AppError::Validation("回答データのJSONが不正です。".into()))?,
            );
            continue;
        }

        let Some(field_id) = field_name.strip_prefix("image__") else {
            return Err(AppError::Validation(
                "フォームに存在しないデータが送信されました。".into(),
            ));
        };
        if field_id.is_empty()
            || !field_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(AppError::Validation("画像項目IDが不正です。".into()));
        }
        if uploaded_images.len() >= MAX_IMAGES || uploaded_images.contains_key(field_id) {
            return Err(AppError::Validation(
                "画像項目が重複しているか、上限を超えています。".into(),
            ));
        }

        let filename = field.file_name().unwrap_or("form-image.jpg").to_string();
        let content_type = field.content_type().unwrap_or("").to_string();
        if !matches!(
            content_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp"
        ) {
            return Err(AppError::Validation(
                "JPEG、PNG、WebP画像のみ送信できます。".into(),
            ));
        }
        let bytes = read_multipart_field(
            &mut field,
            MAX_MULTIPART_IMAGE_BYTES,
            "縮小後の画像は1.5MB以内にしてください。",
        )
        .await?;
        uploaded_images.insert(field_id.to_string(), UploadedFormImage { filename, bytes });
    }

    let submission = submission
        .ok_or_else(|| AppError::Validation("回答データが送信されていません。".into()))?;
    Ok((submission, uploaded_images))
}

/// multipartの1フィールドを上限サイズまで分割して読み込む。
async fn read_multipart_field(
    field: &mut axum::extract::multipart::Field<'_>,
    max_bytes: usize,
    error_message: &'static str,
) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|_| AppError::BadRequest)? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(AppError::PayloadTooLarge(error_message.into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// 送信された画像の項目IDがフォーム定義内の画像項目と一致するか検証する。
fn validate_uploaded_image_keys(
    schema: &MarkerFormSchema,
    uploaded_images: &HashMap<String, UploadedFormImage>,
) -> Result<(), AppError> {
    let image_ids: HashSet<&str> = schema
        .fields
        .iter()
        .filter(|field| field.field_type == "image")
        .map(|field| field.id.as_str())
        .collect();
    if uploaded_images
        .keys()
        .any(|field_id| !image_ids.contains(field_id.as_str()))
    {
        return Err(AppError::Validation(
            "フォームに存在しない画像項目が送信されました。".into(),
        ));
    }
    Ok(())
}
/// 送信された回答の項目IDがフォーム定義に存在するか検証する。
fn validate_submission_keys(
    schema: &MarkerFormSchema,
    values: &HashMap<String, JsonValue>,
) -> Result<(), AppError> {
    let ids: HashSet<&str> = schema
        .fields
        .iter()
        .map(|field| field.id.as_str())
        .collect();
    if values.keys().any(|key| !ids.contains(key.as_str())) {
        return Err(AppError::Validation(
            "フォームに存在しない項目が送信されました。".into(),
        ));
    }
    Ok(())
}

/// 画像以外の項目を型ごとに検証し、保存用JSONと追記用Markdownへ変換する。
fn process_non_image_field_value(
    field: &MarkerFormField,
    value: &JsonValue,
) -> Result<(JsonValue, Option<String>), AppError> {
    if field.field_type == "checkbox" {
        let checked = match value {
            JsonValue::Null => false,
            JsonValue::Bool(checked) => *checked,
            _ => {
                return Err(AppError::Validation(format!(
                    "{}の値が不正です。",
                    field.label
                )));
            },
        };
        if field.required && !checked {
            return Err(required_error(field));
        }
        return Ok((
            JsonValue::Bool(checked),
            Some(if checked { "はい" } else { "いいえ" }.into()),
        ));
    }

    if let JsonValue::Number(number) = value {
        if field.field_type != "number" {
            return Err(AppError::Validation(format!(
                "{}の値が不正です。",
                field.label
            )));
        }
        let parsed = number
            .as_f64()
            .ok_or_else(|| AppError::Validation(format!("{}の数値が不正です。", field.label)))?;
        if !parsed.is_finite() {
            return Err(AppError::Validation(format!(
                "{}の数値が不正です。",
                field.label
            )));
        }
        return Ok((JsonValue::Number(number.clone()), Some(number.to_string())));
    }

    let raw = match value {
        JsonValue::Null => "",
        JsonValue::String(value) => value.trim(),
        _ => {
            return Err(AppError::Validation(format!(
                "{}の値が不正です。",
                field.label
            )));
        },
    };
    if field.required && raw.is_empty() {
        return Err(required_error(field));
    }
    if raw.is_empty() {
        return Ok((JsonValue::Null, None));
    }
    let max_length = field.max_length.unwrap_or_else(|| {
        if field.field_type == "textarea" {
            2000
        } else {
            200
        }
    });
    if raw.chars().count() > max_length {
        return Err(AppError::Validation(format!(
            "{}は{}文字以内で入力してください。",
            field.label, max_length
        )));
    }
    if matches!(field.field_type.as_str(), "select" | "radio")
        && !field.choices.iter().any(|choice| choice == raw)
    {
        return Err(AppError::Validation(format!(
            "{}の選択値が不正です。",
            field.label
        )));
    }
    if field.field_type == "number" {
        let parsed = raw.parse::<f64>().map_err(|_| {
            AppError::Validation(format!("{}には数値を入力してください。", field.label))
        })?;
        if !parsed.is_finite() {
            return Err(AppError::Validation(format!(
                "{}の数値が不正です。",
                field.label
            )));
        }
    }
    if field.field_type == "date" {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| {
            AppError::Validation(format!("{}には正しい日付を入力してください。", field.label))
        })?;
        return Ok((JsonValue::String(raw.to_string()), Some(raw.to_string())));
    }
    Ok((
        JsonValue::String(raw.to_string()),
        Some(escape_markdown(raw)),
    ))
}
/// 必須項目が未入力の場合に返すバリデーションエラーを生成する。
fn required_error(field: &MarkerFormField) -> AppError {
    AppError::Validation(format!("{}は必須項目です。", field.label))
}

/// 第三者の入力がMarkdown構文として解釈されないよう特殊文字をエスケープする。
fn escape_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '\\' | '`'
                | '*'
                | '_'
                | '{'
                | '}'
                | '['
                | ']'
                | '<'
                | '>'
                | '('
                | ')'
                | '#'
                | '+'
                | '-'
                | '.'
                | '!'
                | '|'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// 投稿画像をblockingスレッド上で検証・縮小し、保存前のJPEGデータを組み立てる。
async fn prepare_image(bytes: Vec<u8>, filename: String) -> Result<PreparedImage, AppError> {
    task::spawn_blocking(move || prepare_image_blocking(&bytes, &filename))
        .await
        .map_err(|_| AppError::InternalServerError)?
}

/// 投稿画像を最大1600pxへ縮小し、サイズ上限内の通常画像とサムネイルへ変換する。
fn prepare_image_blocking(bytes: &[u8], filename: &str) -> Result<PreparedImage, AppError> {
    if bytes.is_empty() || bytes.len() > MAX_MULTIPART_IMAGE_BYTES {
        return Err(AppError::PayloadTooLarge(
            "送信する画像は1.5MB以内にしてください。".into(),
        ));
    }

    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_INPUT_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_INPUT_IMAGE_DIMENSION);
    limits.max_alloc = Some(128 * 1024 * 1024);
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| AppError::Validation("画像形式を判定できません。".into()))?;
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| AppError::Validation("画像を読み込めません。".into()))?;
    let (width, height) = image.dimensions();
    let image = if width > MAX_STORED_IMAGE_DIMENSION || height > MAX_STORED_IMAGE_DIMENSION {
        image.thumbnail(MAX_STORED_IMAGE_DIMENSION, MAX_STORED_IMAGE_DIMENSION)
    } else {
        image
    };

    let encoded = encode_jpeg_with_limit(
        &image,
        JPEG_QUALITIES,
        MAX_STORED_IMAGE_BYTES,
        "変換後の画像が1.5MBを超えています。別の画像を選択してください。",
    )?;
    let thumbnail = image.thumbnail(450, 450);
    let thumb_encoded = encode_jpeg_with_limit(
        &thumbnail,
        THUMBNAIL_QUALITIES,
        MAX_THUMBNAIL_BYTES,
        "サムネイル画像の変換に失敗しました。",
    )?;

    let upload_id = Uuid::now_v7();
    let upload_id_string = upload_id.to_string();
    let sub_dir = &upload_id_string[0..5];
    let dir_path = PathBuf::from(&CONFIG.upload_file_path).join(sub_dir);
    let thumb_dir = dir_path.join("thumb");
    let unique_filename = format!("{upload_id}.jpg");
    let safe_filename: String = filename
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect();

    Ok(PreparedImage {
        id: Uuid::now_v7().to_string(),
        filename: if safe_filename.is_empty() {
            "form-image.jpg".into()
        } else {
            safe_filename
        },
        final_path: dir_path.join(&unique_filename),
        thumb_path: thumb_dir.join(&unique_filename),
        unique_filename,
        bytes: encoded,
        thumb_bytes: thumb_encoded,
    })
}

/// 指定した品質候補を順に試し、上限サイズ以内のJPEGデータを生成する。
fn encode_jpeg_with_limit(
    image: &image::DynamicImage,
    qualities: &[u8],
    max_bytes: usize,
    error_message: &'static str,
) -> Result<Vec<u8>, AppError> {
    for quality in qualities {
        let mut encoded = Vec::new();
        JpegEncoder::new_with_quality(&mut encoded, *quality)
            .encode_image(image)
            .map_err(|_| AppError::Validation("画像の変換に失敗しました。".into()))?;
        if encoded.len() <= max_bytes {
            return Ok(encoded);
        }
    }
    Err(AppError::PayloadTooLarge(error_message.into()))
}

/// 準備済み画像の通常ファイルとサムネイルをディスクへ保存する。
async fn write_prepared_images(images: &[PreparedImage]) -> Result<(), AppError> {
    for image in images {
        let dir_path = image
            .final_path
            .parent()
            .ok_or(AppError::InternalServerError)?;
        let thumb_dir = image
            .thumb_path
            .parent()
            .ok_or(AppError::InternalServerError)?;
        ensure_dir(dir_path)
            .await
            .map_err(|_| AppError::InternalServerError)?;
        ensure_dir(thumb_dir)
            .await
            .map_err(|_| AppError::InternalServerError)?;
        write_bytes(&image.final_path, &image.bytes).await?;
        write_bytes(&image.thumb_path, &image.thumb_bytes).await?;
    }
    Ok(())
}

/// 指定されたバイト列を新しいファイルとして書き込む。
async fn write_bytes(path: &PathBuf, bytes: &[u8]) -> Result<(), AppError> {
    let mut file = File::create(path)
        .await
        .map_err(|_| AppError::InternalServerError)?;
    file.write_all(bytes)
        .await
        .map_err(|_| AppError::InternalServerError)
}
/// トランザクション失敗時などに、準備済みの通常画像とサムネイルを削除する。
async fn cleanup_images(images: &[PreparedImage]) {
    for image in images {
        let _ = tokio::fs::remove_file(&image.final_path).await;
        let _ = tokio::fs::remove_file(&image.thumb_path).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 単体テストで使用する最小構成のフォーム項目を生成する。
    fn field(id: &str, field_type: &str) -> MarkerFormField {
        MarkerFormField {
            id: id.into(),
            label: "項目".into(),
            field_type: field_type.into(),
            required: false,
            max_length: None,
            choices: vec![],
        }
    }

    #[test]
    /// 回答のMarkdown特殊文字が安全にエスケープされることを確認する。
    fn markdown_from_answers_is_escaped() {
        assert_eq!(
            escape_markdown("# [x](javascript:alert(1))"),
            "\\# \\[x\\]\\(javascript:alert\\(1\\)\\)"
        );
    }

    #[test]
    /// 不正な項目IDと未対応の項目種類が拒否されることを確認する。
    fn rejects_invalid_field_ids_and_types() {
        let mut invalid_id = field("bad-id", "text");
        assert!(validate_field(&invalid_id).is_err());
        invalid_id.id = "valid_id".into();
        invalid_id.field_type = "html".into();
        assert!(validate_field(&invalid_id).is_err());
    }

    #[test]
    /// 選択形式の項目に選択肢が必須であることを確認する。
    fn select_requires_choices() {
        assert!(validate_field(&field("choice", "select")).is_err());
    }

    #[test]
    /// JSON数値をnumber項目だけで受け付け、他の項目では拒否することを確認する。
    fn json_number_is_only_accepted_for_number_fields() {
        let value = json!(20260801);
        assert!(process_non_image_field_value(&field("date", "date"), &value).is_err());
        assert!(process_non_image_field_value(&field("text", "text"), &value).is_err());

        let (stored, rendered) = process_non_image_field_value(&field("number", "number"), &value)
            .expect("number field should accept a JSON number");
        assert_eq!(stored, value);
        assert_eq!(rendered.as_deref(), Some("20260801"));
    }

    #[test]
    /// 大きな投稿画像が1600px以内へ縮小され、出力サイズ上限内になることを確認する。
    fn uploaded_image_is_resized_and_capped() {
        let source = image::DynamicImage::new_rgb8(2000, 1000);
        let mut input = Cursor::new(Vec::new());
        source
            .write_to(&mut input, image::ImageFormat::Png)
            .expect("test image should encode");

        let prepared = prepare_image_blocking(input.get_ref(), "large.png")
            .expect("test image should be prepared");
        let stored = image::load_from_memory(&prepared.bytes).expect("stored image should decode");
        assert_eq!(stored.dimensions(), (1600, 800));
        assert!(prepared.bytes.len() <= MAX_STORED_IMAGE_BYTES);
        assert!(prepared.thumb_bytes.len() <= MAX_THUMBNAIL_BYTES);
    }
}
