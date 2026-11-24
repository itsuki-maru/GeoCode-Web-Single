//! 保存条件をブラウザーで判定するため、読み込み済み地物の登録から指定項目を返す。
use super::answer_map_filter::scope;
use super::form_answers::{AnswerQuery, LoadedAnswerTargets, build_target_query, validate};
use crate::{
    ai::actions::{validate_form, validate_scope},
    error::AppError,
};
use axum::{
    Json,
    extract::Extension,
    http::{HeaderMap, header},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, SqlitePool};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const BATCH_SIZE: usize = 2048;
const PAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RowCursor {
    target: String,
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresetDataRequest {
    targets: Vec<String>,
    forms: BTreeMap<Uuid, BTreeSet<String>>,
    query: Option<AnswerQuery>,
    layer_ids: Option<Vec<Uuid>>,
    as_of: Option<DateTime<Utc>>,
    cursor: Option<RowCursor>,
}

#[derive(Serialize, FromRow)]
struct PresetDataRow {
    target: String,
    id: String,
    revision: i64,
    form_id: Option<String>,
    fields: Value,
}

#[derive(Serialize)]
struct PresetDataPage {
    as_of: DateTime<Utc>,
    rows: Vec<PresetDataRow>,
    next_cursor: Option<RowCursor>,
}

async fn load_data(
    pool: &SqlitePool,
    user: &str,
    request: PresetDataRequest,
) -> Result<PresetDataPage, AppError> {
    if request.targets.len() > BATCH_SIZE
        || request.forms.len() > 64
        || request.forms.values().map(BTreeSet::len).sum::<usize>() > 1024
        || request.forms.values().flatten().any(|field| {
            field.is_empty()
                || field.len() > 40
                || !field
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
    {
        return Err(AppError::Validation(
            "読み込み対象または項目の指定が不正です。".into(),
        ));
    }
    let scope = scope(&request.targets)?;
    if let Some(cursor) = &request.cursor {
        if !request.targets.contains(&cursor.target) {
            return Err(AppError::Validation("登録の続き位置が不正です。".into()));
        }
    }
    let ordinary = request.query.is_none();
    let query = if let Some(query) = request.query {
        if query.as_of.is_none()
            || request.layer_ids.is_some()
            || request.as_of.is_some_and(|at| Some(at) != query.as_of)
        {
            return Err(AppError::Validation(
                "登録地図の検索範囲または基準日時が不正です。".into(),
            ));
        }
        query
    } else {
        AnswerQuery {
            mode: "latest".into(),
            as_of: request.as_of,
            ..Default::default()
        }
    };
    validate(&query)?;
    let at = query.as_of.unwrap_or_else(Utc::now);
    validate_scope(pool, user, &request.layer_ids).await?;
    for form in request.forms.keys() {
        validate_form(pool, user, *form).await?;
    }
    if request.targets.is_empty() || (ordinary && request.forms.is_empty()) {
        return Ok(PresetDataPage {
            as_of: at,
            rows: vec![],
            next_cursor: None,
        });
    }
    let targets = LoadedAnswerTargets {
        markers: scope.markers,
        shapes: scope.shapes,
        layers: request
            .layer_ids
            .map(|ids| ids.iter().map(Uuid::to_string).collect()),
        // 登録地図の全件・NOTでは、個別登録や参照対象外のフォームの登録も数える。
        forms: ordinary.then(|| request.forms.keys().map(Uuid::to_string).collect()),
    };
    let mut b = build_target_query(user, &query, at, &targets);
    b.push(
        r#"
        , page AS MATERIALIZED (
            SELECT target_type || ':' || target_id AS target, id, revision,
                source_form->>'id' AS form_id, form_snapshot, submitted_values
            FROM filtered
        "#,
    );
    if let Some(cursor) = request.cursor {
        b.push(" WHERE (target_type || ':' || target_id, id) > (")
            .push_bind(cursor.target)
            .push(", ")
            .push_bind(cursor.id.to_string())
            .push(")");
    }
    // 数値は JSON の元の表記で返し、画像は入力状態だけを返す。
    b.push(" ORDER BY target, id LIMIT ")
        .push_bind(BATCH_SIZE as i64 + 1)
        .push("), requested AS (SELECT key AS form_id, value AS fields FROM json_each(")
        .push_bind(
            serde_json::to_string(&request.forms).map_err(|_| AppError::InternalServerError)?,
        )
        .push(
            r#"))
            SELECT p.target, p.id, p.revision, p.form_id, (
                SELECT json_group_object(field_id, json_object(
                    'type', field_type,
                    'value', json(CASE
                        WHEN field_type = 'image' THEN
                            CASE WHEN value_type IS NULL OR value_type = 'null' THEN 'null'
                                 WHEN value_type = 'text' AND value_raw = '""' THEN '""'
                                 ELSE 'true' END
                        WHEN field_type = 'checkbox' AND value_type IN ('true', 'false')
                            THEN value_type
                        WHEN value_type IN ('true', 'false') THEN json_quote(value_type)
                        WHEN value_type IN ('integer', 'real') THEN json_quote('' || value_raw)
                        ELSE json_quote('' || (p.submitted_values ->> field_path))
                    END)
                ))
                FROM (
                    SELECT field_id, field_type, field_path,
                        json_type(p.submitted_values, field_path) AS value_type,
                        p.submitted_values -> field_path AS value_raw
                    FROM (
                        SELECT field.value->>'id' AS field_id,
                            field.value->>'type' AS field_type,
                            '$."' || (field.value->>'id') || '"' AS field_path
                        FROM requested r
                        JOIN json_each(r.fields) selected
                        JOIN json_each(p.form_snapshot, '$.form_schema.fields') field
                            ON field.value->>'id' = selected.value
                        WHERE r.form_id = p.form_id
                    )
                )
            ) AS fields
            FROM page p ORDER BY p.target, p.id"#,
        );
    let mut tx = super::answer_sqlite::begin_read(pool).await?;
    let mut stream = b.build_query_as::<PresetDataRow>().fetch(&mut *tx);
    let mut rows = Vec::<PresetDataRow>::new();
    let mut next_cursor = None;
    let mut bytes = 0;
    let mut encoded = Vec::new();
    while let Some(row) = stream.try_next().await? {
        // 大きな単一登録も分割せず返す。
        encoded.clear();
        serde_json::to_writer(&mut encoded, &row).map_err(|_| AppError::InternalServerError)?;
        bytes += encoded.len() + 1;
        if !rows.is_empty() && (bytes > PAGE_BYTES || rows.len() == BATCH_SIZE) {
            let last = rows.last().unwrap();
            next_cursor = Some(RowCursor {
                target: last.target.clone(),
                id: Uuid::parse_str(&last.id).map_err(|_| AppError::InternalServerError)?,
            });
            break;
        }
        rows.push(row);
    }
    drop(stream);
    tx.commit().await?;
    Ok(PresetDataPage {
        as_of: at,
        rows,
        next_cursor,
    })
}

pub async fn data_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
    Json(request): Json<PresetDataRequest>,
) -> Result<impl IntoResponse, AppError> {
    super::answer_map_presets::validate_optional_account(&user, &headers)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(load_data(&pool, &user, request).await?),
    ))
}
