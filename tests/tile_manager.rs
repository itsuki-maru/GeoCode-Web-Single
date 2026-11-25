//! 専用管理画面のbackendを、利用者データに触れず隔離設定で検証する。
#[path = "standard_tile_fixture/mod.rs"]
mod fixture;
#[cfg(windows)]
#[path = "support/worker_cleanup.rs"]
mod worker_cleanup;

use geocode_web_single::{
    init::SetupForm,
    tile_manager::{Manager, setup},
};
use serde_json::{Value, json};
use std::path::Path;
#[cfg(windows)]
use std::time::{Duration, Instant};

fn form() -> SetupForm {
    SetupForm {
        app_title: "GUI試験".into(),
        admin_username: "guiadmin".into(),
        admin_password: "GuiFixture!94".into(),
        failed_account_lock: "5".into(),
        next_challenge_minutes: "10".into(),
        challenge_limit_time_failed_count: "5".into(),
        access_token_exp_minutes: "30".into(),
        refresh_token_exp_minutes: "1440".into(),
    }
}

#[tokio::test]
async fn avoid_creating_configuration_or_catalog_for_unconfigured_queries_and_invalid_actions() {
    let root = tempfile::tempdir().unwrap();
    let absent = root.path().join("未作成の保存先");
    let manager = Manager::new(
        absent.join("settings.json"),
        std::env::current_exe().unwrap(),
    );
    for _ in 0..2 {
        let state = manager.snapshot().await.unwrap();
        assert_eq!(state["configured"], false);
        assert_eq!(state["jobs"], json!([]));
    }
    assert!(manager.query("import", json!({})).await.is_err());
    assert!(
        manager
            .submit("import", json!({}), "invalid-id".into())
            .await
            .is_err()
    );
    assert!(!absent.exists());
}

#[tokio::test]
async fn keep_configuration_database_and_generation_ownership_unchanged_after_initial_setup_queries()
 {
    let root = tempfile::tempdir().unwrap();
    let config_path = root.path().join("設定 日本語.json");
    setup::initialize(&config_path, form()).await.unwrap();
    let settings = geocode_web_single::init::read_env_json_readonly(&config_path).unwrap();
    let config_bytes = std::fs::read(&config_path).unwrap();
    let database_bytes = std::fs::read(&settings.sqlite_database_path).unwrap();
    let manager = Manager::new(config_path.clone(), std::env::current_exe().unwrap());
    for _ in 0..2 {
        let state = manager.snapshot().await.unwrap();
        assert_eq!(state["configured"], true, "{state}");
        assert_eq!(state["owner_available"], true, "{state}");
        assert_eq!(state["datasets"], json!([]));
        assert_eq!(state["jobs"], json!([]));
    }
    assert_eq!(std::fs::read(&config_path).unwrap(), config_bytes);
    assert_eq!(
        std::fs::read(&settings.sqlite_database_path).unwrap(),
        database_bytes
    );
    assert!(Path::new(&settings.tile_catalog_database_path).is_file());
    assert!(
        !Path::new(&settings.tile_dataset_path)
            .join("routing")
            .exists()
    );
}

