//! 登録地図のフィルターと色分けに使う、所有者専用の再利用可能な定義。
use super::{
    answer_map_filter::validate_numeric_condition,
    form_answers::{
        AnswerCondition, AnswerQuery, FieldOption, answer_fields, build_query, merge_field,
        validate,
    },
};
use crate::{
    ai::actions::{AiAction, AiCondition, Expression},
    error::AppError,
    model::MarkerFormSchema,
};
use axum::{
    Json,
    extract::{Extension, Path, Query},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction, types::Json as SqlJson};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PresetKind {
    Filter,
    Coloring,
}
impl PresetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Filter => "filter",
            Self::Coloring => "coloring",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreatePreset {
    pub name: String,
    pub kind: PresetKind,
    pub schema_version: i32,
    pub definition: Value,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FilterDefinition {
    common_form_id: Option<Uuid>,
    conditions: Vec<AnswerCondition>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ColoringDefinition {
    common_form_id: Uuid,
    rules: Vec<ColorRule>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ColorRule {
    id: String,
    label: String,
    color: String,
    conditions: Vec<AnswerCondition>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DisplayField {
    pub id: String,
    pub field_type: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_id: Option<Uuid>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PresetDisplay {
    pub form_label: Option<String>,
    pub fields: Vec<DisplayField>,
}
#[derive(Clone, Debug, Serialize)]
pub struct SavedPreset {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub schema_version: i32,
    pub definition: Value,
    pub display: PresetDisplay,
    pub create_at: NaiveDateTime,
}
#[derive(FromRow)]
struct PresetRow {
    id: String,
    kind: String,
    name: String,
    schema_version: i32,
    definition: SqlJson<Value>,
    display: SqlJson<PresetDisplay>,
    create_at: NaiveDateTime,
}
impl From<PresetRow> for SavedPreset {
    fn from(row: PresetRow) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            name: row.name,
            schema_version: row.schema_version,
            definition: row.definition.0,
            display: row.display.0,
            create_at: row.create_at,
        }
    }
}
#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    pub page: Option<i64>,
    pub page_size: Option<i64>,
    pub versions: Option<String>,
    pub kind: Option<PresetKind>,
    pub name: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct PresetPage {
    pub items: Vec<SavedPreset>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn supported(kind: &str) -> bool {
    matches!(
        kind,
        "text" | "textarea" | "number" | "date" | "select" | "radio" | "checkbox" | "image"
    )
}

// 所有するフォームと、その過去の定義のみを解決する。論理削除されたフォームも
// map-filter と同様に、既存の登録を説明する定義として利用できる。
async fn form_fields(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    form: &str,
) -> Result<(String, BTreeMap<(String, String), FieldOption>), AppError> {
    let current: Option<(String, String, SqlJson<MarkerFormSchema>)> = sqlx::query_as(
        r#"
        SELECT
            user_id,
            form_title,
            form_schema
        FROM common_form_model
        WHERE id = $1
        "#,
    )
    .bind(form)
    .fetch_optional(&mut **tx)
    .await?;
    if current.as_ref().is_some_and(|(owner, _, _)| owner != user) {
        return Err(AppError::NotFound);
    }
    let query = AnswerQuery {
        common_form_id: Some(form.to_owned()),
        mode: "history".into(),
        ..Default::default()
    };
    let at = Utc::now();
    let label = if let Some((_, title, _)) = &current {
        title.clone()
    } else {
        build_query(user, &query, at)
            .push(
                r#"
                SELECT
                    COALESCE(form_snapshot ->> 'form_title', '共通フォーム')
                FROM filtered
                ORDER BY create_at COLLATE answer_time DESC, id DESC
                LIMIT 1
                "#,
            )
            .build_query_scalar::<String>()
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(AppError::NotFound)?
    };
    let mut fields = BTreeMap::new();
    let mut order = vec![];
    if let Some((_, _, schema)) = current {
        for field in schema.0.fields {
            merge_field(&mut fields, &mut order, field);
        }
    }
    let schemas: Vec<SqlJson<MarkerFormSchema>> = sqlx::query_scalar(
        r#"
        SELECT
            r.form_schema
        FROM common_form_revision_model r
        JOIN common_form_model f ON f.id = r.form_id
        WHERE f.id = $1
            AND f.user_id = $2
        ORDER BY r.version DESC
        "#,
    )
    .bind(form)
    .bind(user)
    .fetch_all(&mut **tx)
    .await?;
    for schema in schemas {
        for field in schema.0.fields {
            merge_field(&mut fields, &mut order, field);
        }
    }
    for (key, historic) in answer_fields(tx, user, &query, at, &mut vec![]).await? {
        let field = fields.entry(key).or_insert_with(|| historic.clone());
        for choice in historic.choices {
            if !field.choices.contains(&choice) {
                field.choices.push(choice);
            }
        }
    }
    Ok((label, fields))
}

fn validate_group(
    form: Option<&str>,
    conditions: &[AnswerCondition],
    fields: &BTreeMap<(String, String), FieldOption>,
    used: &mut BTreeSet<(String, String)>,
    editor_rules: bool,
) -> Result<(), AppError> {
    validate(&AnswerQuery {
        common_form_id: form.map(str::to_owned),
        conditions: conditions.to_vec(),
        ..Default::default()
    })?;
    for condition in conditions {
        if !supported(&condition.field_type) {
            return Err(invalid("地図で利用できない項目の種類です。"));
        }
        if editor_rules
            && matches!(condition.field_type.as_str(), "text" | "textarea")
            && !matches!(condition.op.as_str(), "empty" | "filled" | "missing")
            && condition
                .value
                .as_str()
                .is_some_and(|value| value.trim().is_empty())
        {
            return Err(invalid("条件の値を入力してください。"));
        }
        let key = (condition.field_id.clone(), condition.field_type.clone());
        let field = fields
            .get(&key)
            .ok_or_else(|| invalid("選択したフォームにない項目、または非対応の項目です。"))?;
        if matches!(condition.field_type.as_str(), "select" | "radio") && condition.op == "in" {
            if condition.value.as_array().is_some_and(|values| {
                values.iter().any(|value| {
                    !value
                        .as_str()
                        .is_some_and(|value| field.choices.iter().any(|choice| choice == value))
                })
            }) {
                return Err(invalid("選択したフォームにない選択肢です。"));
            }
        }
        validate_numeric_condition(condition)?;
        used.insert(key);
    }
    Ok(())
}

// JSON 数値を f64 経由で丸めず、編集画面の再利用可能な表現に合わせる。
fn canonicalize_conditions(conditions: &mut [AnswerCondition]) {
    for condition in conditions {
        if matches!(condition.op.as_str(), "empty" | "filled" | "missing") {
            condition.value = Value::Null;
            condition.upper = Value::Null;
            continue;
        }
        if condition.field_type == "number" {
            if condition.value.is_number() {
                condition.value = Value::String(condition.value.to_string());
            }
            if condition.upper.is_number() {
                condition.upper = Value::String(condition.upper.to_string());
            }
        } else if matches!(condition.field_type.as_str(), "text" | "textarea") {
            if let Some(value) = condition.value.as_str() {
                condition.value = Value::String(value.trim().to_owned());
            }
        }
        if condition.op != "between" {
            condition.upper = Value::Null;
        }
    }
}

const MAX_AI_DEFINITION_BYTES: usize = 128 * 1024;

fn ai_conditions(conditions: &[AnswerCondition]) -> Vec<AiCondition> {
    conditions
        .iter()
        .map(|condition| AiCondition {
            field_id: condition.field_id.clone(),
            field_type: condition.field_type.clone(),
            op: condition.op.clone(),
            value: condition.value.clone(),
            upper: condition.upper.clone(),
        })
        .collect()
}

fn answer_conditions(conditions: &[AiCondition]) -> Vec<AnswerCondition> {
    conditions
        .iter()
        .map(|condition| AnswerCondition {
            field_id: condition.field_id.clone(),
            field_type: condition.field_type.clone(),
            op: condition.op.clone(),
            value: condition.value.clone(),
            upper: condition.upper.clone(),
        })
        .collect()
}

fn parse_ai_definition(kind: PresetKind, definition: &Value) -> Result<AiAction, AppError> {
    if serde_json::to_vec(definition)
        .map_err(|_| AppError::InternalServerError)?
        .len()
        > MAX_AI_DEFINITION_BYTES
    {
        return Err(invalid("AIの保存条件は128KiB以内にしてください。"));
    }
    let mut action: AiAction = serde_json::from_value(definition.clone())
        .map_err(|_| invalid("AIの保存条件の形式が不正です。"))?;
    if !matches!(
        (kind, &action),
        (PresetKind::Filter, AiAction::Filter { .. })
            | (PresetKind::Coloring, AiAction::Color { .. })
    ) {
        return Err(invalid(
            "保存できるのは種類に対応する検索式または色分け定義だけです。",
        ));
    }
    crate::ai::assistant::normalize_action(&mut action);
    action.validate()?;
    if serde_json::to_vec(&action)
        .map_err(|_| AppError::InternalServerError)?
        .len()
        > MAX_AI_DEFINITION_BYTES
    {
        return Err(invalid("AIの保存条件は128KiB以内にしてください。"));
    }
    Ok(action)
}

/// 保存内容を表示専用の型へ変換する。作成・保存等の操作は受け付けない。
pub fn preset_action(preset: &SavedPreset) -> Result<AiAction, AppError> {
    let kind = match preset.kind.as_str() {
        "filter" => PresetKind::Filter,
        "coloring" => PresetKind::Coloring,
        _ => return Err(invalid("保存条件の種類に対応していません。")),
    };
    if preset.schema_version == 2 {
        return parse_ai_definition(kind, &preset.definition);
    }
    if preset.schema_version != 1 {
        return Err(invalid("保存条件の形式バージョンに対応していません。"));
    }
    let action = match kind {
        PresetKind::Filter => {
            let definition: FilterDefinition = serde_json::from_value(preset.definition.clone())
                .map_err(|_| invalid("絞り込み条件の形式が不正です。"))?;
            let expression = match definition.common_form_id {
                Some(common_form_id) => Expression::Attribute {
                    common_form_id,
                    conditions: ai_conditions(&definition.conditions),
                },
                None if definition.conditions.is_empty() => Expression::All {},
                None => return Err(invalid("共通フォームを選択してください。")),
            };
            AiAction::Filter { expression }
        },
        PresetKind::Coloring => {
            let definition: ColoringDefinition = serde_json::from_value(preset.definition.clone())
                .map_err(|_| invalid("色分け条件の形式が不正です。"))?;
            AiAction::Color {
                common_form_id: definition.common_form_id,
                rules: definition
                    .rules
                    .into_iter()
                    .enumerate()
                    .map(|(index, rule)| crate::ai::actions::ColorRule {
                        // v1の長い編集用IDは、分類順序を維持した実行用IDへ変換する。
                        id: format!("preset-{index}"),
                        label: rule.label,
                        color: rule.color,
                        conditions: ai_conditions(&rule.conditions),
                    })
                    .collect(),
            }
        },
    };
    action.validate()?;
    Ok(action)
}

fn expression_groups<'a>(expression: &'a Expression, groups: &mut Vec<(Uuid, &'a [AiCondition])>) {
    match expression {
        Expression::Attribute {
            common_form_id,
            conditions,
        } => groups.push((*common_form_id, conditions)),
        Expression::And { children } | Expression::Or { children } => {
            for child in children {
                expression_groups(child, groups);
            }
        },
        Expression::Not { child } => expression_groups(child, groups),
        Expression::All {} | Expression::Text { .. } => {},
    }
}

async fn validate_action_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    action: &AiAction,
) -> Result<PresetDisplay, AppError> {
    action.validate()?;
    let mut groups = Vec::new();
    match action {
        AiAction::Filter { expression } => expression_groups(expression, &mut groups),
        AiAction::Color {
            common_form_id,
            rules,
        } => {
            for rule in rules {
                groups.push((*common_form_id, rule.conditions.as_slice()));
            }
        },
        _ => return Err(invalid("保存できるのは検索式または色分け定義だけです。")),
    }
    let mut forms = BTreeMap::new();
    let mut display_fields = BTreeMap::new();
    for (form, conditions) in groups {
        if !forms.contains_key(&form) {
            forms.insert(form, form_fields(tx, user, &form.to_string()).await?);
        }
        let (label, fields) = &forms[&form];
        let mut used = BTreeSet::new();
        validate_group(
            Some(&form.to_string()),
            &answer_conditions(conditions),
            fields,
            &mut used,
            false,
        )?;
        for key in used {
            let field = &fields[&key];
            display_fields.insert(
                (form, key),
                (
                    label.clone(),
                    DisplayField {
                        id: field.id.clone(),
                        field_type: field.field_type.clone(),
                        label: field.label.clone(),
                        form_id: Some(form),
                    },
                ),
            );
        }
    }
    let multiple = forms.len() > 1;
    Ok(PresetDisplay {
        form_label: if forms.is_empty() {
            None
        } else {
            Some(
                forms
                    .values()
                    .map(|(label, _)| label.as_str())
                    .collect::<Vec<_>>()
                    .join(" / "),
            )
        },
        fields: display_fields
            .into_values()
            .map(|(form, mut field)| {
                if multiple {
                    field.label = format!("{form} / {}", field.label);
                }
                field
            })
            .collect(),
    })
}

async fn normalize_legacy(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    request: &CreatePreset,
) -> Result<(Value, PresetDisplay), AppError> {
    let filter: Option<FilterDefinition> = if matches!(request.kind, PresetKind::Filter) {
        Some(
            serde_json::from_value(request.definition.clone())
                .map_err(|_| invalid("絞り込み条件の形式が不正です。"))?,
        )
    } else {
        None
    };
    let coloring: Option<ColoringDefinition> = if matches!(request.kind, PresetKind::Coloring) {
        let definition: ColoringDefinition = serde_json::from_value(request.definition.clone())
            .map_err(|_| invalid("色分け条件の形式が不正です。"))?;
        if definition.rules.is_empty() || definition.rules.len() > 10 {
            return Err(invalid("分類は1〜10件で指定してください。"));
        }
        let mut ids = BTreeSet::new();
        for rule in &definition.rules {
            if rule.id.trim().is_empty()
                || rule.id.encode_utf16().count() > 100
                || !ids.insert(rule.id.clone())
                || rule.label.trim().is_empty()
                || rule.label.encode_utf16().count() > 100
                || rule.conditions.is_empty()
                || rule.color.len() != 7
                || !rule.color.starts_with('#')
                || !rule.color[1..].bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(invalid("分類名・色・条件を確認してください。"));
            }
        }
        Some(definition)
    } else {
        None
    };
    let form = filter
        .as_ref()
        .and_then(|definition| definition.common_form_id)
        .or_else(|| {
            coloring
                .as_ref()
                .map(|definition| definition.common_form_id)
        });
    let (label, fields) = if let Some(form) = form {
        let (label, fields) = form_fields(tx, user, &form.to_string()).await?;
        (Some(label), fields)
    } else {
        (None, BTreeMap::new())
    };
    let mut used = BTreeSet::new();
    let definition = if let Some(mut definition) = filter {
        validate_group(
            form.as_ref().map(ToString::to_string).as_deref(),
            &definition.conditions,
            &fields,
            &mut used,
            true,
        )?;
        canonicalize_conditions(&mut definition.conditions);
        serde_json::to_value(definition).map_err(|_| AppError::InternalServerError)?
    } else {
        let mut definition = coloring.expect("coloring kind has a definition");
        for rule in &mut definition.rules {
            validate_group(
                form.as_ref().map(ToString::to_string).as_deref(),
                &rule.conditions,
                &fields,
                &mut used,
                true,
            )?;
            canonicalize_conditions(&mut rule.conditions);
            rule.label = rule.label.trim().to_owned();
        }
        serde_json::to_value(definition).map_err(|_| AppError::InternalServerError)?
    };
    let display = PresetDisplay {
        form_label: label,
        fields: used
            .into_iter()
            .map(|key| {
                let field = &fields[&key];
                DisplayField {
                    id: field.id.clone(),
                    field_type: field.field_type.clone(),
                    label: field.label.clone(),
                    form_id: None,
                }
            })
            .collect(),
    };
    Ok((definition, display))
}

async fn normalize_preset_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    request: &CreatePreset,
) -> Result<(Value, PresetDisplay), AppError> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(invalid("条件名を1〜100文字で入力してください。"));
    }
    if !matches!(request.schema_version, 1 | 2) {
        return Err(invalid("保存条件の形式バージョンに対応していません。"));
    }
    if request.schema_version == 1 {
        normalize_legacy(tx, user, request).await
    } else {
        let action = parse_ai_definition(request.kind, &request.definition)?;
        let display = validate_action_tx(tx, user, &action).await?;
        Ok((
            serde_json::to_value(action).map_err(|_| AppError::InternalServerError)?,
            display,
        ))
    }
}

