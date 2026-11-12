//! CLIの契約を一時設定・一時DBだけで検証する。
#[path = "tilegen_support/mod.rs"]
mod support;

#[path = "standard_tile_fixture/mod.rs"]
mod standard_fixture;

use geocode_web_single::{
    db::run_migrations,
    local_tiles::{
        LocalTiles,
        catalog::{self, JobRecord},
        cli::{self, Command, Invocation},
        config::LocalTileConfig,
    },
    tilegen::cancel::CancellationToken,
};
use serde_json::{Value, json};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{path::Path, process::Command as Process, time::Duration};

fn invocation(args: &[&str]) -> Invocation {
    cli::parse(
        &args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

async fn pool(path: &Path) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    pool
}

async fn execute(args: &[&str], config: &LocalTileConfig, pool: &SqlitePool) -> cli::CommandOutput {
    cli::execute(&invocation(args), config.clone(), Some(pool.clone()))
        .await
        .unwrap()
}

#[tokio::test]
async fn 同じ完成dbの複数描画世代をcliで固定し背景名と再開を独立して保存する() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("app.sqlite");
    let pool = pool(&database).await;
    let mut config = LocalTileConfig::defaults(root.path());
    config.workers = 1;
    let input = root.path().join("map.pbf");
    let dem = root.path().join("dem.xml");
    standard_fixture::write_inputs(&input, &dem);
    let input_text = input.to_str().unwrap();
    let imported = execute(
        &[
            "import",
            "--input",
            input_text,
            "--name",
            "新地図",
            "--features",
            "standard-v2",
            "--contour-data",
            "off",
        ],
        &config,
        &pool,
    )
    .await;
    assert_eq!(imported.exit_code, 0, "{}", imported.value);
    let datasets = execute(&["datasets", "list"], &config, &pool).await;
    let dataset = datasets.value[0]["id"].as_str().unwrap();
    let original = execute(&["url", "--dataset", dataset], &config, &pool)
        .await
        .value;
    let original_render = original["render_id"].as_str().unwrap();
    let modified = execute(
        &[
            "datasets",
            "prepare",
            "--dataset",
            dataset,
            "--style",
            "osm-like-v1",
            "--roads",
            "off",
            "--buildings",
            "off",
            "--labels",
            "off",
        ],
        &config,
        &pool,
    )
    .await
    .value;
    let other_render = modified["render_id"].as_str().unwrap();
    assert_ne!(original_render, other_render);
    let duplicate = execute(
        &[
            "datasets",
            "prepare",
            "--dataset",
            dataset,
            "--labels",
            "off",
            "--buildings",
            "off",
            "--roads",
            "off",
            "--language",
            "en",
        ],
        &config,
        &pool,
    )
    .await
    .value;
    assert_eq!(duplicate["render_id"], other_render);
    for unsupported in ["--contours", "--hillshade"] {
        assert!(
            cli::execute(
                &invocation(&[
                    "datasets",
                    "prepare",
                    "--dataset",
                    dataset,
                    unsupported,
                    "on"
                ]),
                config.clone(),
                Some(pool.clone())
            )
            .await
            .is_err()
        );
    }
    let current = execute(&["url", "--dataset", dataset], &config, &pool)
        .await
        .value;
    assert_eq!(current["relative_url"], original["relative_url"]);
    let prepared = execute(&["datasets", "show", "--dataset", dataset], &config, &pool)
        .await
        .value;
    assert_eq!(prepared["profiles"].as_array().unwrap().len(), 2);
    assert_eq!(prepared["current_profile_prepared"], true);
    for (render, name) in [
        (original_render, "名称付き地図"),
        (other_render, "道路と建物なし"),
    ] {
        let background = execute(
            &[
                "background",
                "add",
                "--dataset",
                dataset,
                "--render",
                render,
                "--name",
                name,
            ],
            &config,
            &pool,
        )
        .await
        .value;
        let row: (String, String) =
            sqlx::query_as("SELECT label,url FROM tileserver_model WHERE id=?")
                .bind(background["id"].as_i64().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, name);
        assert!(row.1.contains(render));
    }
    let generated = execute(
        &[
            "precompute",
            "run",
            "--dataset",
            dataset,
            "--render",
            other_render,
            "--bbox",
            "139.6999,35.6999,139.7001,35.7001",
            "--min-zoom",
            "16",
            "--max-zoom",
            "16",
            "--max-tiles",
            "100",
        ],
        &config,
        &pool,
    )
    .await;
    assert_eq!(generated.exit_code, 0, "{}", generated.value);
    assert_eq!(generated.value["request"]["render_id"], other_render);
    let previous = generated.value["id"].as_str().unwrap();
    let resumed = execute(&["precompute", "resume", "--job", previous], &config, &pool).await;
    assert_eq!(resumed.exit_code, 0, "{}", resumed.value);
    assert_eq!(resumed.value["request"]["render_id"], other_render);
    assert!(resumed.value["progress"]["reused_tiles"].as_u64().unwrap() > 0);
    let app = LocalTiles::new(config.clone(), pool.clone());
    let tile = geocode_web_single::tilegen::tile::TileId::from_lon_lat(17, 139.7, 35.7).unwrap();
    let first = app
        .render(dataset, original_render, tile, false)
        .await
        .unwrap()
        .0;
    let second = app
        .render(dataset, other_render, tile, false)
        .await
        .unwrap()
        .0;
    let repeated = app
        .render(dataset, original_render, tile, false)
        .await
        .unwrap()
        .0;
    assert_eq!(first, repeated);
    assert_ne!(first, second);
    // 一つのワーカーで通常・省略・通常と切り替えても、直前の設定が残らないことを確認する。
    let next = geocode_web_single::tilegen::tile::TileId::from_lon_lat(18, 139.7, 35.7).unwrap();
    let after_switch = app
        .render(dataset, original_render, next, false)
        .await
        .unwrap()
        .0;
    let record = catalog::get_dataset(&app.catalog, dataset)
        .await
        .unwrap()
        .unwrap();
    let completed_db = geocode_web_single::tilegen::dataset::Dataset::open(
        record.resolve_path(&config.dataset_path).unwrap(),
    )
    .unwrap();
    let expected = completed_db
        .create_session(Default::default())
        .unwrap()
        .render_png_with_context(next, &Default::default())
        .unwrap();
    assert_eq!(after_switch.as_slice(), expected.png.as_slice());
    let profiles = catalog::list_profiles(&app.catalog, dataset).await.unwrap();
    for render in [original_render, other_render] {
        assert!(profiles.iter().any(|p| p.id == render));
        assert!(config.cache_path.join(dataset).join(render).is_dir());
    }
    assert!(!first.is_empty() && !second.is_empty());
    app.shutdown().await;
    pool.close().await;
}

