use super::validation::{invalid, validate};
use crate::{error::AppError, model::transfer::*};
use chrono::{DateTime, NaiveDateTime, SubsecRound, Utc};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use sqlx::{Row, types::Json};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};
use uuid::Uuid;

type Pool = sqlx::SqlitePool;
type DbRow = sqlx::sqlite::SqliteRow;
fn sql(s: &str) -> Cow<'_, str> {
    Cow::Owned(
        s.replace("::text", "")
            .replace("::uuid", "")
            .replace(" FOR UPDATE", "")
            .replace(
                "ORDER BY s.create_at,s.id",
                "ORDER BY s.create_at COLLATE answer_time,s.id",
            ),
    )
}
fn db_id(s: &str) -> Result<String, AppError> {
    Uuid::parse_str(s)
        .map(|id| id.to_string())
        .map_err(|_| invalid("識別子が不正です。"))
}
async fn read_transaction(pool: &Pool) -> Result<sqlx::Transaction<'_, sqlx::Sqlite>, AppError> {
    Ok(super::super::answer_sqlite::begin_read(pool).await?)
}
async fn write_transaction(pool: &Pool) -> Result<sqlx::Transaction<'_, sqlx::Sqlite>, AppError> {
    Ok(pool.begin_with("BEGIN IMMEDIATE").await?)
}

fn precise_time(row: &DbRow, name: &str) -> Result<DateTime<Utc>, AppError> {
    let text: String = row.try_get(name)?;
    if let Ok(time) = DateTime::parse_from_rfc3339(&text) {
        return Ok(time.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(time) = NaiveDateTime::parse_from_str(&text, format) {
            return Ok(time.and_utc());
        }
    }
    Err(invalid("日時が不正です。"))
}
fn time(row: &DbRow, name: &str) -> Result<DateTime<Utc>, AppError> {
    Ok(precise_time(row, name)?.trunc_subsecs(6))
}
fn source(row: &DbRow) -> Result<Option<SourceForm>, AppError> {
    let value: Option<Json<Value>> = row.try_get("source_form")?;
    value
        .map(|v| {
            Ok(SourceForm {
                form_key: v
                    .0
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("適用元が不正です。"))?
                    .into(),
                version: v
                    .0
                    .get("version")
                    .and_then(Value::as_i64)
                    .and_then(|v| i32::try_from(v).ok())
                    .ok_or_else(|| invalid("適用元の版が不正です。"))?,
            })
        })
        .transpose()
}
fn value(row: &DbRow, name: &str) -> Result<Value, AppError> {
    Ok(row.try_get::<Json<Value>, _>(name)?.0)
}

struct Budget(usize);
impl Budget {
    fn add(&mut self, v: &impl serde::Serialize) -> Result<(), AppError> {
        self.0 = self.0.saturating_add(
            serde_json::to_vec(v)
                .map_err(|_| AppError::InternalServerError)?
                .len()
                + 1,
        );
        if self.0 > TRANSFER_LIMIT {
            return Err(too_large());
        }
        Ok(())
    }
}
pub(super) fn too_large() -> AppError {
    AppError::PayloadTooLarge(
        "version 3のJSONは20MiB以内にしてください。対象レイヤを分けて出力してください。".into(),
    )
}

