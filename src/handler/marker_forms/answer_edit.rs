//! Owner-only correction of an existing answer and its managed body projection.
use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum BodyPart {
    Text { text: String },
    Answer { id: String },
}

#[derive(Clone, FromRow)]
struct Answer {
    id: String,
    target_id: String,
    submitted_values: JsonValue,
    form_snapshot: Option<JsonValue>,
    rendered_markdown: String,
    revision: i64,
    edited_at: Option<chrono::NaiveDateTime>,
}

#[derive(FromRow)]
struct PopupAnswer {
    id: String,
    target_id: String,
    rendered_markdown: String,
}

// Body matching needs only these references, including for full editing rows.
trait AnswerText {
    fn id(&self) -> &str;
    fn rendered_markdown(&self) -> &str;
}
impl AnswerText for Answer {
    fn id(&self) -> &str {
        &self.id
    }
    fn rendered_markdown(&self) -> &str {
        &self.rendered_markdown
    }
}
impl AnswerText for PopupAnswer {
    fn id(&self) -> &str {
        &self.id
    }
    fn rendered_markdown(&self) -> &str {
        &self.rendered_markdown
    }
}

pub(crate) struct Document {
    pub body: String,
    pub parts: Option<Vec<BodyPart>>,
    answers: Vec<Answer>,
    target: String,
}
fn table(kind: &str) -> Result<&'static str, AppError> {
    match kind {
        "marker" => Ok("marker_info_model"),
        "shape" => Ok("shape_model"),
        _ => Err(AppError::NotFound),
    }
}
fn invalid(text: &str) -> AppError {
    AppError::Validation(text.into())
}