/// 確認画面の準備時にも、作成時と同じ検証をINSERTなしで行う。
pub async fn validate_preset_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    request: &CreatePreset,
) -> Result<(), AppError> {
    normalize_preset_tx(tx, user, request).await?;
    Ok(())
}

pub async fn create_preset_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    request: CreatePreset,
) -> Result<SavedPreset, AppError> {
    let (definition, display) = normalize_preset_tx(tx, user, &request).await?;
    let row: PresetRow = sqlx::query_as(
        r#"
        INSERT INTO answer_map_saved_condition_model (
            id,
            user_id,
            kind,
            name,
            schema_version,
            definition,
            display,
            create_at
        ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8
        )
        RETURNING
            id,
            kind,
            name,
            schema_version,
            definition,
            display,
            create_at
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(user)
    .bind(request.kind.as_str())
    .bind(request.name.trim())
    .bind(request.schema_version)
    .bind(SqlJson(definition))
    .bind(SqlJson(display))
    .bind(Utc::now().naive_utc())
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.into())
}

pub async fn create_preset(
    pool: &SqlitePool,
    user: &str,
    request: CreatePreset,
) -> Result<SavedPreset, AppError> {
    let mut tx = super::answer_sqlite::begin_write(pool).await?;
    let result = create_preset_tx(&mut tx, user, request).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn get_preset(pool: &SqlitePool, user: &str, id: &str) -> Result<SavedPreset, AppError> {
    let row: PresetRow = sqlx::query_as(
        r#"
        SELECT
            id,
            kind,
            name,
            schema_version,
            definition,
            display,
            create_at
        FROM answer_map_saved_condition_model
        WHERE user_id = $1
            AND id = $2
        "#,
    )
    .bind(user)
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let preset: SavedPreset = row.into();
    preset_action(&preset)?;
    Ok(preset)
}

/// 適用時には保存済みの型だけでなく、現在の所有権・フォーム・項目・選択肢も検証する。
pub async fn validate_saved_preset(
    pool: &SqlitePool,
    user: &str,
    preset: &SavedPreset,
) -> Result<AiAction, AppError> {
    // 呼出元から他者の値を渡されても所有者付きで取り直す。
    let preset = get_preset(pool, user, &preset.id).await?;
    let action = preset_action(&preset)?;
    let mut tx = super::answer_sqlite::begin_read(pool).await?;
    validate_action_tx(&mut tx, user, &action).await?;
    tx.commit().await?;
    Ok(action)
}
pub async fn list_presets(
    pool: &SqlitePool,
    user: &str,
    query: ListQuery,
) -> Result<PresetPage, AppError> {
    let page = query.page.unwrap_or(1);
    let page_size = query.page_size.unwrap_or(20);
    let offset = page
        .checked_sub(1)
        .and_then(|page| page.checked_mul(page_size));
    if page < 1 || !(1..=100).contains(&page_size) || offset.is_none() {
        return Err(invalid("ページの指定が不正です。"));
    }
    let versions = match query.versions.as_deref() {
        None => vec![1],
        Some(raw) if raw.len() <= 32 => {
            let mut versions = BTreeSet::new();
            for value in raw.split(',') {
                let version: i32 = value.trim().parse().map_err(|_| {
                    invalid("保存条件の形式バージョンを1または2で指定してください。")
                })?;
                if !matches!(version, 1 | 2) {
                    return Err(invalid(
                        "保存条件の形式バージョンを1または2で指定してください。",
                    ));
                }
                versions.insert(version);
            }
            versions.into_iter().collect()
        },
        Some(_) => return Err(invalid("保存条件の形式バージョンの指定が長すぎます。")),
    };
    let kind = query.kind.map(PresetKind::as_str);
    let name = query.name.as_deref().map(str::trim);
    if name.is_some_and(|value| value.is_empty() || value.chars().count() > 100) {
        return Err(invalid("条件名を1〜100文字で入力してください。"));
    }
    let mut tx = super::answer_sqlite::begin_read(pool).await?;
    let total = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM answer_map_saved_condition_model
        WHERE user_id = $1
            AND schema_version IN (SELECT value FROM json_each($2))
            AND ($3 IS NULL OR kind = $3)
            AND ($4 IS NULL OR name = $4)
        "#,
    )
    .bind(user)
    .bind(serde_json::to_string(&versions).unwrap())
    .bind(kind)
    .bind(name)
    .fetch_one(&mut *tx)
    .await?;
    let rows: Vec<PresetRow> = sqlx::query_as(
        r#"
        SELECT
            id,
            kind,
            name,
            schema_version,
            definition,
            display,
            create_at
        FROM answer_map_saved_condition_model
        WHERE user_id = $1
            AND schema_version IN (SELECT value FROM json_each($2))
            AND ($3 IS NULL OR kind = $3)
            AND ($4 IS NULL OR name = $4)
        ORDER BY create_at COLLATE answer_time DESC, id DESC
        LIMIT $5
        OFFSET $6
        "#,
    )
    .bind(user)
    .bind(serde_json::to_string(&versions).unwrap())
    .bind(kind)
    .bind(name)
    .bind(page_size)
    .bind(offset.unwrap())
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(PresetPage {
        items: rows.into_iter().map(Into::into).collect(),
        total,
        page,
        page_size,
    })
}

pub async fn delete_preset(pool: &SqlitePool, user: &str, id: &str) -> Result<(), AppError> {
    let result = sqlx::query(
        r#"
        DELETE FROM answer_map_saved_condition_model
        WHERE id = $1
            AND user_id = $2
        "#,
    )
    .bind(id)
    .bind(user)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
pub async fn create_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(request): Json<CreatePreset>,
) -> Result<Response, AppError> {
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(create_preset(&pool, &user, request).await?),
    )
        .into_response())
}
pub async fn list_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(query): Query<ListQuery>,
) -> Result<Response, AppError> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(list_presets(&pool, &user, query).await?),
    )
        .into_response())
}
pub async fn delete_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    delete_preset(&pool, &user, &id.to_string()).await?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response())
}
