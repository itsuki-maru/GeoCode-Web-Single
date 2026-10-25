//! 初期対象集合の中で、同一回答に追加条件を適用する。位置・形状は再送しない。
use super::form_answers::{
    AnswerCondition, AnswerQuery, FieldOption, append_conditions, build_query, merge_field,
    validate,
};
use crate::{
    error::AppError,
    model::{MarkerFormField, MarkerFormSchema},
};
use axum::{
    Json,
    extract::Extension,
    http::header,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite, SqlitePool, Transaction};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
pub struct MapFilterRequest {
    pub query: AnswerQuery,
    pub targets: Vec<String>,
    pub common_form_id: Option<String>,
    #[serde(default)]
    pub conditions: Vec<AnswerCondition>,
    #[serde(default)]
    pub options_only: bool,
}
#[derive(Serialize)]
pub struct MapFormOption {
    pub id: String,
    pub label: String,
}
#[derive(Serialize)]
pub struct MapFilterResult {
    pub forms: Vec<MapFormOption>,
    pub forms_overflow: bool,
    pub fields: Vec<FieldOption>,
    pub targets: Vec<String>,
    pub answer_count: i64,
    pub target_count: usize,
}
fn invalid(s: &str) -> AppError {
    AppError::Validation(s.into())
}
pub(super) struct Scope {
    markers: Vec<String>,
    shapes: Vec<String>,
}
pub(super) fn scope(keys: &[String]) -> Result<Scope, AppError> {
    if keys.len() > 10_000 {
        return Err(invalid("地図の対象は10,000件までです。"));
    }
    let mut result = Scope {
        markers: vec![],
        shapes: vec![],
    };
    let mut unique = BTreeSet::new();
    for key in keys {
        let (kind, id) = key
            .split_once(':')
            .ok_or_else(|| invalid("対象情報が不正です。"))?;
        let id = Uuid::parse_str(id)
            .map_err(|_| invalid("対象IDが不正です。"))?
            .to_string();
        if !unique.insert((kind.to_string(), id.clone())) {
            return Err(invalid("対象情報が重複しています。"));
        }
        match kind {
            "marker" => result.markers.push(id),
            "shape" => result.shapes.push(id),
            _ => return Err(invalid("対象種別が不正です。")),
        }
    }
    Ok(result)
}
fn base(
    user: &str,
    q: &AnswerQuery,
    at: DateTime<Utc>,
    scope: &Scope,
) -> QueryBuilder<'static, Sqlite> {
    let mut b = build_query(user, q, at);
    b.push(
        r#", map_scope AS (
        SELECT * FROM filtered WHERE
        (target_type='marker' AND target_id IN (SELECT value FROM json_each("#,
    )
    .push_bind(serde_json::to_string(&scope.markers).unwrap())
    .push(
        r#"))) OR
        (target_type='shape' AND target_id IN (SELECT value FROM json_each("#,
    )
    .push_bind(serde_json::to_string(&scope.shapes).unwrap())
    .push("))))");
    b
}
pub(super) fn matched(
    user: &str,
    r: &MapFilterRequest,
    at: DateTime<Utc>,
    scope: &Scope,
) -> QueryBuilder<'static, Sqlite> {
    let mut b = base(user, &r.query, at, scope);
    b.push(", map_matched AS (SELECT * FROM map_scope WHERE TRUE");
    if let Some(form) = &r.common_form_id {
        b.push(" AND source_form->>'id'=")
            .push_bind(form.to_string());
    }
    append_conditions(&mut b, &r.conditions);
    b.push(")");
    b
}
async fn fields(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    r: &MapFilterRequest,
    at: DateTime<Utc>,
    scope: &Scope,
) -> Result<Vec<FieldOption>, AppError> {
    let Some(form) = &r.common_form_id else {
        return Ok(vec![]);
    };
    let mut fields = BTreeMap::new();
    let mut order = vec![];
    let schemas:Vec<Value>=sqlx::query_scalar(r#"
        SELECT r.form_schema FROM common_form_revision_model r JOIN common_form_model f ON f.id=r.form_id
        WHERE f.id=$1 AND f.user_id=$2 ORDER BY r.version DESC
    "#).bind(form).bind(user).fetch_all(&mut **tx).await?;
    for schema in schemas {
        if let Ok(schema) = serde_json::from_value::<MarkerFormSchema>(schema) {
            for f in schema.fields {
                merge_field(&mut fields, &mut order, f);
            }
        }
    }
    let definitions: Vec<Value> = base(user, &r.query, at, scope)
        .push(
            r#"
        SELECT field FROM (
            SELECT f.value AS field,a.create_at,CAST(f.key AS INTEGER) AS position,
                row_number() OVER(PARTITION BY f.value ORDER BY a.create_at COLLATE answer_time DESC,a.id DESC,a.target_type,CAST(f.key AS INTEGER)) AS definition_rank
            FROM map_scope a,json_each(a.form_snapshot,'$.form_schema.fields') f
            WHERE source_form->>'id'=
    "#,
        )
        .push_bind(form.to_string())
        .push(
            r#"
        ) definitions WHERE definition_rank=1 ORDER BY create_at COLLATE answer_time DESC,position,field LIMIT 10001
    "#,
        )
        .build_query_scalar()
        .fetch_all(&mut **tx)
        .await?;
    if definitions.len() > 10_000 {
        return Err(invalid(
            "項目定義が多すぎます。一覧で条件を絞ってください。",
        ));
    }
    for definition in definitions {
        if let Ok(f) = serde_json::from_value::<MarkerFormField>(definition) {
            merge_field(&mut fields, &mut order, f);
        }
    }
    if fields.len() > 200 {
        return Err(invalid(
            "項目が200件を超えています。一覧で条件を絞ってください。",
        ));
    }
    Ok(order
        .into_iter()
        .filter_map(|k| fields.remove(&k))
        .filter(|f| {
            matches!(
                f.field_type.as_str(),
                "text" | "textarea" | "number" | "date" | "select" | "radio" | "checkbox"
            )
        })
        .collect())
}

pub(super) fn validate_request(r: &MapFilterRequest) -> Result<DateTime<Utc>, AppError> {
    validate(&r.query)?;
    let at = r
        .query
        .as_of
        .ok_or_else(|| invalid("検索基準日時がありません。地図を開き直してください。"))?;
    let extra = AnswerQuery {
        common_form_id: r.common_form_id.clone(),
        conditions: r.conditions.clone(),
        ..Default::default()
    };
    validate(&extra)?;
    Ok(at)
}

pub(super) async fn validate_conditions(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    r: &MapFilterRequest,
    at: DateTime<Utc>,
    scope: &Scope,
    include_missing_history: bool,
) -> Result<Vec<FieldOption>, AppError> {
    let fields = fields(tx, user, r, at, scope).await?;
    for condition in &r.conditions {
        let mut known = fields
            .iter()
            .any(|f| f.id == condition.field_id && f.field_type == condition.field_type);
        // CSVでは表示対象がさらに狭まる。missing条件の定義が残らない場合だけ、
        // 元の一覧条件に一致する同一フォームの過去定義で検証する（回答定義の補完はしない）。
        if !known
            && include_missing_history
            && condition.op == "missing"
            && matches!(
                condition.field_type.as_str(),
                "text" | "textarea" | "number" | "date" | "select" | "radio" | "checkbox"
            )
        {
            known = build_query(user, &r.query, at).push(r#"
                SELECT EXISTS (SELECT 1 FROM filtered,json_each(form_snapshot,'$.form_schema.fields') field
                WHERE source_form->>'id'=
            "#).push_bind(r.common_form_id.as_ref().map(|v|v.to_string()))
                .push(" AND field.value->>'id'=").push_bind(condition.field_id.clone())
                .push(" AND field.value->>'type'=").push_bind(condition.field_type.clone()).push(")")
                .build_query_scalar().fetch_one(&mut **tx).await?;
        }
        if !known {
            return Err(invalid(
                "選択したフォームにない項目、または非対応の項目です。",
            ));
        }
        validate_numeric_condition(condition)?;
    }
    Ok(fields)
}

// 保存と実行で同じ十進数比較を使い、f64やSQLite REALへの変換を避ける。
pub(super) fn validate_numeric_condition(condition: &AnswerCondition) -> Result<(), AppError> {
    if condition.field_type == "number"
        && !matches!(condition.op.as_str(), "empty" | "filled" | "missing")
    {
        let text = |v: &Value| {
            v.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string())
        };
        let lo = text(&condition.value);
        let hi = if condition.op == "between" {
            text(&condition.upper)
        } else {
            lo.clone()
        };
        for v in [&lo, &hi] {
            if v.find(['e', 'E']).is_some_and(|i| {
                !v[i + 1..]
                    .parse::<i32>()
                    .is_ok_and(|e| (-1000..=1000).contains(&e))
            }) {
                return Err(invalid("数値の指数が大きすぎます。"));
            }
        }
        if super::answer_sqlite::compare_numbers(&format!("query:{lo}"), &format!("query:{hi}"))
            == std::cmp::Ordering::Greater
        {
            return Err(invalid("数値範囲を確認してください。"));
        }
    }
    Ok(())
}

pub async fn filter_targets(
    pool: &SqlitePool,
    user: &str,
    r: &MapFilterRequest,
) -> Result<MapFilterResult, AppError> {
    let at = validate_request(r)?;
    let scope = scope(&r.targets)?;
    let mut tx = super::answer_sqlite::begin_read(pool).await?;
    let forms: Vec<(String, String)> = base(user, &r.query, at, &scope)
        .push(
            r#"
        SELECT form_id,label FROM (
            SELECT source_form->>'id' AS form_id,COALESCE(common_form_name,form_snapshot->>'form_title','共通フォーム') AS label,
            row_number() OVER(PARTITION BY source_form->>'id' ORDER BY create_at COLLATE answer_time DESC,id DESC) AS form_rank
            FROM map_scope WHERE source_form->>'id' IS NOT NULL
        ) forms WHERE form_rank=1 ORDER BY form_id LIMIT 201
    "#,
        )
        .build_query_as()
        .fetch_all(&mut *tx)
        .await?;
    let forms_overflow = forms.len() > 200;
    let fields = validate_conditions(&mut tx, user, r, at, &scope, false).await?;
    let mut targets = vec![];
    let mut answer_count = 0;
    if !r.options_only {
        answer_count = matched(user, r, at, &scope)
            .push(" SELECT count(*) FROM map_matched")
            .build_query_scalar()
            .fetch_one(&mut *tx)
            .await?;
        targets = matched(user, r, at, &scope)
            .push(" SELECT DISTINCT target_type||':'||target_id FROM map_matched ORDER BY 1")
            .build_query_scalar()
            .fetch_all(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(MapFilterResult {
        forms: forms
            .into_iter()
            .take(200)
            .filter_map(|(id, label)| {
                Uuid::parse_str(&id)
                    .ok()
                    .map(|_| MapFormOption { id, label })
            })
            .collect(),
        forms_overflow,
        fields,
        target_count: targets.len(),
        targets,
        answer_count,
    })
}
pub async fn filter_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(r): Json<MapFilterRequest>,
) -> Result<Response, AppError> {
    let data = filter_targets(&pool, &user, &r).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(data)).into_response())
}
