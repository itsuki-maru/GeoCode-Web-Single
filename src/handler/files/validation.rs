use crate::{
    error::AppError,
    model::{MarkerFormConfigUpdate, MarkerFormSchema, transfer::*},
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(super) fn invalid(message: &str) -> AppError {
    AppError::Validation(format!("JSONデータ: {message}"))
}

fn keys<'a>(keys: impl Iterator<Item = &'a str>) -> Result<HashSet<&'a str>, AppError> {
    let mut found = HashSet::new();
    for key in keys {
        if key.is_empty()
            || key.len() > 100
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || !found.insert(key)
        {
            return Err(invalid("識別キーが不正、または重複しています。"));
        }
    }
    Ok(found)
}

fn definition(
    title: &str,
    description: &str,
    schema: &Value,
) -> Result<MarkerFormSchema, AppError> {
    if !schema.is_object() || !schema.get("fields").is_some_and(Value::is_array) {
        return Err(invalid("フォーム定義が不正です。"));
    }
    let schema: MarkerFormSchema =
        serde_json::from_value(schema.clone()).map_err(|_| invalid("フォーム定義が不正です。"))?;
    // Cleared, disabled object configurations legitimately have no title/fields.
    super::super::marker_forms::validate_config(&MarkerFormConfigUpdate {
        source_form: None,
        enabled: false,
        form_title: if title.is_empty() && schema.fields.is_empty() {
            "-".into()
        } else {
            title.into()
        },
        form_description: description.into(),
        form_schema: schema.clone(),
        password_mode: "keep".into(),
        password: None,
    })?;
    Ok(schema)
}

