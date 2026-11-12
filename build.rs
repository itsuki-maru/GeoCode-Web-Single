use sha2::{Digest, Sha256};
use std::{env, fs, path::Path, process::Command};

#[path = "build_support/render_execution.rs"]
mod render_execution;

fn collect_sources(path: &Path, files: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(path).expect("read application source directory") {
        let path = entry.expect("read source entry").path();
        if path.is_dir() {
            collect_sources(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

fn tile_build_id() {
    // 全体のハッシュは診断用のビルド来歴であり、描画世代や完成DBの識別には使わない。
    let mut files = vec![
        "Cargo.toml".into(),
        "Cargo.lock".into(),
        "build.rs".into(),
        "build_support/render_execution.rs".into(),
        "res/tile-render-execution.json".into(),
    ];
    collect_sources(Path::new("src"), &mut files);
    files.sort();
    let mut hash = Sha256::new();
    hash.update(b"geocode-web-single-tile-build-v1\0");
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        hash.update(path.to_string_lossy().replace('\\', "/").as_bytes());
        hash.update([0]);
        hash.update(fs::read(&path).expect("read tile build input"));
        hash.update([0]);
    }
    for key in ["TARGET", "OPT_LEVEL", "DEBUG", "CARGO_ENCODED_RUSTFLAGS"] {
        hash.update(key);
        hash.update([0]);
        hash.update(env::var(key).unwrap_or_default());
        hash.update([0]);
    }
    let mut features: Vec<_> = env::vars()
        .filter(|(key, _)| key.starts_with("CARGO_FEATURE_"))
        .collect();
    features.sort();
    for (key, value) in features {
        hash.update(key);
        hash.update([0]);
        hash.update(value);
        hash.update([0]);
    }
    let compiler = env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let version = Command::new(compiler)
        .arg("--version")
        .output()
        .expect("read rustc build identity");
    assert!(version.status.success(), "rustc --version failed");
    hash.update(version.stdout);
    println!("cargo:rustc-env=TILEGEN_BUILD_ID={:x}", hash.finalize());
}

fn certify_render_execution(manifest_root: &Path) {
    println!("cargo:rerun-if-changed=res/fonts/NotoSansCJKjp-Regular.otf");
    println!("cargo:rerun-if-changed=res/tile-render-execution.json");
    println!("cargo:rerun-if-changed=build_support/render_execution.rs");
    for key in [
        "RUSTC",
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let compiler = Command::new(env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default();
    let target = env::var("TARGET").unwrap_or_default();
    let mut target_features: Vec<_> = env::var("CARGO_CFG_TARGET_FEATURE")
        .unwrap_or_default()
        .split(',')
        .filter(|feature| !feature.is_empty())
        .map(str::to_owned)
        .collect();
    target_features.sort();
    target_features.dedup();
    let mut application_features: Vec<_> = env::vars()
        .filter_map(|(key, _)| key.strip_prefix("CARGO_FEATURE_").map(str::to_owned))
        .collect();
    application_features.sort();
    let config = render_execution::ExecutionConfig {
        compiler: compiler.clone(),
        target: target.clone(),
        opt_level: env::var("OPT_LEVEL").unwrap_or_default(),
        target_features,
        rustflags: env::var("CARGO_ENCODED_RUSTFLAGS")
            .unwrap_or_default()
            .split('\u{1f}')
            .filter(|flag| !flag.is_empty())
            .map(str::to_owned)
            .collect(),
        application_features,
        compiler_wrapper: ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]
            .iter()
            .any(|key| env::var_os(key).is_some_and(|value| !value.is_empty())),
    };
    let manifest = fs::read(manifest_root.join("res/tile-render-execution.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    // metadataはコンパイルを開始せず、解決済みの機能と対象環境の依存辺を取得する。
    let metadata = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .current_dir(manifest_root)
        .args([
            "metadata",
            "--locked",
            "--offline",
            "--format-version",
            "1",
            "--filter-platform",
            &target,
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok());
    let dependency_hash = metadata
        .as_ref()
        .ok_or_else(|| "解決済み依存を取得できないため、実行構成を確認できません。".to_owned())
        .and_then(render_execution::dependency_fingerprint);
    let assessed = dependency_hash
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|hash| {
            manifest
                .as_ref()
                .ok_or_else(|| "実行構成の認定記録を読み取れません。".to_owned())
                .and_then(|manifest| render_execution::assess(manifest, &config, hash))
        });
    let standard_dependency_hash = metadata
        .as_ref()
        .ok_or_else(|| "標準地図の解決済み依存を取得できません。".to_owned())
        .and_then(render_execution::standard_dependency_fingerprint);
    let standard_assessed = standard_dependency_hash
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|hash| {
            manifest
                .as_ref()
                .and_then(|manifest| manifest.get("standard"))
                .ok_or_else(|| "標準地図の実行認定記録がありません。".to_owned())
                .and_then(|manifest| render_execution::assess(manifest, &config, hash))
        });
    let series = manifest
        .as_ref()
        .and_then(|manifest| manifest["series"].as_str())
        .unwrap_or("");
    let osm_dependency_hash = metadata
        .as_ref()
        .ok_or_else(|| "名称付き地図の解決済み依存を取得できません。".to_owned())
        .and_then(render_execution::osm_dependency_fingerprint);
    let osm_assessed = osm_dependency_hash
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|hash| {
            manifest
                .as_ref()
                .and_then(|m| m.get("osm"))
                .ok_or_else(|| "名称付き地図の認定記録がありません。".to_owned())
                .and_then(|m| {
                    let bytes = fs::read(manifest_root.join("res/fonts/NotoSansCJKjp-Regular.otf"))
                        .map_err(|_| "固定フォントを確認できません。".to_owned())?;
                    let actual = format!("{:x}", Sha256::digest(bytes));
                    if m["font_sha256"].as_str() != Some(&actual) {
                        return Err("固定フォントの内容が認定と一致しません。".into());
                    }
                    render_execution::assess(m, &config, hash)
                })
        });
    let reason = assessed.as_ref().err().map(String::as_str);
    let mut source = format!(
        "pub const VERIFIED:bool={};\npub const REASON:Option<&str>={:?};\npub const SERIES:&str={:?};\npub const COMPILER:&str={:?};\npub const TARGET:&str={:?};\npub const DEPENDENCIES:&str={:?};\npub const STANDARD_SERIES:&str={:?};\npub const STANDARD_VERIFIED:bool={};\npub const STANDARD_REASON:Option<&str>={:?};\npub const STANDARD_DEPENDENCIES:&str={:?};\n",
        assessed.is_ok(),
        reason,
        series,
        compiler,
        target,
        dependency_hash.as_ref().map(String::as_str).unwrap_or(""),
        manifest
            .as_ref()
            .and_then(|m| m["standard"]["series"].as_str())
            .unwrap_or(""),
        standard_assessed.is_ok(),
        standard_assessed.as_ref().err().map(String::as_str),
        standard_dependency_hash
            .as_ref()
            .map(String::as_str)
            .unwrap_or("")
    );
    source.push_str(&format!(
        "pub const OSM_SERIES:&str={:?};\npub const OSM_VERIFIED:bool={};\npub const OSM_REASON:Option<&str>={:?};\npub const OSM_DEPENDENCIES:&str={:?};\n",
        manifest.as_ref().and_then(|m| m["osm"]["series"].as_str()).unwrap_or(""),
        osm_assessed.is_ok(), osm_assessed.as_ref().err().map(String::as_str),
        osm_dependency_hash.as_ref().map(String::as_str).unwrap_or("")));
    fs::write(
        std::path::PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("render_execution.rs"),
        source,
    )
    .expect("write render execution assessment");
    if let Some(reason) = reason {
        println!("cargo:warning=道路地図の新規生成は未認定構成のため停止します: {reason}");
    }
    if let Err(reason) = standard_assessed {
        println!("cargo:warning=標準地図の新規生成は未認定構成のため停止します: {reason}");
    }
}

fn main() {
    // 検証資材と実行中アプリのdistを分離できるよう、埋込先だけをビルド時に選ぶ。
    println!("cargo:rerun-if-env-changed=GEOCODE_FRONTEND_DIST");
    let manifest = std::path::PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let assets = env::var_os("GEOCODE_FRONTEND_DIST")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| manifest.join("dist"));
    let assets = if assets.is_absolute() {
        assets
    } else {
        manifest.join(assets)
    };
    let assets = assets
        .canonicalize()
        .expect("frontend assets must be built before Rust");
    println!("cargo:rerun-if-changed={}", assets.display());
    let source = [
        ("Asset", assets.clone()),
        ("Templates", assets.join("templates")),
        ("StaticAsset", assets.join("assets")),
    ]
    .into_iter()
    .map(|(name, path)| {
        format!(
            "#[derive(rust_embed::RustEmbed)]\n#[folder = {:?}]\npub(crate) struct {name};\n",
            path.to_string_lossy()
        )
    })
    .collect::<String>();
    fs::write(
        std::path::PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("embedded_assets.rs"),
        source,
    )
    .expect("write embedded asset definitions");
    tile_build_id();
    certify_render_execution(&manifest);
    tauri_build::build();
}
