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
        r#"
        , map_scope AS (
            SELECT *
            FROM filtered
            WHERE (target_type = 'marker' AND target_id IN (
                SELECT value
                FROM json_each(
        "#,
    )
    .push_bind(serde_json::to_string(&scope.markers).unwrap())
    .push(
        r#"
        ))) OR (target_type = 'shape' AND target_id IN (
            SELECT value
            FROM json_each(
        "#,
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
    b.push(
        r#"
        , map_matched AS (
            SELECT *
            FROM map_scope
            WHERE TRUE
        "#,
    );
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
    let schemas: Vec<Value> = sqlx::query_scalar(
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
        if let Ok(schema) = serde_json::from_value::<MarkerFormSchema>(schema) {
            for f in schema.fields {
                merge_field(&mut fields, &mut order, f);
            }
        }
    }
    let mut query = base(user, &r.query, at, scope);
    append_map_field_definitions(&mut query, form);
    let definitions: Vec<Value> = query.build_query_scalar().fetch_all(&mut **tx).await?;
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

fn append_map_field_definitions(b: &mut QueryBuilder<'static, Sqlite>, form: &str) {
    // BINARY で比較する JSON テキストによるグループ化は、配列だけに適用する。文字列からも同じテキストが
    // 抽出され得るため、null・欠落・オブジェクト・スカラー値は従来どおり展開する。
    b.push(
        r#"
        , map_field_source AS (
            SELECT
                form_snapshot,
                create_at,
                id,
                target_type
            FROM map_scope
            WHERE source_form->>'id' =
        "#,
    )
    .push_bind(form.to_owned())
    .push(
        r#"
        )
        SELECT field
        FROM (
            SELECT
                f.value AS field,
                a.create_at,
                CAST(f.key AS INTEGER) AS position,
                row_number() OVER (
                    PARTITION BY f.value
                    ORDER BY a.create_at COLLATE answer_time DESC, a.id DESC, a.target_type ASC,
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
                                json_extract(form_snapshot, '$.form_schema.fields') COLLATE BINARY
                            ORDER BY create_at COLLATE answer_time DESC, id DESC, target_type ASC
                        ) AS snapshot_rank
                    FROM map_field_source
                    WHERE json_type(form_snapshot, '$.form_schema.fields') = 'array'
                ) arrays
                WHERE snapshot_rank = 1
                UNION ALL
                SELECT
                    form_snapshot,
                    create_at,
                    id,
                    target_type
                FROM map_field_source
                WHERE json_type(form_snapshot, '$.form_schema.fields') IS NOT 'array'
            ) a, json_each(a.form_snapshot, '$.form_schema.fields') f
        ) definitions
        WHERE definition_rank = 1
        ORDER BY create_at COLLATE answer_time DESC, position, field
        LIMIT 10001
        "#,
    );
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
            known = build_query(user, &r.query, at)
                .push(
                    r#"
                    SELECT EXISTS (
                        SELECT 1
                        FROM filtered, json_each(form_snapshot, '$.form_schema.fields') field
                        WHERE source_form->>'id' =
                    "#,
                )
                .push_bind(r.common_form_id.as_ref().map(|v| v.to_string()))
                .push(" AND field.value->>'id'=")
                .push_bind(condition.field_id.clone())
                .push(" AND field.value->>'type'=")
                .push_bind(condition.field_type.clone())
                .push(")")
                .build_query_scalar()
                .fetch_one(&mut **tx)
                .await?;
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
            SELECT
                form_id,
                label
            FROM (
                SELECT
                    source_form ->> 'id' AS form_id,
                    COALESCE(common_form_name, form_snapshot ->> 'form_title', '共通フォーム') AS label,
                    row_number() OVER (
                        PARTITION BY source_form ->> 'id'
                        ORDER BY create_at COLLATE answer_time DESC, id DESC
                    ) AS form_rank
                FROM map_scope
                WHERE source_form ->> 'id' IS NOT NULL
            ) forms
            WHERE form_rank = 1
            ORDER BY form_id
            LIMIT 201
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
            .push(
                r#"
                SELECT
                    count(*)
                FROM map_matched
                "#,
            )
            .build_query_scalar()
            .fetch_one(&mut *tx)
            .await?;
        targets = matched(user, r, at, &scope)
            .push(
                r#"
                SELECT DISTINCT
                    target_type || ':' || target_id
                FROM map_matched
                ORDER BY 1
                "#,
            )
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

#[cfg(test)]
mod field_tests {
    use super::*;
    use serde_json::json;

    const FORM: &str = "10000000-0000-4000-8000-000000000001";
    const PREVIOUS: &str = r#"
        SELECT field
        FROM (
            SELECT
                f.value AS field,
                a.create_at,
                CAST(f.key AS INTEGER) AS position,
                row_number() OVER (
                    PARTITION BY f.value
                    ORDER BY a.create_at COLLATE answer_time DESC, a.id DESC, a.target_type,
                        CAST(f.key AS INTEGER)
                ) AS definition_rank
            FROM map_scope a, json_each(a.form_snapshot, '$.form_schema.fields') f
            WHERE source_form->>'id' =
        "#;
    const PREVIOUS_END: &str = r#"
        ) definitions WHERE definition_rank=1
        ORDER BY create_at COLLATE answer_time DESC,position,field LIMIT 10001
        "#;

    fn record(id: u128, kind: &str, at: &str, snapshot: Option<Value>) -> Value {
        json!({"id":Uuid::from_u128(id),"target_type":kind,"create_at":at,
            "snapshot_text":snapshot.map(|v|v.to_string()),"form_id":FORM,
            "submitted_values":{"legacy":"must not add unknown fields"}})
    }
    fn snapshot(fields: Value) -> Value {
        json!({"form_schema":{"fields":fields}})
    }
    fn field(id: &str, label: &str) -> Value {
        json!({"id":id,"type":"text","label":label})
    }
    async fn pool() -> SqlitePool {
        sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }
    async fn definitions(
        pool: &SqlitePool,
        rows: Value,
        previous: bool,
    ) -> Result<Vec<Value>, sqlx::Error> {
        let mut b = QueryBuilder::new(
            r#"
            WITH map_scope AS MATERIALIZED (
                SELECT json_extract(r.value,'$.id') AS id,
                    json_extract(r.value,'$.target_type') AS target_type,
                    json_extract(r.value,'$.create_at') AS create_at,
                    json_extract(r.value,'$.snapshot_text') AS form_snapshot,
                    json_object('id',json_extract(r.value,'$.form_id')) AS source_form,
                    json_extract(r.value,'$.submitted_values') AS submitted_values
                FROM json_each(
            "#,
        );
        b.push_bind(rows).push(") r) ");
        if previous {
            b.push(PREVIOUS)
                .push_bind(FORM.to_owned())
                .push(PREVIOUS_END);
        } else {
            append_map_field_definitions(&mut b, FORM);
        }
        let mut tx = super::super::answer_sqlite::begin_read(pool).await?;
        let result = b.build_query_scalar().fetch_all(&mut *tx).await;
        tx.rollback().await?;
        result
    }
    fn merged(
        definitions: &[Value],
        seed_current: bool,
    ) -> BTreeMap<(String, String), FieldOption> {
        let mut result = BTreeMap::new();
        let mut order = vec![];
        if seed_current {
            merge_field(
                &mut result,
                &mut order,
                serde_json::from_value(json!({
                    "id":"state","type":"select","label":"現在版","choices":["現行"]
                }))
                .unwrap(),
            );
        }
        for definition in definitions {
            if let Ok(field) = serde_json::from_value::<MarkerFormField>(definition.clone()) {
                merge_field(&mut result, &mut order, field);
            }
        }
        result
    }

    #[tokio::test]
    async fn map_field_representatives_preserve_order_labels_choices_and_legacy() {
        let pool = pool().await;
        let old = json!({"id":"state","type":"select","label":"旧名","choices":["旧","共通"]});
        let current = json!({"id":"state","type":"select","label":"新名","choices":["新","共通"]});
        let repeated = json!([
            field("first", "先頭"),
            old.clone(),
            old,
            field("state", "同IDの文字列")
        ]);
        let mut rows = vec![];
        for id in 1..=256 {
            let mut saved = snapshot(repeated.clone());
            saved["form_title"] = json!(format!("題名{id}"));
            rows.push(record(id, "marker", "2026-10-01 08:00:00", Some(saved)));
        }
        rows.push(record(
            500,
            "marker",
            "2026-10-02 09:00:00",
            Some(snapshot(json!([current]))),
        ));
        let tie = field("tie", "同時刻の項目");
        rows.push(record(
            1000,
            "marker",
            "2026-10-03 10:00:00",
            Some(snapshot(json!([field("a", "a"), tie.clone()]))),
        ));
        rows.push(record(
            1000,
            "shape",
            "2026-10-03T19:00:00+09:00",
            Some(snapshot(json!([tie, field("b", "b")]))),
        ));
        rows.push(record(1001, "marker", "2026-10-04 00:00:00", None));
        rows.push(record(
            1002,
            "marker",
            "2026-10-04 00:00:00",
            Some(Value::Null),
        ));
        rows.push(record(
            1003,
            "marker",
            "2026-10-04 00:00:00",
            Some(json!({"form_schema":{}})),
        ));
        rows.push(record(
            1004,
            "marker",
            "2026-10-04 00:00:00",
            Some(snapshot(json!([]))),
        ));
        let mut foreign = record(
            2000,
            "marker",
            "2026-10-05 00:00:00",
            Some(snapshot(json!([field("foreign", "別フォーム")]))),
        );
        foreign["form_id"] = json!("20000000-0000-4000-8000-000000000002");
        rows.push(foreign);
        let rows = json!(rows);
        let old = definitions(&pool, rows.clone(), true).await.unwrap();
        let new = definitions(&pool, rows, false).await.unwrap();
        assert_eq!(new, old);
        assert_eq!(
            new.iter()
                .take(3)
                .map(|v| v["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["a", "b", "tie"]
        );
        assert!(
            !new.iter()
                .any(|v| v["id"] == "legacy" || v["id"] == "foreign")
        );
        let presentation = merged(&new, true);
        let state = &presentation[&("state".into(), "select".into())];
        assert_eq!(state.label, "現在版");
        assert_eq!(state.choices, vec!["現行", "新", "共通", "旧"]);
        assert!(presentation.contains_key(&("state".into(), "text".into())));
    }

    #[tokio::test]
    async fn map_field_representatives_preserve_both_definition_limits() {
        let pool = pool().await;
        for (count, distinct_ids) in [
            (200usize, true),
            (201, true),
            (10_000, false),
            (10_001, false),
            (10_002, false),
        ] {
            let fields: Vec<_> = (0..count)
                .map(|i| {
                    field(
                        &if distinct_ids {
                            format!("field_{i}")
                        } else {
                            "shared".into()
                        },
                        &format!("label_{i}"),
                    )
                })
                .collect();
            let rows = json!([record(
                1,
                "marker",
                "2026-10-01 00:00:00",
                Some(snapshot(json!(fields)))
            )]);
            let old = definitions(&pool, rows.clone(), true).await.unwrap();
            let new = definitions(&pool, rows, false).await.unwrap();
            assert_eq!(new, old);
            assert_eq!(new.len(), count.min(10_001));
            assert_eq!(new.len() > 10_000, count > 10_000);
            assert_eq!(merged(&new, false).len() > 200, distinct_ids && count > 200);
        }
    }

    #[tokio::test]
    async fn map_field_representatives_preserve_non_array_types_and_errors() {
        let pool = pool().await;
        for fields in [
            Value::Null,
            json!(false),
            json!(12),
            json!("not json"),
            json!("[]"),
            json!({"one":field("x","x")}),
        ] {
            let rows = json!([record(
                1,
                "marker",
                "2026-10-01 00:00:00",
                Some(snapshot(fields))
            )]);
            match (
                definitions(&pool, rows.clone(), true).await,
                definitions(&pool, rows, false).await,
            ) {
                (Ok(old), Ok(new)) => assert_eq!(new, old),
                (Err(old), Err(new)) => {
                    assert_eq!(std::mem::discriminant(&old), std::mem::discriminant(&new));
                    assert_eq!(old.to_string(), new.to_string());
                },
                other => panic!("Old/new field expansion differs: {other:?}"),
            }
        }
        // JSON 文字列の "[]" と配列の [] からは同じテキストが抽出されるが、フィールドではない定義を
        // 一つ追加して上限を消費するのは、文字列の場合だけである。
        let rows = json!([
            record(
                1,
                "marker",
                "2026-10-01 00:00:00",
                Some(snapshot(json!("[]")))
            ),
            record(
                2,
                "marker",
                "2026-10-02 00:00:00",
                Some(snapshot(json!([])))
            )
        ]);
        let old = definitions(&pool, rows.clone(), true).await.unwrap();
        let new = definitions(&pool, rows, false).await.unwrap();
        assert_eq!(new, old);
        assert_eq!(new, vec![json!([])]);
    }
}