pub(super) async fn export(pool: &Pool, user: &str, layer: &str) -> Result<String, AppError> {
    let mut tx = read_transaction(pool).await?;
    let master: bool = sqlx::query_scalar(&sql(
        "SELECT is_master FROM layer_model WHERE id=$1 AND user_id=$2",
    ))
    .bind(db_id(layer)?)
    .bind(db_id(user)?)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let scope = if master { None } else { Some(db_id(layer)?) };
    let mut p = TransferPackage {
        format: "geocode-web".into(),
        version: 3,
        exported_at: Utc::now().trunc_subsecs(6),
        image_policy: "references_only".into(),
        layers: vec![],
        markers: vec![],
        shapes: vec![],
        common_forms: vec![],
        form_configs: vec![],
        submissions: vec![],
    };
    let mut budget = Budget(512);
    let mut layer_keys = HashMap::new();
    let mut target_keys = HashMap::new();
    let mut needed_forms = HashSet::new();
    let mut answer_order = Vec::new();
    let mut answer_keys = HashMap::new();
    let mut body_documents = HashMap::new();
    {
        let text = sql(
            "SELECT id::text AS id,layer_name,is_master,restrict_free_text,common_form_id::text AS common_form_id,common_form_version,create_at::text AS created_at,update_at::text AS updated_at FROM layer_model WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY id",
        );
        let mut rows = sqlx::query(&text)
            .bind(db_id(user)?)
            .bind(&scope)
            .fetch(&mut *tx);
        while let Some(row) = rows.try_next().await? {
            let key = format!("l{}", p.layers.len() + 1);
            layer_keys.insert(row.try_get::<String, _>("id")?, key.clone());
            let common_form = row
                .try_get::<Option<String>, _>("common_form_id")?
                .map(|id| {
                    needed_forms.insert(id.clone());
                    Ok::<_, AppError>(SourceForm {
                        form_key: id,
                        version: row.try_get("common_form_version")?,
                    })
                })
                .transpose()?;
            let layer = Layer {
                key,
                layer_name: row.try_get("layer_name")?,
                is_master: row.try_get("is_master")?,
                restrict_free_text: row.try_get("restrict_free_text")?,
                common_form,
                created_at: time(&row, "created_at")?,
                updated_at: time(&row, "updated_at")?,
            };
            budget.add(&layer)?;
            p.layers.push(layer);
        }
    }
    for kind in ["marker", "shape"] {
        let (table, data, created, updated) = if kind == "marker" {
            (
                "marker_info_model",
                "marker_name,latitude,longitude,detail",
                "create_at",
                "update_at",
            )
        } else {
            (
                "shape_model",
                "shape_type,name,geojson",
                "created_at",
                "updated_at",
            )
        };
        {
            let text = sql(&format!("SELECT id::text AS id,layer_id::text AS layer_id,{data},form_body_parts,{created}::text AS created_at,{updated}::text AS updated_at FROM {table} WHERE user_id=$1 AND ($2::uuid IS NULL OR layer_id=$2) ORDER BY id")).into_owned();
            let mut rows = sqlx::query(&text)
                .bind(db_id(user)?)
                .bind(&scope)
                .fetch(&mut *tx);
            while let Some(row) = rows.try_next().await? {
                let id: String = row.try_get("id")?;
                let layer: String = row.try_get("layer_id")?;
                let layer_key = layer_keys
                    .get(&layer)
                    .ok_or_else(|| invalid("対象のレイヤがありません。"))?
                    .clone();
                let key = format!(
                    "{}{}",
                    if kind == "marker" { "m" } else { "g" },
                    target_keys.len() + 1
                );
                target_keys.insert((kind.to_string(), id), key.clone());
                if let Some(parts) = row.try_get::<Option<
                    Json<Vec<super::super::marker_forms::answer_edit::BodyPart>>,
                >, _>("form_body_parts")?
                {
                    body_documents.insert((kind.to_string(), key.clone()), parts.0);
                }
                if kind == "marker" {
                    let m = Marker {
                        key,
                        layer_key,
                        marker_name: row.try_get("marker_name")?,
                        latitude: row.try_get("latitude")?,
                        longitude: row.try_get("longitude")?,
                        detail: row.try_get("detail")?,
                        body_parts: None,
                        created_at: time(&row, "created_at")?,
                        updated_at: time(&row, "updated_at")?,
                    };
                    budget.add(&m)?;
                    p.markers.push(m);
                } else {
                    let s = Shape {
                        key,
                        layer_key,
                        shape_type: row.try_get("shape_type")?,
                        name: row.try_get("name")?,
                        geojson: value(&row, "geojson")?,
                        body_parts: None,
                        created_at: time(&row, "created_at")?,
                        updated_at: time(&row, "updated_at")?,
                    };
                    budget.add(&s)?;
                    p.shapes.push(s);
                }
            }
        }
        {
            let text = sql(&format!("SELECT c.{kind}_id::text AS id,c.form_title,c.form_description,c.form_schema,c.source_form,c.managed_layer_id::text AS managed_layer_id,c.create_at::text AS created_at,c.update_at::text AS updated_at FROM {kind}_form_config_model c JOIN {table} o ON o.id=c.{kind}_id WHERE o.user_id=$1 AND ($2::uuid IS NULL OR o.layer_id=$2) ORDER BY c.{kind}_id")).into_owned();
            let mut rows = sqlx::query(&text)
                .bind(db_id(user)?)
                .bind(&scope)
                .fetch(&mut *tx);
            while let Some(row) = rows.try_next().await? {
                let id: String = row.try_get("id")?;
                let key = target_keys
                    .get(&(kind.to_string(), id))
                    .ok_or_else(|| invalid("フォームの対象がありません。"))?
                    .clone();
                let source_form = source(&row)?;
                if let Some(s) = &source_form {
                    needed_forms.insert(s.form_key.clone());
                }
                let managed_layer_key = row
                    .try_get::<Option<String>, _>("managed_layer_id")?
                    .map(|id| {
                        layer_keys
                            .get(&id)
                            .cloned()
                            .ok_or_else(|| invalid("管理レイヤが出力対象にありません。"))
                    })
                    .transpose()?;
                let c = FormConfig {
                    target: Target {
                        kind: kind.into(),
                        key,
                    },
                    form_title: row.try_get("form_title")?,
                    form_description: row.try_get("form_description")?,
                    form_schema: value(&row, "form_schema")?,
                    source_form,
                    managed_layer_key,
                    created_at: time(&row, "created_at")?,
                    updated_at: time(&row, "updated_at")?,
                };
                budget.add(&c)?;
                p.form_configs.push(c);
            }
        }
        {
            let text = sql(&format!("SELECT s.id::text AS answer_id,s.{kind}_id::text AS id,s.submitted_values,s.form_snapshot,s.source_form,s.rendered_markdown,s.edited_at::text AS edited_at,s.create_at::text AS created_at FROM {kind}_form_submission_model s JOIN {table} o ON o.id=s.{kind}_id WHERE o.user_id=$1 AND ($2::uuid IS NULL OR o.layer_id=$2) ORDER BY s.create_at,s.id")).into_owned();
            let mut rows = sqlx::query(&text)
                .bind(db_id(user)?)
                .bind(&scope)
                .fetch(&mut *tx);
            while let Some(row) = rows.try_next().await? {
                let id: String = row.try_get("id")?;
                let key = target_keys
                    .get(&(kind.to_string(), id))
                    .ok_or_else(|| invalid("回答の対象がありません。"))?
                    .clone();
                let source_form = source(&row)?;
                if let Some(s) = &source_form {
                    needed_forms.insert(s.form_key.clone());
                }
                let order = p.submissions.len() as u64 + 1;
                answer_order.push((
                    precise_time(&row, "created_at")?,
                    db_id(&row.try_get::<String, _>("answer_id")?)?.to_string(),
                    kind.to_string(),
                    p.submissions.len(),
                ));
                answer_keys.insert(
                    (kind.to_string(), row.try_get::<String, _>("answer_id")?),
                    format!("a{order}"),
                );
                let s = Submission {
                    key: format!("a{order}"),
                    target: Target {
                        kind: kind.into(),
                        key,
                    },
                    submitted_values: value(&row, "submitted_values")?,
                    form_snapshot: row
                        .try_get::<Option<Json<Value>>, _>("form_snapshot")?
                        .map(|v| v.0),
                    source_form,
                    rendered_markdown: row.try_get("rendered_markdown")?,
                    edited_at: row
                        .try_get::<Option<String>, _>("edited_at")?
                        .map(|_| time(&row, "edited_at"))
                        .transpose()?,
                    created_at: time(&row, "created_at")?,
                    source_order: order,
                };
                budget.add(&s)?;
                p.submissions.push(s);
            }
        }
    }
    let portable_parts = |kind: &str, key: &str| -> Result<Option<Vec<BodyPart>>, AppError> {
        body_documents
            .get(&(kind.to_string(), key.to_string()))
            .map(|parts| {
                parts
                    .iter()
                    .map(|part| {
                        Ok(match part {
                            super::super::marker_forms::answer_edit::BodyPart::Text { text } => {
                                BodyPart::Text { text: text.clone() }
                            },
                            super::super::marker_forms::answer_edit::BodyPart::Answer { id } => {
                                BodyPart::Answer {
                                    key: answer_keys
                                        .get(&(kind.to_string(), id.to_string()))
                                        .cloned()
                                        .ok_or_else(|| invalid("本文の回答参照が不正です。"))?,
                                }
                            },
                        })
                    })
                    .collect::<Result<Vec<_>, AppError>>()
            })
            .transpose()
    };
    for m in &mut p.markers {
        m.body_parts = portable_parts("marker", &m.key)?;
        if let Some(parts) = &m.body_parts {
            budget.add(parts)?;
        }
    }
    for shape in &mut p.shapes {
        shape.body_parts = portable_parts("shape", &shape.key)?;
        if let Some(parts) = &shape.body_parts {
            budget.add(parts)?;
        }
    }
    // One priority order across marker and shape answers, even when timestamps
    // collapse to the shared microsecond precision during transfer.
    answer_order.sort_unstable();
    for (index, (_, _, _, position)) in answer_order.into_iter().enumerate() {
        p.submissions[position].source_order = index as u64 + 1;
    }
    p.submissions.sort_by_key(|s| s.source_order);
    let mut form_keys = HashMap::new();
    {
        let text = sql(
            "SELECT id::text AS id,version,deleted,form_title,form_description,form_schema,create_at::text AS created_at,update_at::text AS updated_at FROM common_form_model WHERE user_id=$1 ORDER BY id",
        );
        let mut rows = sqlx::query(&text).bind(db_id(user)?).fetch(&mut *tx);
        while let Some(row) = rows.try_next().await? {
            let id: String = row.try_get("id")?;
            let deleted: bool = row.try_get("deleted")?;
            if !needed_forms.contains(&id) && (!master || deleted) {
                continue;
            }
            let key = format!("f{}", form_keys.len() + 1);
            form_keys.insert(id, key.clone());
            let f = CommonForm {
                key,
                version: row.try_get("version")?,
                deleted,
                form_title: row.try_get("form_title")?,
                form_description: row.try_get("form_description")?,
                form_schema: value(&row, "form_schema")?,
                revisions: vec![],
                created_at: time(&row, "created_at")?,
                updated_at: time(&row, "updated_at")?,
            };
            budget.add(&f)?;
            p.common_forms.push(f);
        }
    }
    {
        let positions: HashMap<_, _> = p
            .common_forms
            .iter()
            .enumerate()
            .map(|(i, f)| (f.key.clone(), i))
            .collect();
        let text = sql(
            "SELECT r.form_id::text AS form_id,r.version,r.form_schema FROM common_form_revision_model r JOIN common_form_model f ON f.id=r.form_id WHERE f.user_id=$1 ORDER BY r.form_id,r.version",
        );
        let mut rows = sqlx::query(&text).bind(db_id(user)?).fetch(&mut *tx);
        while let Some(row) = rows.try_next().await? {
            let form_id: String = row.try_get("form_id")?;
            let Some(key) = form_keys.get(&form_id) else {
                continue;
            };
            let r = Revision {
                version: row.try_get("version")?,
                form_schema: value(&row, "form_schema")?,
            };
            budget.add(&r)?;
            p.common_forms[positions[key]].revisions.push(r);
        }
    }
    for s in p
        .layers
        .iter_mut()
        .filter_map(|l| l.common_form.as_mut())
        .chain(
            p.form_configs
                .iter_mut()
                .filter_map(|c| c.source_form.as_mut()),
        )
        .chain(
            p.submissions
                .iter_mut()
                .filter_map(|s| s.source_form.as_mut()),
        )
    {
        s.form_key = form_keys
            .get(&s.form_key)
            .cloned()
            .ok_or_else(|| invalid("参照先の共通フォームがありません。"))?;
    }
    validate(&p)?;
    let text = serde_json::to_string(&p).map_err(|_| AppError::InternalServerError)?;
    if text.len() > TRANSFER_LIMIT {
        return Err(too_large());
    }
    tx.commit().await?;
    Ok(text)
}

