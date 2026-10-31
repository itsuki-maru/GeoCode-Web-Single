//! 所有者の構造化回答を、履歴・最新回答で検索し、同じ条件でCSVへ出力する。
use crate::{error::AppError, model::MarkerFormField};
use axum::{
    Json,
    body::Body,
    extract::Extension,
    http::header,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};
use std::collections::BTreeMap;
#[cfg(test)]
use uuid::Uuid;

pub(super) const EXPORT_LIMIT: i64 = 10_000;
const COLUMN_LIMIT: usize = 200;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AnswerQuery {
    #[serde(default)]
    pub mode: String,
    pub common_form_id: Option<String>,
    #[serde(default)]
    pub individual_only: bool,
    pub version: Option<i32>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub layer_id: Option<String>,
    pub target_name: Option<String>,
    pub from: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub as_of: Option<DateTime<Utc>>,
    pub cursor: Option<AnswerCursor>,
    pub limit: Option<i64>,
    #[serde(default)]
    pub conditions: Vec<AnswerCondition>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnswerCursor {
    pub at: NaiveDateTime,
    pub id: String,
    pub target_type: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnswerCondition {
    pub field_id: String,
    pub field_type: String,
    pub op: String,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub upper: Value,
}

#[derive(Debug, Serialize)]
pub struct AnswerRow {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub target_name: String,
    pub layer_id: Option<String>,
    pub layer_name: Option<String>,
    pub edited_at: Option<chrono::NaiveDateTime>,
    pub revision: i64,
    pub create_at: NaiveDateTime,
    pub submitted_values: Value,
    pub form_snapshot: Option<Value>,
    pub source_form: Option<Value>,
    pub common_form_name: Option<String>,
    pub common_form_deleted: Option<bool>,
}

impl<'r> FromRow<'r, sqlx::sqlite::SqliteRow> for AnswerRow {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row;
        Ok(Self {
            id: row.try_get("id")?,
            target_type: row.try_get("target_type")?,
            target_id: row.try_get("target_id")?,
            target_name: row.try_get("target_name")?,
            layer_id: row.try_get("layer_id")?,
            layer_name: row.try_get("layer_name")?,
            edited_at: row
                .try_get::<Option<DateTime<Utc>>, _>("edited_at")?
                .map(|t| t.naive_utc()),
            revision: row.try_get("revision")?,
            // SQLiteのNaiveDateTimeデコードはオフセットを除くだけなので、UTCへ変換する。
            create_at: row.try_get::<DateTime<Utc>, _>("create_at")?.naive_utc(),
            submitted_values: row.try_get("submitted_values")?,
            form_snapshot: row.try_get("form_snapshot")?,
            source_form: row.try_get("source_form")?,
            common_form_name: row.try_get("common_form_name")?,
            common_form_deleted: row.try_get("common_form_deleted")?,
        })
    }
}

#[derive(Serialize)]
pub struct AnswerPage {
    pub editing_supported: bool,
    pub rows: Vec<AnswerRow>,
    pub total: i64,
    pub target_count: i64,
    pub as_of: DateTime<Utc>,
    pub next_cursor: Option<AnswerCursor>,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

fn text(value: &Value) -> Result<&str, AppError> {
    value
        .as_str()
        .filter(|s| s.len() <= 5_000)
        .ok_or_else(|| invalid("検索値が不正です。"))
}

fn number(value: &Value) -> Result<String, AppError> {
    let raw = if let Some(s) = value.as_str() {
        s.to_string()
    } else if value.is_number() {
        value.to_string()
    } else {
        return Err(invalid("数値を入力してください。"));
    };
    let n: f64 = raw
        .parse()
        .map_err(|_| invalid("数値を入力してください。"))?;
    if !n.is_finite() {
        return Err(invalid("有限の数値を入力してください。"));
    }
    if raw.len() > 200 {
        return Err(invalid("数値が長すぎます。"));
    }
    Ok(raw)
}

pub(super) fn validate(query: &AnswerQuery) -> Result<(), AppError> {
    for id in [&query.common_form_id, &query.target_id, &query.layer_id] {
        if id
            .as_deref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(invalid("検索対象のIDが不正です。"));
        }
    }
    if query
        .cursor
        .as_ref()
        .is_some_and(|c| uuid::Uuid::parse_str(&c.id).is_err())
    {
        return Err(invalid("ページ情報が不正です。"));
    }
    if !matches!(query.mode.as_str(), "" | "history" | "latest") {
        return Err(invalid("表示モードが不正です。"));
    }
    if query.common_form_id.is_some() && query.individual_only {
        return Err(invalid("フォームの条件が不正です。"));
    }
    if query
        .target_type
        .as_deref()
        .is_some_and(|t| !matches!(t, "marker" | "shape"))
    {
        return Err(invalid("対象種別が不正です。"));
    }
    if query.target_id.is_some() && query.target_type.is_none() {
        return Err(invalid("対象IDには対象種別が必要です。"));
    }
    if query.version.is_some_and(|v| v <= 0)
        || (query.version.is_some() && query.common_form_id.is_none())
    {
        return Err(invalid("版の条件が不正です。"));
    }
    if query
        .target_name
        .as_ref()
        .is_some_and(|v| v.chars().count() > 100)
        || query.limit.is_some_and(|n| !(1..=100).contains(&n))
    {
        return Err(invalid("検索条件の上限を超えています。"));
    }
    if query.from.zip(query.until).is_some_and(|(a, b)| a >= b) {
        return Err(invalid("投稿期間を確認してください。"));
    }
    if query.as_of.is_some_and(|v| v > Utc::now()) {
        return Err(invalid("検索基準日時が不正です。"));
    }
    if query
        .cursor
        .as_ref()
        .is_some_and(|c| !matches!(c.target_type.as_str(), "marker" | "shape"))
    {
        return Err(invalid("ページ情報が不正です。"));
    }
    if query.conditions.len() > 10 {
        return Err(invalid("回答条件は10件以内にしてください。"));
    }
    if !query.conditions.is_empty() && query.common_form_id.is_none() && query.target_id.is_none() {
        return Err(invalid(
            "回答条件を使う場合は共通フォームまたは対象を選択してください。",
        ));
    }
    for c in &query.conditions {
        if c.field_id.is_empty()
            || c.field_id.len() > 40
            || !c
                .field_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(invalid("項目IDが不正です。"));
        }
        if !matches!(
            c.field_type.as_str(),
            "text"
                | "textarea"
                | "number"
                | "date"
                | "select"
                | "radio"
                | "checkbox"
                | "image"
                | "unknown"
        ) {
            return Err(invalid("項目の型が不正です。"));
        }
        if matches!(c.op.as_str(), "filled" | "empty" | "missing") {
            continue;
        }
        match c.field_type.as_str() {
            "text" | "textarea" | "unknown" if matches!(c.op.as_str(), "eq" | "contains") => {
                text(&c.value)?;
            },
            "number" if matches!(c.op.as_str(), "eq" | "gte" | "lte" | "between") => {
                let a = number(&c.value)?;
                if c.op == "between"
                    && a.parse::<f64>().unwrap() > number(&c.upper)?.parse::<f64>().unwrap()
                {
                    return Err(invalid("数値範囲を確認してください。"));
                }
            },
            "date" if matches!(c.op.as_str(), "eq" | "gte" | "lte" | "between") => {
                let a = NaiveDate::parse_from_str(text(&c.value)?, "%Y-%m-%d")
                    .map_err(|_| invalid("日付を確認してください。"))?;
                if a.format("%Y-%m-%d").to_string() != text(&c.value)? {
                    return Err(invalid("日付はYYYY-MM-DD形式で入力してください。"));
                }
                if c.op == "between" {
                    let b = NaiveDate::parse_from_str(text(&c.upper)?, "%Y-%m-%d")
                        .map_err(|_| invalid("日付を確認してください。"))?;
                    if a > b || b.format("%Y-%m-%d").to_string() != text(&c.upper)? {
                        return Err(invalid("日付範囲を確認してください。"));
                    }
                }
            },
            "select" | "radio" if c.op == "in" => {
                let items = c
                    .value
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 100)
                    .ok_or_else(|| invalid("選択値を指定してください。"))?;
                for item in items {
                    text(item)?;
                }
            },
            "checkbox" if c.op == "eq" && c.value.is_boolean() => {},
            _ => return Err(invalid("この項目では使えない検索条件です。")),
        }
    }
    Ok(())
}

