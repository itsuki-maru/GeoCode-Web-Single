//! 実行構成の認定と、描画・取り込みに関係する解決済み依存の確認。
//! 補助的な検証情報であり、描画世代の計算には使用しない。

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const DEPENDENCY_ROOTS: &[&str] = &[
    "tiny-skia",
    "libm",
    "rusqlite",
    "serde_json",
    "sha2",
    "osmpbfreader",
    "protobuf",
    "flate2",
];

pub const STANDARD_DEPENDENCY_ROOTS: &[&str] = &[
    "tiny-skia",
    "libm",
    "rusqlite",
    "serde_json",
    "sha2",
    "osmpbfreader",
    "protobuf",
    "flate2",
    "quick-xml",
    "crc32fast",
];

pub const OSM_DEPENDENCY_ROOTS: &[&str] = &[
    "tiny-skia",
    "libm",
    "rusqlite",
    "serde_json",
    "sha2",
    "osmpbfreader",
    "protobuf",
    "flate2",
    "quick-xml",
    "crc32fast",
    "harfrust",
    "skrifa",
    "unicode-segmentation",
];

#[derive(Debug, Clone)]
pub struct ExecutionConfig {
    pub compiler: String,
    pub target: String,
    pub opt_level: String,
    pub target_features: Vec<String>,
    pub rustflags: Vec<String>,
    pub application_features: Vec<String>,
    pub compiler_wrapper: bool,
}

/// パスや製品版を含めず、関係する依存の版・取得元・機能・依存辺を固定順で確認する。
pub fn dependency_fingerprint(metadata: &Value) -> Result<String, String> {
    dependency_fingerprint_for_roots(metadata, DEPENDENCY_ROOTS)
}

/// 標準地図だけの入力依存を含め、道路用の認定とは独立して確認する。
pub fn standard_dependency_fingerprint(metadata: &Value) -> Result<String, String> {
    dependency_fingerprint_for_roots(metadata, STANDARD_DEPENDENCY_ROOTS)
}

pub fn osm_dependency_fingerprint(metadata: &Value) -> Result<String, String> {
    dependency_fingerprint_for_roots(metadata, OSM_DEPENDENCY_ROOTS)
}

