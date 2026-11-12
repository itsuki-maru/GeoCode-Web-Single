//! 保存済みの描画契約を照合する。ビルド来歴は生成可否の判断に使わない。

use super::catalog::ProfileRecord;
use crate::tilegen::{
    dataset::{Dataset, RenderOptions},
    identity::{self, RenderContract},
    render_spec::RenderSpec,
    tile::TileId,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct StoredIdentity {
    identity_version: u32,
    render_identity: String,
    render_contract: RenderContract,
}

/// 形式・構成・識別子がすべて現在の契約に一致する世代だけを生成可能とする。
/// 旧形式や未知の形式は保存済みPNGの配信に限って利用する。
pub fn is_compatible(profile: &ProfileRecord) -> bool {
    if profile.retired {
        return false;
    }
    let Ok(stored) = serde_json::from_str::<StoredIdentity>(&profile.info_json) else {
        return false;
    };
    if stored.identity_version != stored.render_contract.identity_version {
        return false;
    }
    let current = match stored.render_contract.render_spec {
        Some(spec) => RenderContract::for_spec(
            stored.render_contract.schema_version,
            stored.render_contract.geometry_version,
            spec,
        ),
        None => RenderContract::for_format(
            stored.render_contract.schema_version,
            stored.render_contract.geometry_version,
        ),
    };
    let Some(current) = current else {
        return false;
    };
    stored.render_contract == current
        && stored.render_identity == current.id()
        && profile.id == identity::render_id(&profile.dataset_id, &current)
}

/// 同じ完成DB・描画契約は、登録元のビルドが違っても同じ世代になる。
pub fn record(dataset_id: &str, dataset: &Dataset) -> super::runtime::Result<ProfileRecord> {
    record_with_spec(dataset_id, dataset, None)
}

/// 明示した描画内容を保存し、同じ完成DBに複数の不変な描画世代を登録する。
pub fn record_with_spec(
    dataset_id: &str,
    dataset: &Dataset,
    spec: Option<RenderSpec>,
) -> super::runtime::Result<ProfileRecord> {
    let options = spec.map_or_else(RenderOptions::default, RenderOptions::with_spec);
    let contract = dataset.render_contract_for(&options).map_err(|error| {
        if error.kind() == crate::tilegen::dataset::ErrorKind::InvalidDataset {
            super::runtime::Failure::new(400, error.to_string())
        } else {
            super::runtime::render_failure(error)
        }
    })?;
    let profile = dataset.profile();
    let tile = TileId::new(0, 0, 0).unwrap();
    let sdk = identity::tile_cache_key(dataset_id, &contract, tile.z, tile.x, tile.y);
    Ok(ProfileRecord {
        id: identity::render_id(dataset_id, &contract),
        dataset_id: dataset_id.into(),
        build_id: env!("TILEGEN_BUILD_ID").into(),
        retired: false,
        info_json: json!({
            "identity_version": contract.identity_version,
            "render_identity": contract.id(),
            "render_contract": contract,
            "sdk_identity": sdk,
            "style_version": contract.style_version,
            "image_version": profile.image_version,
            "tile_size": contract.tile_size,
        })
        .to_string(),
    })
}

/// 保存済み世代から生成設定を復元し、現在の既定値への置換を防ぐ。
pub fn resolve(
    profile: &ProfileRecord,
    dataset: &Dataset,
) -> super::runtime::Result<(RenderOptions, RenderContract)> {
    if profile.dataset_id != dataset.info().dataset_id || !is_compatible(profile) {
        return Err(super::runtime::Failure::new(
            410,
            "指定された描画世代の未生成タイルは利用できません。",
        ));
    }
    let stored: StoredIdentity =
        serde_json::from_str(&profile.info_json).map_err(super::runtime::Failure::internal)?;
    let options = stored
        .render_contract
        .render_spec
        .map_or_else(RenderOptions::default, RenderOptions::with_spec);
    let contract = dataset
        .render_contract_for(&options)
        .map_err(super::runtime::render_failure)?;
    if contract != stored.render_contract {
        return Err(super::runtime::Failure::new(
            410,
            "保存された描画契約を再現できません。",
        ));
    }
    Ok((options, contract))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored() -> ProfileRecord {
        let contract = RenderContract::for_format(1, 1).unwrap();
        let dataset_id = "a".repeat(64);
        ProfileRecord {
            id: identity::render_id(&dataset_id, &contract),
            dataset_id,
            build_id: "別のビルド来歴".into(),
            retired: false,
            info_json: json!({"identity_version":2,"render_identity":contract.id(),"render_contract":contract}).to_string(),
        }
    }

    #[test]
    fn 描画契約が同じなら登録元のビルドを問わない() {
        let mut profile = stored();
        assert!(is_compatible(&profile));
        profile.build_id = "さらに別のビルド".into();
        assert!(is_compatible(&profile));
    }

    #[test]
    fn 同じdbの複数表示を区別し無効な非正規化契約を認めない() {
        let mut a = stored();
        let contract = RenderContract::for_format(3, 2).unwrap();
        a.id = identity::render_id(&a.dataset_id, &contract);
        a.info_json = json!({"identity_version":4,"render_identity":contract.id(),"render_contract":contract}).to_string();
        assert!(is_compatible(&a));
        let mut spec = RenderSpec::osm_like();
        spec.roads = false;
        let other = RenderContract::for_spec(3, 2, spec).unwrap();
        let mut b = a.clone();
        b.id = identity::render_id(&b.dataset_id, &other);
        b.info_json =
            json!({"identity_version":4,"render_identity":other.id(),"render_contract":other})
                .to_string();
        assert!(is_compatible(&b));
        assert_ne!(a.id, b.id);
        let mut info: serde_json::Value = serde_json::from_str(&b.info_json).unwrap();
        info["render_contract"]["render_spec"]["labels"] = json!(false);
        b.info_json = info.to_string();
        assert!(!is_compatible(&b));
    }

    #[test]
    fn 旧形式と未知形式と改変された世代は生成可能にしない() {
        for mutation in [
            "legacy", "version", "contract", "schema", "geometry", "hash", "profile", "dataset",
            "retired",
        ] {
            let mut profile = stored();
            let mut info: serde_json::Value = serde_json::from_str(&profile.info_json).unwrap();
            match mutation {
                "legacy" => {
                    info = json!({"sdk_identity":"過去の不透明なキー","style_version":"roads-v1"})
                },
                "version" => info["identity_version"] = json!(999),
                "contract" => info["render_contract"]["renderer_revision"] = json!(999),
                "schema" => info["render_contract"]["schema_version"] = json!(999),
                "geometry" => info["render_contract"]["geometry_version"] = json!(999),
                "hash" => info["render_identity"] = json!("b".repeat(64)),
                "profile" => profile.id = "b".repeat(64),
                "dataset" => profile.dataset_id = "b".repeat(64),
                "retired" => profile.retired = true,
                _ => unreachable!(),
            }
            profile.info_json = info.to_string();
            assert!(!is_compatible(&profile), "{mutation}");
        }
    }
}