#[cfg(windows)]
#[tokio::test]
async fn use_independent_databases_after_a_drive_move_or_a_same_path_replacement() {
    use geocode_web_single::local_tiles::catalog::rebind::storage;
    use std::fs;

    let root = tempfile::tempdir().unwrap();
    let local = root.path().join("アプリ");
    let external = root.path().join("外付け #100%");
    let config = local.join("設定.json");
    let other_config = external.join("別の設定.json");
    setup::initialize(&config, form()).await.unwrap();
    let mut other_form = form();
    other_form.admin_username = "second-admin".into();
    setup::initialize(&other_config, other_form).await.unwrap();
    let settings = geocode_web_single::init::read_env_json_readonly(&config).unwrap();
    let original = settings.sqlite_database_path;
    let second = external.join("geocode-web.sqlite");
    assert_ne!(fs::read(&original).unwrap(), fs::read(&second).unwrap());

    // 旧形式の許可や将来の未知項目を含む既存設定でも、新しい保存先を一度で選択できる。
    let mut document: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    document["tile_database_replacement"] = json!({"catalog_file_id":"旧ドライブの識別子"});
    document["future_option"] = json!({"value": "保持"});
    fs::write(&config, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    let manager = Manager::new(config.clone(), std::env::current_exe().unwrap());
    let run = |request| storage::run(&config, serde_json::from_value(request).unwrap());
    let apply = |selection| {
        let current = run(json!({"action":"current"})).unwrap();
        run(json!({"action":"apply","expected":current["expected"],"selection":selection})).unwrap()
    };
    // 元の本体を外しても、元のカタログを使いながら別内容のDBを選べる。
    fs::rename(&original, local.join("保管.sqlite")).unwrap();
    assert!(manager.snapshot().await.unwrap()["error"].is_string());
    assert_eq!(apply(json!({"database":second}))["state"], "succeeded");
    assert!(manager.snapshot().await.unwrap()["error"].is_null());
    let updated: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert!(updated.get("tile_database_replacement").is_none());
    assert_eq!(updated["future_option"], document["future_option"]);
    assert_eq!(
        updated["tile_catalog_database_path"],
        document["tile_catalog_database_path"]
    );
    assert!(!original.exists());

    // 保存先を同じ名前の別ファイルに入れ替えても設定の書き換えは不要。
    fs::rename(&second, external.join("前の本体.sqlite")).unwrap();
    fs::copy(local.join("保管.sqlite"), &second).unwrap();
    assert!(manager.snapshot().await.unwrap()["error"].is_null());
    let before = fs::read(&config).unwrap();
    let offline = local.join("取り外したtiles");
    fs::rename(local.join("tiles"), &offline).unwrap();
    assert!(manager.snapshot().await.unwrap()["error"].is_string());
    assert_eq!(fs::read(&config).unwrap(), before);
    assert!(!local.join("tiles").exists());
    // 外付け側の別のカタログに切り替える。元のカタログを復元する必要はない。
    assert_eq!(
        apply(json!({"tiles":external.join("tiles")}))["state"],
        "succeeded"
    );
    assert!(manager.snapshot().await.unwrap()["error"].is_null());
    assert!(!local.join("tiles").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn invalid_or_missing_selected_files_leave_settings_and_existing_databases_intact() {
    use geocode_web_single::local_tiles::catalog::rebind::storage;
    use std::fs;
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("設定.json");
    setup::initialize(&config, form()).await.unwrap();
    let before = fs::read(&config).unwrap();
    let unrelated = root.path().join("別形式.sqlite");
    let db = rusqlite::Connection::open(&unrelated).unwrap();
    db.execute("CREATE TABLE unrelated (n INTEGER)", [])
        .unwrap();
    drop(db);
    let unrelated_before = fs::read(&unrelated).unwrap();
    let corrupt = root.path().join("参照の壊れたカタログ.sqlite");
    fs::copy(root.path().join("tiles/catalog.sqlite"), &corrupt).unwrap();
    let db = rusqlite::Connection::open(&corrupt).unwrap();
    db.execute_batch(
        r#"
        PRAGMA foreign_keys = OFF;
        INSERT INTO local_tile_render_profiles (id, dataset_id, build_id, info_json, retired)
        VALUES ('profile', 'missing-dataset', 'build', '{}', FALSE);
        "#,
    )
    .unwrap();
    drop(db);
    let run = |request| storage::run(&config, serde_json::from_value(request).unwrap());
    let current = run(json!({"action":"current"})).unwrap();
    let missing = root.path().join("未接続").join("tiles");
    for selection in [
        json!({"database":unrelated}),
        json!({"catalog":unrelated}),
        json!({"catalog":corrupt}),
        json!({"tiles":missing}),
    ] {
        assert!(
            run(json!({"action":"apply","expected":current["expected"],"selection":selection}))
                .is_err()
        );
    }
    assert!(!missing.exists());
    assert_eq!(fs::read(&config).unwrap(), before);
    assert_eq!(fs::read(&unrelated).unwrap(), unrelated_before);
}

#[cfg(windows)]
#[tokio::test]
async fn create_a_catalog_only_after_explicitly_choosing_an_empty_location() {
    use geocode_web_single::local_tiles::catalog::rebind::storage;
    use std::fs;

    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("設定.json");
    setup::initialize(&config, form()).await.unwrap();
    let tiles = root.path().join("tiles");
    fs::rename(&tiles, root.path().join("元のカタログ")).unwrap();
    let run = |request| storage::run(&config, serde_json::from_value(request).unwrap());
    let current = run(json!({"action":"current"})).unwrap();
    assert_eq!(current["can_initialize_catalog"], true);
    assert!(!tiles.exists());
    let initialize = json!({"action":"initialize_catalog","expected":current["expected"]});

    // 元のSQLiteに付随するファイルが残っているときは、空の管理DBを重ねない。
    fs::create_dir(&tiles).unwrap();
    let wal = tiles.join("catalog.sqlite-wal");
    fs::write(&wal, b"existing journal").unwrap();
    assert!(run(initialize.clone()).is_err());
    assert!(!tiles.join("catalog.sqlite").exists());
    assert_eq!(fs::read(&wal).unwrap(), b"existing journal");
    fs::remove_file(wal).unwrap();
    fs::write(tiles.join("catalog.sqlite.owner.lock"), b"").unwrap();

    assert_eq!(run(initialize.clone()).unwrap()["state"], "succeeded");
    assert!(tiles.join("catalog.sqlite").is_file());
    assert!(run(initialize).is_err());
    let manager = Manager::new(config, std::env::current_exe().unwrap());
    assert!(manager.snapshot().await.unwrap()["error"].is_null());
}

#[cfg(windows)]
async fn terminal(manager: &Manager, request_id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let snapshot = manager.snapshot().await.unwrap();
            let receipt = snapshot["requests"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == request_id)
                .cloned();
            if let Some(receipt) = receipt {
                if !matches!(
                    receipt["state"].as_str(),
                    Some("starting" | "running" | "queued" | "cancelling")
                ) {
                    return receipt;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("受付が90秒以内に終了しませんでした")
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "Windowsの実画面QA用。所有process handleで回収し、GEOCODE_TILE_MANAGER_UI_FIXTUREの新規フォルダーに隔離資料を保持"]
async fn prepare_isolated_fixtures_for_manual_gui_verification() {
    let root = std::path::PathBuf::from(
        std::env::var_os("GEOCODE_TILE_MANAGER_UI_FIXTURE").expect("検証用保存先が必要です"),
    );
    let exe = std::path::PathBuf::from(
        std::env::var_os("GEOCODE_TILE_MANAGER_TEST_EXE").expect("認定済みexeが必要です"),
    );
    assert!(
        root.is_absolute() && !root.exists(),
        "新しい検証用フォルダーだけを指定してください"
    );
    std::fs::create_dir_all(&root).unwrap();
    let config_path = root.join("管理画面 設定.json");
    setup::initialize(&config_path, form()).await.unwrap();
    let input = root.join("小さな 入力.osm.pbf");
    let dem = root.join("標高.xml");
    fixture::write_inputs(&input, &dem);
    let manager = Manager::new(config_path.clone(), exe.clone());
    let mut cleanup = worker_cleanup::WorkerCleanup::new(&config_path, &exe).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    cleanup.submit(&manager,"import", json!({"input_path":input,"name":"実画面検証用の地図","features":"standard-v2","contour_data":"off"}), id.clone()).await.unwrap();
    let result = terminal(&manager, &id).await;
    assert_eq!(result["state"], "succeeded", "{result}");
    cleanup.finish().unwrap();
    std::fs::write(root.join("fixture.json"), serde_json::to_vec_pretty(&json!({"config_path":config_path,"input":input,"dem":dem,"snapshot":manager.snapshot().await.unwrap()})).unwrap()).unwrap();
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "Windowsの所有process handleで回収。GEOCODE_TILE_MANAGER_TEST_EXEに生成認定済みexeを指定して別プロセス経路を検証"]
async fn complete_independent_worker_jobs_after_dropping_the_manager_and_support_reconnect_cancel_and_resume()
 {
    let exe = std::path::PathBuf::from(
        std::env::var_os("GEOCODE_TILE_MANAGER_TEST_EXE").expect("認定済みexeが必要です"),
    );
    let root = tempfile::tempdir().unwrap();
    let config_path = root.path().join("設定 日本語.json");
    setup::initialize(&config_path, form()).await.unwrap();
    let input = root.path().join("小さな 入力.osm.pbf");
    let dem = root.path().join("標高.xml");
    fixture::write_inputs(&input, &dem);
    let manager = Manager::new(config_path.clone(), exe.clone());
    let mut cleanup = worker_cleanup::WorkerCleanup::new(&config_path, &exe).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({"input_path":input,"name":"GUI取り込み","features":"standard-v2","contour_data":"off"});
    cleanup
        .submit(&manager, "import", payload.clone(), id.clone())
        .await
        .unwrap();
    drop(manager);
    let manager = Manager::new(config_path, exe);
    let imported = terminal(&manager, &id).await;
    assert_eq!(imported["state"], "succeeded", "{imported}");
    cleanup
        .submit(&manager, "import", payload, id.clone())
        .await
        .unwrap();
    assert!(cleanup.submit(&manager,"import", json!({"input_path":input,"name":"異なる条件","features":"standard-v2","contour_data":"off"}), id).await.is_err());
    let snapshot = manager.snapshot().await.unwrap();
    assert_eq!(snapshot["datasets"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["jobs"].as_array().unwrap().len(), 1);
    let dataset = snapshot["datasets"][0]["id"].as_str().unwrap().to_owned();
    let url = manager
        .query("url", json!({"dataset":dataset}))
        .await
        .unwrap();
    let render = url["render_id"].as_str().unwrap().to_owned();
    let precompute = json!({"dataset_id":dataset,"render_id":render,"bbox":[139.69,35.69,139.71,35.71],"min_zoom":18,"max_zoom":18,"max_tiles":10000});
    let plan = manager.query("plan", precompute.clone()).await.unwrap();
    assert!(plan.is_object());
    let id = uuid::Uuid::new_v4().to_string();
    cleanup
        .submit(&manager, "precompute", precompute.clone(), id.clone())
        .await
        .unwrap();
    // 受付IDがjob IDと一致するため、受付直後の再接続でも取消を一意に届けられる。
    let cancelled = manager.query("cancel", json!({"job":id})).await;
    let first = terminal(&manager, &id).await;
    assert!(
        cancelled.is_ok() || first["state"] == "succeeded",
        "{first}"
    );
    assert!(
        matches!(first["state"].as_str(), Some("cancelled" | "succeeded")),
        "{first}"
    );
    cleanup
        .submit(&manager, "precompute", precompute, id.clone())
        .await
        .unwrap();
    let resume_id = uuid::Uuid::new_v4().to_string();
    cleanup
        .submit(&manager, "resume", json!({"job":id}), resume_id.clone())
        .await
        .unwrap();
    let resumed = terminal(&manager, &resume_id).await;
    assert_eq!(resumed["state"], "succeeded", "{resumed}");
    assert_eq!(manager.snapshot().await.unwrap()["owner_available"], true);
    cleanup.finish().unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn routing_worker_reconnects_and_publishes_only_complete_generations() {
    let exe = std::env::var_os("GEOCODE_TILE_MANAGER_TEST_EXE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_BIN_EXE_geocode_web_single")).to_owned());
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("設定.json");
    setup::initialize(&config, form()).await.unwrap();
    let input = root.path().join("市街地.osm.pbf");
    fixture::write_inputs(&input, &root.path().join("unused.xml"));
    let manager = Manager::new(config.clone(), exe.clone());
    let mut cleanup = worker_cleanup::WorkerCleanup::new(&config, &exe).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({"name":"市街地","input_path":input});
    cleanup
        .submit(&manager, "route_build", payload.clone(), id.clone())
        .await
        .unwrap();
    drop(manager);
    let manager = Manager::new(config, exe);
    let receipt = terminal(&manager, &id).await;
    assert_eq!(receipt["state"], "succeeded", "{receipt}");
    assert_eq!(receipt["result"]["dataset_id"], id);
    assert_eq!(
        manager
            .submit("route_build", payload.clone(), id.clone())
            .await
            .unwrap()["id"],
        id
    );
    assert!(
        manager
            .submit(
                "route_build",
                json!({"name":"別条件","input_path":input}),
                id.clone()
            )
            .await
            .is_err()
    );
    let route = |dataset: &str| {
        json!({"dataset":dataset,"mode":"car",
        "start":{"lat":35.7,"lon":139.699},"end":{"lat":35.701,"lon":139.701}})
    };
    let path = manager.query("route_search", route(&id)).await.unwrap();
    assert!(path["distance_m"].as_f64().unwrap() > 100.);
    let second_id = uuid::Uuid::new_v4().to_string();
    cleanup
        .submit(&manager, "route_build", payload.clone(), second_id.clone())
        .await
        .unwrap();
    let receipt = terminal(&manager, &second_id).await;
    assert_eq!(receipt["state"], "succeeded", "{receipt}");
    let snapshot = manager.snapshot().await.unwrap();
    let datasets = snapshot["routing"]["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), 1);
    assert_eq!(datasets[0]["id"], second_id);
    assert_eq!(snapshot["routing"]["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["datasets"], json!([]));
    assert_eq!(
        manager.query("route_search", route(&id)).await.unwrap(),
        path
    );
    let third_id = uuid::Uuid::new_v4().to_string();
    cleanup
        .submit(&manager, "route_build", payload, third_id.clone())
        .await
        .unwrap();
    let _ = manager
        .query("cancel", json!({"job":third_id}))
        .await
        .unwrap();
    let receipt = terminal(&manager, &third_id).await;
    assert!(
        matches!(receipt["state"].as_str(), Some("cancelled" | "succeeded")),
        "{receipt}"
    );
    if receipt["state"] == "cancelled" {
        assert_eq!(
            manager.snapshot().await.unwrap()["routing"]["datasets"][0]["id"],
            second_id
        );
    }
    cleanup.finish().unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn worker_cleanup_reaps_owned_processes_after_panic_and_timeout() {
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    const CHILD: &str = "GEOCODE_WORKER_CLEANUP_TEST_CHILD";
    if let Some(value) = std::env::var_os(CHILD) {
        assert_eq!(value, "1");
        let ready =
            std::env::var_os("GEOCODE_WORKER_CLEANUP_READY").expect("ready path is required");
        std::fs::write(ready, b"ready").unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
        panic!("cleanup did not terminate the owned test child");
    }
    struct TestChild(Child);
    impl Drop for TestChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let deadline = Instant::now() + Duration::from_secs(2);
                while self.0.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
    let executable = std::env::current_exe().unwrap();
    for panic_case in [true, false] {
        let fixture = tempfile::tempdir().unwrap();
        let ready = fixture.path().join("child-ready");
        let before = worker_cleanup::process_clock();
        let mut child = TestChild(
            Command::new(&executable)
                .args([
                    "--exact",
                    "worker_cleanup_reaps_owned_processes_after_panic_and_timeout",
                    "--test-threads=1",
                ])
                .env(CHILD, "1")
                .env("GEOCODE_WORKER_CLEANUP_READY", &ready)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap(),
        );
        let after = worker_cleanup::process_clock();
        let mut cleanup = worker_cleanup::WorkerCleanup::for_child(&executable).unwrap();
        assert!(
            cleanup.track_child(&child.0, before, after).unwrap(),
            "cleanup child must still be running"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "cleanup child exited before becoming ready"
            );
            assert!(
                Instant::now() < deadline,
                "cleanup child did not become ready"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if panic_case {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _cleanup = cleanup;
                panic!("simulated test-body assertion failure");
            }));
            assert!(result.is_err());
        } else {
            let result = tokio::time::timeout(Duration::from_millis(20), async {
                let _cleanup = cleanup;
                std::future::pending::<()>().await;
            })
            .await;
            assert!(result.is_err());
        }
        assert!(
            child.0.try_wait().unwrap().is_some(),
            "owned child must be reaped before guard returns"
        );
    }
}