pub(super) fn validate(p: &TransferPackage) -> Result<(), AppError> {
    if p.format != "geocode-web" || p.version != 3 || p.image_policy != "references_only" {
        return Err(invalid("対応していない形式・バージョン・画像方針です。"));
    }
    let layers = keys(p.layers.iter().map(|v| v.key.as_str()))?;
    let markers = keys(p.markers.iter().map(|v| v.key.as_str()))?;
    let shapes = keys(p.shapes.iter().map(|v| v.key.as_str()))?;
    keys(p.common_forms.iter().map(|v| v.key.as_str()))?;
    keys(p.submissions.iter().map(|v| v.key.as_str()))?;
    let forms: HashMap<_, _> = p.common_forms.iter().map(|v| (v.key.as_str(), v)).collect();
    let versions: HashSet<_> = p
        .common_forms
        .iter()
        .flat_map(|f| f.revisions.iter().map(|r| (f.key.as_str(), r.version)))
        .collect();
    let source = |v: &SourceForm| -> Result<(), AppError> {
        let form = forms
            .get(v.form_key.as_str())
            .ok_or_else(|| invalid("参照先の共通フォームがありません。"))?;
        if !versions.contains(&(form.key.as_str(), v.version)) {
            return Err(invalid("参照先のフォームの版がありません。"));
        }
        Ok(())
    };
    let target = |t: &Target| -> Result<(), AppError> {
        let exists = match t.kind.as_str() {
            "marker" => markers.contains(t.key.as_str()),
            "shape" => shapes.contains(t.key.as_str()),
            _ => false,
        };
        if !exists {
            return Err(invalid("参照先の対象がありません。"));
        }
        Ok(())
    };
    for f in &p.common_forms {
        if f.form_title.trim().is_empty()
            || f.version < 1
            || f.revisions.len() != f.version as usize
        {
            return Err(invalid("共通フォームの名前または版履歴が不正です。"));
        }
        definition(&f.form_title, &f.form_description, &f.form_schema)?;
        let mut revisions: Vec<_> = f.revisions.iter().collect();
        revisions.sort_by_key(|r| r.version);
        let mut seen = HashMap::new();
        let mut previous = HashSet::new();
        for (index, revision) in revisions.iter().enumerate() {
            if revision.version as usize != index + 1 {
                return Err(invalid("版履歴が重複または欠落しています。"));
            }
            let schema = definition(&f.form_title, &f.form_description, &revision.form_schema)?;
            let mut current = HashSet::new();
            for field in schema.fields {
                if let Some(old_type) = seen.get(&field.id) {
                    if old_type != &field.field_type || !previous.contains(&field.id) {
                        return Err(invalid("項目IDの型変更または再使用があります。"));
                    }
                }
                seen.insert(field.id.clone(), field.field_type);
                current.insert(field.id);
            }
            previous = current;
        }
        if revisions.last().map(|r| &r.form_schema) != Some(&f.form_schema) {
            return Err(invalid("現在の定義と最新版の定義が異なります。"));
        }
    }
    let mut layer_forms = HashMap::new();
    for l in &p.layers {
        if l.layer_name.trim().is_empty() || l.layer_name.chars().count() > 100 {
            return Err(invalid("レイヤ名は1〜100文字にしてください。"));
        }
        if let Some(f) = &l.common_form {
            source(f)?;
            let form = forms[f.form_key.as_str()];
            if form.deleted || f.version != form.version {
                return Err(invalid(
                    "管理レイヤの共通フォームが削除済み、または最新版ではありません。",
                ));
            }
            layer_forms.insert(l.key.as_str(), f);
        }
    }
    let mut target_layers = HashMap::new();
    for m in &p.markers {
        if !layers.contains(m.layer_key.as_str())
            || !m.latitude.is_finite()
            || !m.longitude.is_finite()
            || !(-90.0..=90.0).contains(&m.latitude)
            || !(-180.0..=180.0).contains(&m.longitude)
        {
            return Err(invalid("マーカーの所属または座標が不正です。"));
        }
        target_layers.insert(
            Target {
                kind: "marker".into(),
                key: m.key.clone(),
            },
            m.layer_key.as_str(),
        );
    }
    for s in &p.shapes {
        if !layers.contains(s.layer_key.as_str()) {
            return Err(invalid("図形の所属レイヤがありません。"));
        }
        crate::shape_validation::validate_shape_geojson(&s.shape_type, &s.geojson)?;
        target_layers.insert(
            Target {
                kind: "shape".into(),
                key: s.key.clone(),
            },
            s.layer_key.as_str(),
        );
    }
    let mut configured = HashMap::new();
    for c in &p.form_configs {
        target(&c.target)?;
        if configured.insert(&c.target, c).is_some() {
            return Err(invalid("対象別フォーム設定が重複しています。"));
        }
        let configured_schema = definition(&c.form_title, &c.form_description, &c.form_schema)?;
        if let Some(f) = &c.source_form {
            source(f)?;
            let revision = forms[f.form_key.as_str()]
                .revisions
                .iter()
                .find(|r| r.version == f.version)
                .ok_or_else(|| invalid("適用元の版がありません。"))?;
            let schema: MarkerFormSchema = serde_json::from_value(revision.form_schema.clone())
                .map_err(|_| invalid("適用元の定義が不正です。"))?;
            for field in &configured_schema.fields {
                if schema
                    .fields
                    .iter()
                    .any(|old| old.id == field.id && old.field_type != field.field_type)
                {
                    return Err(invalid("適用元と対象別設定で項目IDの型が異なります。"));
                }
            }
        }
        if let Some(layer) = &c.managed_layer_key {
            if target_layers[&c.target] != layer {
                return Err(invalid("管理レイヤと所属レイヤが異なります。"));
            }
            let expected = layer_forms
                .get(layer.as_str())
                .ok_or_else(|| invalid("管理レイヤに共通フォームがありません。"))?;
            let current = c
                .source_form
                .as_ref()
                .ok_or_else(|| invalid("管理フォームに適用元がありません。"))?;
            let f = forms[expected.form_key.as_str()];
            if current.form_key != expected.form_key
                || current.version != expected.version
                || c.form_schema != f.form_schema
                || c.form_title != f.form_title
                || c.form_description != f.form_description
            {
                return Err(invalid("レイヤ管理の定義と対象別設定が一致しません。"));
            }
        } else if layer_forms.contains_key(target_layers[&c.target]) {
            return Err(invalid("共通フォーム管理中のレイヤに個別設定があります。"));
        }
    }
    for (target, layer) in target_layers {
        if layer_forms.contains_key(layer) && !configured.contains_key(&target) {
            return Err(invalid("管理対象のフォーム設定が欠落しています。"));
        }
    }
    let mut orders = HashSet::new();
    for s in &p.submissions {
        target(&s.target)?;
        if !s.submitted_values.is_object() || s.source_order == 0 || !orders.insert(s.source_order)
        {
            return Err(invalid("回答値または回答順が不正です。"));
        }
        if let Some(f) = &s.source_form {
            source(f)?;
        }
        if let Some(snapshot) = &s.form_snapshot {
            let snapshot = snapshot
                .as_object()
                .ok_or_else(|| invalid("回答時の定義が不正です。"))?;
            if snapshot.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "form_title" | "form_description" | "form_schema"
                )
            }) {
                return Err(invalid("回答時の定義に不明な情報があります。"));
            }
            definition(
                snapshot
                    .get("form_title")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("回答時のフォーム名がありません。"))?,
                snapshot
                    .get("form_description")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("回答時の説明がありません。"))?,
                snapshot
                    .get("form_schema")
                    .ok_or_else(|| invalid("回答時の項目定義がありません。"))?,
            )?;
        }
    }
    for (target, parts, body) in p
        .markers
        .iter()
        .map(|m| {
            (
                Target {
                    kind: "marker".into(),
                    key: m.key.clone(),
                },
                &m.body_parts,
                m.detail.as_str(),
            )
        })
        .chain(p.shapes.iter().map(|s| {
            (
                Target {
                    kind: "shape".into(),
                    key: s.key.clone(),
                },
                &s.body_parts,
                s.geojson
                    .get("properties")
                    .and_then(|p| p.get("memo"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )
        }))
    {
        if let Some(parts) = parts {
            let answers: HashMap<_, _> = p
                .submissions
                .iter()
                .filter(|s| s.target == target)
                .map(|s| (s.key.as_str(), s))
                .collect();
            let mut used = HashSet::new();
            let mut rendered = String::new();
            for part in parts {
                match part {
                    BodyPart::Text { text } => rendered.push_str(text),
                    BodyPart::Answer { key } => {
                        if !used.insert(key.as_str()) {
                            return Err(invalid("本文の回答参照が重複しています。"));
                        }
                        rendered.push_str(
                            &answers
                                .get(key.as_str())
                                .ok_or_else(|| invalid("本文の回答参照が不正です。"))?
                                .rendered_markdown,
                        );
                    },
                }
            }
            if used.len() != answers.len() || rendered != body {
                return Err(invalid("本文・メモと回答の対応が一致しません。"));
            }
        }
    }
    Ok(())
}
