//! 所有者の最新登録から入力例だけを作る。LLM・外部接続・業務更新は行わない。
use super::{
    actions::{AiAction, AiCondition, ColorRule, Expression, MapContext},
    settings,
};
use crate::{
    error::AppError,
    handler::{
        ai::{acquire_suggestion_request, validate_account},
        answer_map_filter::suggestion_fields,
        answer_sqlite::{begin_read, compare_numbers},
        form_answers::{AnswerQuery, FieldOption, build_query},
    },
};
use axum::{
    Json,
    extract::Extension,
    http::{HeaderMap, header::CACHE_CONTROL},
    response::IntoResponse,
};
use chrono::{DateTime, NaiveDate, Utc};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite, SqlitePool, Transaction};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_ROWS: i64 = 50_000;
const MAX_FORMS: usize = 3;
const MAX_FIELDS: usize = 8;
const MAX_SUGGESTIONS: usize = 3;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuggestionRequest {
    pub revision: Uuid,
    pub context: MapContext,
}

#[derive(Debug, Serialize)]
pub struct Suggestion {
    pub text: String,
    pub kind: &'static str,
}

#[derive(Serialize)]
pub struct SuggestionResponse {
    revision: Uuid,
    as_of: DateTime<Utc>,
    suggestions: Vec<Suggestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

async fn require_config(pool: &SqlitePool, revision: Uuid) -> Result<settings::AiConfig, AppError> {
    let (current, config) = settings::load_config(pool).await?;
    if !config.enabled {
        return Err(AppError::Forbidden(
            "AI機能は管理者により無効になっています。".into(),
        ));
    }
    if current != Some(revision) {
        return Err(AppError::Conflict);
    }
    Ok(config)
}

pub async fn suggest(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
    Json(request): Json<SuggestionRequest>,
) -> Result<impl IntoResponse, AppError> {
    validate_account(&user, &headers)?;
    let config = require_config(&pool, request.revision).await?;
    let permit = acquire_suggestion_request(&user, config.max_requests_per_minute)?;
    super::actions::validate_scope(&pool, &user, &request.context.layer_ids).await?;
    let at = Utc::now();
    let task_pool = pool.clone();
    let task_user = user.clone();
    let task_ids = request.context.layer_ids.clone();
    // HTTP待機が中断されても、SQL停止・接続設定の復元が終わるまで専用枠を保持する。
    let result = tokio::spawn(async move {
        let _permit = permit;
        collect(&task_pool, &task_user, &task_ids, at).await
    })
    .await
    .map_err(|_| AppError::InternalServerError)?;
    let (suggestions, reason) = match result {
        Err(AppError::Sqlx(error))
            if is_timeout(&error) || error.to_string().contains("入力候補の取得期限") =>
        {
            (vec![], Some("timeout"))
        },
        Err(AppError::Sqlx(error)) if error.to_string().contains("malformed JSON") => {
            (vec![], Some("empty"))
        },
        value => value?,
    };
    require_config(&pool, request.revision).await?;
    super::actions::validate_scope(&pool, &user, &request.context.layer_ids).await?;
    Ok((
        [(CACHE_CONTROL, "no-store")],
        Json(SuggestionResponse {
            revision: request.revision,
            as_of: at,
            reason,
            suggestions,
        }),
    ))
}

fn scoped_query(
    user: &str,
    ids: &Option<Vec<Uuid>>,
    at: DateTime<Utc>,
) -> QueryBuilder<'static, Sqlite> {
    let mut query = build_query(
        user,
        &AnswerQuery {
            mode: "latest".into(),
            ..Default::default()
        },
        at,
    );
    query.push(", candidate_scope AS MATERIALIZED (SELECT * FROM filtered WHERE TRUE");
    if let Some(ids) = ids {
        query
            .push(" AND layer_id IN (SELECT value FROM json_each(")
            .push_bind(
                serde_json::to_string(&ids.iter().map(Uuid::to_string).collect::<Vec<_>>())
                    .unwrap(),
            )
            .push("))");
    }
    query
        .push(" ORDER BY create_at COLLATE answer_time DESC,id DESC,target_type LIMIT ")
        .push_bind(MAX_ROWS + 1)
        .push(")");
    query
}

#[derive(sqlx::FromRow)]
struct FormProfile {
    form_id: String,
    label: String,
    rows: i64,
}

