//! ログイン中の所有者によるフォーム回答。公開設定とは独立し、保存処理は公開フォームと共通。
use super::*;
use sha2::{Digest, Sha256};

enum Form {
    Marker(PublicFormRow),
    Shape(ShapePublicFormRow),
}
impl Form {
    fn parts(&self) -> (&str, &str, &MarkerFormSchema, &Option<JsonValue>) {
        match self {
            Self::Marker(f) => (
                &f.form_title,
                &f.form_description,
                &f.form_schema.0,
                &f.source_form,
            ),
            Self::Shape(f) => (
                &f.form_title,
                &f.form_description,
                &f.form_schema.0,
                &f.source_form,
            ),
        }
    }
    fn token(&self) -> String {
        let (title, description, schema, source) = self.parts();
        let identity = match self {
            Self::Marker(f) => json!([f.marker_id, f.public_id, f.enabled, f.password_hash]),
            Self::Shape(f) => json!([f.shape_id, f.public_id, f.enabled, f.password_hash]),
        };
        format!(
            "{:x}",
            Sha256::digest(json!([identity, title, description, schema, source]).to_string())
        )
    }
}
async fn fetch(pool: &SqlitePool, user: &str, id: &str, shape: bool) -> Result<Form, AppError> {
    let form = if shape {
        let row = fetch_shape_owner_form(pool, user, id).await?;
        Form::Shape(fetch_shape_public_form(pool, &row.public_id.ok_or(AppError::NotFound)?).await?)
    } else {
        let row = fetch_owner_form(pool, user, id).await?;
        Form::Marker(fetch_public_form(pool, &row.public_id.ok_or(AppError::NotFound)?).await?)
    };
    if form.parts().2.fields.is_empty() {
        return Err(AppError::NotFound);
    }
    Ok(form)
}
async fn input(pool: &SqlitePool, user: &str, id: &str, shape: bool) -> Result<Response, AppError> {
    let form = fetch(pool, user, id, shape).await?;
    let (title, description, schema, source) = form.parts();
    // 対象・適用元ごとの最新1回答だけを採用する。過去回答の合成や本文の推測はしない。
    let query = if shape {
        r#"
        SELECT submitted_values, form_snapshot FROM shape_form_submission_model
        WHERE shape_id=$1 AND source_form->>'id' IS $2
        ORDER BY create_at COLLATE answer_time DESC,id DESC LIMIT 1
        "#
    } else {
        r#"
        SELECT submitted_values, form_snapshot FROM marker_form_submission_model
        WHERE marker_id=$1 AND source_form->>'id' IS $2
        ORDER BY create_at COLLATE answer_time DESC,id DESC LIMIT 1
        "#
    };
    let mut tx = super::super::answer_sqlite::begin_read(pool).await?;
    let latest: Option<(JsonValue, Option<JsonValue>)> = sqlx::query_as(query)
        .bind(id)
        .bind(
            source
                .as_ref()
                .and_then(|v| v.get("id"))
                .and_then(JsonValue::as_str),
        )
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    let mut values = serde_json::Map::new();
    if let Some((submitted, Some(snapshot))) = latest {
        if let Ok(old) = serde_json::from_value::<MarkerFormSchema>(snapshot["form_schema"].clone())
        {
            for field in &schema.fields {
                if field.field_type == "image"
                    || !old
                        .fields
                        .iter()
                        .any(|f| f.id == field.id && f.field_type == field.field_type)
                {
                    continue;
                }
                if let Some(value) = submitted.get(&field.id) {
                    // 選択肢が削除された値は引き継がない。
                    if matches!(field.field_type.as_str(), "select" | "radio")
                        && !value
                            .as_str()
                            .is_some_and(|s| field.choices.iter().any(|c| c == s))
                    {
                        continue;
                    }
                    values.insert(
                        field.id.clone(),
                        if field.field_type == "number" && value.is_number() {
                            JsonValue::String(value.to_string())
                        } else {
                            value.clone()
                        },
                    );
                }
            }
        }
    }
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "form_title":title,"form_description":description,"form_schema":schema,
            "config_token":form.token(),"values":values
        })),
    )
        .into_response())
}
async fn submit(
    pool: &SqlitePool,
    user: &str,
    id: &str,
    shape: bool,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    let form = fetch(pool, user, id, shape).await?;
    let (mut payload, images) = parse_marker_form_multipart(&mut multipart).await?;
    if payload.config_token.as_deref() != Some(form.token().as_str()) {
        return Err(AppError::Conflict);
    }
    let (title, _, schema, _) = form.parts();
    // ブラウザから文字列で受け取り、整数をf64へ変換せず既存のJSON数値経路へ渡す。
    for field in &schema.fields {
        if field.field_type == "number" {
            if let Some(JsonValue::String(raw)) = payload.values.get(&field.id) {
                if let Ok(JsonValue::Number(number)) = serde_json::from_str::<JsonValue>(raw.trim())
                {
                    payload
                        .values
                        .insert(field.id.clone(), JsonValue::Number(number));
                }
            }
        }
    }
    validate_submission_keys(schema, &payload.values)?;
    validate_uploaded_image_keys(schema, &images)?;
    let (values, markdown, prepared) =
        build_submission(schema, &payload.values, &images, title).await?;
    let saved = match &form {
        Form::Marker(f) => persist_submission(pool, f, &values, &markdown, &prepared, true).await,
        Form::Shape(f) => {
            persist_shape_submission(pool, f, &values, &markdown, &prepared, true).await
        },
    };
    let object = match saved {
        Ok(object) => object,
        Err(error) => {
            cleanup_images(&prepared).await;
            return Err(error);
        },
    };
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({"message":"フォームの回答を保存しました。", "object":object})),
    )
        .into_response())
}
pub async fn get_marker_input_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    input(&pool, &user, &id, false).await
}
pub async fn get_shape_input_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    input(&pool, &user, &id, true).await
}
pub async fn submit_marker_input_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
    multipart: Multipart,
) -> Result<Response, AppError> {
    submit(&pool, &user, &id, false, multipart).await
}
pub async fn submit_shape_input_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
    multipart: Multipart,
) -> Result<Response, AppError> {
    submit(&pool, &user, &id, true, multipart).await
}

pub(super) fn marker_token(f: &PublicFormRow) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            json!([
                [f.marker_id, f.public_id, f.enabled, f.password_hash],
                f.form_title,
                f.form_description,
                f.form_schema.0,
                f.source_form
            ])
            .to_string()
        )
    )
}
pub(super) fn shape_token(f: &ShapePublicFormRow) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            json!([
                [f.shape_id, f.public_id, f.enabled, f.password_hash],
                f.form_title,
                f.form_description,
                f.form_schema.0,
                f.source_form
            ])
            .to_string()
        )
    )
}