// Text matching is used only to adopt unambiguous legacy data. Afterwards the
// persisted structure, rather than matching strings, identifies each answer.
fn adopt(body: &str, answers: &[impl AnswerText]) -> Option<Vec<BodyPart>> {
    let mut matches = Vec::new();
    for answer in answers {
        if answer.rendered_markdown().is_empty() {
            return None;
        }
        let positions: Vec<_> = body
            .match_indices(answer.rendered_markdown())
            .take(2)
            .collect();
        if positions.len() != 1 {
            return None;
        }
        matches.push((positions[0].0, answer));
    }
    matches.sort_by_key(|(offset, _)| *offset);
    let mut parts = Vec::new();
    let mut cursor = 0;
    for (offset, answer) in matches {
        if offset < cursor {
            return None;
        }
        parts.push(BodyPart::Text {
            text: body[cursor..offset].into(),
        });
        parts.push(BodyPart::Answer {
            id: answer.id().to_owned(),
        });
        cursor = offset + answer.rendered_markdown().len();
    }
    parts.push(BodyPart::Text {
        text: body[cursor..].into(),
    });
    Some(parts)
}
fn render(parts: &[BodyPart], answers: &[impl AnswerText]) -> Option<String> {
    let by_id: HashMap<_, _> = answers
        .iter()
        .map(|a| (a.id(), a.rendered_markdown()))
        .collect();
    let mut used = HashSet::new();
    let mut body = String::new();
    for part in parts {
        match part {
            BodyPart::Text { text } => body.push_str(text),
            BodyPart::Answer { id } => {
                if !used.insert(id.as_str()) {
                    return None;
                }
                body.push_str(by_id.get(id.as_str())?);
            },
        }
    }
    (used.len() == answers.len()).then_some(body)
}
fn token(doc: &Document) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            json!([
                doc.target,
                doc.body,
                doc.parts,
                doc.answers
                    .iter()
                    .map(|a| json!([a.id, a.revision, a.rendered_markdown]))
                    .collect::<Vec<_>>()
            ])
            .to_string()
        )
    )
}
fn free_text(parts: &[BodyPart]) -> String {
    parts
        .iter()
        .filter_map(|p| match p {
            BodyPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}
fn replace_free(parts: &[BodyPart], text: &str) -> Vec<BodyPart> {
    if free_text(parts) == text {
        return parts.to_vec();
    }
    let mut result = parts.to_vec();
    let mut first = true;
    for part in &mut result {
        if let BodyPart::Text { text: old } = part {
            *old = if first { text.into() } else { String::new() };
            first = false;
        }
    }
    if first {
        result.insert(0, BodyPart::Text { text: text.into() });
    }
    result
}
async fn answer(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    id: &str,
) -> Result<Answer, AppError> {
    let object_table = table(kind)?;
    sqlx::query_as(&format!("SELECT s.id,s.{kind}_id AS target_id,s.submitted_values,s.form_snapshot,s.rendered_markdown,s.revision,s.edited_at FROM {kind}_form_submission_model s JOIN {object_table} o ON o.id=s.{kind}_id WHERE s.id=$1 AND o.user_id=$2"))
        .bind(id).bind(user).fetch_optional(&mut **tx).await?.ok_or(AppError::NotFound)
}
pub(crate) async fn document(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    target: &str,
) -> Result<Document, AppError> {
    let object_table = table(kind)?;
    let column = if kind == "marker" {
        "detail"
    } else {
        "COALESCE(geojson->'properties'->>'memo','')"
    };
    let (body, stored): (String, Option<SqlJson<Vec<BodyPart>>>) = sqlx::query_as(&format!(
        "SELECT {column},form_body_parts FROM {object_table} WHERE id=$1 AND user_id=$2"
    ))
    .bind(target)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let answers: Vec<Answer> = sqlx::query_as(&format!("SELECT id,{kind}_id AS target_id,submitted_values,form_snapshot,rendered_markdown,revision,edited_at FROM {kind}_form_submission_model WHERE {kind}_id=$1 ORDER BY create_at COLLATE answer_time,id"))
        .bind(target).fetch_all(&mut **tx).await?;
    let parts = match stored {
        Some(parts) if render(&parts.0, &answers).as_deref() == Some(&body) => Some(parts.0),
        Some(_) => None,
        None => adopt(&body, &answers),
    };
    Ok(Document {
        body,
        parts,
        answers,
        target: target.to_owned(),
    })
}
fn info(doc: &Document) -> JsonValue {
    json!({ "body":doc.body,"body_token":token(doc),"sync_required":doc.parts.is_none(),
        "free_text":doc.parts.as_ref().map(|p|free_text(p)).unwrap_or_default(),
        "managed_markdown":doc.answers.iter().map(|a|a.rendered_markdown.as_str()).collect::<String>(),
        "parts":doc.parts.as_ref().map(|parts| parts.iter().map(|p| match p {
            BodyPart::Text {text} => json!({"type":"text","text":text}),
            BodyPart::Answer {id} => json!({"type":"answer","id":id,"markdown":doc.answers.iter().find(|a|a.id==*id).map(|a|&a.rendered_markdown)}),
        }).collect::<Vec<_>>()).unwrap_or_default() })
}

/// Read-only popup projections for an already authorized map snapshot. Four
/// bounded queries cover every object; no per-object queries or writes occur.
pub(crate) async fn popup_bodies(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    targets: &[(&str, String, String)],
) -> Result<HashMap<String, JsonValue>, AppError> {
    let mut result = HashMap::new();
    for kind in ["marker", "shape"] {
        let ids: Vec<String> = targets
            .iter()
            .filter(|(k, _, _)| *k == kind)
            .map(|(_, id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            continue;
        }
        let stored: Vec<(String, Option<SqlJson<Vec<BodyPart>>>)> = sqlx::query_as(&format!(
            "SELECT id,form_body_parts FROM {} WHERE user_id=$1 AND id IN (SELECT value FROM json_each($2))",
            table(kind)?
        ))
        .bind(user)
        .bind(SqlJson(&ids))
        .fetch_all(&mut **tx)
        .await?;
        let mut by_target: HashMap<String, Vec<PopupAnswer>> = HashMap::new();
        let answers: Vec<PopupAnswer> = sqlx::query_as(&format!(
            "SELECT s.id,s.{kind}_id AS target_id,s.rendered_markdown FROM {kind}_form_submission_model s JOIN {} m ON m.id=s.{kind}_id WHERE m.user_id=$1 AND m.id IN (SELECT value FROM json_each($2)) ORDER BY s.create_at COLLATE answer_time,s.id", table(kind)?
        )).bind(user).bind(SqlJson(&ids)).fetch_all(&mut **tx).await?;
        for answer in answers {
            by_target
                .entry(answer.target_id.clone())
                .or_default()
                .push(answer);
        }
        let bodies: HashMap<String, &str> = targets
            .iter()
            .filter(|(k, _, _)| *k == kind)
            .map(|(_, id, body)| (id.clone(), body.as_str()))
            .collect();
        for (id, stored) in stored {
            let body = bodies[&id];
            let answers = by_target.remove(&id).unwrap_or_default();
            let parts = match stored {
                Some(parts) if render(&parts.0, &answers).as_deref() == Some(body) => Some(parts.0),
                Some(_) => None,
                None => adopt(body, &answers),
            };
            result.insert(format!("{kind}:{id}"), json!({
                "free_text":parts.as_ref().map(|p|free_text(p)).unwrap_or_default(),
                "managed_markdown":answers.iter().map(|a|a.rendered_markdown.as_str()).collect::<String>(),
                "sync_required":parts.is_none()
            }));
        }
    }
    Ok(result)
}
pub(crate) async fn store_parts(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    target: &str,
    parts: Option<&[BodyPart]>,
) -> Result<(), AppError> {
    let object_table = table(kind)?;
    sqlx::query(&format!(
        "UPDATE {object_table} SET form_body_parts=$1 WHERE id=$2 AND user_id=$3"
    ))
    .bind(parts.map(SqlJson))
    .bind(target)
    .bind(user)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
pub(crate) async fn append_parts(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    target: &str,
    mut parts: Option<Vec<BodyPart>>,
    id: &str,
) -> Result<(), AppError> {
    if let Some(p) = &mut parts {
        p.push(BodyPart::Answer { id: id.to_owned() });
    }
    store_parts(tx, user, kind, target, parts.as_deref()).await
}

// The normal object API may update free text, but cannot change the projection
// of structured answers. Older clients may still send an unchanged full body.
pub(crate) async fn normal_body(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    target: &str,
    requested: &str,
    free: Option<&str>,
    expected: Option<&str>,
) -> Result<String, AppError> {
    let doc = document(tx, user, kind, target).await?;
    let parts = if let Some(free) = free {
        if expected != Some(token(&doc).as_str()) {
            return Err(AppError::Conflict);
        }
        replace_free(
            doc.parts.as_ref().ok_or_else(|| {
                invalid(
                    "本文・メモと回答の対応確認が必要です。回答一覧から回答を編集してください。",
                )
            })?,
            free,
        )
    } else if requested == doc.body {
        store_parts(tx, user, kind, target, doc.parts.as_deref()).await?;
        return Ok(doc.body);
    } else {
        let next = adopt(requested, &doc.answers)
            .ok_or_else(|| invalid("フォーム由来の内容は回答一覧から編集してください。"))?;
        let ids = |p: &[BodyPart]| {
            p.iter()
                .filter_map(|p| match p {
                    BodyPart::Answer { id } => Some(id.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        if let Some(old) = &doc.parts {
            if ids(old) != ids(&next) {
                return Err(invalid("フォーム回答の並び順は変更できません。"));
            }
        }
        next
    };
    let body = render(&parts, &doc.answers).ok_or(AppError::Conflict)?;
    store_parts(tx, user, kind, target, Some(&parts)).await?;
    Ok(body)
}
async fn write_body(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    target: &str,
    body: &str,
    parts: &[BodyPart],
) -> Result<JsonValue, AppError> {
    if kind == "marker" {
        let object = sqlx::query_as::<_, crate::model::MarkerObject>("UPDATE marker_info_model SET detail=$1,form_body_parts=$2,update_at=$3 WHERE id=$4 AND user_id=$5 RETURNING id,layer_id,marker_name,latitude,longitude,detail,update_at")
            .bind(body).bind(SqlJson(parts)).bind(Utc::now().naive_utc()).bind(target).bind(user).fetch_one(&mut **tx).await?;
        return serde_json::to_value(object).map_err(|_| AppError::InternalServerError);
    }
    let (shape_type, mut geojson): (String, JsonValue) =
        sqlx::query_as("SELECT shape_type,geojson FROM shape_model WHERE id=$1 AND user_id=$2")
            .bind(target)
            .bind(user)
            .fetch_one(&mut **tx)
            .await?;
    if body.chars().count() > SHAPE_MEMO_MAX_LENGTH {
        return Err(AppError::PayloadTooLarge(
            "図形メモは10000文字以内にしてください。".into(),
        ));
    }
    let feature = geojson.as_object_mut().ok_or(AppError::BadRequest)?;
    let properties = feature.entry("properties").or_insert_with(|| json!({}));
    if !properties.is_object() {
        *properties = json!({});
    }
    properties["memo"] = json!(body);
    validate_shape_geojson(&shape_type, &geojson)?;
    let object = sqlx::query_as::<_, crate::model::ShapeObject>("UPDATE shape_model SET geojson=$1,form_body_parts=$2,updated_at=$3 WHERE id=$4 AND user_id=$5 RETURNING id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at")
        .bind(SqlJson(geojson)).bind(SqlJson(parts)).bind(Utc::now().naive_utc()).bind(target).bind(user).fetch_one(&mut **tx).await?;
    serde_json::to_value(object).map_err(|_| AppError::InternalServerError)
}
async fn begin_read(pool: &SqlitePool) -> Result<Transaction<'_, Sqlite>, AppError> {
    Ok(super::super::answer_sqlite::begin_read(pool).await?)
}
pub async fn marker_body_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    body_handler(&user, pool, &id, "marker").await
}
pub async fn shape_body_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    body_handler(&user, pool, &id, "shape").await
}
async fn body_handler(
    user: &str,
    pool: SqlitePool,
    id: &str,
    kind: &str,
) -> Result<Response, AppError> {
    let mut tx = begin_read(&pool).await?;
    let doc = document(&mut tx, user, kind, id).await?;
    let data = info(&doc);
    tx.commit().await?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(data),
    )
        .into_response())
}
fn editable_schema(a: &Answer) -> Result<MarkerFormSchema, AppError> {
    let snapshot = a
        .form_snapshot
        .as_ref()
        .ok_or_else(|| invalid("投稿時のフォーム定義がないため、この回答は編集できません。"))?;
    let schema: MarkerFormSchema = serde_json::from_value(snapshot["form_schema"].clone())
        .map_err(|_| invalid("投稿時のフォーム定義が不正です。"))?;
    let values = a.submitted_values.as_object().ok_or(AppError::BadRequest)?;
    if schema.fields.is_empty()
        || values
            .keys()
            .any(|id| !schema.fields.iter().any(|field| field.id == *id))
    {
        return Err(invalid(
            "投稿時のフォーム定義が不足しているため、この回答は編集できません。",
        ));
    }
    Ok(schema)
}
pub async fn get_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let mut tx = begin_read(&pool).await?;
    let a = answer(&mut tx, &user, &kind, &id).await?;
    editable_schema(&a)?;
    let snapshot = a
        .form_snapshot
        .as_ref()
        .ok_or_else(|| invalid("投稿時のフォーム定義がないため、この回答は編集できません。"))?;
    let doc = document(&mut tx, &user, &kind, &a.target_id).await?;
    let mut display_values = a.submitted_values.clone();
    if let Some(fields) = snapshot
        .get("form_schema")
        .and_then(|s| s.get("fields"))
        .and_then(JsonValue::as_array)
    {
        for field in fields {
            if field.get("type").and_then(JsonValue::as_str) == Some("number") {
                if let Some(id) = field.get("id").and_then(JsonValue::as_str) {
                    if let Some(value) = display_values.get_mut(id) {
                        if value.is_number() {
                            *value = JsonValue::String(value.to_string());
                        }
                    }
                }
            }
        }
    }
    let data = json!({"id":id,"target_id":a.target_id,"target_type":kind,"revision":a.revision,"edited_at":a.edited_at,
        "form_title":snapshot["form_title"],"form_description":snapshot["form_description"],"form_schema":snapshot["form_schema"],"values":display_values,"body_info":info(&doc)});
    tx.commit().await?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(data),
    )
        .into_response())
}

