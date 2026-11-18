//! 実SQLite・実ファイル識別を使い、移設以外のデータが変わらないことを検証する。
#![cfg(all(windows, target_pointer_width = "64"))]
use geocode_web_single::{
    db::run_migrations,
    init::{SetupForm, build_env_settings},
    local_tiles::{
        catalog::{
            self, DatasetRecord, JobRecord, ProfileRecord, TileCatalog,
            rebind::{self, Plan, Request, Signed},
        },
        config::LocalTileConfig,
    },
    model::ApplicationInitSetup,
    tilegen::cancel::CancellationToken,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[path = "support/process_output.rs"]
mod process_output;
#[cfg(windows)]
#[path = "support/worker_cleanup.rs"]
mod worker_cleanup;

struct Fixture {
    _root: tempfile::TempDir,
    config: PathBuf,
    old: PathBuf,
    new: PathBuf,
    settings: ApplicationInitSetup,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut settings = build_env_settings(
            root.path(),
            SetupForm {
                app_title: "移設試験".into(),
                admin_username: "relocationadmin".into(),
                admin_password: "Relocation fixture!2026".into(),
                failed_account_lock: "5".into(),
                next_challenge_minutes: "5".into(),
                challenge_limit_time_failed_count: "5".into(),
                access_token_exp_minutes: "30".into(),
                refresh_token_exp_minutes: "60".into(),
            },
        )
        .unwrap();
        let old = settings.sqlite_database_path.clone();
        let new = root.path().join("移設先 日本語.sqlite");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&old)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        run_migrations(&pool).await.unwrap();
        sqlx::query("INSERT INTO application_settings(id,setting_key,setting_value,description,create_at,updated_at) VALUES ('fixture','relocation-test','sensitive-preserved-value','test','2026','2026')").execute(&pool).await.unwrap();
        let config = LocalTileConfig::from_setup(&settings).unwrap();
        fs::create_dir_all(&config.dataset_path).unwrap();
        fs::create_dir_all(&config.cache_path).unwrap();
        fs::create_dir_all(&config.work_path).unwrap();
        let catalog = TileCatalog::new(config.catalog_database_path.clone(), pool.clone());
        catalog.initialize().await.unwrap();
        catalog::insert_dataset(
            &catalog,
            &DatasetRecord {
                id: "dataset".into(),
                name: "履歴を保持".into(),
                storage_kind: "managed".into(),
                database_path: "one/data.sqlite".into(),
                dataset_key: "fixture".into(),
                info_json: "{}".into(),
                created_at: "2026".into(),
                retired: false,
            },
        )
        .await
        .unwrap();
        catalog::insert_profile(
            &catalog,
            &ProfileRecord {
                dataset_id: "dataset".into(),
                id: "profile".into(),
                build_id: "old-build".into(),
                info_json: "{}".into(),
                retired: false,
            },
        )
        .await
        .unwrap();
        for (id, state) in [
            ("completed", "succeeded"),
            ("stopped", "cancelled"),
            ("orphan", "running"),
        ] {
            catalog::insert_job(
                &catalog,
                &JobRecord {
                    id: id.into(),
                    kind: "precompute".into(),
                    dataset_id: Some("dataset".into()),
                    state: state.into(),
                    request_json: "{\"keep\":true}".into(),
                    progress_json: "{\"completed\":17}".into(),
                    error: None,
                    created_at: "2026".into(),
                    updated_at: "2026".into(),
                    owner_id: "old-owner".into(),
                },
            )
            .await
            .unwrap();
        }
        catalog.close().await;
        loop {
            pool.close().await;
            if pool.size() == 0 {
                break;
            }
        }
        settings.local_tile_workers = "4".into();
        let config_path = root.path().join("設定.json");
        fs::write(&config_path, serde_json::to_vec_pretty(&settings).unwrap()).unwrap();
        Self {
            _root: root,
            config: config_path,
            old,
            new,
            settings,
        }
    }
    fn copy_app(&mut self) {
        fs::copy(&self.old, &self.new).unwrap();
        self.settings.sqlite_database_path = self.new.clone();
        self.settings.database_url = format!("sqlite:{}", self.new.display());
        self.save();
    }
    fn save(&self) {
        fs::write(
            &self.config,
            serde_json::to_vec_pretty(&self.settings).unwrap(),
        )
        .unwrap();
    }
    fn call(&self, request: Request) -> Result<Value, String> {
        rebind::execute(
            &self.config,
            request,
            &CancellationToken::new(),
            &mut |_, _| Ok(()),
        )
    }
    fn plan(&self) -> Signed<Plan> {
        serde_json::from_value(
            self.call(Request::Plan {
                source_database: Some(self.old.clone()),
                proof: None,
            })
            .unwrap(),
        )
        .unwrap()
    }
    fn contents(&self) -> Vec<Vec<String>> {
        let c = Connection::open(&self.settings.tile_catalog_database_path).unwrap();
        [
            "local_tile_datasets",
            "local_tile_render_profiles",
            "local_tile_jobs",
        ]
        .iter()
        .map(|name| {
            let mut q = c
                .prepare(&format!("SELECT * FROM {name} ORDER BY id"))
                .unwrap();
            let width = q.column_count();
            q.query_map([], |r| {
                Ok((0..width)
                    .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        })
        .collect()
    }
    fn binding_path(&self) -> String {
        Connection::open(&self.settings.tile_catalog_database_path)
            .unwrap()
            .query_row(
                "SELECT app_database_path FROM tile_catalog_binding",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }
}
fn hash(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}

#[tokio::test]
async fn copied_application_rebind_preserves_every_record_and_creates_verified_backup() {
    let mut f = Fixture::new().await;
    let data = f.contents();
    let old_hash = hash(&f.old);
    f.copy_app();
    let new_hash = hash(&f.new);
    let plan = f.plan();
    assert_eq!(plan.payload.evidence, "original_database");
    let outcome = f.call(Request::Apply { plan: plan.clone() }).unwrap();
    assert_eq!(outcome["state"], "succeeded");
    assert_eq!(f.contents(), data);
    assert_eq!(hash(&f.old), old_hash);
    assert_eq!(hash(&f.new), new_hash);
    assert_eq!(Path::new(&f.binding_path()), f.new.canonicalize().unwrap());
    let backup = Connection::open(outcome["backup"].as_str().unwrap()).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM local_tile_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        PathBuf::from(
            backup
                .query_row(
                    "SELECT app_database_path FROM tile_catalog_binding",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap()
        ),
        f.old.canonicalize().unwrap()
    );
    assert_eq!(
        f.call(Request::Apply { plan }).unwrap()["already_applied"],
        true
    );
    assert_eq!(f.call(Request::Inspect).unwrap()["binding_matches"], true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(&f.new))
        .await
        .unwrap();
    let normal = TileCatalog::new(
        f.settings.tile_catalog_database_path.clone().into(),
        pool.clone(),
    );
    assert_eq!(catalog::list_jobs(&normal, 100, 0).await.unwrap().len(), 3);
    normal.close().await;
    pool.close().await;
}

#[tokio::test]
async fn prepared_proof_survives_copies_of_both_databases_without_original_file() {
    let mut f = Fixture::new().await;
    let proof = f._root.path().join("proof.json");
    f.call(Request::Prepare {
        output: proof.clone(),
    })
    .unwrap();
    f.copy_app();
    fs::remove_file(&f.old).unwrap();
    let cat = PathBuf::from(&f.settings.tile_catalog_database_path);
    let moved = f._root.path().join("catalog-moved.sqlite");
    fs::copy(cat, &moved).unwrap();
    f.settings.tile_catalog_database_path = moved.to_string_lossy().into_owned();
    f.save();
    let before = f.contents();
    let plan: Signed<Plan> = serde_json::from_value(
        f.call(Request::Plan {
            source_database: None,
            proof: Some(proof),
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(plan.payload.evidence, "prepared_proof");
    f.call(Request::Apply { plan }).unwrap();
    assert_eq!(f.contents(), before);
}

#[tokio::test]
async fn same_file_can_move_without_origin_or_proof() {
    let mut f = Fixture::new().await;
    fs::rename(&f.old, &f.new).unwrap();
    f.settings.sqlite_database_path = f.new.clone();
    f.settings.database_url = format!("sqlite:{}", f.new.display());
    f.save();
    let plan: Signed<Plan> = serde_json::from_value(
        f.call(Request::Plan {
            source_database: None,
            proof: None,
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(plan.payload.evidence, "same_file");
    f.call(Request::Apply { plan }).unwrap();
}

#[tokio::test]
async fn missing_evidence_and_ordinary_backup_copies_never_authorize_a_rebind() {
    let mut f = Fixture::new().await;
    f.copy_app();
    let before = f.binding_path();
    assert!(
        f.call(Request::Plan {
            source_database: None,
            proof: None
        })
        .unwrap_err()
        .contains("同一性")
    );
    assert!(
        f.call(Request::Plan {
            source_database: Some(f.new.clone()),
            proof: None
        })
        .unwrap_err()
        .contains("元DB")
    );
    assert_eq!(f.binding_path(), before);
}

#[tokio::test]
async fn changed_application_or_catalog_and_tampered_plans_are_rejected() {
    let mut f = Fixture::new().await;
    f.copy_app();
    let before = f.binding_path();
    let plan = f.plan();
    let mut tainted = plan.clone();
    tainted.payload.target.file_id = "other".into();
    assert!(f.call(Request::Apply { plan: tainted }).is_err());
    let conn = Connection::open(&f.new).unwrap();
    conn.execute(
        "UPDATE application_settings SET setting_value='changed'",
        [],
    )
    .unwrap();
    drop(conn);
    assert!(
        f.call(Request::Apply { plan: plan.clone() })
            .unwrap_err()
            .contains("内容")
    );
    assert_eq!(f.binding_path(), before);
    fs::copy(&f.old, &f.new).unwrap();
    let plan = f.plan();
    let cat = Connection::open(&f.settings.tile_catalog_database_path).unwrap();
    cat.execute(
        "UPDATE local_tile_jobs SET progress_json='{}' WHERE id='completed'",
        [],
    )
    .unwrap();
    drop(cat);
    assert!(
        f.call(Request::Apply { plan })
            .unwrap_err()
            .contains("内容")
    );
    assert_eq!(f.binding_path(), before);
}

#[tokio::test]
async fn configuration_changes_and_proof_tampering_are_rejected() {
    let mut f = Fixture::new().await;
    let proof = f._root.path().join("proof.json");
    f.call(Request::Prepare {
        output: proof.clone(),
    })
    .unwrap();
    f.copy_app();
    let mut json: Value = serde_json::from_slice(&fs::read(&proof).unwrap()).unwrap();
    json["payload"]["application"]["sha256"] = json!("modified");
    fs::write(&proof, serde_json::to_vec(&json).unwrap()).unwrap();
    assert!(
        f.call(Request::Plan {
            source_database: None,
            proof: Some(proof)
        })
        .unwrap_err()
        .contains("変更")
    );
    let plan = f.plan();
    let before = f.binding_path();
    f.settings.app_title = "changed".into();
    f.save();
    assert!(
        f.call(Request::Apply { plan })
            .unwrap_err()
            .contains("計画")
    );
    assert_eq!(f.binding_path(), before);
}

#[tokio::test]
async fn cancellation_before_commit_rolls_back_and_history_remains_unchanged() {
    let mut f = Fixture::new().await;
    f.copy_app();
    let before = f.binding_path();
    let data = f.contents();
    let plan = f.plan();
    let result = rebind::execute(
        &f.config,
        Request::Apply { plan: plan.clone() },
        &CancellationToken::new(),
        &mut |stage, _| {
            if stage == "committing" {
                Err("simulated interruption".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
    assert_eq!(f.binding_path(), before);
    assert_eq!(f.contents(), data);
    // 同じ計画の再実行では検証済みのbackupを再利用する。
    f.call(Request::Apply { plan }).unwrap();
    assert_eq!(f.contents(), data);
}

#[tokio::test]
async fn error_after_commit_reports_success_and_retry_never_updates_history_twice() {
    let mut f = Fixture::new().await;
    f.copy_app();
    let data = f.contents();
    let plan = f.plan();
    let result = rebind::execute(
        &f.config,
        Request::Apply { plan: plan.clone() },
        &CancellationToken::new(),
        &mut |stage, _| {
            if stage == "completed" {
                Err("completion notification unavailable".into())
            } else {
                Ok(())
            }
        },
    )
    .unwrap();
    assert_eq!(result["state"], "succeeded");
    assert!(result["warning"].is_string());
    assert_eq!(
        f.call(Request::Apply { plan }).unwrap()["already_applied"],
        true
    );
    assert_eq!(f.contents(), data);
}

#[tokio::test]
async fn owner_lock_blocks_inspection_and_application_and_hardlinks_are_rejected() {
    use fs2::FileExt;
    let mut f = Fixture::new().await;
    f.copy_app();
    let plan = f.plan();
    let path = PathBuf::from(format!(
        "{}.owner.lock",
        f.settings.tile_catalog_database_path
    ));
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    assert!(f.call(Request::Inspect).is_err());
    assert!(f.call(Request::Apply { plan }).is_err());
    drop(lock);
    let alias = f._root.path().join("alias.sqlite");
    fs::hard_link(&f.new, &alias).unwrap();
    assert!(f.call(Request::Inspect).unwrap_err().contains("hard link"));
}

#[cfg(windows)]
#[tokio::test]
async fn running_application_write_handles_block_relocation_even_when_idle() {
    let mut f = Fixture::new().await;
    f.copy_app();
    let conn = Connection::open(&f.new).unwrap();
    conn.query_row("SELECT count(*) FROM application_settings", [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap();
    assert!(
        f.call(Request::Plan {
            source_database: Some(f.old.clone()),
            proof: None
        })
        .unwrap_err()
        .contains("終了")
    );
    drop(conn);
}

#[cfg(windows)]
#[tokio::test]
async fn original_database_is_rechecked_and_frozen_until_application() {
    let mut f = Fixture::new().await;
    f.copy_app();
    let plan = f.plan();
    let before = f.binding_path();
    let old = Connection::open(&f.old).unwrap();
    old.query_row("SELECT count(*) FROM application_settings", [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap();
    assert!(
        f.call(Request::Apply { plan: plan.clone() })
            .unwrap_err()
            .contains("終了")
    );
    old.execute(
        "UPDATE application_settings SET setting_value='updated after plan'",
        [],
    )
    .unwrap();
    drop(old);
    assert!(
        f.call(Request::Apply { plan })
            .unwrap_err()
            .contains("元DB")
    );
    assert_eq!(f.binding_path(), before);
}

#[tokio::test]
async fn changed_schema_and_unrelated_proof_keys_never_bypass_normal_catalog_checks() {
    let mut f = Fixture::new().await;
    let proof = f._root.path().join("proof.json");
    f.call(Request::Prepare {
        output: proof.clone(),
    })
    .unwrap();
    f.copy_app();
    let before = f.binding_path();
    let original_key = f.settings.tile_settings_encryption_key.clone();
    f.settings.tile_settings_encryption_key =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [7u8; 32]);
    f.save();
    assert!(
        f.call(Request::Plan {
            source_database: None,
            proof: Some(proof)
        })
        .is_err()
    );
    f.settings.tile_settings_encryption_key = original_key;
    f.save();
    let plan = f.plan();
    let conn = Connection::open(&f.settings.tile_catalog_database_path).unwrap();
    conn.execute(
        "CREATE INDEX forged_catalog_index ON local_tile_jobs(state)",
        [],
    )
    .unwrap();
    drop(conn);
    assert!(
        f.call(Request::Apply { plan })
            .unwrap_err()
            .contains("schema")
    );
    assert_eq!(f.binding_path(), before);
}

#[tokio::test]
async fn expired_authentic_plan_and_pre_cancelled_request_make_no_binding_changes() {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    let mut f = Fixture::new().await;
    f.copy_app();
    let before = f.binding_path();
    let mut plan = f.plan();
    plan.payload.created -= 1800;
    plan.payload.expires -= 1800;
    let master = base64::engine::general_purpose::STANDARD
        .decode(&f.settings.tile_settings_encryption_key)
        .unwrap();
    let mut derive = Hmac::<Sha256>::new_from_slice(&master).unwrap();
    derive.update(b"geocode-catalog-relocation-key-v1");
    let mut mac = Hmac::<Sha256>::new_from_slice(&derive.finalize().into_bytes()).unwrap();
    mac.update(b"plan\0");
    mac.update(&serde_json::to_vec(&plan.payload).unwrap());
    plan.signature = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect();
    assert!(
        f.call(Request::Apply { plan })
            .unwrap_err()
            .contains("計画")
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert!(
        rebind::execute(
            &f.config,
            Request::Plan {
                source_database: Some(f.old.clone()),
                proof: None
            },
            &cancellation,
            &mut |_, _| Ok(())
        )
        .is_err()
    );
    assert_eq!(f.binding_path(), before);
}

#[tokio::test]
async fn cli_inspects_and_applies_signed_plans_without_a_server_or_configuration_writes() {
    use process_output::CommandTestExt;
    let mut f = Fixture::new().await;
    f.copy_app();
    let config = fs::read(&f.config).unwrap();
    let contents = f.contents();
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_geocode_web_single"));
    let call = |words: &[&str]| {
        std::process::Command::new(&exe)
            .args(["local-tiles", "catalog", "rebind"])
            .args(words)
            .args(["--config", f.config.to_str().unwrap(), "--json"])
            .output_with_timeout(std::time::Duration::from_secs(30))
            .unwrap()
    };
    let inspect = call(&["inspect"]);
    assert!(
        inspect.status.success(),
        "{}",
        String::from_utf8_lossy(&inspect.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&inspect.stdout).unwrap()["binding_matches"],
        false
    );
    let planned = call(&["plan", "--source-database", f.old.to_str().unwrap()]);
    assert!(
        planned.status.success(),
        "{}",
        String::from_utf8_lossy(&planned.stderr)
    );
    let plan = f._root.path().join("plan.json");
    fs::write(&plan, planned.stdout).unwrap();
    #[cfg(windows)]
    {
        let helper =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/rebind-local-tile-catalog.ps1");
        let helper_plan = f._root.path().join("PowerShell 計画.json");
        let shell = |mode: &str| {
            std::process::Command::new("powershell.exe")
                // 検証用の子プロセスだけでローカルスクリプトを許可し、永続ポリシーは変更しない。
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "RemoteSigned",
                    "-File",
                ])
                .arg(&helper)
                .arg("-Executable")
                .arg(&exe)
                .arg("-ConfigFile")
                .arg(&f.config)
                .args(["-Mode", mode, "-OriginalDatabase"])
                .arg(&f.old)
                .arg("-PlanFile")
                .arg(&helper_plan)
                .output_with_timeout(std::time::Duration::from_secs(30))
                .unwrap()
        };
        let result = shell("Plan");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let preserved = fs::read(&helper_plan).unwrap();
        assert!(rebind::read_document::<Signed<Plan>>(&helper_plan).is_ok());
        assert!(!shell("Plan").status.success());
        assert_eq!(fs::read(&helper_plan).unwrap(), preserved);
    }
    let result = call(&["apply", "--plan", plan.to_str().unwrap()]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&result.stdout).unwrap()["state"],
        "succeeded"
    );
    assert_eq!(fs::read(&f.config).unwrap(), config);
    assert_eq!(f.contents(), contents);
    assert!(
        !call(&["apply", "--plan", plan.to_str().unwrap(), "--force"])
            .status
            .success()
    );
}

#[cfg(windows)]
#[tokio::test]
async fn gui_backend_can_diagnose_mismatch_and_worker_finishes_after_manager_is_dropped() {
    use geocode_web_single::tile_manager::Manager;
    let mut f = Fixture::new().await;
    f.copy_app();
    let contents = f.contents();
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_geocode_web_single"));
    let manager = Manager::new(f.config.clone(), exe.clone());
    let snapshot = manager.snapshot().await.unwrap();
    assert_eq!(snapshot["rebind"]["binding_matches"], false);
    let plan = manager
        .query("rebind_plan", json!({"source_database":f.old,"proof":null}))
        .await
        .unwrap();
    let mut cleanup = worker_cleanup::WorkerCleanup::new(&f.config, &exe).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    cleanup
        .submit(
            &manager,
            "rebind",
            json!({"kind":"apply","plan":plan}),
            id.clone(),
        )
        .await
        .unwrap();
    drop(manager);
    let reconnect = Manager::new(f.config.clone(), exe);
    let terminal = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let snapshot = reconnect.snapshot().await.unwrap();
            if let Some(receipt) = snapshot["requests"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == id)
            {
                if !matches!(
                    receipt["state"].as_str(),
                    Some("starting" | "running" | "accepted")
                ) {
                    break receipt.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    cleanup.finish().unwrap();
    assert_eq!(terminal["state"], "succeeded", "{terminal}");
    assert_eq!(f.contents(), contents);
    assert_eq!(
        reconnect.query("rebind_inspect", json!({})).await.unwrap()["binding_matches"],
        true
    );
    assert!(
        reconnect
            .query("rebind_inspect", json!({"skip_checks":true}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn interrupted_incremental_backup_releases_handles_and_allows_a_new_plan() {
    let mut f = Fixture::new().await;
    let cat = Connection::open(&f.settings.tile_catalog_database_path).unwrap();
    cat.execute("UPDATE local_tile_jobs SET progress_json=json_object('padding',lower(hex(zeroblob(300000))))",[]).unwrap();
    drop(cat);
    f.copy_app();
    let before = f.binding_path();
    let contents = f.contents();
    let plan = f.plan();
    let mut interrupted = false;
    let result = rebind::execute(
        &f.config,
        Request::Apply { plan },
        &CancellationToken::new(),
        &mut |stage, completed| {
            if stage == "backup" && completed > 0 {
                interrupted = true;
                Err("simulated backup interruption".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(interrupted);
    assert!(result.is_err());
    assert_eq!(f.binding_path(), before);
    assert_eq!(f.contents(), contents);
    f.call(Request::Apply { plan: f.plan() }).unwrap();
    assert_eq!(f.contents(), contents);
}

#[tokio::test]
async fn work_directory_move_keeps_gui_receipts_logs_and_all_catalog_jobs() {
    use geocode_web_single::tile_manager::Manager;
    let mut f = Fixture::new().await;
    let id = uuid::Uuid::new_v4().to_string();
    let namespace = format!(
        "{:x}",
        Sha256::digest(
            f.config
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_bytes()
        )
    );
    let old_root = PathBuf::from(&f.settings.tile_work_path)
        .join("tile-manager")
        .join(&namespace);
    fs::create_dir_all(&old_root).unwrap();
    let request = json!({"version":1,"id":id,"config_path":f.config.canonicalize().unwrap(),
        "config_sha256":"previous-settings","executable":std::env::current_exe().unwrap(),"executable_sha256":"previous-exe",
        "operation":{"action":"resume","payload":{"job":"completed"}}});
    let receipt = json!({"id":id,"action":"resume","request_sha256":"preserved","state":"succeeded","job_id":"completed",
        "result":{"state":"succeeded"},"error":null,"log_path":old_root.join(format!("{id}.log")),
        "created_at":"2026-11-15T00:00:00Z","updated_at":"2026-11-15T00:01:00Z","worker_pid":null});
    let request_bytes = serde_json::to_vec(&request).unwrap();
    let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
    fs::write(old_root.join(format!("{id}.request.json")), &request_bytes).unwrap();
    fs::write(old_root.join(format!("{id}.receipt.json")), &receipt_bytes).unwrap();
    fs::write(old_root.join(format!("{id}.log")), "historical log 日本語").unwrap();
    fs::write(
        old_root.join("requests.json"),
        serde_json::to_vec(&vec![&id]).unwrap(),
    )
    .unwrap();
    let new_work = f._root.path().join("moved-work");
    fs::rename(&f.settings.tile_work_path, &new_work).unwrap();
    f.settings.tile_work_path = new_work.to_string_lossy().into_owned();
    f.copy_app();
    let contents = f.contents();
    f.call(Request::Apply { plan: f.plan() }).unwrap();
    let manager = Manager::new(f.config.clone(), std::env::current_exe().unwrap());
    let snapshot = manager.snapshot().await.unwrap();
    assert_eq!(snapshot["requests"][0]["id"], id);
    assert_eq!(snapshot["requests"][0]["state"], "succeeded");
    let log = manager
        .query("log", json!({"request_id":id}))
        .await
        .unwrap();
    assert!(log.to_string().contains("historical log"));
    let new_root = new_work.join("tile-manager").join(namespace);
    assert_eq!(
        fs::read(new_root.join(format!("{id}.request.json"))).unwrap(),
        request_bytes
    );
    assert_eq!(
        fs::read(new_root.join(format!("{id}.receipt.json"))).unwrap(),
        receipt_bytes
    );
    assert_eq!(f.contents(), contents);
}