async fn collect(
    pool: &SqlitePool,
    user: &str,
    ids: &Option<Vec<Uuid>>,
    at: DateTime<Utc>,
) -> Result<(Vec<Suggestion>, Option<&'static str>), AppError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut tx = match tokio::time::timeout_at(deadline.into(), begin_read(pool)).await {
        Ok(value) => value?,
        Err(_) => return Ok((vec![], Some("timeout"))),
    };
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&mut *tx)
        .await?;
    let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("PRAGMA busy_timeout=100")
        .execute(&mut *tx)
        .await?;
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut *tx)
        .await?;
    {
        let mut handle = tx.lock_handle().await?;
        // SQLiteワーカースレッド上の実行も期限で止め、HTTP側だけの取消に依存しない。
        handle.set_progress_handler(1_000, move || Instant::now() < deadline);
    }
    let result = collect_in_transaction(&mut tx, user, ids, at, deadline).await;
    // 期限切れのコールバックをプールの次の利用者へ残さない。
    tx.lock_handle().await?.remove_progress_handler();
    sqlx::query(&format!("PRAGMA busy_timeout={busy_timeout}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!("PRAGMA query_only={query_only}"))
        .execute(&mut *tx)
        .await?;
    tx.rollback().await?;
    result
}

fn is_timeout(error: &sqlx::Error) -> bool {
    error.as_database_error().is_some_and(|error| {
        error
            .code()
            .and_then(|code| code.parse::<u32>().ok())
            .is_some_and(|code| matches!(code & 255, 9 | 5 | 6))
    })
}

async fn collect_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    ids: &Option<Vec<Uuid>>,
    at: DateTime<Utc>,
    deadline: Instant,
) -> Result<(Vec<Suggestion>, Option<&'static str>), AppError> {
    let forms: Vec<FormProfile> = scoped_query(user, ids, at)
        .push(
            r#"
        , form_counts AS (
            SELECT COALESCE(source_form->>'id','') AS form_id,
                COALESCE(common_form_name,form_snapshot->>'form_title','') AS label,
                count(*) OVER (PARTITION BY source_form->>'id') AS rows,
                row_number() OVER (PARTITION BY source_form->>'id'
                    ORDER BY create_at COLLATE answer_time DESC,id DESC) AS form_rank
            FROM candidate_scope
        ) SELECT form_id,label,rows FROM form_counts WHERE form_rank=1
        ORDER BY rows DESC,form_id
    "#,
        )
        .build_query_as()
        .fetch_all(&mut **tx)
        .await?;
    if forms.iter().map(|f| f.rows).sum::<i64>() > MAX_ROWS || forms.len() > 200 {
        return Ok((vec![], Some("limit")));
    }
    // 現行フォーム名も含め、同名フォームを自然言語だけで誤指定しない。
    let current: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT
            id,
            form_title
        FROM common_form_model
        WHERE user_id = $1
            AND NOT deleted
        ORDER BY id
        LIMIT 201
        "#,
    )
    .bind(user)
    .fetch_all(&mut **tx)
    .await?;
    if current.len() > 200 {
        return Ok((vec![], Some("limit")));
    }
    let mut names: BTreeMap<String, BTreeSet<Uuid>> = BTreeMap::new();
    for (id, name) in current {
        if let Ok(id) = Uuid::parse_str(&id) {
            names.entry(name).or_default().insert(id);
        }
    }
    for form in &forms {
        if let Ok(id) = Uuid::parse_str(&form.form_id) {
            names.entry(form.label.clone()).or_default().insert(id);
        }
    }
    let mut selected = vec![];
    for form in forms
        .iter()
        .filter(|f| safe_label(&f.label) && names.get(&f.label).is_some_and(|ids| ids.len() == 1))
        .take(MAX_FORMS)
    {
        let Ok(form_id) = Uuid::parse_str(&form.form_id) else {
            continue;
        };
        let all_fields = match suggestion_fields(tx, user, form_id, ids, at).await {
            Ok(fields) => fields,
            Err(AppError::Validation(_)) => continue,
            Err(AppError::Sqlx(sqlx::Error::ColumnDecode { .. })) => continue,
            Err(error) => return Err(error),
        };
        let fields: Vec<_> = all_fields
            .iter()
            .filter(|field| {
                safe_field(field)
                    && all_fields
                        .iter()
                        .filter(|other| other.label == field.label)
                        .count()
                        == 1
            })
            .take(MAX_FIELDS)
            .collect();
        if fields.is_empty() {
            continue;
        }
        let profiles = profiles(tx, user, ids, at, form_id, &fields, deadline).await?;
        for field in fields {
            if let Some(profile) = profiles
                .iter()
                .find(|p| p.field_id == field.id && p.field_type == field.field_type)
            {
                selected.extend(make_suggestions(&form.label, form_id, field, profile));
            }
        }
    }
    if Instant::now() >= deadline {
        return Ok((vec![], Some("timeout")));
    }
    // 値の抽出、分類、未入力確認の順を安定させ、同じ文章は返さない。
    selected.sort_by_key(|(priority, suggestion)| (*priority, suggestion.text.clone()));
    let mut seen = BTreeSet::new();
    let mut priorities = BTreeSet::new();
    let mut suggestions = vec![];
    let mut remaining = vec![];
    for (priority, suggestion) in selected {
        if !seen.insert(suggestion.text.clone()) {
            continue;
        }
        if priorities.insert(priority) {
            suggestions.push(suggestion);
        } else {
            remaining.push(suggestion);
        }
    }
    suggestions.extend(remaining);
    suggestions.truncate(MAX_SUGGESTIONS);
    let reason = suggestions.is_empty().then_some("empty");
    Ok((suggestions, reason))
}