// 動的な項目IDもJSONパスとしてバインドし、SQLへ連結しない。
fn field_path(c: &AnswerCondition) -> String {
    format!(
        "$.{}",
        serde_json::to_string(&c.field_id).expect("field id")
    )
}

fn field_exists(b: &mut QueryBuilder<'_, Sqlite>, c: &AnswerCondition) {
    if c.field_type == "unknown" {
        b.push("(form_snapshot IS NULL AND json_type(submitted_values, ")
            .push_bind(field_path(c))
            .push(") IS NOT NULL)");
    } else {
        b.push(
            r#"
            EXISTS (
                SELECT 1
                FROM json_each(form_snapshot, '$.form_schema.fields') f
                WHERE f.value ->> 'id' =
            "#,
        )
        .push_bind(c.field_id.clone())
        .push(" AND f.value ->> 'type' = ")
        .push_bind(c.field_type.clone())
        .push(")");
    }
}

fn value_text(b: &mut QueryBuilder<'_, Sqlite>, c: &AnswerCondition) {
    // JSON数値は -> の元の文字列を使い、SQLite REALへの変換による桁落ちを防ぐ。
    b.push("(CASE WHEN json_type(submitted_values, ")
        .push_bind(field_path(c))
        .push(") IN ('integer','real') THEN submitted_values -> ")
        .push_bind(field_path(c))
        .push(" WHEN json_type(submitted_values, ")
        .push_bind(field_path(c))
        .push(") = 'true' THEN 'true' WHEN json_type(submitted_values, ")
        .push_bind(field_path(c))
        .push(") = 'false' THEN 'false'")
        .push(" ELSE CAST(submitted_values ->> ")
        .push_bind(field_path(c))
        .push(" AS TEXT) END)");
}

fn typed_value(b: &mut QueryBuilder<'_, Sqlite>, c: &AnswerCondition) {
    if c.field_type == "number" {
        b.push("(CASE WHEN ('stored:' || ");
        value_text(b, c);
        b.push(") COLLATE answer_numeric > '' THEN ('stored:' || ");
        value_text(b, c);
        b.push(") END) COLLATE answer_numeric");
    } else {
        value_text(b, c);
    }
}

fn bound_value(b: &mut QueryBuilder<'_, Sqlite>, c: &AnswerCondition, value: &Value) {
    b.push_bind(if c.field_type == "number" {
        format!("query:{}", number(value).expect("validated number"))
    } else {
        value.as_str().expect("validated text").to_owned()
    });
}

/// 最新回答の決定後に、版・期間・回答条件を適用する。
pub(super) fn build_query(
    user: &str,
    q: &AnswerQuery,
    at: DateTime<Utc>,
) -> QueryBuilder<'static, Sqlite> {
    build_query_with_projection(user, q, at, AnswerProjection::Full)
}