fn settings(root: &Path, database: &Path) -> std::path::PathBuf {
    let config = LocalTileConfig::defaults(root);
    let path = root.join("geocode-web-single.env.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&json!({
        "app_title":"CLI Test", "access_token_exp_minutes":"30", "refresh_token_exp_minutes":"60",
        "secret_key":"never-print-this-secret", "admin_username":"admin", "admin_passwotd":"never-print-this-password",
        "failed_account_lock":"5", "next_challenge_minutes":"5", "challenge_limit_time_failed_count":"3",
        "sqlite_database_path":database, "database_url":format!("sqlite:{}",database.display()),
        "tile_catalog_database_path":config.catalog_database_path, "tile_dataset_path":config.dataset_path,
        "tile_cache_path":config.cache_path,"tile_work_path":config.work_path,"local_tile_workers":"1"
    })).unwrap()).unwrap();
    path
}

fn binary() -> std::path::PathBuf {
    // 配布用exeを再ビルドせず、同じ一時データ試験を最終成果物にも適用できる。
    std::env::var_os("GEOCODE_TEST_CLI_EXE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_geocode_web_single").into())
}

#[tokio::test]
async fn 実バイナリの取込失敗は原因をjsonと標準エラーへ残す() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("app.sqlite");
    let pool = pool(&database).await;
    pool.close().await;
    drop(pool);
    let settings = settings(root.path(), &database);
    let input = root.path().join("map.pbf");
    let dem = root.path().join("dem.xml");
    standard_fixture::write_inputs(&input, &dem);
    let xml = std::fs::read_to_string(&dem)
        .unwrap()
        .replace("fguuid:jgd2024.bl", "fguuid:unsupported.bl");
    std::fs::write(&dem, &xml).unwrap();

    let output = Process::new(binary())
        .args(["local-tiles", "import", "--config"])
        .arg(&settings)
        .arg("--input")
        .arg(&input)
        .args(["--name", "未対応の標高", "--features", "standard-v1"])
        .arg("--elevation-input")
        .arg(&dem)
        .arg("--json")
        .env("RUST_LOG", "warn")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let job: Value =
        serde_json::from_slice(&output.stdout).expect("標準出力のJSONに診断ログが混入しています");
    assert_eq!(job["state"], "failed");
    assert!(job["dataset_id"].is_null());
    let error = job["error"].as_str().unwrap();
    assert!(error.contains("fguuid:unsupported.bl"));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("fguuid:unsupported.bl"), "{stderr}");
    assert!(!stderr.contains('\u{1b}'));
    assert!(!stderr.contains("never-print"));
    assert_eq!(std::fs::read_to_string(&dem).unwrap(), xml);
}