fn image_markdown(field: &MarkerFormField, value: &JsonValue) -> Result<Option<String>, AppError> {
    if value.is_null() {
        return if field.required {
            Err(required_error(field))
        } else {
            Ok(None)
        };
    }
    let url = value
        .get("url")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid("保存済み画像の参照が不正です。"))?;
    let safe = url.starts_with("/static/images/")
        || reqwest::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"));
    if !safe {
        return Err(invalid("保存済み画像の参照が不正です。"));
    }
    Ok(Some(format!(
        "![{}]({})",
        escape_markdown(&field.label),
        url.replace('(', "%28")
            .replace(')', "%29")
            .replace('\n', "%0A")
            .replace('\r', "%0D")
    )))
}
async fn build_edit(
    a: &Answer,
    payload: &mut MarkerFormSubmissionRequest,
    uploads: &HashMap<String, UploadedFormImage>,
) -> Result<(JsonValue, String, Vec<PreparedImage>), AppError> {
    let snapshot = a
        .form_snapshot
        .as_ref()
        .ok_or_else(|| invalid("投稿時のフォーム定義がないため、この回答は編集できません。"))?;
    let schema = editable_schema(a)?;
    let title = snapshot["form_title"]
        .as_str()
        .ok_or(AppError::BadRequest)?;
    validate_submission_keys(&schema, &payload.values)?;
    validate_uploaded_image_keys(&schema, uploads)?;
    for (id, action) in &payload.image_actions {
        if !schema
            .fields
            .iter()
            .any(|f| f.id == *id && f.field_type == "image")
            || !matches!(action.as_str(), "keep" | "replace" | "remove")
        {
            return Err(invalid("画像の操作が不正です。"));
        }
    }
    for f in &schema.fields {
        if f.field_type == "number" {
            if let Some(JsonValue::String(raw)) = payload.values.get(&f.id) {
                if !raw.trim().is_empty() {
                    let n: JsonValue = serde_json::from_str(raw.trim())
                        .map_err(|_| invalid("数値が不正です。"))?;
                    if !n.is_number() {
                        return Err(invalid("数値が不正です。"));
                    }
                    payload.values.insert(f.id.clone(), n);
                }
            }
        }
        if f.field_type == "image" {
            let action = payload
                .image_actions
                .get(&f.id)
                .map(String::as_str)
                .unwrap_or(if uploads.contains_key(&f.id) {
                    "replace"
                } else {
                    "keep"
                });
            if (action == "replace") != uploads.contains_key(&f.id) {
                return Err(invalid("画像の操作と添付ファイルが一致しません。"));
            }
        }
    }
    let mut loose = schema.clone();
    for f in &mut loose.fields {
        if f.field_type == "image" {
            f.required = false;
        }
    }
    let (mut values, _, prepared) =
        build_submission(&loose, &payload.values, uploads, title).await?;
    let result = (|| {
        let mut sections = Vec::new();
        for f in &schema.fields {
            let rendered = if f.field_type == "image" {
                let action = payload
                    .image_actions
                    .get(&f.id)
                    .map(String::as_str)
                    .unwrap_or(if uploads.contains_key(&f.id) {
                        "replace"
                    } else {
                        "keep"
                    });
                if action == "keep" {
                    values[&f.id] = a
                        .submitted_values
                        .get(&f.id)
                        .cloned()
                        .unwrap_or(JsonValue::Null);
                }
                if action == "remove" {
                    values[&f.id] = JsonValue::Null;
                }
                image_markdown(f, &values[&f.id])?
            } else {
                process_non_image_field_value(f, &values[&f.id])?.1
            };
            if let Some(rendered) = rendered {
                sections.push(format!("### {}\n\n{}", escape_markdown(&f.label), rendered));
            }
        }
        Ok::<_, AppError>(format!(
            "\n\n---\n\n## フォーム投稿: {}\n\n{}",
            escape_markdown(title),
            sections.join("\n\n")
        ))
    })();
    match result {
        Ok(markdown) => Ok((values, markdown, prepared)),
        Err(e) => {
            cleanup_images(&prepared).await;
            Err(e)
        },
    }
}
async fn save_images(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    images: &[PreparedImage],
) -> Result<(), AppError> {
    let used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(stored_bytes),0) FROM marker_form_image_model WHERE owner_id=$1",
    )
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    let incoming: i64 = images
        .iter()
        .map(|i| (i.bytes.len() + i.thumb_bytes.len()) as i64)
        .sum();
    if used.saturating_add(incoming) > CONFIG.marker_form_storage_quota_bytes {
        return Err(AppError::PayloadTooLarge(
            "入力フォームから保存できる画像容量の上限を超えています。".into(),
        ));
    }
    write_prepared_images(images).await?;
    for i in images {
        sqlx::query("INSERT INTO image_model (id,user_id,filename,uuid_filename,create_at) VALUES ($1,$2,$3,$4,$5)")
            .bind(&i.id).bind(user).bind(&i.filename).bind(&i.unique_filename).bind(Utc::now().naive_utc()).execute(&mut **tx).await?;
        sqlx::query("INSERT INTO marker_form_image_model (image_id,owner_id,stored_bytes,create_at) VALUES ($1,$2,$3,$4)")
            .bind(&i.id).bind(user).bind((i.bytes.len()+i.thumb_bytes.len()) as i64).bind(Utc::now().naive_utc()).execute(&mut **tx).await?;
    }
    Ok(())
}
pub async fn update_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path((kind, id)): Path<(String, String)>,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    table(&kind)?;
    let mut read = begin_read(&pool).await?;
    let old = answer(&mut read, &user, &kind, &id).await?;
    read.commit().await?;
    let (mut payload, uploads) = parse_marker_form_multipart(&mut multipart).await?;
    if payload.revision != Some(old.revision) {
        return Err(AppError::Conflict);
    }
    let (values, markdown, prepared) = build_edit(&old, &mut payload, &uploads).await?;
    let result=async {
        let mut tx=super::super::answer_sqlite::begin_write(&pool).await?;
        let current=answer(&mut tx,&user,&kind,&id).await?;
        if current.revision!=old.revision {return Err(AppError::Conflict);}
        let mut doc=document(&mut tx,&user,&kind,&old.target_id).await?;
        let parts=if let Some(reconcile)=&payload.reconcile {
            if reconcile.token!=token(&doc) {return Err(AppError::Conflict);}
            let mut p=vec![BodyPart::Text{text:reconcile.free_text.clone()}];
            p.extend(doc.answers.iter().map(|a|BodyPart::Answer{id:a.id.clone()}));p
        } else {doc.parts.clone().ok_or_else(||invalid("本文・メモと回答の対応確認が必要です。自由記述として残す内容を確認してください。"))?};
        for a in &mut doc.answers {if a.id==id {a.rendered_markdown=markdown.clone();}}
        let body=render(&parts,&doc.answers).ok_or(AppError::Conflict)?;
        // Validate body before creating any image files.
        if kind=="shape" && body.chars().count()>SHAPE_MEMO_MAX_LENGTH {return Err(AppError::PayloadTooLarge("図形メモは10000文字以内にしてください。".into()));}
        save_images(&mut tx,&user,&prepared).await?;
        sqlx::query(&format!("UPDATE {kind}_form_submission_model SET submitted_values=$1,rendered_markdown=$2,revision=revision+1,edited_at=$3 WHERE id=$4"))
            .bind(SqlJson(values)).bind(&markdown).bind(Utc::now().naive_utc()).bind(&id).execute(&mut *tx).await?;
        let object=write_body(&mut tx,&user,&kind,&old.target_id,&body,&parts).await?;
        tx.commit().await?;
        Ok::<_,AppError>(([(axum::http::header::CACHE_CONTROL,"no-store")],Json(json!({"message":"回答を更新しました。","object":object}))).into_response())
    }.await;
    if result.is_err() {
        cleanup_images(&prepared).await;
    }
    result
}