#[derive(Clone, Copy)]
enum AnswerProjection<'a> {
    Full,
    Search(&'a AnswerQuery),
    Count(&'a AnswerQuery),
}

#[derive(FromRow)]
struct AnswerKey {
    id: String,
    target_type: String,
}

/// Share ownership and the complete row projection with the bounded detail
/// fetch. Only search planning omits display joins and unused JSON columns.
fn append_answer_source(
    b: &mut QueryBuilder<'static, Sqlite>,
    user: &str,
    projection: AnswerProjection<'_>,
    keys: Option<&[AnswerKey]>,
) {
    let mut first = true;
    for kind in ["marker", "shape"] {
        if keys.is_some_and(|keys| !keys.iter().any(|key| key.target_type == kind)) {
            continue;
        }
        if !first {
            b.push(" UNION ALL ");
        }
        first = false;
        let (table, name) = if kind == "marker" {
            ("marker_info_model", "m.marker_name")
        } else {
            ("shape_model", "COALESCE(m.name, '名称なし')")
        };
        b.push(
            r#"
            SELECT
            "#,
        );
        // History counts need no answer ID, so target/create indexes can
        // cover the submission scan. Latest ranking still breaks ties by ID.
        if !matches!(projection, AnswerProjection::Count(q) if q.mode != "latest") {
            b.push("s.id, ");
        }
        b.push(format!(
            r#"
            '{kind}' AS target_type, m.id AS target_id
            "#
        ));
        match projection {
            AnswerProjection::Full => {
                b.push(format!(
                    r#"
                    ,
                    {name} AS target_name,
                    m.layer_id,
                    l.layer_name,
                    s.create_at COLLATE answer_time AS create_at,
                    s.edited_at,
                    s.revision,
                    s.submitted_values,
                    s.form_snapshot,
                    s.source_form,
                    cf.form_title AS common_form_name,
                    cf.deleted AS common_form_deleted
                    "#
                ));
            },
            AnswerProjection::Search(q) | AnswerProjection::Count(q) => {
                b.push(", s.create_at COLLATE answer_time AS create_at");
                if q.target_name.is_some() {
                    b.push(format!(", {name} AS target_name"));
                }
                if q.layer_id.is_some() {
                    b.push(", m.layer_id");
                }
                if q.mode == "latest"
                    || q.common_form_id.is_some()
                    || q.individual_only
                    || q.version.is_some()
                {
                    b.push(", s.source_form");
                }
                if !q.conditions.is_empty() {
                    b.push(", s.submitted_values, s.form_snapshot");
                }
            },
        }
        // For bounded details, start with submission PK lookups. An ordinary
        // join can instead scan every owned target before applying s.id IN.
        let target_join = if keys.is_some() { "CROSS JOIN" } else { "JOIN" };
        b.push(format!(
            r#"
            FROM {kind}_form_submission_model s
            {target_join} {table} m ON m.id = s.{kind}_id
            "#
        ));
        if matches!(projection, AnswerProjection::Full) {
            b.push(
                r#"
                LEFT JOIN layer_model l ON l.id = m.layer_id AND l.user_id = m.user_id
                LEFT JOIN common_form_model cf ON cf.id = s.source_form ->> 'id'
                    AND cf.user_id = m.user_id
                "#,
            );
        }
        b.push(" WHERE m.user_id = ").push_bind(user.to_owned());
        if let Some(keys) = keys {
            b.push(" AND s.id IN (");
            let mut ids = b.separated(",");
            for key in keys.iter().filter(|key| key.target_type == kind) {
                ids.push_bind(key.id.clone());
            }
            b.push(")");
        }
    }
}

fn build_query_with_projection(
    user: &str,
    q: &AnswerQuery,
    at: DateTime<Utc>,
    projection: AnswerProjection<'_>,
) -> QueryBuilder<'static, Sqlite> {
    let mut b = QueryBuilder::new(
        r#"
        WITH owned AS (
        "#,
    );
    append_answer_source(&mut b, user, projection, None);
    b.push(
        r#"
        ), scoped AS (
            SELECT *
            FROM owned
            WHERE create_at COLLATE answer_time <=
        "#,
    )
    .push_bind(at.naive_utc());
    if let Some(id) = &q.common_form_id {
        b.push(" AND source_form ->> 'id' = ").push_bind(id.clone());
    }
    if q.individual_only {
        b.push(" AND source_form ->> 'id' IS NULL");
    }
    if let Some(kind) = &q.target_type {
        b.push(" AND target_type = ").push_bind(kind.clone());
    }
    if let Some(id) = &q.target_id {
        b.push(" AND target_id = ").push_bind(id.clone());
    }
    if let Some(id) = &q.layer_id {
        b.push(" AND layer_id = ").push_bind(id.clone());
    }
    if let Some(name) = &q.target_name {
        b.push(
            r#"
            AND EXISTS (
                WITH RECURSIVE positions(n) AS (
                    SELECT 1
                    UNION ALL
                    SELECT n + 1 FROM positions WHERE n < length(target_name)
                )
                SELECT 1 FROM positions WHERE substr(target_name, n, length(
            "#,
        )
        .push_bind(name.clone())
        .push(")) COLLATE answer_name = ")
        .push_bind(name.clone())
        .push(")");
    }
    if q.mode == "latest" {
        b.push(
            r#"
            ), ranked AS (
                SELECT
                    *,
                    row_number() OVER (
                        PARTITION BY
                            target_type, target_id, COALESCE(source_form->>'id', 'individual')
                        ORDER BY create_at COLLATE answer_time DESC, id DESC
                    ) AS rn
                FROM scoped
            ), filtered AS (
                SELECT *
                FROM ranked
                WHERE rn = 1
            "#,
        );
    } else {
        // History does not need to rank or sort every answer before filtering.
        b.push(
            r#"
            ), filtered AS (
                SELECT *
                FROM scoped
                WHERE TRUE
            "#,
        );
    }
    if let Some(v) = q.version {
        b.push(" AND CAST(source_form ->> 'version' AS TEXT) = ")
            .push_bind(v.to_string());
    }
    if let Some(from) = q.from {
        b.push(" AND create_at COLLATE answer_time >= ")
            .push_bind(from.naive_utc());
    }
    if let Some(until) = q.until {
        b.push(" AND create_at COLLATE answer_time < ")
            .push_bind(until.naive_utc());
    }
    append_conditions(&mut b, &q.conditions);
    b.push(")");
    b
}

/// 検証済み条件を同一回答へAND適用する。検索と回答地図で共用。
pub(super) fn append_conditions(b: &mut QueryBuilder<'_, Sqlite>, conditions: &[AnswerCondition]) {
    for c in conditions {
        b.push(" AND (");
        if c.op == "missing" {
            b.push("NOT ");
            field_exists(b, c);
        } else {
            field_exists(b, c);
            if matches!(c.op.as_str(), "empty" | "filled") {
                b.push(if c.op == "filled" {
                    " AND NOT ("
                } else {
                    " AND ("
                });
                b.push("json_type(submitted_values, ")
                    .push_bind(field_path(c))
                    .push(") IS NULL OR json_type(submitted_values, ")
                    .push_bind(field_path(c))
                    .push(") = 'null' OR ");
                value_text(b, c);
                b.push(" = '')");
            } else {
                b.push(" AND ");
                match c.op.as_str() {
                    "contains" => {
                        b.push("instr(");
                        value_text(b, c);
                        b.push(", ")
                            .push_bind(text(&c.value).unwrap().to_owned())
                            .push(") > 0");
                    },
                    "in" => {
                        value_text(b, c);
                        b.push(" IN (");
                        for (i, v) in c.value.as_array().unwrap().iter().enumerate() {
                            if i > 0 {
                                b.push(",");
                            }
                            b.push_bind(v.as_str().unwrap().to_owned());
                        }
                        b.push(")");
                    },
                    "eq" if c.field_type == "checkbox" => {
                        b.push("json_type(submitted_values, ")
                            .push_bind(field_path(c))
                            .push(") = ")
                            .push_bind(if c.value.as_bool() == Some(true) {
                                "true"
                            } else {
                                "false"
                            });
                    },
                    _ => {
                        typed_value(b, c);
                        b.push(match c.op.as_str() {
                            "gte" | "between" => " >= ",
                            "lte" => " <= ",
                            _ => " = ",
                        });
                        bound_value(b, c, &c.value);
                        if c.op == "between" {
                            b.push(" AND ");
                            typed_value(b, c);
                            b.push(" <= ");
                            bound_value(b, c, &c.upper);
                        }
                    },
                }
            }
        }
        b.push(")");
    }
}

const ROW_COLUMNS: &str = r#"
    id,
    target_type,
    target_id,
    target_name,
    layer_id,
    layer_name,
    create_at,
    edited_at,
    revision,
    submitted_values,
    form_snapshot,
    source_form,
    common_form_name,
    common_form_deleted
    "#;

fn append_page_query(b: &mut QueryBuilder<'static, Sqlite>, q: &AnswerQuery, columns: &str) {
    b.push(format!(
        r#"
        SELECT
            {columns}
        FROM filtered
        WHERE TRUE
        "#,
    ));
    if let Some(c) = &q.cursor {
        b.push(" AND (create_at COLLATE answer_time,id,target_type) < (")
            .push_bind(c.at)
            .push(",")
            .push_bind(c.id.clone())
            .push(",")
            .push_bind(c.target_type.clone())
            .push(")");
    }
    b.push(
        r#"
        ORDER BY create_at COLLATE answer_time DESC, id DESC, target_type DESC
        LIMIT
        "#,
    )
    .push_bind(q.limit.unwrap_or(50) + 1);
}

async fn selected_answer_rows(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    user: &str,
    keys: &[AnswerKey],
) -> Result<Vec<AnswerRow>, sqlx::Error> {
    if keys.is_empty() {
        return Ok(vec![]);
    }
    // IDs already reflect all filters and latest-answer decisions. Resolve
    // only that bounded set, in the same read transaction and ownership scope.
    let mut b = QueryBuilder::new(format!(
        r#"
        SELECT {ROW_COLUMNS}
        FROM (
        "#,
    ));
    append_answer_source(&mut b, user, AnswerProjection::Full, Some(keys));
    b.push(
        r#"
        ) page
        ORDER BY create_at COLLATE answer_time DESC, id DESC, target_type DESC
        "#,
    );
    b.build_query_as().fetch_all(&mut **tx).await
}

pub async fn search_answers_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(q): Json<AnswerQuery>,
) -> Result<Json<AnswerPage>, AppError> {
    validate(&q)?;
    let at = q.as_of.unwrap_or_else(Utc::now);
    let mut tx = super::answer_sqlite::begin_read(&pool).await?;
    let (total, target_count): (i64, i64) =
        build_query_with_projection(&user, &q, at, AnswerProjection::Count(&q))
            .push(
                r#"
                SELECT
                    count(*),
                    count(DISTINCT target_type || ':' || target_id)
                FROM filtered
                "#,
            )
            .build_query_as()
            .fetch_one(&mut *tx)
            .await?;
    let size = q.limit.unwrap_or(50);
    let mut b = build_query_with_projection(&user, &q, at, AnswerProjection::Search(&q));
    append_page_query(&mut b, &q, "id, target_type");
    let keys: Vec<AnswerKey> = b.build_query_as().fetch_all(&mut *tx).await?;
    let mut rows = selected_answer_rows(&mut tx, &user, &keys).await?;
    tx.commit().await?;
    let next_cursor = if rows.len() > size as usize {
        rows.truncate(size as usize);
        rows.last().map(|r| AnswerCursor {
            at: r.create_at,
            id: r.id.clone(),
            target_type: r.target_type.clone(),
        })
    } else {
        None
    };
    Ok(Json(AnswerPage {
        editing_supported: true,
        rows,
        total,
        target_count,
        as_of: at,
        next_cursor,
    }))
}

#[derive(Clone, Debug, Serialize)]
pub struct FieldOption {
    pub id: String,
    pub label: String,
    pub field_type: String,
    pub choices: Vec<String>,
}

pub(super) fn merge_field(
    fields: &mut BTreeMap<(String, String), FieldOption>,
    order: &mut Vec<(String, String)>,
    field: MarkerFormField,
) {
    let key = (field.id.clone(), field.field_type.clone());
    if !order.contains(&key) {
        order.push(key.clone());
    }
    let entry = fields.entry(key).or_insert_with(|| FieldOption {
        id: field.id,
        label: field.label,
        field_type: field.field_type,
        choices: vec![],
    });
    for choice in field.choices {
        if !entry.choices.contains(&choice) {
            entry.choices.push(choice);
        }
    }
}

pub(super) async fn answer_fields(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    user: &str,
    q: &AnswerQuery,
    at: DateTime<Utc>,
    order: &mut Vec<(String, String)>,
) -> Result<BTreeMap<(String, String), FieldOption>, AppError> {
    fields_from_query(tx, build_query(user, q, at), "filtered", order).await
}
pub(super) async fn fields_from_query(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    mut b: QueryBuilder<'static, Sqlite>,
    source: &'static str,
    order: &mut Vec<(String, String)>,
) -> Result<BTreeMap<(String, String), FieldOption>, AppError> {
    append_field_definitions(&mut b, source);
    let definitions: Vec<Value> = b.build_query_scalar().fetch_all(&mut **tx).await?;
    if definitions.len() > 10_000 {
        return Err(invalid(
            "項目定義が多すぎます。対象や期間で絞り込んでください。",
        ));
    }
    let mut fields = BTreeMap::new();
    for definition in definitions {
        if let Ok(field) = serde_json::from_value::<MarkerFormField>(definition) {
            merge_field(&mut fields, order, field);
        }
        if fields.len() > COLUMN_LIMIT {
            return Err(invalid(
                "項目が200件を超えています。フォーム・対象・期間で絞り込んでください。",
            ));
        }
    }
    Ok(fields)
}

fn append_field_definitions(b: &mut QueryBuilder<'static, Sqlite>, source: &'static str) {
    // Only arrays can be grouped by their extracted JSON text. A JSON string
    // can extract to that same text, and JSON null and a missing path both
    // extract to SQL NULL. Preserve those values and expand original snapshots.
    b.push(format!(
        r#"
        SELECT
            field
        FROM (
            SELECT
                field,
                observed,
                position
            FROM (
                SELECT
                    f.value AS field,
                    a.create_at AS observed,
                    CAST(f.key AS INTEGER) AS position,
                    row_number() OVER (
                        PARTITION BY f.value
                        ORDER BY a.create_at COLLATE answer_time DESC,
                            a.id DESC,
                            a.target_type DESC,
                            CAST(f.key AS INTEGER)
                    ) AS definition_rank
                FROM (
                    SELECT
                        form_snapshot,
                        create_at,
                        id,
                        target_type
                    FROM (
                        SELECT
                            form_snapshot,
                            create_at,
                            id,
                            target_type,
                            row_number() OVER (
                                PARTITION BY
                                    json_extract(form_snapshot, '$.form_schema.fields')
                                        COLLATE BINARY
                                ORDER BY create_at COLLATE answer_time DESC,
                                    id DESC,
                                    target_type DESC
                            ) AS snapshot_rank
                        FROM {source}
                        WHERE json_type(form_snapshot, '$.form_schema.fields') = 'array'
                    ) arrays
                    WHERE snapshot_rank = 1
                    UNION ALL
                    SELECT
                        form_snapshot,
                        create_at,
                        id,
                        target_type
                    FROM {source}
                    WHERE json_type(form_snapshot, '$.form_schema.fields') IS NOT 'array'
                ) a,
                json_each(a.form_snapshot, '$.form_schema.fields') f
            ) snapshots
            WHERE definition_rank = 1
            UNION ALL
            SELECT
                json_object('id', f.key, 'label', f.key, 'type', 'unknown'),
                max(a.create_at COLLATE answer_time),
                NULL
            FROM {source} a,
            json_each(a.submitted_values) f
            WHERE a.form_snapshot IS NULL
            GROUP BY f.key
        ) definitions
        ORDER BY observed COLLATE answer_time DESC, position NULLS LAST, field
        LIMIT 10001
        "#,
    ));
}

pub async fn answer_options_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(mut q): Json<AnswerQuery>,
) -> Result<Json<Value>, AppError> {
    q.conditions.clear();
    q.cursor = None;
    q.mode = "history".into();
    q.from = None;
    q.until = None;
    q.version = None;
    validate(&q)?;
    let at = q.as_of.unwrap_or_else(Utc::now);
    let mut tx = super::answer_sqlite::begin_read(&pool).await?;
    // Gather references once instead of rescanning all owned targets per deleted form.
    let forms: Vec<(String, String, bool)> = sqlx::query_as(
        r#"
        SELECT
            f.id,
            f.form_title,
            f.deleted
        FROM common_form_model f
        WHERE f.user_id = $1
            AND (
                NOT f.deleted
                OR f.id IN (
                    SELECT s.source_form ->> 'id'
                    FROM marker_form_submission_model s
                    JOIN marker_info_model m ON m.id = s.marker_id
                    WHERE m.user_id = $1
                    UNION
                    SELECT s.source_form ->> 'id'
                    FROM shape_form_submission_model s
                    JOIN shape_model m ON m.id = s.shape_id
                    WHERE m.user_id = $1
                )
            )
        ORDER BY f.update_at DESC, f.id
        "#,
    )
    .bind(&user)
    .fetch_all(&mut *tx)
    .await?;
    let layers: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT
            id,
            layer_name
        FROM layer_model
        WHERE user_id = $1
        ORDER BY layer_name, id
        "#,
    )
    .bind(&user)
    .fetch_all(&mut *tx)
    .await?;
    let mut fields = BTreeMap::new();
    let mut field_order = vec![];
    let mut versions = vec![];
    if q.common_form_id.is_some() || q.target_id.is_some() {
        if let Some(id) = &q.common_form_id {
            let schemas: Vec<(i32, Value)> = sqlx::query_as(
                r#"
                SELECT
                    r.version,
                    r.form_schema
                FROM common_form_revision_model r
                JOIN common_form_model f
                    ON f.id = r.form_id
                WHERE f.user_id = $1
                    AND f.id = $2
                ORDER BY r.version DESC
                "#,
            )
            .bind(&user)
            .bind(&id)
            .fetch_all(&mut *tx)
            .await?;
            for (version, schema) in schemas {
                versions.push(version);
                if let Ok(schema) = serde_json::from_value::<crate::model::MarkerFormSchema>(schema)
                {
                    for field in schema.fields {
                        merge_field(&mut fields, &mut field_order, field);
                    }
                }
            }
        }
        if let (Some(target), Some(kind)) = (q.target_id.as_ref(), q.target_type.as_deref()) {
            let table = if kind == "marker" {
                "marker_info_model"
            } else {
                "shape_model"
            };
            let definition: Option<Value> = sqlx::query_scalar(&format!(
                r#"
                SELECT
                    c.form_schema
                FROM {kind}_form_config_model c
                JOIN {table} m ON m.id = c.{kind}_id
                WHERE m.id = $1
                    AND m.user_id = $2
                    AND ($3 IS NULL OR c.source_form ->> 'id' = $3)
                    AND (NOT $4 OR c.source_form ->> 'id' IS NULL)
                "#
            ))
            .bind(target)
            .bind(&user)
            .bind(q.common_form_id.as_ref().map(|id| id.to_string()))
            .bind(q.individual_only)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(definition) = definition {
                if let Ok(schema) =
                    serde_json::from_value::<crate::model::MarkerFormSchema>(definition)
                {
                    for field in schema.fields {
                        merge_field(&mut fields, &mut field_order, field);
                    }
                }
            }
        }
        for (key, field) in answer_fields(&mut tx, &user, &q, at, &mut field_order).await? {
            if let Some(existing) = fields.get_mut(&key) {
                for choice in field.choices {
                    if !existing.choices.contains(&choice) {
                        existing.choices.push(choice);
                    }
                }
            } else {
                fields.insert(key, field);
            }
        }
        if fields.len() > COLUMN_LIMIT {
            return Err(invalid(
                "項目が200件を超えています。対象を指定してください。",
            ));
        }
    }
    tx.commit().await?;
    Ok(Json(
        json!({"forms":forms.into_iter().map(|(id,name,deleted)|json!({"id":id,"name":name,"deleted":deleted})).collect::<Vec<_>>(),"layers":layers.into_iter().map(|(id,name)|json!({"id":id,"name":name})).collect::<Vec<_>>(),"fields":field_order.iter().filter_map(|key|fields.get(key)).collect::<Vec<_>>(),"versions":versions}),
    ))
}

/// UTF-8 CSV。文字列のみ数式としての評価を抑止し、数値・真偽値は型を維持する。
fn csv_cell(value: &str, untrusted: bool) -> String {
    let dangerous = untrusted
        && value
            .trim_start_matches(|c: char| c.is_whitespace() || c.is_control() || c == '\u{feff}')
            .starts_with(['=', '+', '-', '@']);
    format!(
        "\"{}{}\"",
        if dangerous { "'" } else { "" },
        value.replace('"', "\"\"")
    )
}

fn record(cells: Vec<String>) -> String {
    format!("{}\r\n", cells.join(","))
}

fn row_csv(row: &AnswerRow, columns: &[FieldOption]) -> String {
    let source = row.source_form.as_ref();
    let mut cells = vec![
        row.id.to_string(),
        row.create_at.and_utc().to_rfc3339(),
        row.target_type.clone(),
        row.target_id.to_string(),
        row.target_name.clone(),
        row.layer_id
            .as_ref()
            .map(|id| id.to_string())
            .unwrap_or_default(),
        row.layer_name.clone().unwrap_or_default(),
        source
            .and_then(|s| s.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        row.common_form_name.clone().unwrap_or_default(),
        source
            .and_then(|s| s.get("version"))
            .map(Value::to_string)
            .unwrap_or_default(),
        if row.form_snapshot.is_some() {
            "あり"
        } else {
            "なし"
        }
        .to_string(),
        row.form_snapshot
            .as_ref()
            .and_then(|s| s.get("form_title"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    ]
    .into_iter()
    .map(|s| csv_cell(&s, true))
    .collect::<Vec<_>>();
    for field in columns {
        let exists = if let Some(snapshot) = &row.form_snapshot {
            snapshot
                .pointer("/form_schema/fields")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|f| f["id"] == field.id && f["type"] == field.field_type)
                })
        } else {
            field.field_type == "unknown" && row.submitted_values.get(&field.id).is_some()
        };
        let value = row.submitted_values.get(&field.id);
        let empty = value.is_none_or(|v| v.is_null() || v.as_str() == Some(""));
        let (raw, untrusted) = match value {
            Some(Value::String(s)) => (s.clone(), true),
            Some(Value::Object(object)) if field.field_type == "image" => (
                object
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                true,
            ),
            Some(value) if !value.is_null() => {
                (value.to_string(), !value.is_boolean() && !value.is_number())
            },
            _ => (String::new(), true),
        };
        cells.push(csv_cell(if exists { &raw } else { "" }, untrusted));
        cells.push(csv_cell(
            if !exists {
                "項目なし"
            } else if empty {
                "未入力"
            } else {
                "回答あり"
            },
            false,
        ));
    }
    record(cells)
}

pub async fn export_answers_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(q): Json<AnswerQuery>,
) -> Result<Response, AppError> {
    let at = q.as_of.unwrap_or_else(Utc::now);
    let (tx, count, fields) = prepare_export(&user, &pool, &q, at).await?;
    stream_csv(
        user,
        tx,
        count,
        fields,
        ExportScope::Answers(q),
        at,
        "geocode-answers.csv",
    )
}