#[test]
fn 混在方針は取り込み条件として解析し既定の道路要求は変えない() {
    let default = invocation(&["import", "--input", "D:/map.pbf", "--name", "道路"]);
    let Command::Import(request) = default.command else {
        panic!("取り込みコマンドが必要です");
    };
    assert_eq!(request.elevation_datum_policy, "strict");
    let serialized = serde_json::to_string(&request).unwrap();
    assert_eq!(
        serialized,
        r#"{"name":"道路","input_path":"D:/map.pbf","missing_nodes":"error","request_id":null}"#
    );
    let accepted = invocation(&[
        "import",
        "--input",
        "D:/map.pbf",
        "--name",
        "地形",
        "--features",
        "standard-v1",
        "--elevation-input",
        "E:/dem",
        "--elevation-datum-policy",
        "allow-jgd2000-2011",
    ]);
    let Command::Import(request) = accepted.command else {
        panic!("取り込みコマンドが必要です");
    };
    assert_eq!(request.elevation_datum_policy, "allow-jgd2000-2011");
    for args in [
        vec![
            "import",
            "--input",
            "D:/map.pbf",
            "--name",
            "道路",
            "--elevation-datum-policy",
            "allow-jgd2000-2011",
        ],
        vec![
            "import",
            "--input",
            "D:/map.pbf",
            "--name",
            "地形",
            "--features",
            "standard-v1",
            "--elevation-datum-policy",
            "allow-jgd2000-2011",
        ],
        vec![
            "import",
            "--input",
            "D:/map.pbf",
            "--name",
            "地形",
            "--features",
            "standard-v1",
            "--elevation-input",
            "E:/dem",
            "--elevation-datum-policy",
            "ignore",
        ],
        vec!["elevation", "inspect", "--input", "relative.xml"],
    ] {
        assert!(cli::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).is_err());
    }
}

