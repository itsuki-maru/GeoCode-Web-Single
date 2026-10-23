use anyhow::{Context, ensure};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

#[derive(Deserialize)]
struct Fixture {
    format_version: u32,
    profile: String,
    seed: i64,
    rows: Vec<FixtureRow>,
    checks: Vec<Check>,
}

#[derive(Deserialize)]
struct FixtureRow {
    table: String,
    values: BTreeMap<String, Value>,
}

#[derive(Deserialize, PartialEq)]
struct Check {
    name: String,
    owner: String,
    query: Value,
    expected: Expected,
}

#[derive(Deserialize, PartialEq)]
struct Expected {
    answers: i64,
    targets: i64,
}

fn literal(value: &Value) -> anyhow::Result<String> {
    Ok(match value {
        Value::Null => "NULL".into(),
        Value::Bool(v) => if *v { "TRUE" } else { "FALSE" }.into(),
        Value::Number(v) => v.to_string(),
        other => {
            let s = match other {
                Value::String(v) => v.clone(),
                _ => serde_json::to_string(other)?,
            };
            ensure!(!s.contains('\0'), "NULは使用できません");
            let escaped = s.replace('\'', "''");
            if POSTGRES {
                format!("E'{}'", escaped.replace('\\', "\\\\"))
            } else {
                format!("'{escaped}'")
            }
        },
    })
}