fn source_db(source: &Option<SourceForm>, forms: &HashMap<&str, Uuid>) -> Option<Json<Value>> {
    source
        .as_ref()
        .map(|s| Json(json!({"id":forms[s.form_key.as_str()],"version":s.version})))
}

pub(super) async fn import(pool: &Pool, user: &str, p: TransferPackage) -> Result<(), AppError> {
    validate(&p)?;
    let mut tx = write_transaction(pool).await?;
    sqlx::query(&sql("SELECT id FROM user_model WHERE id=$1 FOR UPDATE"))
        .bind(db_id(user)?)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    let forms: HashMap<_, _> = p
        .common_forms
        .iter()
        .map(|f| (f.key.as_str(), Uuid::new_v4()))
        .collect();
    let layers: HashMap<_, _> = p
        .layers
        .iter()
        .map(|l| (l.key.as_str(), Uuid::new_v4()))
        .collect();
    let objects: HashMap<_, _> = p
        .markers
        .iter()
        .map(|m| {
            (
                Target {
                    kind: "marker".into(),
                    key: m.key.clone(),
                },
                Uuid::new_v4(),
            )
        })
        .chain(p.shapes.iter().map(|s| {
            (
                Target {
                    kind: "shape".into(),
                    key: s.key.clone(),
                },
                Uuid::new_v4(),
            )
        }))
        .collect();
    for f in &p.common_forms {
        sqlx::query("INSERT INTO common_form_model (id,user_id,version,deleted,form_title,form_description,form_schema,create_at,update_at,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)")
            .bind(db_id(&forms[f.key.as_str()].to_string())?).bind(db_id(user)?).bind(f.version).bind(f.deleted).bind(&f.form_title).bind(&f.form_description).bind(Json(&f.form_schema)).bind(f.created_at.naive_utc()).bind(f.updated_at.naive_utc()).execute(&mut *tx).await?;
        for r in &f.revisions {
            sqlx::query("INSERT INTO common_form_revision_model (form_id,version,form_schema) VALUES ($1,$2,$3)").bind(db_id(&forms[f.key.as_str()].to_string())?).bind(r.version).bind(Json(&r.form_schema)).execute(&mut *tx).await?;
        }
    }
    for l in &p.layers {
        sqlx::query("INSERT INTO layer_model (id,user_id,layer_name,is_master,create_at,update_at,common_form_id,common_form_version,form_binding_revision,restrict_free_text) VALUES ($1,$2,$3,false,$4,$5,$6,$7,1,$8)")
            .bind(db_id(&layers[l.key.as_str()].to_string())?).bind(db_id(user)?).bind(&l.layer_name).bind(l.created_at.naive_utc()).bind(l.updated_at.naive_utc()).bind(l.common_form.as_ref().map(|s| db_id(&forms[s.form_key.as_str()].to_string())).transpose()?).bind(l.common_form.as_ref().map(|s| s.version)).bind(l.restrict_free_text).execute(&mut *tx).await?;
    }
    for m in &p.markers {
        let target = Target {
            kind: "marker".into(),
            key: m.key.clone(),
        };
        sqlx::query("INSERT INTO marker_info_model (id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(db_id(&objects[&target].to_string())?).bind(db_id(user)?).bind(db_id(&layers[m.layer_key.as_str()].to_string())?).bind(&m.marker_name).bind(m.latitude).bind(m.longitude).bind(&m.detail).bind(m.created_at.naive_utc()).bind(m.updated_at.naive_utc()).execute(&mut *tx).await?;
    }
    for s in &p.shapes {
        let target = Target {
            kind: "shape".into(),
            key: s.key.clone(),
        };
        sqlx::query("INSERT INTO shape_model (id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(db_id(&objects[&target].to_string())?).bind(db_id(user)?).bind(db_id(&layers[s.layer_key.as_str()].to_string())?).bind(&s.shape_type).bind(&s.name).bind(Json(&s.geojson)).bind(s.created_at.naive_utc()).bind(s.updated_at.naive_utc()).execute(&mut *tx).await?;
    }
    for c in &p.form_configs {
        let kind = &c.target.kind; // validated closed set, never interpolated from unvalidated input
        sqlx::query(&format!("INSERT INTO {kind}_form_config_model ({kind}_id,public_id,enabled,form_title,form_description,form_schema,password_hash,source_form,managed_layer_id,create_at,update_at) VALUES ($1,$2,false,$3,$4,$5,NULL,$6,$7,$8,$9)"))
            .bind(db_id(&objects[&c.target].to_string())?).bind(db_id(&Uuid::new_v4().to_string())?).bind(&c.form_title).bind(&c.form_description).bind(Json(&c.form_schema)).bind(source_db(&c.source_form,&forms)).bind(c.managed_layer_key.as_ref().map(|l| db_id(&layers[l.as_str()].to_string())).transpose()?).bind(c.created_at.naive_utc()).bind(c.updated_at.naive_utc()).execute(&mut *tx).await?;
    }
    // Sorting fresh UUIDs preserves the source tie order without changing dates,
    // adding persistent ordering fields, or reducing UUID randomness.
    let mut ids: Vec<_> = p.submissions.iter().map(|_| Uuid::new_v4()).collect();
    ids.sort_unstable();
    let mut submissions: Vec<_> = p.submissions.iter().collect();
    submissions.sort_by_key(|s| s.source_order);
    let mut answer_ids = HashMap::new();
    for (s, id) in submissions.into_iter().zip(ids) {
        answer_ids.insert(s.key.clone(), id);
        let kind = &s.target.kind;
        sqlx::query(&format!("INSERT INTO {kind}_form_submission_model (id,{kind}_id,submitted_values,rendered_markdown,create_at,source_form,form_snapshot,edited_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)"))
            .bind(db_id(&id.to_string())?).bind(db_id(&objects[&s.target].to_string())?).bind(Json(&s.submitted_values)).bind(&s.rendered_markdown).bind(s.created_at.naive_utc()).bind(source_db(&s.source_form,&forms)).bind(s.form_snapshot.as_ref().map(Json)).bind(s.edited_at.map(|t|t.naive_utc())).execute(&mut *tx).await?;
    }
    for (target, parts) in p
        .markers
        .iter()
        .map(|m| {
            (
                Target {
                    kind: "marker".into(),
                    key: m.key.clone(),
                },
                &m.body_parts,
            )
        })
        .chain(p.shapes.iter().map(|s| {
            (
                Target {
                    kind: "shape".into(),
                    key: s.key.clone(),
                },
                &s.body_parts,
            )
        }))
    {
        if let Some(parts) = parts {
            let rebound: Vec<_> = parts
                .iter()
                .map(|part| match part {
                    BodyPart::Text { text } => {
                        super::super::marker_forms::answer_edit::BodyPart::Text {
                            text: text.clone(),
                        }
                    },
                    BodyPart::Answer { key } => {
                        super::super::marker_forms::answer_edit::BodyPart::Answer {
                            id: answer_ids[key].to_string(),
                        }
                    },
                })
                .collect();
            super::super::marker_forms::answer_edit::store_parts(
                &mut tx,
                user,
                &target.kind,
                &objects[&target].to_string(),
                Some(&rebound),
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}