#[tokio::test]
async fn 標高検査は本体dbと生成ownerなしで結果と取消を返す() {
    let root = tempfile::tempdir().unwrap();
    let pbf = root.path().join("unused.pbf");
    let dem = root.path().join("dem.xml");
    standard_fixture::write_inputs(&pbf, &dem);
    let input_before = std::fs::read(&dem).unwrap();
    let config = LocalTileConfig::defaults(&root.path().join("未作成の設定領域"));
    let invocation = invocation(&[
        "elevation",
        "inspect",
        "--input",
        dem.to_str().unwrap(),
        "--json",
    ]);
    assert!(!invocation.requires_database());
    assert!(!invocation.is_writer());
    let result =
        cli::execute_with_cancellation(&invocation, config.clone(), None, CancellationToken::new())
            .await
            .unwrap();
    assert_eq!(result.exit_code, 0, "{}", result.value);
    assert_eq!(result.value["allowed"], true);
    assert_eq!(result.value["validation_scope"], "header-only");
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let cancelled = cli::execute_with_cancellation(&invocation, config, None, cancellation)
        .await
        .unwrap();
    assert_eq!(cancelled.exit_code, 130);
    assert_eq!(cancelled.value["allowed"], false);
    assert_eq!(std::fs::read(&dem).unwrap(), input_before);
    assert!(!root.path().join("未作成の設定領域").exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn 実バイナリの混在検査は設定なしで受入可否と終了コードを返す() {
    let root = tempfile::tempdir().unwrap();
    let pbf = root.path().join("unused.pbf");
    let dem = root.path().join("template.xml");
    standard_fixture::write_inputs(&pbf, &dem);
    let template = std::fs::read_to_string(&dem).unwrap();
    let input = root.path().join("dem");
    std::fs::create_dir(&input).unwrap();
    let jgd2000 = input.join("jgd2000.xml");
    let jgd2011 = input.join("jgd2011.xml");
    std::fs::write(&jgd2000, template.replace("jgd2024", "jgd2000")).unwrap();
    std::fs::write(&jgd2011, template.replace("jgd2024", "jgd2011")).unwrap();
    let before = [
        std::fs::read(&jgd2000).unwrap(),
        std::fs::read(&jgd2011).unwrap(),
    ];
    let missing_settings = root
        .path()
        .join("未作成の設定領域/geocode-web-single.env.json");
    for (policy, expected_exit, expected_allowed) in
        [("strict", 2, false), ("allow-jgd2000-2011", 0, true)]
    {
        let output = Process::new(binary())
            .args(["local-tiles", "elevation", "inspect", "--input"])
            .arg(&input)
            .args(["--elevation-datum-policy", policy, "--config"])
            .arg(&missing_settings)
            .arg("--json")
            .current_dir(root.path())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(expected_exit),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["allowed"], expected_allowed);
        assert_eq!(result["exit_code"], expected_exit);
        assert_eq!(result["validation_scope"], "header-only");
        assert!(!String::from_utf8(output.stderr).unwrap().contains('\u{1b}'));
    }
    let output = Process::new(binary())
        .args(["local-tiles", "elevation", "inspect", "--input"])
        .arg(root.path().join("存在しないdem.xml"))
        .args(["--config"])
        .arg(&missing_settings)
        .arg("--json")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let failed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(failed["allowed"], false);
    assert_eq!(failed["exit_code"], 1);
    assert_eq!(std::fs::read(&jgd2000).unwrap(), before[0]);
    assert_eq!(std::fs::read(&jgd2011).unwrap(), before[1]);
    assert!(!missing_settings.parent().unwrap().exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 3);
}

#[cfg(windows)]
#[test]
fn windows_shell_でも_jsonと終了コードをリダイレクトできる() {
    use std::os::windows::process::CommandExt;

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("日本語と 空白の出力先");
    std::fs::create_dir(&directory).unwrap();
    let script = directory.join("CLI 出力確認.ps1");
    std::fs::write(&script, r#"
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$PSNativeCommandUseErrorActionPreference = $false
$executable = $args[0]
$outputPath = $args[1]
$errorPath = $args[2]
& $executable local-tiles unknown --json 2> $errorPath | Out-File -LiteralPath $outputPath -Encoding utf8NoBOM
$nativeExitCode = $LASTEXITCODE
exit $nativeExitCode
"#).unwrap();

    let assert_protocol = |stdout: &Path, stderr: &Path| {
        let bytes = std::fs::read(stdout).unwrap();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["exit_code"], 2);
        let message = result["error"].as_str().unwrap();
        assert!(message.contains("コマンド"));
        let diagnostic = std::fs::read_to_string(stderr).unwrap();
        assert!(
            diagnostic.contains(message),
            "診断がstderrへ分離されていません: {diagnostic}"
        );
        assert!(!diagnostic.contains("\"exit_code\""));
    };

    let output = directory.join("PowerShell 標準出力.json");
    let error = directory.join("PowerShell 診断.txt");
    let powershell = Process::new("pwsh.exe")
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(&script)
        .arg(binary())
        .arg(&output)
        .arg(&error)
        .output()
        .unwrap();
    assert_eq!(
        powershell.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&powershell.stderr)
    );
    assert!(powershell.stdout.is_empty());
    assert_protocol(&output, &error);

    let output = directory.join("cmd 標準出力.json");
    let error = directory.join("cmd 診断.txt");
    // パス値は環境変数で渡し、cmd用の引用済みコマンドへ生のパスを連結しない。
    let command = Process::new("cmd.exe")
        .args(["/d", "/v:off", "/s", "/c"])
        .env("GEOCODE_LOCAL_CLI_EXE", binary())
        .env("GEOCODE_LOCAL_CLI_STDOUT", &output)
        .env("GEOCODE_LOCAL_CLI_STDERR", &error)
        .raw_arg(r#"""%GEOCODE_LOCAL_CLI_EXE%" local-tiles unknown --json 1>"%GEOCODE_LOCAL_CLI_STDOUT%" 2>"%GEOCODE_LOCAL_CLI_STDERR%"""#)
        .output().unwrap();
    assert_eq!(
        command.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&command.stderr)
    );
    assert!(command.stdout.is_empty());
    assert_protocol(&output, &error);
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 5);
}

