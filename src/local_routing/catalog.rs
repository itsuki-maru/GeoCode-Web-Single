//! 完成した経路データのカタログ。世代はディレクトリのrenameで一度に公開される。
use crate::utils::{is_link, read_managed_json};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) const GRAPH: &str = "graph.sqlite";
pub(crate) const MANIFEST: &str = "generation.json";

#[derive(Serialize, Deserialize)]
pub(crate) struct Generation {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) sequence: u64,
    pub(crate) created_at: String,
    pub(crate) info: Value,
}

pub(crate) fn canonical_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

pub(crate) fn store(dataset_root: &Path, create: bool) -> Result<Option<PathBuf>> {
    let root = dataset_root.join("routing");
    if create {
        fs::create_dir_all(&root)?;
    }
    match fs::symlink_metadata(&root) {
        Ok(meta) if meta.is_dir() && !is_link(&meta) => Ok(Some(root)),
        Ok(_) => bail!("経路データの保存先には通常のフォルダーを指定してください。"),
        Err(error) if error.kind() == ErrorKind::NotFound && !create => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn generation(root: &Path, id: &str) -> Result<Generation> {
    ensure!(canonical_id(id), "経路データの世代IDが不正です。");
    let directory = root.join(id);
    let meta = fs::symlink_metadata(&directory).context("経路データの世代を確認できません。")?;
    ensure!(
        meta.is_dir() && !is_link(&meta),
        "経路データの保存先が不正です。"
    );
    let manifest: Generation = read_managed_json(&directory.join(MANIFEST))?;
    ensure!(manifest.id == id, "経路データの世代が一致しません。");
    let meta = fs::symlink_metadata(directory.join(GRAPH)).context("経路DBを確認できません。")?;
    ensure!(
        meta.is_file() && !is_link(&meta),
        "経路DBの形式が不正です。"
    );
    Ok(manifest)
}

fn generation_ids(root: &Path) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if let Some(id) = entry.file_name().to_str().filter(|id| canonical_id(id)) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

pub(crate) fn generations(root: &Path) -> Result<Vec<Generation>> {
    let mut result = generation_ids(root)?
        .iter()
        .map(|id| generation(root, id))
        .collect::<Result<Vec<_>>>()?;
    result.sort_unstable_by_key(|item| std::cmp::Reverse(item.sequence));
    Ok(result)
}

/// 1件の検索が参照する完成世代を固定する。更新後も古い世代のファイルは保持される。
pub(crate) fn latest_graph(dataset_root: &Path, name: &str) -> Result<PathBuf> {
    let root = store(dataset_root, false)?.context("公開する道路網が見つかりません。")?;
    // 管理画面には全世代の診断を返すが、配信には完全な世代だけを使う。
    let latest = generation_ids(&root)?
        .iter()
        .filter_map(|id| generation(&root, id).ok())
        .filter(|item| item.name == name)
        .max_by_key(|item| item.sequence)
        .context("指定した名前の完成済み道路網が見つかりません。")?;
    Ok(root.join(latest.id).join(GRAPH))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stage(root: &Path, name: &str, sequence: u64) -> Result<(PathBuf, PathBuf)> {
        let id = Uuid::new_v4().to_string();
        let staging = root.join(format!(".building-{id}"));
        fs::create_dir(&staging)?;
        fs::write(staging.join(GRAPH), name)?;
        fs::write(
            staging.join(MANIFEST),
            serde_json::to_vec(&json!({
                "id":id, "name":name, "sequence":sequence, "created_at":"2026-11-25", "info":{}
            }))?,
        )?;
        Ok((staging, root.join(id)))
    }

    #[test]
    fn published_name_follows_only_committed_generations_and_keeps_previous_graph() -> Result<()> {
        let dataset = tempfile::tempdir()?;
        assert!(latest_graph(dataset.path(), "日本全国").is_err());
        assert!(!dataset.path().join("routing").exists());

        let root = store(dataset.path(), true)?.unwrap();
        let (staging, previous) = stage(&root, "日本全国", 1)?;
        fs::rename(staging, &previous)?;
        let (staging, another) = stage(&root, "新潟", 2)?;
        fs::rename(staging, another)?;
        let (staging, next) = stage(&root, "日本全国", 3)?;
        let in_flight = latest_graph(dataset.path(), "日本全国")?;
        assert_eq!(in_flight, previous.join(GRAPH));
        assert!(latest_graph(dataset.path(), "日本").is_err());

        fs::rename(staging, &next)?;
        assert_eq!(latest_graph(dataset.path(), "日本全国")?, next.join(GRAPH));
        assert_eq!(fs::read_to_string(in_flight)?, "日本全国");
        Ok(())
    }

    #[test]
    fn rejects_manifests_with_mismatched_ids_and_incomplete_published_files() -> Result<()> {
        let dataset = tempfile::tempdir()?;
        let root = store(dataset.path(), true)?.unwrap();
        let (staging, next) = stage(&root, "日本全国", 1)?;
        let wrong = root.join(Uuid::new_v4().to_string());
        fs::rename(staging, &wrong)?;
        assert!(latest_graph(dataset.path(), "日本全国").is_err());
        fs::rename(wrong, &next)?;
        fs::remove_file(next.join(GRAPH))?;
        assert!(latest_graph(dataset.path(), "日本全国").is_err());
        Ok(())
    }

    #[test]
    fn broken_siblings_do_not_hide_the_latest_complete_named_graph() -> Result<()> {
        let dataset = tempfile::tempdir()?;
        let root = store(dataset.path(), true)?.unwrap();
        let (staging, expected) = stage(&root, "日本全国", 1)?;
        fs::rename(staging, &expected)?;
        let (staging, incomplete) = stage(&root, "日本全国", 2)?;
        fs::rename(staging, &incomplete)?;
        fs::remove_file(incomplete.join(GRAPH))?;
        let (staging, unrelated) = stage(&root, "四国", 3)?;
        fs::rename(staging, &unrelated)?;
        fs::write(unrelated.join(MANIFEST), "broken JSON")?;

        assert_eq!(
            latest_graph(dataset.path(), "日本全国")?,
            expected.join(GRAPH)
        );
        assert!(latest_graph(dataset.path(), "四国").is_err());
        assert!(generations(&root).is_err(), "管理画面では破損を診断できる");
        Ok(())
    }
}