fn safe_label(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= 80
        && !value
            .chars()
            .any(|c| c.is_control() || "「」『』\"".contains(c))
}

fn safe_field(field: &FieldOption) -> bool {
    safe_label(&field.label)
        && !field.id.is_empty()
        && field.id.len() <= 40
        && field
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && matches!(
            field.field_type.as_str(),
            "select" | "radio" | "checkbox" | "number" | "date" | "text" | "textarea" | "image"
        )
}

#[derive(Default)]
struct Profile {
    field_id: String,
    field_type: String,
    empty_count: i64,
    min_number: Option<String>,
    max_number: Option<String>,
    midpoint: Option<String>,
    min_date: Option<String>,
    max_date: Option<String>,
    categories: Value,
}

#[derive(sqlx::FromRow)]
struct MeasuredValue {
    field_id: String,
    field_type: String,
    value: Option<String>,
    declared: bool,
    choices: Option<String>,
}

async fn profiles(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    ids: &Option<Vec<Uuid>>,
    at: DateTime<Utc>,
    form_id: Uuid,
    fields: &[&FieldOption],
    deadline: Instant,
) -> Result<Vec<Profile>, AppError> {
    let definitions: Vec<_> = fields
        .iter()
        .map(|f| json!({"id":f.id,"field_type":f.field_type}))
        .collect();
    let mut query = scoped_query(user, ids, at);
    query
        .push(
            r#"
            , raw_values AS MATERIALIZED (
                SELECT
                    f.value->>'id' AS field_id,
                    f.value->>'field_type' AS field_type,
                    s.submitted_values -> ('$.' || (f.value->>'id')) AS value,
                    (
                        SELECT d.value
                        FROM json_each(
                            CASE
                                WHEN json_type(s.form_snapshot,'$.form_schema.fields') = 'array'
                                THEN json_extract(s.form_snapshot,'$.form_schema.fields')
                                ELSE '[]'
                            END
                        ) d
                        WHERE d.value->>'id' = f.value->>'id'
                            AND d.value->>'type' = f.value->>'field_type'
                        LIMIT 1
                    ) AS definition
                FROM candidate_scope s
                CROSS JOIN json_each(
            "#,
        )
        .push_bind(json!(definitions))
        .push(
            r#"
                ) f
                WHERE s.source_form->>'id' =
            "#,
        )
        .push_bind(form_id.to_string())
        .push(
            r#"
            )
            SELECT
                field_id,
                field_type,
                value,
                definition IS NOT NULL AS declared,
                definition->'choices' AS choices
            FROM raw_values
            "#,
        );
    let mut result: BTreeMap<(String, String), Profile> = fields
        .iter()
        .map(|field| {
            (
                (field.id.clone(), field.field_type.clone()),
                Profile {
                    field_id: field.id.clone(),
                    field_type: field.field_type.clone(),
                    ..Default::default()
                },
            )
        })
        .collect();
    let mut categories: BTreeMap<(String, String), BTreeMap<String, i64>> = BTreeMap::new();
    let prepared = query.build_query_as::<MeasuredValue>();
    let mut rows = prepared.fetch(&mut **tx);
    while let Some(row) = rows.try_next().await? {
        if Instant::now() >= deadline {
            return Err(sqlx::Error::Protocol("入力候補の取得期限を超えました。".into()).into());
        }
        if !row.declared {
            continue;
        }
        let p = result
            .get_mut(&(row.field_id.clone(), row.field_type.clone()))
            .expect("選択済みの項目");
        let value: Value = if let Some(raw) = row.value.as_deref() {
            let Ok(value) = serde_json::from_str(raw) else {
                // 型の不正や過剰に深い値を、未入力へ読み替えない。
                continue;
            };
            value
        } else {
            Value::Null
        };
        if value.is_null() || value == json!("") {
            p.empty_count += 1;
        }
        if row.field_type == "number" && value.is_number() {
            // JSON1のREAL変換を経由せず、保存された数値トークンを厳密に比較する。
            let raw = value.to_string();
            if compare_numbers(&raw, "") == Ordering::Greater {
                if p.min_number
                    .as_deref()
                    .is_none_or(|lo| compare_numbers(&raw, lo) == Ordering::Less)
                {
                    p.min_number = Some(raw.clone());
                }
                if p.max_number
                    .as_deref()
                    .is_none_or(|hi| compare_numbers(&raw, hi) == Ordering::Greater)
                {
                    p.max_number = Some(raw);
                }
            }
        }
        if row.field_type == "date" {
            if let Some(date) = value
                .as_str()
                .filter(|raw| raw.len() == 10)
                .filter(|raw| NaiveDate::parse_from_str(raw, "%Y-%m-%d").is_ok())
            {
                if p.min_date.as_deref().is_none_or(|lo| date < lo) {
                    p.min_date = Some(date.into());
                }
                if p.max_date.as_deref().is_none_or(|hi| date > hi) {
                    p.max_date = Some(date.into());
                }
            }
        }
        let category = if row.field_type == "checkbox" {
            value.is_boolean()
        } else if matches!(row.field_type.as_str(), "select" | "radio") && value.is_string() {
            row.choices
                .as_deref()
                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                .and_then(|v| v.as_array().map(|choices| choices.contains(&value)))
                .unwrap_or(false)
        } else {
            false
        };
        if category {
            *categories
                .entry((row.field_id, row.field_type))
                .or_default()
                .entry(value.to_string())
                .or_default() += 1;
        }
    }
    for p in result.values_mut() {
        p.midpoint = p
            .min_number
            .as_deref()
            .zip(p.max_number.as_deref())
            .and_then(|(lo, hi)| midpoint(lo, hi));
        let mut values: Vec<_> = categories
            .remove(&(p.field_id.clone(), p.field_type.clone()))
            .unwrap_or_default()
            .into_iter()
            .collect();
        values.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        p.categories =
            json!(values.into_iter().take(11).map(|(value,count)| {
            json!({"value":serde_json::from_str::<Value>(&value).unwrap(),"count":count})
        }).collect::<Vec<_>>());
    }
    Ok(result.into_values().collect())
}

