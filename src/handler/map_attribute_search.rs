//! 通常地図の属性検索。現行の共通フォーム定義を許可リストにし、最新回答を検索する。
use super::form_answers::{AnswerCondition, AnswerQuery, build_query, validate};
use crate::{error::AppError, model::MarkerFormSchema};
use axum::{
    Json,
    extract::Extension,
    http::header,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, types::Json as SqlJson};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttributeTarget {
    pub target_type: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttributeSearchRequest {
    pub common_form_id: String,
    pub definition_version: i32,
    pub layer_ids: Option<Vec<String>>,
    #[serde(default)]
    pub conditions: Vec<AnswerCondition>,
    // 通常検索では省略。保存後は変更した対象だけ再判定できる。
    pub targets: Option<Vec<AttributeTarget>>,
}

#[derive(Debug, Serialize)]
pub struct AttributeSearchResult {
    pub common_form_id: String,
    pub definition_version: i32,
    pub as_of: DateTime<Utc>,
    pub marker_ids: Vec<String>,
    pub shape_ids: Vec<String>,
    pub target_count: usize,
}

pub async fn search_attributes(
    pool: &SqlitePool,
    user: &str,
    r: &AttributeSearchRequest,
) -> Result<AttributeSearchResult, AppError> {
    let at = Utc::now();
    let mut q = AnswerQuery {
        mode: "latest".into(),
        common_form_id: Some(r.common_form_id.clone()),
        conditions: r.conditions.clone(),
        ..Default::default()
    };
    if let Some(targets) = &r.targets {
        if targets.len() == 1 {
            q.target_type = Some(targets[0].target_type.clone());
            q.target_id = Some(targets[0].id.clone());
        }
    }
    validate(&q)?;
    if r.targets.as_ref().is_some_and(|v| {
        v.len() > 512
            || v.iter()
                .any(|t| !matches!(t.target_type.as_str(), "marker" | "shape"))
    }) {
        return Err(AppError::Validation(
            "再判定する対象情報が不正です。".into(),
        ));
    }
    let mut tx = super::answer_sqlite::begin_read(pool).await?;
    let (version, schema): (i32, SqlJson<MarkerFormSchema>) = sqlx::query_as(
        r#"
        SELECT
            version,
            form_schema
        FROM common_form_model
        WHERE id = $1
            AND user_id = $2
            AND NOT deleted
        "#,
    )
    .bind(&r.common_form_id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if version != r.definition_version {
        return Err(AppError::Conflict);
    }
    for c in &r.conditions {
        if !schema
            .fields
            .iter()
            .any(|f| f.id == c.field_id && f.field_type == c.field_type)
        {
            return Err(AppError::Validation(
                "共通フォームに定義されていない属性です。".into(),
            ));
        }
        super::answer_map_filter::validate_numeric_condition(c)?;
    }
    if let Some(layers) = &r.layer_ids {
        let owned: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT
                id
            FROM layer_model
            WHERE user_id = $1
            "#,
        )
        .bind(user)
        .fetch_all(&mut *tx)
        .await?;
        if layers.iter().any(|id| !owned.contains(id)) {
            return Err(AppError::NotFound);
        }
    }
    let mut b = build_query(user, &q, at);
    b.push(
        r#"
        SELECT DISTINCT
            target_type,
            target_id
        FROM filtered
        WHERE TRUE
        "#,
    );
    if let Some(layers) = &r.layer_ids {
        b.push(" AND (FALSE");
        for id in layers {
            b.push(" OR layer_id=").push_bind(id.clone());
        }
        b.push(")");
    }
    if let Some(targets) = &r.targets {
        b.push(" AND (FALSE");
        for t in targets {
            b.push(" OR (target_type=")
                .push_bind(t.target_type.clone())
                .push(" AND target_id=")
                .push_bind(t.id.clone())
                .push(")");
        }
        b.push(")");
    }
    b.push(" ORDER BY target_type,target_id");
    let rows: Vec<(String, String)> = b.build_query_as().fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut result = AttributeSearchResult {
        common_form_id: r.common_form_id.clone(),
        definition_version: version,
        as_of: at,
        marker_ids: vec![],
        shape_ids: vec![],
        target_count: rows.len(),
    };
    for (kind, id) in rows {
        if kind == "marker" {
            result.marker_ids.push(id);
        } else {
            result.shape_ids.push(id);
        }
    }
    Ok(result)
}

pub async fn search_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(r): Json<AttributeSearchRequest>,
) -> Result<Response, AppError> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(search_attributes(&pool, &user, &r).await?),
    )
        .into_response())
}