pub(super) enum ExportScope {
    Answers(AnswerQuery),
    Map {
        request: super::answer_map_filter::MapFilterRequest,
        scope: super::answer_map_filter::Scope,
    },
}
impl ExportScope {
    pub(super) fn build(&self, user: &str, at: DateTime<Utc>) -> QueryBuilder<'static, Sqlite> {
        match self {
            Self::Answers(q) => {
                let mut b = build_query(user, q, at);
                b.push(
                    r#"
                    ,
                    export_rows AS (
                        SELECT
                            *
                        FROM filtered
                    )
                    "#,
                );
                b
            },
            Self::Map { request, scope } => {
                let mut b = super::answer_map_filter::matched(user, request, at, scope);
                b.push(
                    r#"
                    ,
                    export_rows AS (
                        SELECT
                            *
                        FROM map_matched
                    )
                    "#,
                );
                b
            },
        }
    }
}

pub(super) fn stream_csv(
    user: String,
    tx: sqlx::Transaction<'static, Sqlite>,
    count: i64,
    fields: Vec<FieldOption>,
    scope: ExportScope,
    at: DateTime<Utc>,
    filename: &'static str,
) -> Result<Response, AppError> {
    let mut headers = [
        "回答ID",
        "投稿日時（UTC）",
        "対象種別",
        "対象ID",
        "対象名（現在）",
        "レイヤID",
        "レイヤ名（現在）",
        "共通フォームID",
        "共通フォーム名（現在）",
        "適用元の版",
        "投稿時定義",
        "投稿時フォーム名",
    ]
    .into_iter()
    .map(|s| csv_cell(s, false))
    .collect::<Vec<_>>();
    for field in &fields {
        headers.push(csv_cell(
            &format!("{} [{}:{}]", field.label, field.id, field.field_type),
            true,
        ));
        headers.push(csv_cell(
            &format!("状態 [{}:{}]", field.id, field.field_type),
            true,
        ));
    }
    let header_row = format!("\u{feff}{}", record(headers));
    // 検索と同じDBスナップショットを保持し、200件単位で出力する。
    let output = stream::try_unfold(
        (tx, 0_i64, Some(header_row), scope, fields, user),
        move |(mut tx, offset, header_row, scope, fields, user)| async move {
            if let Some(header_row) = header_row {
                return Ok::<_, std::io::Error>(Some((
                    header_row,
                    (tx, offset, None, scope, fields, user),
                )));
            }
            if offset >= count {
                tx.commit().await.map_err(std::io::Error::other)?;
                return Ok(None);
            }
            let mut b = scope.build(&user, at);
            b.push(format!(
                r#"
                SELECT
                    {ROW_COLUMNS}
                FROM export_rows
                ORDER BY create_at COLLATE answer_time DESC, id DESC, target_type DESC
                LIMIT 200
                OFFSET
                "#
            ))
            .push_bind(offset);
            let rows = b
                .build_query_as::<AnswerRow>()
                .fetch_all(&mut *tx)
                .await
                .map_err(std::io::Error::other)?;
            let next = offset + rows.len() as i64;
            let chunk = rows
                .iter()
                .map(|row| row_csv(row, &fields))
                .collect::<String>();
            Ok(Some((chunk, (tx, next, None, scope, fields, user))))
        },
    );
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                &format!("attachment; filename={filename}"),
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(output),
    )
        .into_response())
}