#[test]
fn 引数解析はモード混在と不明引数を拒否する() {
    assert!(matches!(invocation(&[]).command, Command::Help));
    let build_info = invocation(&["build-info", "--json"]);
    assert!(matches!(build_info.command, Command::BuildInfo));
    assert!(!build_info.requires_database() && !build_info.is_writer());
    let import = invocation(&[
        "import",
        "--input",
        "日本 roads.osm.pbf",
        "--name",
        "日本",
        "--json",
    ]);
    assert!(import.is_writer() && import.requires_database() && import.json);
    for args in [
        vec!["-s"],
        vec!["datasets", "list", "--detach"],
        vec!["jobs", "list", "--offset", "-1"],
        vec!["jobs", "list", "--limit", "201"],
        vec!["import", "--name", "日本"],
        vec!["status", "--json", "--json"],
        vec!["status", "--config", "relative.json"],
        vec![
            "precompute",
            "plan",
            "--dataset",
            "one",
            "--bbox",
            "NaN,1,2,3",
            "--min-zoom",
            "1",
            "--max-zoom",
            "2",
        ],
    ] {
        assert_eq!(
            cli::parse(
                &args
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect::<Vec<_>>()
            )
            .unwrap_err()
            .exit_code,
            2,
            "{args:?}"
        );
    }
    for args in [
        vec!["status"],
        vec!["url", "--dataset", "one"],
        vec!["jobs", "watch", "--job", "one"],
        vec![
            "precompute",
            "plan",
            "--dataset",
            "one",
            "--bbox",
            "139,35,140,36",
            "--min-zoom",
            "6",
            "--max-zoom",
            "6",
        ],
    ] {
        assert!(!invocation(&args).is_writer());
    }
}

#[test]
fn 実バイナリのhelpと設定照会は設定ファイルを補完保存しない() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("未作成フォルダ/設定.json");
    let help = Process::new(binary())
        .args(["local-tiles", "--help", "--config"])
        .arg(&missing)
        .output()
        .unwrap();
    assert!(
        help.status.success(),
        "{}",
        String::from_utf8_lossy(&help.stderr)
    );
    assert!(String::from_utf8_lossy(&help.stdout).contains("datasets prepare"));
    assert!(!missing.parent().unwrap().exists());
    let build_info = Process::new(binary())
        .args(["local-tiles", "build-info", "--json", "--config"])
        .arg(&missing)
        .output()
        .unwrap();
    assert!(
        build_info.status.success(),
        "{}",
        String::from_utf8_lossy(&build_info.stderr)
    );
    let build_info: Value = serde_json::from_slice(&build_info.stdout).unwrap();
    assert_eq!(build_info["app_build_id"].as_str().unwrap().len(), 64);
    assert_eq!(build_info["render_contract"]["identity_version"], 2);
    assert!(build_info["execution"]["verified"].is_boolean());
    assert_eq!(build_info["font"]["family"], "Noto Sans CJK JP");
    assert_eq!(build_info["font"]["sha256"].as_str().unwrap().len(), 64);
    assert!(
        build_info["font"]["license_text"]
            .as_str()
            .unwrap()
            .contains("SIL OPEN FONT LICENSE Version 1.1")
    );
    assert!(
        build_info["font"]["copyright"]
            .as_str()
            .unwrap()
            .contains("Adobe")
    );
    assert!(!missing.parent().unwrap().exists());
    let path = settings(root.path(), &root.path().join("存在しない本体.sqlite"));
    let before = std::fs::read(&path).unwrap();
    let output = Process::new(binary())
        .args(["local-tiles", "config", "show", "--json", "--config"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["tile_catalog_database_path"],
        LocalTileConfig::defaults(root.path())
            .catalog_database_path
            .to_string_lossy()
            .as_ref()
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("never-print"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!root.path().join("geocode-web-single.env.json.bak").exists());
    assert!(!root.path().join("tiles").exists());
    let bad = Process::new(binary())
        .args(["local-tiles", "unknown", "--json"])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&bad.stdout).unwrap()["exit_code"],
        2
    );
}