fn identifier(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

fn row_key(row: &FixtureRow) -> anyhow::Result<String> {
    let key = if let Some(id) = row.values.get("id") {
        id.to_string()
    } else if row.table == "common_form_revision_model" {
        format!("{}:{}", row.values["form_id"], row.values["version"])
    } else {
        row.values
            .get("marker_id")
            .or_else(|| row.values.get("shape_id"))
            .context("行の識別情報がありません")?
            .to_string()
    };
    Ok(format!("{}:{key}", row.table))
}

fn row_predicate(row: &FixtureRow) -> anyhow::Result<String> {
    row.values
        .iter()
        .map(|(key, value)| {
            ensure!(identifier(key), "不正な列名です");
            Ok(if value.is_null() {
                format!("{key} IS NULL")
            } else {
                format!("{key} = {}", literal(value)?)
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .map(|v| v.join(" AND "))
}

fn upgrade_plan<'a>(
    old: &'a Fixture,
    new: &'a Fixture,
) -> anyhow::Result<(
    Vec<(&'a FixtureRow, &'a FixtureRow, Vec<&'a str>)>,
    Vec<&'a FixtureRow>,
)> {
    ensure!(
        old.format_version == 1 && new.format_version == 2,
        "第1版から第2版への更新のみ対応します"
    );
    ensure!(
        old.profile == new.profile && old.seed == new.seed && old.checks == new.checks,
        "対象セット・シード・検証条件は変更できません"
    );
    let mut next = BTreeMap::new();
    for row in &new.rows {
        ensure!(
            next.insert(row_key(row)?, row).is_none(),
            "識別情報が重複しています"
        );
    }
    let mut updates = Vec::new();
    for before in &old.rows {
        let after = next
            .remove(&row_key(before)?)
            .context("既存行の削除はできません")?;
        ensure!(
            before.values.keys().eq(after.values.keys()),
            "列の追加・削除はできません"
        );
        let changed: Vec<&str> = before
            .values
            .iter()
            .filter(|(k, v)| after.values.get(*k) != Some(*v))
            .map(|(k, _)| k.as_str())
            .collect();
        let allowed: &[&str] = match before.table.as_str() {
            "layer_model" => &["is_master"],
            "marker_info_model" => &["detail", "update_at"],
            "shape_model" => &["geojson", "updated_at"],
            "marker_form_submission_model" | "shape_form_submission_model" => {
                &["rendered_markdown"]
            },
            _ => &[],
        };
        ensure!(
            changed.iter().all(|c| allowed.contains(c)),
            "許可されていない変更です: {}",
            before.table
        );
        if before.table == "shape_model" && changed.contains(&"geojson") {
            let mut geometry = before.values["geojson"].clone();
            geometry["properties"]["memo"] = after.values["geojson"]["properties"]["memo"].clone();
            ensure!(
                geometry == after.values["geojson"],
                "図形メモ以外は変更できません"
            );
        }
        if before.table == "layer_model" && !changed.is_empty() {
            ensure!(
                before.values["is_master"] == true && after.values["is_master"] == false,
                "地域レイヤのmasterフラグ解除のみ許可します"
            );
        }
        if !changed.is_empty() {
            updates.push((before, after, changed));
        }
    }
    let inserts: Vec<_> = next.into_values().collect();
    ensure!(inserts.len() == 2, "追加するmasterは2ユーザー分のみです");
    ensure!(
        inserts[0].values["user_id"] != inserts[1].values["user_id"],
        "masterはユーザーごとに1つです"
    );
    for row in &inserts {
        ensure!(
            row.table == "layer_model"
                && row.values["is_master"] == true
                && row.values["layer_name"] == "master",
            "独立master以外は追加できません"
        );
        ensure!(
            old.rows
                .iter()
                .any(|r| r.table == "user_model" && r.values["id"] == row.values["user_id"]),
            "既存の検証ユーザーではありません"
        );
    }
    Ok((updates, inserts))
}

async fn verify_display(pool: &Pool, fixture: &Fixture) -> anyhow::Result<()> {
    let mut checked = 0;
    for row in &fixture.rows {
        if !matches!(
            row.table.as_str(),
            "layer_model"
                | "marker_info_model"
                | "shape_model"
                | "marker_form_submission_model"
                | "shape_form_submission_model"
        ) {
            continue;
        }
        let sql = format!(
            "SELECT COUNT(*) FROM {} WHERE {}",
            row.table,
            row_predicate(row)?
        );
        let count: i64 = sqlx::query_scalar(&sql).fetch_one(pool).await?;
        ensure!(
            count == 1,
            "本文・メモ・レイヤまたは回答に不一致があります: {}",
            row_key(row)?
        );
        checked += 1;
    }
    println!("PASS 本文・メモ・レイヤ・構造化回答: {checked}行一致");
    Ok(())
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use serde_json::json;

    fn fixtures() -> (Fixture, Fixture) {
        let old = json!({"format_version":1,"profile":"small","seed":1,"checks":[],"rows":[
            {"table":"user_model","values":{"id":"u1"}},
            {"table":"user_model","values":{"id":"u2"}},
            {"table":"layer_model","values":{"id":"l1","user_id":"u1","is_master":true}},
            {"table":"layer_model","values":{"id":"l2","user_id":"u2","is_master":true}},
            {"table":"marker_info_model","values":{"id":"m","latitude":35,"detail":"base","update_at":"old"}},
            {"table":"shape_model","values":{"id":"s","geojson":{"properties":{},"geometry":{"coordinates":[[139,35]]}},"updated_at":"old"}},
            {"table":"marker_form_submission_model","values":{"id":"a","submitted_values":{"n":0},"rendered_markdown":"old"}}
        ]});
        let mut new = old.clone();
        new["format_version"] = json!(2);
        new["rows"][2]["values"]["is_master"] = json!(false);
        new["rows"][3]["values"]["is_master"] = json!(false);
        new["rows"][4]["values"]["detail"] = json!("base + answer");
        new["rows"][4]["values"]["update_at"] = json!("new");
        new["rows"][5]["values"]["geojson"]["properties"]["memo"] = json!("answer");
        new["rows"][5]["values"]["updated_at"] = json!("new");
        new["rows"][6]["values"]["rendered_markdown"] = json!("answer");
        for (id, user) in [("master1", "u1"), ("master2", "u2")] {
            new["rows"]
                .as_array_mut()
                .unwrap()
                .push(json!({"table":"layer_model","values":{
                "id":id,"user_id":user,"layer_name":"master","is_master":true}}));
        }
        (
            serde_json::from_value(old).unwrap(),
            serde_json::from_value(new).unwrap(),
        )
    }

    #[test]
    fn allows_only_display_repair() {
        let (old, new) = fixtures();
        let (updates, inserts) = upgrade_plan(&old, &new).unwrap();
        assert_eq!(updates.len(), 5);
        assert_eq!(inserts.len(), 2);
    }

    #[test]
    fn rejects_answer_and_position_changes() {
        let (old, mut new) = fixtures();
        new.rows[6].values.get_mut("submitted_values").unwrap()["n"] = json!(1);
        assert!(upgrade_plan(&old, &new).is_err());
        let (old, mut new) = fixtures();
        new.rows[4].values.insert("latitude".into(), json!(36));
        assert!(upgrade_plan(&old, &new).is_err());
        let (old, mut new) = fixtures();
        new.rows[5].values.get_mut("geojson").unwrap()["geometry"]["coordinates"] =
            json!([[140, 36]]);
        assert!(upgrade_plan(&old, &new).is_err());
    }

    #[test]
    fn rejects_removal_wrong_seed_and_duplicate_master() {
        let (old, mut new) = fixtures();
        new.rows.remove(4);
        assert!(upgrade_plan(&old, &new).is_err());
        let (old, mut new) = fixtures();
        new.seed += 1;
        assert!(upgrade_plan(&old, &new).is_err());
        let (old, mut new) = fixtures();
        new.rows[8].values.insert("user_id".into(), json!("u1"));
        assert!(upgrade_plan(&old, &new).is_err());
    }
}

async fn csv_body_count(response: axum::response::Response) -> anyhow::Result<i64> {
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024).await?;
    ensure!(
        body.starts_with(&[0xef, 0xbb, 0xbf]),
        "CSVのBOMがありません"
    );
    let mut quoted = false;
    let mut records = 0;
    for (i, byte) in body.iter().enumerate().skip(3) {
        if *byte == b'"' {
            quoted = !quoted;
        }
        if *byte == b'\n' && !quoted {
            ensure!(
                i > 0 && body[i - 1] == b'\r',
                "CSVの改行がCRLFではありません"
            );
            records += 1;
        }
    }
    ensure!(!quoted && records > 0, "CSVの形式が不正です");
    println!("CSV SHA256 {:x}", Sha256::digest(&body));
    Ok(records - 1)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    ensure!(
        (1..=3).contains(&args.len()),
        "usage: analysis_data MANIFEST.json [--verify | --upgrade-from OLD.json]"
    );
    let verify_only = args.get(1).is_some_and(|a| a == "--verify");
    let upgrade = args.len() == 3 && args[1] == "--upgrade-from";
    ensure!(
        args.len() == 1 || (args.len() == 2 && verify_only) || upgrade,
        "不明なオプションです"
    );
    let bytes = std::fs::read(Path::new(&args[0]))?;
    let fingerprint = format!("{:x}", Sha256::digest(&bytes));
    let fixture: Fixture = serde_json::from_slice(&bytes)?;
    ensure!(
        fixture.format_version == 2 || (verify_only && fixture.format_version == 1),
        "未対応のデータ形式です"
    );
    let password = if verify_only || upgrade {
        None
    } else {
        let value = std::env::var("ANALYSIS_TEST_PASSWORD")
            .context("ANALYSIS_TEST_PASSWORDを設定してください（12文字以上）")?;
        ensure!(
            value.chars().count() >= 12 && value.len() <= 72,
            "パスワードは12文字以上・72バイト以下にしてください"
        );
        Some(bcrypt::hash(value, bcrypt::DEFAULT_COST)?)
    };
    ensure!(
        matches!(
            fixture.profile.as_str(),
            "small" | "basic" | "normal" | "infrastructure"
        ),
        "未対応のプロファイルです"
    );
    let pool = connect(&fixture.profile, verify_only || upgrade).await?;
    let mut tx = pool.begin().await?;
    let previous: Option<String> =
        sqlx::query_scalar("SELECT fingerprint FROM analysis_fixture_metadata WHERE id=1")
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(previous) = previous {
        if upgrade && previous != fingerprint {
            let old_bytes = std::fs::read(&args[2])?;
            ensure!(
                previous == format!("{:x}", Sha256::digest(&old_bytes)),
                "旧JSONが投入済みデータと一致しません"
            );
            let old: Fixture = serde_json::from_slice(&old_bytes)?;
            let (updates, inserts) = upgrade_plan(&old, &fixture)?;
            for (before, after, changed) in &updates {
                let assignments = changed
                    .iter()
                    .map(|key| Ok(format!("{key} = {}", literal(&after.values[*key])?)))
                    .collect::<anyhow::Result<Vec<_>>>()?
                    .join(",");
                let sql = format!(
                    "UPDATE {} SET {} WHERE {}",
                    before.table,
                    assignments,
                    row_predicate(before)?
                );
                let result = sqlx::query(&sql).execute(&mut *tx).await?;
                ensure!(
                    result.rows_affected() == 1,
                    "DBが旧データから変更されています。上書きせず中止します: {}",
                    row_key(before)?
                );
            }
            for row in &inserts {
                let columns: Vec<_> = row.values.keys().map(String::as_str).collect();
                ensure!(columns.iter().all(|c| identifier(c)), "不正な列名です");
                let values = row
                    .values
                    .values()
                    .map(literal)
                    .collect::<anyhow::Result<Vec<_>>>()?;
                let sql = format!(
                    "INSERT INTO layer_model ({}) VALUES ({})",
                    columns.join(","),
                    values.join(",")
                );
                sqlx::query(&sql).execute(&mut *tx).await?;
            }
            let sql = format!(
                "UPDATE analysis_fixture_metadata SET fingerprint={} WHERE id=1",
                literal(&Value::String(fingerprint.clone()))?
            );
            sqlx::query(&sql).execute(&mut *tx).await?;
            println!(
                "表示データを更新しました: {}行更新・{}レイヤ追加",
                updates.len(),
                inserts.len()
            );
        } else {
            ensure!(
                previous == fingerprint,
                "別のデータセットが投入済みです。別の専用DBを用意してください"
            );
            println!("同一データセットが投入済みです。追加投入せず検証します。");
        }
    } else {
        ensure!(!verify_only, "データセットが投入されていません");
        for row in &fixture.rows {
            ensure!(
                matches!(
                    row.table.as_str(),
                    "user_model"
                        | "layer_model"
                        | "common_form_model"
                        | "common_form_revision_model"
                        | "marker_info_model"
                        | "shape_model"
                        | "marker_form_config_model"
                        | "shape_form_config_model"
                        | "marker_form_submission_model"
                        | "shape_form_submission_model"
                ),
                "未対応のテーブルです"
            );
            let mut columns = Vec::new();
            let mut values = Vec::new();
            for (key, value) in &row.values {
                ensure!(identifier(key), "不正な列名です");
                columns.push(key.as_str());
                let value = if row.table == "user_model" && key == "password" {
                    Value::String(password.as_ref().unwrap().clone())
                } else {
                    value.clone()
                };
                values.push(literal(&value)?);
            }
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                row.table,
                columns.join(","),
                values.join(",")
            );
            sqlx::query(&sql)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("{}への投入に失敗しました", row.table))?;
        }
        let sql = format!(
            "INSERT INTO analysis_fixture_metadata (id,fingerprint) VALUES (1,{})",
            literal(&Value::String(fingerprint))?
        );
        sqlx::query(&sql).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    if fixture.format_version == 2 {
        verify_display(&pool, &fixture).await?;
    }
    for check in &fixture.checks {
        let q: app::handler::form_answers::AnswerQuery =
            serde_json::from_value(check.query.clone())?;
        let count = search(&pool, &check.owner, q.clone()).await?;
        ensure!(
            count == check.expected.answers,
            "{}: 検索件数 {} != {}",
            check.name,
            count,
            check.expected.answers
        );
        if check.expected.targets > 0 {
            let (answers, targets) = map_counts(&pool, &check.owner, &q).await?;
            ensure!(
                answers == count && targets == check.expected.targets,
                "{}: 地図件数が不一致です",
                check.name
            );
        }
        let exported = csv_count(&pool, &check.owner, q).await?;
        ensure!(exported == count, "{}: CSV件数が不一致です", check.name);
        println!(
            "PASS {}: {}回答 / {}対象",
            check.name, count, check.expected.targets
        );
    }
    println!("完了: {}条件を検証しました。", fixture.checks.len());
    pool.close().await;
    Ok(())
}