#[cfg(test)]
mod search_tests;

#[cfg(test)]
mod tests {
    use super::*;

    // Independent reference: complete SQLite field text, timestamp collation,
    // legacy values, ordering and the definition limit must remain unchanged.
    const PREVIOUS_FIELD_DEFINITIONS: &str = r#"
        SELECT field FROM (
            SELECT field, observed, position FROM (
                SELECT f.value AS field, a.create_at AS observed,
                    CAST(f.key AS INTEGER) AS position,
                    row_number() OVER (
                        PARTITION BY f.value
                        ORDER BY a.create_at COLLATE answer_time DESC, a.id DESC,
                            a.target_type DESC, CAST(f.key AS INTEGER)
                    ) AS definition_rank
                FROM filtered a, json_each(a.form_snapshot, '$.form_schema.fields') f
            ) snapshots WHERE definition_rank = 1
            UNION ALL
            SELECT json_object('id', f.key, 'label', f.key, 'type', 'unknown'),
                max(a.create_at COLLATE answer_time), NULL
            FROM filtered a, json_each(a.submitted_values) f
            WHERE a.form_snapshot IS NULL GROUP BY f.key
        ) definitions
        ORDER BY observed COLLATE answer_time DESC, position NULLS LAST, field
        LIMIT 10001
        "#;

