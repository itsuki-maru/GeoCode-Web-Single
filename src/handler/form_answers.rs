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
    let mut b = QueryBuilder::new(
        r#"
        WITH owned AS (
        "#,
    );
    for (index, kind) in ["marker", "shape"].iter().enumerate() {
        if index > 0 {
            b.push(" UNION ALL ");
        }
        let (table, name) = if *kind == "marker" {
            ("marker_info_model", "m.marker_name")
        } else {
            ("shape_model", "COALESCE(m.name, '名称なし')")
        };
        b.push(format!(
            r#"
            SELECT
                s.id,
                '{kind}' AS target_type,
                m.id AS target_id,
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
            FROM {kind}_form_submission_model s
            JOIN {table} m ON m.id = s.{kind}_id
            LEFT JOIN layer_model l ON l.id = m.layer_id
                AND l.user_id = m.user_id
            LEFT JOIN common_form_model cf ON cf.id = s.source_form ->> 'id'
                AND cf.user_id = m.user_id
            WHERE m.user_id =
            "#
        ))
        .push_bind(user.to_owned());
    }
    b.push("), scoped AS (SELECT * FROM owned WHERE create_at COLLATE answer_time <= ")
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
    b.push(
        r#"
        ), ranked AS (
            SELECT *, row_number() OVER (
                PARTITION BY target_type, target_id, COALESCE(source_form ->> 'id', 'individual')
                ORDER BY create_at COLLATE answer_time DESC, id DESC
            ) AS rn FROM scoped
        ), filtered AS (
            SELECT * FROM ranked WHERE TRUE
        "#,
    );
    if q.mode == "latest" {
        b.push(" AND rn = 1");
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
    id, target_type, target_id, target_name, layer_id, layer_name, create_at, edited_at, revision, submitted_values, form_snapshot,
        source_form, common_form_name, common_form_deleted
    "#;

pub async fn search_answers_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(q): Json<AnswerQuery>,
) -> Result<Json<AnswerPage>, AppError> {
    validate(&q)?;
    let at = q.as_of.unwrap_or_else(Utc::now);
    let mut tx = super::answer_sqlite::begin_read(&pool).await?;
    let (total, target_count): (i64, i64) = build_query(&user, &q, at)
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
    let mut b = build_query(&user, &q, at);
    b.push(format!(
        r#"
        SELECT
            {ROW_COLUMNS}
        FROM filtered
        WHERE TRUE
        "#
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
    b.push(" ORDER BY create_at COLLATE answer_time DESC,id DESC,target_type DESC LIMIT ")
        .push_bind(size + 1);
    let mut rows = b.build_query_as::<AnswerRow>().fetch_all(&mut *tx).await?;
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
    b.push(format!(r#"
    SELECT
        field
    FROM ( SELECT field, observed, position FROM ( SELECT f.value AS field, a.create_at AS observed, CAST(f.key AS INTEGER) AS position, row_number() OVER ( PARTITION BY f.value ORDER BY a.create_at COLLATE answer_time DESC, a.id DESC, a.target_type DESC, CAST(f.key AS INTEGER) ) AS definition_rank FROM {source} a, json_each(a.form_snapshot, '$.form_schema.fields') f ) snapshots WHERE definition_rank = 1 UNION ALL SELECT json_object('id', f.key, 'label', f.key, 'type', 'unknown'), max(a.create_at COLLATE answer_time), NULL FROM {source} a, json_each(a.submitted_values) f WHERE a.form_snapshot IS NULL GROUP BY f.key ) definitions
    ORDER BY observed COLLATE answer_time DESC,
    position NULLS LAST,
    field
    LIMIT 10001
    "#));
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
    let forms: Vec<(String, String, bool)> = sqlx::query_as(
        r#"
        SELECT
            f.id,
            f.form_title,
            f.deleted
        FROM common_form_model f
        WHERE f.user_id = $1
            AND ( NOT f.deleted OR EXISTS ( SELECT 1 FROM marker_form_submission_model s JOIN marker_info_model m ON m.id = s.marker_id WHERE m.user_id = $1 AND s.source_form ->> 'id' = f.id ) OR EXISTS ( SELECT 1 FROM shape_form_submission_model s JOIN shape_model m ON m.id = s.shape_id WHERE m.user_id = $1 AND s.source_form ->> 'id' = f.id ) )
        ORDER BY f.update_at DESC,
        f.id
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
                b.push(", export_rows AS (SELECT * FROM filtered)");
                b
            },
            Self::Map { request, scope } => {
                let mut b = super::answer_map_filter::matched(user, request, at, scope);
                b.push(", export_rows AS (SELECT * FROM map_matched)");
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
                ORDER BY create_at COLLATE answer_time DESC,
                id DESC,
                target_type DESC
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
mod tests {
    use super::*;
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