#[tokio::test]
async fn 未登録状態の照会でcatalogを作成しない() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(&root.path().join("app.sqlite")).await;
    let config = LocalTileConfig::defaults(root.path());
    assert_eq!(
        execute(&["status"], &config, &pool).await.value["catalog_exists"],
        false
    );
    assert_eq!(
        execute(&["datasets", "list"], &config, &pool).await.value,
        json!([])
    );
    assert_eq!(
        execute(&["jobs", "list"], &config, &pool).await.value,
        json!([])
    );
    assert!(!config.catalog_database_path.exists());
    assert!(!config.work_path.exists());
    pool.close().await;
}

#[tokio::test]
async fn 取り込みと事前生成の_cliが履歴と_urlを保持し共通背景へ登録する() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(&root.path().join("app.sqlite")).await;
    let mut config = LocalTileConfig::defaults(root.path());
    config.workers = 1;
    let input = root.path().join("日本 roads.osm.pbf");
    support::Fixture::sample().write(&input);
    let input_text = input.to_string_lossy().into_owned();
    let request_id = uuid::Uuid::new_v4().to_string();
    let imported = execute(
        &[
            "import",
            "--input",
            &input_text,
            "--name",
            "CLIの道路",
            "--request-id",
            &request_id,
        ],
        &config,
        &pool,
    )
    .await;
    assert_eq!(imported.exit_code, 0, "{}", imported.value);
    assert_eq!(imported.value["state"], "succeeded");
    let records = execute(&["datasets", "list"], &config, &pool).await;
    let id = records.value[0]["id"].as_str().unwrap();
    let url = execute(
        &[
            "url",
            "--dataset",
            id,
            "--base-url",
            "http://127.0.0.1:3000",
        ],
        &config,
        &pool,
    )
    .await
    .value;
    assert!(
        url["url"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:3000/local-tiles/")
    );
    assert!(url["url"].as_str().unwrap().ends_with("/{z}/{x}/{y}.png"));
    assert_eq!(url["kind"], "raster");
    assert_eq!(url["current_build"], true);
    std::fs::remove_file(input).unwrap();
    let repeat = execute(
        &[
            "import",
            "--input",
            &input_text,
            "--name",
            "CLIの道路",
            "--request-id",
            &request_id,
        ],
        &config,
        &pool,
    )
    .await;
    assert_eq!(repeat.value["id"], imported.value["id"]);
    let arguments = [
        "--dataset",
        id,
        "--bbox",
        "139.6999,35.6999,139.7001,35.7001",
        "--min-zoom",
        "14",
        "--max-zoom",
        "14",
        "--max-tiles",
        "100",
    ];
    let mut plan_args = vec!["precompute", "plan"];
    plan_args.extend(arguments);
    assert_eq!(
        execute(&plan_args, &config, &pool).await.value["allowed"],
        true
    );
    let mut run_args = vec!["precompute", "run"];
    run_args.extend(arguments);
    let generated = execute(&run_args, &config, &pool).await;
    assert_eq!(generated.exit_code, 0, "{}", generated.value);
    let job = generated.value["id"].as_str().unwrap();
    let resumed = execute(&["precompute", "resume", "--job", job], &config, &pool).await;
    assert_eq!(resumed.exit_code, 0, "{}", resumed.value);
    assert!(resumed.value["progress"]["reused_tiles"].as_u64().unwrap() > 0);
    let background = execute(&["background", "add", "--dataset", id], &config, &pool)
        .await
        .value;
    let background_id = background["id"].as_i64().unwrap();
    let row: (String, String) = sqlx::query_as("SELECT url,kind FROM tileserver_model WHERE id=?")
        .bind(background_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row,
        (
            url["relative_url"].as_str().unwrap().into(),
            "raster".into()
        )
    );
    let blocked = cli::execute(
        &invocation(&["datasets", "retire", "--dataset", id]),
        config.clone(),
        Some(pool.clone()),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(blocked.exit_code, 1);
    sqlx::query("DELETE FROM tileserver_model WHERE id=?")
        .bind(background_id)
        .execute(&pool)
        .await
        .unwrap();
    execute(&["datasets", "retire", "--dataset", id], &config, &pool).await;
    execute(
        &[
            "cache",
            "cleanup",
            "--dataset",
            id,
            "--render",
            url["render_id"].as_str().unwrap(),
        ],
        &config,
        &pool,
    )
    .await;
    assert!(
        !config
            .cache_path
            .join(id)
            .join(url["render_id"].as_str().unwrap())
            .exists()
    );
    let app_tables: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name GLOB 'local_tile_*'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(app_tables, 0);
    assert_eq!(
        execute(&["jobs", "list"], &config, &pool)
            .await
            .value
            .as_array()
            .unwrap()
            .len(),
        3
    );
    pool.close().await;
}

#[tokio::test]
async fn 読取_cliは生成ownerを奪わず別_cliの取消だけを限定更新する() {
    let root = tempfile::tempdir().unwrap();
    let pool = pool(&root.path().join("app.sqlite")).await;
    let config = LocalTileConfig::defaults(root.path());
    let service = LocalTiles::new(config.clone(), pool.clone());
    service.ensure_writer().await.unwrap();
    let record = JobRecord {
        id: "pending".into(),
        kind: "import".into(),
        dataset_id: None,
        state: "running".into(),
        request_json: "{}".into(),
        progress_json: "{}".into(),
        error: None,
        created_at: "now".into(),
        updated_at: "now".into(),
        owner_id: "active-owner".into(),
    };
    catalog::insert_job(&service.catalog, &record)
        .await
        .unwrap();
    assert_eq!(
        execute(&["status"], &config, &pool).await.value["owner_available"],
        false
    );
    assert_eq!(
        execute(&["jobs", "show", "--job", "pending"], &config, &pool)
            .await
            .value["state"],
        "running"
    );
    let stopped_watch = CancellationToken::new();
    stopped_watch.cancel();
    let error = cli::execute_with_cancellation(
        &invocation(&["jobs", "watch", "--job", "pending"]),
        config.clone(),
        Some(pool.clone()),
        stopped_watch,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.exit_code, 130);
    assert_eq!(
        catalog::get_job(&service.catalog, "pending")
            .await
            .unwrap()
            .unwrap()
            .state,
        "running"
    );
    let cancelled = execute(&["jobs", "cancel", "--job", "pending"], &config, &pool).await;
    assert_eq!(cancelled.value["state"], "cancelling");
    let concurrent_writer = cli::execute(
        &invocation(&["datasets", "prepare", "--dataset", "none"]),
        config,
        Some(pool.clone()),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(concurrent_writer.exit_code, 3);
    assert_eq!(
        catalog::get_job(&service.catalog, "pending")
            .await
            .unwrap()
            .unwrap()
            .state,
        "cancelling"
    );
    service.shutdown().await;
    pool.close().await;
}

#[tokio::test]
async fn 実バイナリの取り込みは一時設定だけを使い_json結果と終了コードを返す() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("app.sqlite");
    let pool = pool(&path).await;
    let setting = settings(root.path(), &path);
    let before = std::fs::read(&setting).unwrap();
    let input = root.path().join("input.osm.pbf");
    support::Fixture::sample().write(&input);
    let output = Process::new(binary())
        .args(["local-tiles", "import", "--input"])
        .arg(&input)
        .args(["--name", "実exeの道路", "--json", "--config"])
        .arg(&setting)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["state"], "succeeded");
    assert!(String::from_utf8_lossy(&output.stderr).contains("ジョブ"));
    let watched = Process::new(binary())
        .args(["local-tiles", "jobs", "watch", "--job"])
        .arg(result["id"].as_str().unwrap())
        .args(["--json", "--config"])
        .arg(&setting)
        .output()
        .unwrap();
    assert!(
        watched.status.success(),
        "{}",
        String::from_utf8_lossy(&watched.stderr)
    );
    let events: Vec<Value> = String::from_utf8(watched.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "terminal");
    assert_eq!(events[0]["job"]["state"], "succeeded");
    assert_eq!(std::fs::read(&setting).unwrap(), before);
    assert!(!root.path().join("geocode-web-single.env.json.bak").exists());
    let url = Process::new(binary())
        .args(["local-tiles", "url", "--dataset"])
        .arg(result["progress"]["dataset"]["id"].as_str().unwrap())
        .args(["--json", "--config"])
        .arg(&setting)
        .output()
        .unwrap();
    assert!(
        url.status.success(),
        "{}",
        String::from_utf8_lossy(&url.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&url.stdout).unwrap()["kind"],
        "raster"
    );
    assert!(input.exists());
    pool.close().await;
}