/// 有限十進数の加算と二分だけを文字列で行い、IEEE754の丸めを混入させない。
fn midpoint(lo: &str, hi: &str) -> Option<String> {
    // 保存数値と同じ100桁・小数100桁・指数3桁の制限を、確保や指数演算より前に適用する。
    // compare_numbersの検索用接頭辞は保存されたJSON数値には現れないため受け付けない。
    if [lo, hi].into_iter().any(|raw| {
        !raw.bytes()
            .all(|byte| byte.is_ascii_digit() || b"eE+.-".contains(&byte))
            || compare_numbers(raw, "") != Ordering::Greater
    }) {
        return None;
    }
    fn parts(raw: &str) -> Option<(bool, String, i32)> {
        let negative = raw.starts_with('-');
        let unsigned = raw.trim_start_matches(['+', '-']);
        let mut exponent = unsigned.split(['e', 'E']);
        let mantissa = exponent.next()?;
        let exponent = exponent.next().map_or(Some(0), |v| v.parse::<i32>().ok())?;
        let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        Some((
            negative,
            format!("{integer}{fraction}"),
            fraction.len() as i32 - exponent,
        ))
    }
    let (an, mut ad, ascale) = parts(lo)?;
    let (bn, mut bd, bscale) = parts(hi)?;
    let scale = ascale.max(bscale).max(0);
    ad.extend(std::iter::repeat_n('0', (scale - ascale) as usize));
    bd.extend(std::iter::repeat_n('0', (scale - bscale) as usize));
    let width = ad.len().max(bd.len());
    ad = format!("{:0>width$}", ad);
    bd = format!("{:0>width$}", bd);
    let (negative, large, small, subtract) = if an == bn {
        (an, ad, bd, false)
    } else if ad >= bd {
        (an, ad, bd, true)
    } else {
        (bn, bd, ad, true)
    };
    let mut carry = 0_i16;
    let mut digits = Vec::with_capacity(width + 1);
    for (a, b) in large.bytes().rev().zip(small.bytes().rev()) {
        let value = if subtract {
            (a - b'0') as i16 - (b - b'0') as i16 + carry
        } else {
            (a - b'0') as i16 + (b - b'0') as i16 + carry
        };
        if subtract {
            carry = if value < 0 { -1 } else { 0 };
            digits.push((value.rem_euclid(10)) as u8 + b'0');
        } else {
            carry = value / 10;
            digits.push((value % 10) as u8 + b'0');
        }
    }
    if carry > 0 {
        digits.push(carry as u8 + b'0');
    }
    digits.reverse();
    let mut remainder = 0;
    let mut half = String::with_capacity(digits.len() + 1);
    for digit in digits {
        let value = remainder * 10 + digit - b'0';
        half.push((value / 2 + b'0') as char);
        remainder = value % 2;
    }
    let scale = if remainder > 0 {
        half.push('5');
        scale + 1
    } else {
        scale
    } as usize;
    if half.len() <= scale {
        half = format!("{}{}", "0".repeat(scale + 1 - half.len()), half);
    }
    if scale > 0 {
        half.insert(half.len() - scale, '.');
        half = half.trim_end_matches('0').trim_end_matches('.').to_owned();
    }
    let half = half.trim_start_matches('0');
    let half = if half.is_empty() {
        "0".into()
    } else if half.starts_with('.') {
        format!("0{half}")
    } else {
        half.to_owned()
    };
    Some(if negative && half != "0" {
        format!("-{half}")
    } else {
        half
    })
}

