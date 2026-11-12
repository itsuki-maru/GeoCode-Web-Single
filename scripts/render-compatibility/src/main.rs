//! 描画コードの確認漏れを検出する。ここで作る指紋は描画世代へ使用しない。

use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

use proc_macro2::{Delimiter, Group, TokenStream, TokenTree};
use quote::ToTokens;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[path = "../../../build_support/render_execution.rs"]
#[allow(dead_code)]
mod execution;

const FORMAT: u32 = 1;
const NORMALIZATION: &str = "syn-rust-tokens-without-doc-v1";
const RECORD: &str = "tests/fixtures/render-compatibility-review.json";
const GOLDEN: &str = "tests/fixtures/render-golden/manifest.json";
const FONT_ASSETS: &[&str] = &[
    "res/fonts/NotoSansCJKjp-Regular.otf",
    "res/fonts/manifest.json",
    "res/fonts/OFL.txt",
];

fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

/// 構文解析済みのトークンから説明属性を除く。文字列内のコメント記号は保持する。
fn without_docs(stream: TokenStream) -> TokenStream {
    let input: Vec<_> = stream.into_iter().collect();
    let mut output = TokenStream::new();
    let mut index = 0;
    while index < input.len() {
        if matches!(&input[index], TokenTree::Punct(value) if value.as_char() == '#') {
            let attribute = index
                + 1
                + usize::from(
                    matches!(input.get(index + 1), Some(TokenTree::Punct(value)) if value.as_char() == '!'),
                );
            if let Some(TokenTree::Group(group)) = input.get(attribute) {
                if group.delimiter() == Delimiter::Bracket
                    && matches!(group.stream().into_iter().next(), Some(TokenTree::Ident(value)) if value == "doc")
                {
                    index = attribute + 1;
                    continue;
                }
            }
        }
        let token = match &input[index] {
            TokenTree::Group(group) => {
                TokenTree::Group(Group::new(group.delimiter(), without_docs(group.stream())))
            },
            other => other.clone(),
        };
        output.extend([token]);
        index += 1;
    }
    output
}

fn source_fingerprint(source: &str) -> Result<String, String> {
    let parsed =
        syn::parse_file(source).map_err(|error| format!("Rustの構文を解析できません: {error}"))?;
    Ok(digest(without_docs(parsed.into_token_stream()).to_string()))
}

fn font_fingerprints(root: &Path) -> Result<BTreeMap<String, String>, String> {
    FONT_ASSETS
        .iter()
        .map(|asset| {
            let bytes = fs::read(root.join(asset)).map_err(|error| {
                format!("固定フォントの必須ファイルを読み取れません: {asset}: {error}")
            })?;
            Ok(((*asset).to_owned(), digest(bytes)))
        })
        .collect()
}

