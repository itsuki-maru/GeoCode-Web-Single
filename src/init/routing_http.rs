use super::{
    backup_configuration, lock_configuration, parse_env_value, read_env_value, write_to_json_file,
};
use crate::{
    local_routing::{catalog::latest_graph, config::HttpSettings},
    routing::osrm_origins::validate_origin,
};
use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::path::Path;

/// 管理画面で開いた設定だけを更新する。datasetがNoneなら現在の道路網名を残して配信を停止する。
pub(crate) fn save(
    path: &Path,
    expected: &HttpSettings,
    dataset: Option<&str>,
    allow_origin: Option<&str>,
) -> Result<()> {
    ensure!(
        path.is_absolute() && path.is_file(),
        "セットアップ済みの設定JSONを開いてください。"
    );
    let parent = path
        .parent()
        .context("設定ファイルの親ディレクトリがありません。")?;
    let origin = match (dataset, allow_origin) {
        (Some(_), Some(raw)) => Some(validate_origin(raw.trim()).map_err(anyhow::Error::msg)?),
        _ => None,
    };

    // 起動時の設定移行・他の管理画面と同じロックで、最新のJSONに変更を重ねる。
    let _lock = lock_configuration(path)?;
    super::ensure_no_pending_move(path)?;
    let mut document = read_env_value(path)?;
    let settings = parse_env_value(parent, &document, || None)?;
    let current = settings.local_routing_http.unwrap_or_default();
    let next = HttpSettings {
        enabled: dataset.is_some(),
        dataset: dataset
            .map(str::trim)
            .unwrap_or(&current.dataset)
            .to_owned(),
    };
    ensure!(
        expected == &current || next == current,
        "配信設定が別の操作で更新されました。最新の設定を確認して保存してください。"
    );
    if next.enabled {
        let name = next.dataset_name().map_err(anyhow::Error::msg)?;
        latest_graph(Path::new(&settings.tile_dataset_path), name)?;
    }

    let existing = settings
        .osrm_allowed_origins
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let addition = origin.filter(|origin| !existing.clone().any(|entry| entry == *origin));
    if next == current && addition.is_none() {
        return Ok(());
    }
    if next != current {
        document["local_routing_http"] = json!(next);
    }
    if let Some(origin) = addition {
        document["osrm_allowed_origins"] =
            json!(existing.chain([origin]).collect::<Vec<_>>().join(","));
    }
    // 読み込み時の既定値や秘密鍵を再シリアライズせず、未知の設定も保持する。
    if let Some(object) = document.as_object_mut() {
        object.remove("tile_database_replacement");
    }
    backup_configuration(path, &path.with_added_extension("bak"))?;
    write_to_json_file(path.to_owned(), &document)?;
    Ok(())
}