pub fn dependency_fingerprint_for_roots(
    metadata: &Value,
    roots: &[&str],
) -> Result<String, String> {
    let packages = metadata["packages"]
        .as_array()
        .ok_or("Cargo依存一覧がありません。")?;
    let nodes = metadata["resolve"]["nodes"]
        .as_array()
        .ok_or("Cargoの解決済み依存がありません。")?;
    let root = metadata["resolve"]["root"]
        .as_str()
        .ok_or("本体の依存ルートがありません。")?;
    let mut package_by_id = BTreeMap::new();
    for package in packages {
        let id = package["id"].as_str().ok_or("依存のIDがありません。")?;
        if package_by_id.insert(id, package).is_some() {
            return Err("依存のIDが重複しています。".into());
        }
    }
    let mut node_by_id = BTreeMap::new();
    for node in nodes {
        let id = node["id"]
            .as_str()
            .ok_or("解決済み依存のIDがありません。")?;
        if node_by_id.insert(id, node).is_some() {
            return Err("解決済み依存のIDが重複しています。".into());
        }
    }
    let root_node = node_by_id
        .get(root)
        .ok_or("本体の依存ノードがありません。")?;
    let edges = |node: &Value| -> Result<Vec<String>, String> {
        let mut result = Vec::new();
        for edge in node["deps"].as_array().ok_or("依存辺がありません。")? {
            let package = edge["pkg"].as_str().ok_or("依存辺の参照先がありません。")?;
            let kinds = edge["dep_kinds"]
                .as_array()
                .filter(|kinds| !kinds.is_empty())
                .ok_or("依存辺の種類がありません。")?;
            let mut included = false;
            for kind in kinds {
                match kind.get("kind") {
                    Some(Value::Null) => included = true,
                    Some(Value::String(kind)) if kind == "build" => included = true,
                    Some(Value::String(kind)) if kind == "dev" => {},
                    _ => return Err("未対応の依存辺の種類です。".into()),
                }
            }
            if included {
                result.push(package.to_owned());
            }
        }
        Ok(result)
    };
    let mut pending = Vec::new();
    let mut found = BTreeSet::new();
    for id in edges(root_node)? {
        let package = package_by_id
            .get(id.as_str())
            .ok_or("直接依存の情報がありません。")?;
        if let Some(name) = package["name"].as_str().filter(|name| roots.contains(name)) {
            found.insert(name);
            pending.push(id);
        }
    }
    if found.len() != roots.len() {
        return Err("必要な描画・取り込み依存を確認できません。".into());
    }
    let package_key = |package: &Value| -> Result<String, String> {
        let name = package["name"].as_str().ok_or("依存名がありません。")?;
        let version = package["version"].as_str().ok_or("依存版がありません。")?;
        let source = package["source"]
            .as_str()
            .ok_or("ローカル差替え依存は未認定です。")?;
        Ok(format!("{name}@{version}@{source}"))
    };
    let mut visited = BTreeSet::new();
    let mut records = BTreeMap::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        let package = package_by_id
            .get(id.as_str())
            .ok_or("依存の詳細がありません。")?;
        let node = node_by_id
            .get(id.as_str())
            .ok_or("依存の解決結果がありません。")?;
        let children = edges(node)?;
        let mut dependencies = Vec::new();
        for child in &children {
            dependencies.push(package_key(
                package_by_id
                    .get(child.as_str())
                    .ok_or("子依存がありません。")?,
            )?);
        }
        dependencies.sort();
        dependencies.dedup();
        let mut features: Vec<_> = node["features"]
            .as_array()
            .ok_or("依存の機能情報がありません。")?
            .iter()
            .map(|feature| feature.as_str().ok_or("依存の機能名が不正です。"))
            .collect::<Result<_, _>>()?;
        features.sort();
        features.dedup();
        records.insert(
            package_key(package)?,
            json!({
                "dependencies":dependencies,"features":features,"name":package["name"],
                "source":package["source"],"version":package["version"]
            }),
        );
        pending.extend(children);
    }
    let bytes = serde_json::to_vec(&records.into_values().collect::<Vec<_>>())
        .map_err(|_| "依存の検証情報を直列化できません。")?;
    let mut hash = Sha256::new();
    hash.update(b"geocode-render-execution-dependencies-v1\0");
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}