fn collect_sources(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    let mut pending = vec![root.join("src/tilegen")];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let kind = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if kind.file_type().is_symlink() {
                return Err(format!(
                    "リンクされた描画ソースは検査できません: {}",
                    path.display()
                ));
            }
            if kind.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|value| value == "rs") {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                result.insert(relative, source_fingerprint(&source)?);
            }
        }
    }
    // 固定画像の入力を変更した場合も、基準の差し替えを見逃さない。
    for relative in [
        "tests/render_golden_support/mod.rs",
        "tests/render_golden.rs",
        "tests/standard_tile_render.rs",
        "tests/carto_tile_render.rs",
        "build_support/render_execution.rs",
        "build.rs",
        "src/local_tiles/profile.rs",
    ] {
        result.insert(
            relative.into(),
            source_fingerprint(
                &fs::read_to_string(root.join(relative)).map_err(|error| error.to_string())?,
            )?,
        );
    }
    let execution_record = "res/tile-render-execution.json";
    let value: Value = serde_json::from_slice(
        &fs::read(root.join(execution_record)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    result.insert(
        execution_record.into(),
        digest(serde_json::to_vec(&value).map_err(|error| error.to_string())?),
    );
    result.extend(font_fingerprints(root)?);
    Ok(result)
}

fn golden_fingerprint(root: &Path) -> Result<String, String> {
    let bytes = fs::read(root.join(GOLDEN)).map_err(|error| error.to_string())?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if manifest["source_ref"].as_str() != Some("9c30ae1") {
        return Err("固定画像の移行前基準が一致しません。".into());
    }
    let entries = manifest["cases"]
        .as_array()
        .ok_or("固定画像の一覧がありません。")?;
    if entries.len() < 30 {
        return Err("固定画像の検証範囲が不足しています。".into());
    }
    let mut hash = Sha256::new();
    let carto_root = root.join("tests/fixtures/carto-render-golden");
    let carto_bytes = fs::read(carto_root.join("manifest.json")).map_err(|e| e.to_string())?;
    let carto: Value = serde_json::from_slice(&carto_bytes).map_err(|e| e.to_string())?;
    let carto_entries = carto["cases"]
        .as_array()
        .filter(|cases| cases.len() >= 2)
        .ok_or("名称付き地図の固定画像が不足しています。")?;
    if carto["style_version"].as_str() != Some("osm-like-v1") {
        return Err("名称付き地図の固定画像契約が不正です。".into());
    }
    hash.update(&carto_bytes);
    for item in carto_entries {
        let name = item["name"]
            .as_str()
            .filter(|name| {
                !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
            .ok_or("名称付き地図の固定画像名が不正です。")?;
        hash.update(name.as_bytes());
        hash.update(fs::read(carto_root.join(format!("{name}.png"))).map_err(|e| e.to_string())?);
    }
    let standard_root = root.join("tests/fixtures/standard-render-golden");
    let standard_bytes =
        fs::read(standard_root.join("manifest.json")).map_err(|e| e.to_string())?;
    let standard: Value = serde_json::from_slice(&standard_bytes).map_err(|e| e.to_string())?;
    let standard_entries = standard["cases"]
        .as_array()
        .filter(|c| c.len() >= 5)
        .ok_or("標準地図の固定画像が不足しています。")?;
    if standard["style_version"].as_str() != Some("standard-terrain-v1") {
        return Err("標準地図の固定画像契約が不正です。".into());
    }
    hash.update(&standard_bytes);
    for item in standard_entries {
        let name = item["name"]
            .as_str()
            .filter(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
            .ok_or("標準地図の固定画像名が不正です。")?;
        hash.update(name.as_bytes());
        hash.update(
            fs::read(standard_root.join(format!("{name}.png"))).map_err(|e| e.to_string())?,
        );
    }
    hash.update(&bytes);
    for entry in entries {
        let name = entry["name"].as_str().ok_or("固定画像の名前が不正です。")?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'-')
        {
            return Err("固定画像の名前に未対応の文字があります。".into());
        }
        hash.update(name.as_bytes());
        hash.update(
            fs::read(
                root.join("tests/fixtures/render-golden")
                    .join(format!("{name}.png")),
            )
            .map_err(|error| error.to_string())?,
        );
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn metadata(root: &Path, offline: bool) -> Result<Value, String> {
    let mut command = Command::new("cargo");
    command.current_dir(root).args([
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        "x86_64-pc-windows-msvc",
    ]);
    if offline {
        command.arg("--offline");
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "依存グラフを取得できません: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn compare_files(expected: &Value, actual: &BTreeMap<String, String>) -> Vec<String> {
    let expected: BTreeMap<String, String> =
        serde_json::from_value(expected.clone()).unwrap_or_default();
    let mut paths: Vec<_> = expected.keys().chain(actual.keys()).cloned().collect();
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter(|path| expected.get(path) != actual.get(path))
        .collect()
}

fn run() -> Result<(), String> {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut record = false;
    let mut reason = None;
    let mut offline = false;
    let mut fingerprints_only = false;
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--root" => {
                root = args
                    .next()
                    .map(PathBuf::from)
                    .ok_or("--rootの値がありません。")?
            },
            "--record" => record = true,
            "--reason" => reason = args.next(),
            "--offline" => offline = true,
            "--execution-fingerprints" => fingerprints_only = true,
            _ => return Err(format!("未対応の引数: {argument}")),
        }
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let sources = collect_sources(&root)?;
    let resolved = metadata(&root, offline)?;
    let dependencies = execution::dependency_fingerprint(&resolved)?;
    let standard_dependencies = execution::standard_dependency_fingerprint(&resolved)?;
    let osm_dependencies = execution::osm_dependency_fingerprint(&resolved)?;
    if fingerprints_only {
        println!(
            "{}",
            json!({"roads": dependencies, "standard": standard_dependencies, "osm": osm_dependencies})
        );
        return Ok(());
    }
    let golden = golden_fingerprint(&root)?;
    if record {
        let reason = reason
            .filter(|value| value.trim().chars().count() >= 20)
            .ok_or("記録の更新には20文字以上の互換性判断理由を--reasonで指定してください。")?;
        let value = json!({"format":FORMAT,"normalization":NORMALIZATION,"source_scope":"src/tilegen/**/*.rs + render-profile-policy + execution-certification + fixed-golden-inputs + font-assets",
            "files":sources,"dependency_roots":execution::DEPENDENCY_ROOTS,"dependency_fingerprint":dependencies,
            "standard_dependency_roots":execution::STANDARD_DEPENDENCY_ROOTS,"standard_dependency_fingerprint":standard_dependencies,
            "osm_dependency_roots":execution::OSM_DEPENDENCY_ROOTS,"osm_dependency_fingerprint":osm_dependencies,
            "golden_fingerprint":golden,"review":{"reason":reason,"baseline_ref":"9c30ae1","required_validation":"render_golden、standard_tile_render、carto_tile_render、取り込み・SDK・世代管理の回帰試験"}});
        fs::write(
            root.join(RECORD),
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())? + "\n",
        )
        .map_err(|error| error.to_string())?;
        println!("描画互換性の判断を記録しました。固定画像と回帰試験の結果も確認してください。");
        return Ok(());
    }
    let value: Value =
        serde_json::from_slice(&fs::read(root.join(RECORD)).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if value["format"].as_u64() != Some(FORMAT.into())
        || value["normalization"].as_str() != Some(NORMALIZATION)
        || value["review"]["reason"]
            .as_str()
            .is_none_or(|reason| reason.trim().chars().count() < 20)
    {
        return Err("描画互換性の確認記録が不正です。".into());
    }
    let mut differences = compare_files(&value["files"], &sources);
    if value["dependency_fingerprint"].as_str() != Some(&dependencies) {
        differences.push("描画・取り込みの依存グラフ".into());
    }
    if value["dependency_roots"] != json!(execution::DEPENDENCY_ROOTS) {
        differences.push("確認対象の依存一覧".into());
    }
    if value["standard_dependency_fingerprint"].as_str() != Some(&standard_dependencies) {
        differences.push("標準地図の描画・取り込み依存グラフ".into());
    }
    if value["standard_dependency_roots"] != json!(execution::STANDARD_DEPENDENCY_ROOTS) {
        differences.push("標準地図で確認する依存一覧".into());
    }
    if value["osm_dependency_fingerprint"].as_str() != Some(&osm_dependencies)
        || value["osm_dependency_roots"] != json!(execution::OSM_DEPENDENCY_ROOTS)
    {
        differences.push("名称付き地図の描画依存グラフ".into());
    }
    if value["golden_fingerprint"].as_str() != Some(&golden) {
        differences.push("固定した基準画像・来歴".into());
    }
    if !differences.is_empty() {
        return Err(format!(
            "描画関連の変更に互換性判断が必要です:\n{}\n結果が変わる場合は契約版を更新し、同じ場合は理由と固定画像の比較結果を記録してください。",
            differences.join("\n")
        ));
    }
    println!(
        "描画互換性の確認記録: OK（{}ソース、道路・標準・名称付き地図の固定画像、フォント、系列別の推移的依存を照合）",
        sources.len()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn コメントと説明属性と整形だけなら同じ指紋になる() {
        let plain = "pub fn value() -> &'static str { r#\"// literal /* value */\"# }";
        let documented = "//! モジュールの説明\n/// 関数の説明\n#[doc = \"別の説明\"] pub fn value ( ) -> &'static str { /* 外 /* 内 */ 終 */ r#\"// literal /* value */\"# // 行末\n}";
        assert_eq!(
            source_fingerprint(plain).unwrap(),
            source_fingerprint(documented).unwrap()
        );
    }

    #[test]
    fn 処理と文字列の変更は説明コメントとして除外しない() {
        assert_ne!(
            source_fingerprint("fn value(){let x=1;}").unwrap(),
            source_fingerprint("fn value(){let x=2;}").unwrap()
        );
        assert_ne!(
            source_fingerprint("fn value(){let x=\"// one\";}").unwrap(),
            source_fingerprint("fn value(){let x=\"// two\";}").unwrap()
        );
        assert!(source_fingerprint("fn value( { ").is_err());
    }

    #[test]
    fn ファイルの追加と削除と内容差を検出する() {
        let expected = json!({"kept":"one","removed":"two"});
        let actual = BTreeMap::from([
            ("kept".into(), "changed".into()),
            ("added".into(), "three".into()),
        ]);
        assert_eq!(
            compare_files(&expected, &actual),
            vec!["added", "kept", "removed"]
        );
    }

    #[test]
    fn 固定フォントと出典とライセンスの変更と欠落を検出する() {
        let temporary = env::temp_dir().join(format!(
            "geocode-render-font-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(temporary.join("res/fonts")).unwrap();
        for asset in FONT_ASSETS {
            fs::write(temporary.join(asset), asset.as_bytes()).unwrap();
        }
        let baseline = font_fingerprints(&temporary).unwrap();
        for asset in FONT_ASSETS {
            fs::write(temporary.join(asset), "変更後の内容".as_bytes()).unwrap();
            assert_ne!(
                baseline[*asset],
                font_fingerprints(&temporary).unwrap()[*asset]
            );
            fs::remove_file(temporary.join(asset)).unwrap();
            assert!(font_fingerprints(&temporary).unwrap_err().contains(asset));
            fs::write(temporary.join(asset), asset.as_bytes()).unwrap();
        }
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn 関連する推移依存だけを追跡し無関係な更新と配置差を除く() {
        let mut packages =
            vec![json!({"id":"root","name":"geocode_web_single","version":"1.0.0","source":null})];
        let mut nodes = Vec::new();
        let mut root_dependencies = Vec::new();
        for name in execution::DEPENDENCY_ROOTS {
            packages
                .push(json!({"id":name,"name":name,"version":"1.0.0","source":"registry+test"}));
            nodes.push(json!({"id":name,"features":[],"deps":if *name == "tiny-skia" {json!([{"pkg":"child","dep_kinds":[{"kind":null}]}])} else {json!([])}}));
            root_dependencies.push(json!({"pkg":name,"dep_kinds":[{"kind":null}]}));
        }
        for name in ["child", "unrelated"] {
            packages
                .push(json!({"id":name,"name":name,"version":"1.0.0","source":"registry+test"}));
            nodes.push(json!({"id":name,"features":[],"deps":[]}));
        }
        root_dependencies.push(json!({"pkg":"unrelated","dep_kinds":[{"kind":null}]}));
        nodes.push(json!({"id":"root","features":[],"deps":root_dependencies}));
        let metadata = json!({"packages":packages,"resolve":{"root":"root","nodes":nodes}});
        let expected = execution::dependency_fingerprint(&metadata).unwrap();
        let mut changed = metadata.clone();
        let unrelated = changed["packages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|package| package["id"] == "unrelated")
            .unwrap();
        unrelated["version"] = json!("2.0.0");
        assert_eq!(
            expected,
            execution::dependency_fingerprint(&changed).unwrap()
        );
        let child = changed["packages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|package| package["id"] == "child")
            .unwrap();
        child["version"] = json!("2.0.0");
        assert_ne!(
            expected,
            execution::dependency_fingerprint(&changed).unwrap()
        );
        let child = changed["packages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|package| package["id"] == "child")
            .unwrap();
        child["source"] = Value::Null;
        assert!(execution::dependency_fingerprint(&changed).is_err());
    }
}