fn condition(field: &FieldOption, op: &str, value: Value) -> AiCondition {
    AiCondition {
        field_id: field.id.clone(),
        field_type: field.field_type.clone(),
        op: op.into(),
        value,
        upper: Value::Null,
    }
}

fn valid_filter(form: Uuid, condition: AiCondition) -> bool {
    AiAction::Filter {
        expression: Expression::Attribute {
            common_form_id: form,
            conditions: vec![condition],
        },
    }
    .validate()
    .is_ok()
}

fn make_suggestions(
    form_label: &str,
    form: Uuid,
    field: &FieldOption,
    p: &Profile,
) -> Vec<(u8, Suggestion)> {
    let prefix = format!("「{form_label}」フォームの「{}」", field.label);
    let mut result = vec![];
    let mut add = |priority, text: String, kind| {
        if text.chars().count() <= 300 {
            result.push((priority, Suggestion { text, kind }));
        }
    };
    let categories = p.categories.as_array().cloned().unwrap_or_default();
    if matches!(field.field_type.as_str(), "select" | "radio" | "checkbox") {
        let usable: Vec<_> = categories
            .iter()
            .filter_map(|c| {
                let value = c.get("value")?;
                let label = if field.field_type == "checkbox" {
                    if value.as_bool()? {
                        "はい".into()
                    } else {
                        "いいえ".into()
                    }
                } else {
                    value.as_str()?.to_owned()
                };
                safe_label(&label).then_some((value.clone(), label))
            })
            .collect();
        if let Some((value, label)) = usable.first() {
            let c = condition(
                field,
                if field.field_type == "checkbox" {
                    "eq"
                } else {
                    "in"
                },
                if field.field_type == "checkbox" {
                    value.clone()
                } else {
                    json!([value])
                },
            );
            if valid_filter(form, c) {
                add(
                    0,
                    format!("{prefix}が「{label}」の地図オブジェクトを抽出して"),
                    "filter",
                );
            }
        }
        if usable.len() >= 2
            && categories.len() == usable.len()
            && usable.len() <= 8
            && (field.field_type == "checkbox" || field.choices.len() <= 8)
        {
            let rules: Vec<_> = usable
                .iter()
                .enumerate()
                .map(|(i, (value, label))| ColorRule {
                    id: format!("suggestion_{i}"),
                    label: label.clone(),
                    color: "#0072b2".into(),
                    conditions: vec![condition(
                        field,
                        if field.field_type == "checkbox" {
                            "eq"
                        } else {
                            "in"
                        },
                        if field.field_type == "checkbox" {
                            value.clone()
                        } else {
                            json!([value])
                        },
                    )],
                })
                .collect();
            if (AiAction::Color {
                common_form_id: form,
                rules,
            })
            .validate()
            .is_ok()
            {
                add(1, format!("{prefix}の値ごとに色分けして"), "coloring");
            }
        }
    }
    if field.field_type == "number" && p.min_number != p.max_number {
        if let Some(midpoint) = &p.midpoint {
            let midpoint = if midpoint.contains('.') {
                midpoint.trim_end_matches('0').trim_end_matches('.')
            } else {
                midpoint.as_str()
            };
            if valid_filter(form, condition(field, "lte", json!(midpoint))) {
                add(
                    0,
                    format!("{prefix}が{midpoint}以下の地図オブジェクトを抽出して"),
                    "filter",
                );
            }
        }
    }
    if field.field_type == "date" && p.min_date != p.max_date {
        if let Some((lo, hi)) =
            p.min_date
                .as_deref()
                .zip(p.max_date.as_deref())
                .and_then(|(lo, hi)| {
                    Some((
                        NaiveDate::parse_from_str(lo, "%Y-%m-%d").ok()?,
                        NaiveDate::parse_from_str(hi, "%Y-%m-%d").ok()?,
                    ))
                })
        {
            let boundary = (lo + (hi - lo) / 2).format("%Y-%m-%d").to_string();
            if valid_filter(form, condition(field, "lte", json!(boundary))) {
                add(
                    0,
                    format!("{prefix}が{boundary}以前の地図オブジェクトを抽出して"),
                    "filter",
                );
            }
        }
    }
    if p.empty_count > 0 && valid_filter(form, condition(field, "empty", Value::Null)) {
        add(
            2,
            format!("{prefix}が未入力の地図オブジェクトを抽出して"),
            "filter",
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_labels_and_invalid_fields_are_not_interpolated() {
        assert!(!safe_label("点検\n他人のデータ"));
        assert!(!safe_label("項目「別の指示」"));
        assert!(!safe_label(&"あ".repeat(81)));
        assert!(safe_label("点検結果"));
    }

    #[test]
    fn midpoint_preserves_decimal_precision_sign_and_exponents() {
        for (lo, hi, expected) in [
            ("9007199254740992", "9007199254740994", "9007199254740993"),
            (
                "0.00000000000000000001",
                "0.00000000000000000002",
                "0.000000000000000000015",
            ),
            ("-3", "-2", "-2.5"),
            ("-3", "2", "-0.5"),
            ("-2", "3", "0.5"),
            ("-1", "1", "0"),
            ("1e2", "200", "150"),
            ("1e-2", "0.02", "0.015"),
        ] {
            assert_eq!(midpoint(lo, hi).as_deref(), Some(expected), "{lo} / {hi}");
        }
    }

    #[test]
    fn midpoint_rejects_oversized_legacy_numbers_before_allocation() {
        for invalid in [
            "1e2147483647".to_owned(),
            "1e-2147483648".to_owned(),
            "1e99999999999999999999999999999".to_owned(),
            "1".repeat(101),
            format!("0.{}", "1".repeat(101)),
            "query:1".to_owned(),
            "stored:1".to_owned(),
        ] {
            assert_eq!(midpoint(&invalid, "2"), None, "{invalid}");
            assert_eq!(midpoint("2", &invalid), None, "{invalid}");
        }
    }
}