/// 未認定構成は世代を増やさず、公開PNGの新規生成を停止する。
pub fn assess(
    manifest: &Value,
    config: &ExecutionConfig,
    dependency_hash: &str,
) -> Result<(), String> {
    if manifest["format"].as_u64() != Some(1) {
        return Err("実行構成の認定記録が未対応です。".into());
    }
    if manifest["dependency_fingerprint"].as_str() != Some(dependency_hash) {
        return Err("描画・取り込み依存の構成が未認定です。".into());
    }
    let strings = |key: &str| -> Vec<&str> {
        manifest[key].as_array().map_or_else(Vec::new, |array| {
            array.iter().filter_map(Value::as_str).collect()
        })
    };
    if !strings("compilers").contains(&config.compiler.as_str()) {
        return Err("コンパイラの構成が未認定です。".into());
    }
    if !strings("targets").contains(&config.target.as_str()) {
        return Err("描画対象の実行環境が未認定です。".into());
    }
    if !strings("opt_levels").contains(&config.opt_level.as_str()) {
        return Err("描画の最適化設定が未認定です。".into());
    }
    if config.compiler_wrapper {
        return Err("コンパイラのラッパーが未認定です。".into());
    }
    let matches = |key: &str, actual: &[String]| -> bool {
        manifest[key].as_array().is_some_and(|alternatives| {
            alternatives.iter().any(|candidate| {
                candidate.as_array().is_some_and(|array| {
                    array.len() == actual.len()
                        && array
                            .iter()
                            .zip(actual)
                            .all(|(expected, actual)| expected.as_str() == Some(actual.as_str()))
                })
            })
        })
    };
    if !matches("target_feature_sets", &config.target_features) {
        return Err("CPU機能の構成が未認定です。".into());
    }
    if !matches("rustflag_sets", &config.rustflags) {
        return Err("描画ビルドの追加フラグが未認定です。".into());
    }
    if !matches("application_feature_sets", &config.application_features) {
        return Err("アプリケーションの機能構成が未認定です。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> Value {
        let mut packages =
            vec![json!({"id":"root","name":"application","version":"1","source":null})];
        let mut nodes = vec![json!({"id":"root","features":[],"deps":[]})];
        for name in DEPENDENCY_ROOTS {
            packages.push(json!({"id":name,"name":name,"version":"1","source":"registry+test"}));
            nodes.push(json!({"id":name,"features":["std"],"deps":[]}));
            nodes[0]["deps"]
                .as_array_mut()
                .unwrap()
                .push(json!({"pkg":name,"dep_kinds":[{"kind":null,"target":null}]}));
        }
        json!({"packages":packages,"resolve":{"root":"root","nodes":nodes}})
    }

    #[test]
    fn 関係ない版や保存先や列挙順の変更は依存の認定を変えない() {
        let baseline = metadata();
        let expected = dependency_fingerprint(&baseline).unwrap();
        let mut changed = baseline.clone();
        changed["packages"][0]["version"] = json!("2");
        changed["packages"][0]["manifest_path"] = json!("別の保存先/Cargo.toml");
        changed["packages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"unrelated","name":"unrelated","version":"99","source":null}));
        changed["resolve"]["nodes"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert_eq!(expected, dependency_fingerprint(&changed).unwrap());
        changed["packages"][1]["version"] = json!("2");
        assert_ne!(expected, dependency_fingerprint(&changed).unwrap());
    }

    #[test]
    fn 欠けた依存情報や機能情報を無視して認定しない() {
        for mutation in 0..7 {
            let mut changed = metadata();
            match mutation {
                0 => changed["resolve"]["nodes"][0]["deps"][0]["dep_kinds"] = Value::Null,
                1 => changed["resolve"]["nodes"][0]["deps"][0]["pkg"] = Value::Null,
                2 => changed["resolve"]["nodes"][1]["features"] = json!([1]),
                3 => changed["resolve"]["nodes"][0]["deps"][0]["dep_kinds"] = json!([{}]),
                4 => changed["packages"][1]["source"] = Value::Null,
                5 => changed["packages"][1]["id"] = json!("root"),
                _ => {
                    changed["resolve"]["nodes"][0]["deps"]
                        .as_array_mut()
                        .unwrap()
                        .pop();
                },
            }
            assert!(
                dependency_fingerprint(&changed).is_err(),
                "不正情報{mutation}"
            );
        }
    }

    #[test]
    fn 標準地図専用のxml依存変更は道路の指紋と認定を変えない() {
        let mut baseline = metadata();
        for name in STANDARD_DEPENDENCY_ROOTS
            .iter()
            .filter(|name| !DEPENDENCY_ROOTS.contains(name))
        {
            baseline["packages"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":name,"name":name,"version":"1","source":"registry+test"}));
            baseline["resolve"]["nodes"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":name,"features":[],"deps":[]}));
            baseline["resolve"]["nodes"][0]["deps"]
                .as_array_mut()
                .unwrap()
                .push(json!({"pkg":name,"dep_kinds":[{"kind":null}]}));
        }
        let road = dependency_fingerprint(&baseline).unwrap();
        let standard = standard_dependency_fingerprint(&baseline).unwrap();
        let manifest = |fingerprint: &str| json!({"format":1,"dependency_fingerprint":fingerprint,"compilers":["compiler"],"targets":["target"],"opt_levels":["0"],"target_feature_sets":[[]],"rustflag_sets":[[]],"application_feature_sets":[[]]});
        let road_manifest = manifest(&road);
        let standard_manifest = manifest(&standard);
        let config = ExecutionConfig {
            compiler: "compiler".into(),
            target: "target".into(),
            opt_level: "0".into(),
            target_features: vec![],
            rustflags: vec![],
            application_features: vec![],
            compiler_wrapper: false,
        };
        assert!(assess(&road_manifest, &config, &road).is_ok());
        assert!(assess(&standard_manifest, &config, &standard).is_ok());
        let xml = baseline["packages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|package| package["name"] == "quick-xml")
            .unwrap();
        xml["version"] = json!("2");
        let changed_road = dependency_fingerprint(&baseline).unwrap();
        let changed_standard = standard_dependency_fingerprint(&baseline).unwrap();
        assert_eq!(road, changed_road);
        assert_ne!(standard, changed_standard);
        assert!(assess(&road_manifest, &config, &changed_road).is_ok());
        assert!(assess(&standard_manifest, &config, &changed_standard).is_err());
        baseline["packages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|package| package["name"] == "quick-xml")
            .unwrap()["source"] = Value::Null;
        assert!(dependency_fingerprint(&baseline).is_ok());
        assert!(standard_dependency_fingerprint(&baseline).is_err());
    }

    #[test]
    fn 文字エンジンと分割規則の依存変更は名称付き系列だけの認定を変える() {
        let mut baseline = metadata();
        for name in OSM_DEPENDENCY_ROOTS
            .iter()
            .filter(|name| !DEPENDENCY_ROOTS.contains(name))
        {
            baseline["packages"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":name,"name":name,"version":"1","source":"registry+test"}));
            baseline["resolve"]["nodes"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":name,"features":[],"deps":[]}));
            baseline["resolve"]["nodes"][0]["deps"]
                .as_array_mut()
                .unwrap()
                .push(json!({"pkg":name,"dep_kinds":[{"kind":null}]}));
        }
        let road = dependency_fingerprint(&baseline).unwrap();
        let standard = standard_dependency_fingerprint(&baseline).unwrap();
        let osm = osm_dependency_fingerprint(&baseline).unwrap();
        for name in ["harfrust", "skrifa", "unicode-segmentation"] {
            let mut changed = baseline.clone();
            changed["packages"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|package| package["name"] == name)
                .unwrap()["version"] = json!("2");
            assert_eq!(road, dependency_fingerprint(&changed).unwrap());
            assert_eq!(standard, standard_dependency_fingerprint(&changed).unwrap());
            assert_ne!(osm, osm_dependency_fingerprint(&changed).unwrap(), "{name}");
            changed["packages"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|package| package["name"] == name)
                .unwrap()["source"] = Value::Null;
            assert!(dependency_fingerprint(&changed).is_ok());
            assert!(standard_dependency_fingerprint(&changed).is_ok());
            assert!(osm_dependency_fingerprint(&changed).is_err(), "{name}");
        }
    }

    #[test]
    fn 未認定構成を拒否し診断用情報を契約の識別へ混ぜない() {
        let manifest = json!({"format":1,"dependency_fingerprint":"deps","compilers":["compiler"],
            "targets":["target"],"opt_levels":["0","3"],"target_feature_sets":[["sse2"]],
            "rustflag_sets":[[]],"application_feature_sets":[[]]});
        let config = ExecutionConfig {
            compiler: "compiler".into(),
            target: "target".into(),
            opt_level: "0".into(),
            target_features: vec!["sse2".into()],
            rustflags: vec![],
            application_features: vec![],
            compiler_wrapper: false,
        };
        assert!(assess(&manifest, &config, "deps").is_ok());
        let mut changed = config.clone();
        changed.opt_level = "3".into();
        assert!(assess(&manifest, &changed, "deps").is_ok());
        for change in 0..6 {
            let mut changed = config.clone();
            match change {
                0 => changed.compiler.push('2'),
                1 => changed.target.push('2'),
                2 => changed.target_features.push("fma".into()),
                3 => changed.rustflags.push("-Ctarget-cpu=native".into()),
                4 => changed.application_features.push("experimental".into()),
                _ => changed.compiler_wrapper = true,
            }
            assert!(assess(&manifest, &changed, "deps").is_err(), "構成{change}");
        }
        assert!(assess(&manifest, &config, "changed-deps").is_err());
    }
}
