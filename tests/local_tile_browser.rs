//! 手動ブラウザ受入用。CLIで準備した一時データを共通画面と通常XYZから利用する。
#[allow(dead_code)]
mod common;
#[path = "tilegen_support/mod.rs"]
mod support;
use geocode_web_single::{
    auth::create_token,
    build_tera_extension,
    local_tiles::{LocalTiles, cli, config::LocalTileConfig},
    router::build_router_with_local_tiles,
    tile_settings::TileSettings,
};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::test]
#[ignore = "ユーザーによる明示的なブラウザ受入用。一時DBとtarget/local-tile-browser-*だけを使用する"]
async fn local_tile_browser_acceptance_server() {
    let root = std::env::current_dir()
        .unwrap()
        .join("target")
        .join(format!("local-tile-browser-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    common::init_test_env();
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(root.join("application.sqlite"))
                .create_if_missing(true)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    geocode_web_single::db::check_and_insert_initial_data(&pool)
        .await
        .unwrap();
    let admin = common::create_test_admin(&pool, "local-browser-admin").await;
    let token = create_token(&admin, 60, "access_token", 0).unwrap();
    let input = root.join("sample.osm.pbf");
    support::Fixture::sample().write(&input);
    let config = LocalTileConfig::defaults(&root);
    let run_cli = |arguments: Vec<String>| {
        let config = config.clone();
        let pool = pool.clone();
        async move {
            let invocation = cli::parse(&arguments).unwrap();
            let output = cli::execute(&invocation, config, Some(pool)).await.unwrap();
            assert_eq!(
                output.exit_code, 0,
                "CLI操作が失敗しました: {}",
                output.value
            );
            output.value
        }
    };
    let imported = run_cli(vec![
        "import".into(),
        "--input".into(),
        input.to_string_lossy().into_owned(),
        "--name".into(),
        "CLI受入用道路".into(),
    ])
    .await;
    let dataset_id = imported["progress"]["dataset"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // 元PBFなしで事前生成と配信・共有を続けられることを確認する。
    std::fs::remove_file(&input).unwrap();
    let plan = run_cli(vec![
        "precompute".into(),
        "plan".into(),
        "--dataset".into(),
        dataset_id.clone(),
        "--bbox".into(),
        "139.6999,35.6999,139.7001,35.7001".into(),
        "--min-zoom".into(),
        "14".into(),
        "--max-zoom".into(),
        "14".into(),
        "--max-tiles".into(),
        "100".into(),
    ])
    .await;
    assert_eq!(plan["allowed"], true);
    let precomputed = run_cli(vec![
        "precompute".into(),
        "run".into(),
        "--dataset".into(),
        dataset_id.clone(),
        "--bbox".into(),
        "139.6999,35.6999,139.7001,35.7001".into(),
        "--min-zoom".into(),
        "14".into(),
        "--max-zoom".into(),
        "14".into(),
        "--max-tiles".into(),
        "100".into(),
    ])
    .await;
    let background = run_cli(vec![
        "background".into(),
        "add".into(),
        "--dataset".into(),
        dataset_id.clone(),
    ])
    .await;
    let dataset = run_cli(vec!["url".into(), "--dataset".into(), dataset_id]).await;
    let scan = run_cli(vec!["cache".into(), "scan".into()]).await;
    std::fs::write(
        root.join("cli-preparation.json"),
        json!({
            "import_job":imported,"precompute_job":precomputed,"plan":plan,"dataset":dataset,
            "background":background,"cache":scan,"original_pbf_absent":!input.exists()
        })
        .to_string(),
    )
    .unwrap();
    let service = LocalTiles::new(config.clone(), pool.clone());
    service.initialize().await.unwrap();
    let app = build_router_with_local_tiles(
        pool.clone(),
        build_tera_extension().unwrap(),
        None,
        Arc::new(TileSettings::from_env()),
        service.clone(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::fs::write(
        root.join("ready.json"),
        json!({"url":url,"access_token":token,"input_path":input,"dataset":dataset,
            "background_id":background["id"],"catalog_database_path":config.catalog_database_path,
            "prepared_by_cli":true,"original_pbf_absent":!input.exists()})
        .to_string(),
    )
    .unwrap();
    println!("LOCAL_TILE_BROWSER_READY {}", root.display());
    let done = root.join("done");
    let started = Instant::now();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            while !done.exists() && started.elapsed() < Duration::from_secs(600) {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            service.shutdown().await;
            let tile_tables: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name LIKE 'local_tile_%'",
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(tile_tables, 0);
            let catalog = rusqlite::Connection::open_with_flags(
                &config.catalog_database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ).unwrap();
            let datasets: i64 = catalog.query_row("SELECT COUNT(*) FROM local_tile_datasets", [], |r| r.get(0)).unwrap();
            let jobs: i64 = catalog.query_row("SELECT COUNT(*) FROM local_tile_jobs", [], |r| r.get(0)).unwrap();
            assert!(datasets > 0 && jobs >= 2);
            std::fs::write(root.join("database-separation.json"), json!({
                "application_tile_tables":tile_tables,"catalog_datasets":datasets,"catalog_jobs":jobs,
                "catalog_database_path":config.catalog_database_path
            }).to_string()).unwrap();
        })
        .await
        .unwrap();
}