    async fn field_test_pool() -> SqlitePool {
        sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    fn field_source(rows: Value) -> QueryBuilder<'static, Sqlite> {
        // Decode fixture records once, like reading stored answer columns.
        // Inlining would reparse a large snapshot for each expanded field.
        let mut b = QueryBuilder::new(
            r#"
            WITH filtered AS MATERIALIZED (
                SELECT json_extract(r.value, '$.id') AS id,
                    json_extract(r.value, '$.target_type') AS target_type,
                    json_extract(r.value, '$.create_at') AS create_at,
                    json_extract(r.value, '$.form_snapshot') AS form_snapshot,
                    json_extract(r.value, '$.submitted_values') AS submitted_values
                FROM json_each(
            "#,
        );
        b.push_bind(rows).push(") r) ");
        b
    }

    fn field_record(id: u128, kind: &str, at: &str, snapshot: Value, values: Value) -> Value {
        json!({
            "id": Uuid::from_u128(id), "target_type": kind, "create_at": at,
            "form_snapshot": snapshot, "submitted_values": values
        })
    }

    fn snapshot(fields: Value) -> Value {
        json!({"form_schema":{"fields":fields}})
    }

    fn repeated_field_records() -> Value {
        let first = json!({"id":"first","type":"text","label":"先頭","ignored_number":1});
        let current = json!({"id":"state","type":"select","label":"新名","choices":["新","共通"]});
        let text = json!({"id":"state","type":"text","label":"同名の文字列"});
        let fields = json!([first, current, current, text]);
        let mut rows = Vec::new();
        for id in 1..=256 {
            let mut definition = snapshot(fields.clone());
            definition["form_title"] = json!(format!("投稿時の題名{id}"));
            if id % 2 == 0 {
                definition["form_schema"]["fields"][0]["ignored_number"] = json!(1.0);
            }
            rows.push(field_record(
                id,
                "marker",
                "2026-10-01 08:00:00",
                definition,
                json!({}),
            ));
        }
        rows.push(field_record(
            1000,
            "marker",
            "2026-10-01 10:00:00",
            snapshot(json!([current, first, text])),
            json!({}),
        ));
        // Same instant and ID, with a different spelling of the timestamp.
        rows.push(field_record(
            1000,
            "shape",
            "2026-10-01T19:00:00+09:00",
            snapshot(fields.clone()),
            json!({}),
        ));
        let mut reversed = fields.as_array().unwrap().clone();
        reversed.reverse();
        rows.push(field_record(
            1001,
            "marker",
            "2026-10-01 09:00:00",
            snapshot(json!(reversed)),
            json!({}),
        ));
        rows.push(field_record(
            1002,
            "marker",
            "2026-10-01 09:00:00",
            snapshot(json!([
                {"id":"state","type":"select","label":"旧名","choices":["旧","共通"]},
                {"id":"retired","type":"date","label":"廃止項目"}
            ])),
            json!({}),
        ));
        rows.push(field_record(
            1003,
            "marker",
            "2026-10-01 07:00:00",
            Value::Null,
            json!({"legacy_one":"旧回答"}),
        ));
        rows.push(field_record(
            1004,
            "shape",
            "2026-10-01 06:00:00",
            Value::Null,
            json!({"legacy_two":"別の旧回答"}),
        ));
        rows.push(field_record(
            1005,
            "marker",
            "2026-10-01 11:00:00",
            snapshot(json!([])),
            json!({}),
        ));
        rows.push(field_record(
            1006,
            "marker",
            "2026-10-01 12:00:00",
            json!({"form_schema":{}}),
            json!({}),
        ));
        json!(rows)
    }

    fn field_definition_query(rows: Value, previous: bool) -> QueryBuilder<'static, Sqlite> {
        let mut b = field_source(rows);
        if previous {
            b.push(PREVIOUS_FIELD_DEFINITIONS);
        } else {
            append_field_definitions(&mut b, "filtered");
        }
        b
    }

    async fn field_definitions(
        pool: &SqlitePool,
        rows: Value,
        previous: bool,
    ) -> Result<Vec<Value>, sqlx::Error> {
        let mut tx = super::super::answer_sqlite::begin_read(pool).await?;
        field_definition_query(rows, previous)
            .build_query_scalar()
            .fetch_all(&mut *tx)
            .await
    }

    #[tokio::test]
    async fn field_array_representatives_preserve_definitions_and_presentation() {
        let pool = field_test_pool().await;
        let rows = repeated_field_records();
        let previous = field_definitions(&pool, rows.clone(), true).await.unwrap();
        assert_eq!(
            field_definitions(&pool, rows.clone(), false).await.unwrap(),
            previous
        );
        let mut tx = super::super::answer_sqlite::begin_read(&pool)
            .await
            .unwrap();
        let mut order = vec![];
        let fields = fields_from_query(&mut tx, field_source(rows), "filtered", &mut order)
            .await
            .unwrap();
        assert_eq!(
            order,
            [
                ("first", "text"),
                ("state", "select"),
                ("state", "text"),
                ("retired", "date"),
                ("legacy_one", "unknown"),
                ("legacy_two", "unknown")
            ]
            .map(|(id, kind)| (id.to_owned(), kind.to_owned()))
        );
        let state = &fields[&("state".into(), "select".into())];
        assert_eq!(state.label, "新名");
        assert_eq!(state.choices, ["新", "共通", "旧"]);
    }

    #[tokio::test]
    async fn field_array_representatives_preserve_both_definition_limits() {
        let pool = field_test_pool().await;
        for (count, unique_ids, error) in [
            (200, true, None),
            (201, true, Some("200件")),
            (10_000, false, None),
            (10_001, false, Some("項目定義が多すぎます")),
        ] {
            let definitions: Vec<_> = (0..count)
                .map(|n| {
                    json!({
                        "id": if unique_ids { format!("field_{n}") } else { "field".into() },
                        "type":"text", "label":format!("定義{n}")
                    })
                })
                .collect();
            let rows = json!([field_record(
                1,
                "marker",
                "2026-10-01 10:00:00",
                snapshot(json!(definitions)),
                json!({})
            )]);
            assert_eq!(
                field_definitions(&pool, rows.clone(), false).await.unwrap(),
                field_definitions(&pool, rows.clone(), true).await.unwrap()
            );
            let mut tx = super::super::answer_sqlite::begin_read(&pool)
                .await
                .unwrap();
            let result =
                fields_from_query(&mut tx, field_source(rows), "filtered", &mut vec![]).await;
            if let Some(message) = error {
                assert!(
                    matches!(result, Err(AppError::Validation(ref text)) if text.contains(message))
                );
            } else {
                assert_eq!(result.unwrap().len(), if unique_ids { count } else { 1 });
            }
        }
    }

    #[tokio::test]
    async fn field_array_representatives_keep_json_types_and_field_text() {
        let pool = field_test_pool().await;
        let field = json!({"id":"value","type":"text","label":"配列の項目"});
        let array = json!([field]);
        let rows = json!([
            field_record(
                1,
                "marker",
                "2026-10-01 08:00:00",
                snapshot(array.clone()),
                json!({})
            ),
            field_record(
                2,
                "marker",
                "2026-10-01 09:00:00",
                snapshot(json!(array.to_string())),
                json!({})
            ),
            field_record(
                3,
                "marker",
                "2026-10-01 10:00:00",
                snapshot(Value::Null),
                json!({})
            ),
            field_record(
                4,
                "marker",
                "2026-10-01 11:00:00",
                json!({"form_schema":{}}),
                json!({})
            ),
            field_record(
                5,
                "marker",
                "2026-10-01 12:00:00",
                snapshot(json!([])),
                json!({})
            ),
            field_record(
                6,
                "marker",
                "2026-10-01 07:00:00",
                snapshot(json!({"x":{"id":"object","type":"text","label":"非配列"}})),
                json!({})
            ),
            field_record(
                7,
                "marker",
                "2026-10-01 06:00:00",
                Value::Null,
                json!({"legacy":"旧回答"})
            )
        ]);
        let mut results = Vec::new();
        for previous in [true, false] {
            let mut tx = super::super::answer_sqlite::begin_read(&pool)
                .await
                .unwrap();
            let values: Vec<Option<String>> = field_definition_query(rows.clone(), previous)
                .build_query_scalar()
                .fetch_all(&mut *tx)
                .await
                .unwrap();
            assert_eq!(values.len(), 5);
            assert_eq!(values[0], None);
            assert_eq!(values[1].as_deref(), Some(array.to_string().as_str()));
            results.push(values);
        }
        assert_eq!(results[0], results[1]);
        // Keep key order and numeric spellings significant for SQLite field
        // text, even when serde_json would decode them to equivalent objects.
        let rows = json!([
            field_record(
                1,
                "marker",
                "2026-10-01 08:00:00",
                json!(
                    r#"{"form_schema":{"fields":[{"id":"raw","type":"text","label":"表記","ignored":1}]}}"#
                ),
                json!({})
            ),
            field_record(
                2,
                "marker",
                "2026-10-01 09:00:00",
                json!(
                    r#"{"form_schema":{"fields":[{"label":"表記","type":"text","id":"raw","ignored":1.0}]}}"#
                ),
                json!({})
            )
        ]);
        let old = field_definitions(&pool, rows.clone(), true).await.unwrap();
        assert_eq!(old.len(), 2);
        assert_eq!(field_definitions(&pool, rows, false).await.unwrap(), old);
    }

    #[tokio::test]
    #[ignore = "diagnostic benchmark: compares SQL medians without a timing threshold"]
    async fn measure_field_array_representatives() {
        let pool = field_test_pool().await;
        for distinct in [false, true] {
            let rows: Vec<_> = (0..2_000)
                .map(|n| {
                    let fields: Vec<_> = (0..5).map(|f| json!({
                    "id":format!("field_{f}"), "type":"text", "label":format!("項目{f}"),
                    "choices": if distinct { vec![format!("回答{n}")] } else { vec!["共通".into()] }
                })).collect();
                    field_record(
                        n + 1,
                        "marker",
                        "2026-10-01 10:00:00",
                        snapshot(json!(fields)),
                        json!({}),
                    )
                })
                .collect();
            let rows = json!(rows);
            let expected = field_definitions(&pool, rows.clone(), true).await.unwrap();
            assert_eq!(
                field_definitions(&pool, rows.clone(), false).await.unwrap(),
                expected
            );
            let mut times = [vec![], vec![]];
            for sample in 0..3 {
                let modes = if sample % 2 == 0 {
                    [true, false]
                } else {
                    [false, true]
                };
                for previous in modes {
                    let index = if previous { 0 } else { 1 };
                    let input = rows.clone();
                    let start = std::time::Instant::now();
                    let actual = field_definitions(&pool, input, previous).await.unwrap();
                    times[index].push(start.elapsed().as_secs_f64() * 1000.0);
                    assert_eq!(actual, expected);
                }
            }
            for samples in &mut times {
                samples.sort_by(f64::total_cmp);
            }
            println!(
                "fields distinct={distinct}: previous={:.2}ms representatives={:.2}ms (3-sample median, synthetic source and query)",
                times[0][1], times[1][1]
            );
        }
    }

    #[test]
    fn csv_escapes_formula_strings_and_quotes() {
        assert_eq!(csv_cell(" =SUM(A1)", true), "\"' =SUM(A1)\"");
        assert_eq!(csv_cell("a,\"b\"\r\nc", true), "\"a,\"\"b\"\"\r\nc\"");
        assert_eq!(csv_cell("-12.5", false), "\"-12.5\"");
        assert_eq!(csv_cell("\t@SUM(A1)", true), "\"'\t@SUM(A1)\"");
    }
    #[test]
    fn rejects_unscoped_and_invalid_typed_conditions() {
        let mut q = AnswerQuery {
            conditions: vec![AnswerCondition {
                field_id: "n".into(),
                field_type: "number".into(),
                op: "gte".into(),
                value: json!("bad"),
                upper: Value::Null,
            }],
            ..Default::default()
        };
        assert_eq!(
            number(&json!("9007199254740993")).unwrap(),
            "9007199254740993"
        );
        assert!(validate(&q).is_err());
        q.common_form_id = Some(Uuid::new_v4().to_string());
        assert!(validate(&q).is_err());
        q.conditions[0].value = json!("-12.5");
        assert!(validate(&q).is_ok());
        q.conditions[0].op = "contains".into();
        assert!(validate(&q).is_err());
    }
}

async fn prepare_export(
    user: &str,
    pool: &SqlitePool,
    q: &AnswerQuery,
    at: DateTime<Utc>,
) -> Result<(sqlx::Transaction<'static, Sqlite>, i64, Vec<FieldOption>), AppError> {
    validate(&q)?;
    let mut tx = super::answer_sqlite::begin_read(&pool).await?;
    let count = build_query(&user, &q, at)
        .push(
            r#"
            SELECT
                count(*)
            FROM filtered
            "#,
        )
        .build_query_scalar::<i64>()
        .fetch_one(&mut *tx)
        .await?;
    if count > EXPORT_LIMIT {
        return Err(invalid(
            "CSVは10000件まで出力できます。検索条件を絞り込んでください。",
        ));
    }
    let fields = answer_fields(&mut tx, user, q, at, &mut vec![])
        .await?
        .into_values()
        .collect();
    Ok((tx, count, fields))
}

pub async fn check_csv_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(q): Json<AnswerQuery>,
) -> Result<Json<Value>, AppError> {
    let (tx, count, _) = prepare_export(&user, &pool, &q, q.as_of.unwrap_or_else(Utc::now)).await?;
    tx.commit().await?;
    Ok(Json(json!({"count":count})))
}

#[derive(Deserialize)]
pub struct CsvDownload {
    pub query: String,
}

/// ネイティブダウンロード用。ブラウザで全回答をBlobに蓄積しない。
pub async fn download_answers_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    axum::Form(form): axum::Form<CsvDownload>,
) -> Result<Response, AppError> {
    let q = serde_json::from_str::<AnswerQuery>(&form.query)
        .map_err(|_| invalid("CSV検索条件が不正です。"))?;
    export_answers_handler(Extension(user), Extension(pool), Json(q)).await
}
