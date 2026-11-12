//! 明示指定した配布用exeのCLIだけを子プロセスで実行し、標準地図の経路を確認する。

#[path = "standard_tile_fixture/mod.rs"]
mod fixture;

use std::{
    cell::Cell,
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

use geocode_web_single::{
    db::run_migrations,
    local_tiles::config::LocalTileConfig,
    tilegen::{
        cancel::CancellationToken,
        dataset::{Dataset, RenderOptions},
        import::{self, ImportOptions, MissingNodes},
        render_spec::RenderSpec,
        tile::TileId,
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

struct Executable {
    path: PathBuf,
    root: PathBuf,
    settings: PathBuf,
    sequence: Cell<u32>,
    timeout: Duration,
}

/// 長時間ジョブの失敗時も、標準出力へ診断履歴全体を複製しない。
fn output_tail(path: &Path) -> String {
    let result = (|| -> std::io::Result<String> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        let limit = 16 * 1024;
        if length > limit {
            file.seek(SeekFrom::End(-(limit as i64)))?;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(format!(
            "{}（末尾最大16KiB）\n{}",
            path.display(),
            String::from_utf8_lossy(&bytes)
        ))
    })();
    result.unwrap_or_else(|error| format!("{}: {error}", path.display()))
}

fn input_snapshot(roots: &[&Path]) -> BTreeMap<PathBuf, (u64, SystemTime, [u8; 32])> {
    let mut pending = roots
        .iter()
        .map(|path| path.to_path_buf())
        .collect::<Vec<_>>();
    let mut result = BTreeMap::new();
    let mut buffer = [0_u8; 64 * 1024];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).unwrap();
        assert!(!metadata.file_type().is_symlink());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(
                metadata.file_attributes() & 0x400,
                0,
                "入力のリンクは指定できません"
            );
        }
        if metadata.is_dir() {
            pending.extend(
                fs::read_dir(&path)
                    .unwrap()
                    .map(|entry| entry.unwrap().path()),
            );
        } else {
            assert!(metadata.is_file());
            let mut file = File::open(&path).unwrap();
            let mut hash = Sha256::new();
            loop {
                let read = file.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                hash.update(&buffer[..read]);
            }
            result.insert(
                path,
                (
                    metadata.len(),
                    metadata.modified().unwrap(),
                    hash.finalize().into(),
                ),
            );
        }
    }
    result
}
impl Executable {
    fn run(&self, args: &[&str]) -> Value {
        let sequence = self.sequence.get();
        self.sequence.set(sequence + 1);
        let stdout = self.root.join(format!("cli-{sequence:03}.stdout.json"));
        let stderr = self.root.join(format!("cli-{sequence:03}.stderr.txt"));
        let mut command = Command::new(&self.path);
        command
            .arg("local-tiles")
            .args(args)
            .arg("--config")
            .arg(&self.settings)
            .arg("--json")
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(File::create(&stdout).unwrap())
            .stderr(File::create(&stderr).unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().expect("指定した配布exeを起動できません");
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() > self.timeout {
                let _ = child.kill();
                let _ = child.wait();
                panic!(
                    "CLI子プロセスが制限時間を超えました: {:?}\n{}",
                    args,
                    output_tail(&stderr)
                );
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert!(
            status.success(),
            "CLI失敗: {args:?}, code={:?}\n標準出力={}\n診断={}",
            status.code(),
            output_tail(&stdout),
            output_tail(&stderr)
        );
        serde_json::from_slice(&fs::read(&stdout).unwrap())
            .expect("実exeの標準出力がJSONではありません")
    }
}

fn write_settings(root: &Path, database: &Path, config: &LocalTileConfig) -> PathBuf {
    let path = root.join("geocode-web-single.env.json");
    fs::write(&path,serde_json::to_vec_pretty(&json!({
        "app_title":"標準地図の実exe試験","access_token_exp_minutes":"30","refresh_token_exp_minutes":"60",
        "secret_key":"isolated-executable-test-key","admin_username":"fixture-admin","admin_passwotd":"isolated-executable-test-password",
        "failed_account_lock":"5","next_challenge_minutes":"5","challenge_limit_time_failed_count":"3",
        "sqlite_database_path":database,"database_url":format!("sqlite:{}",database.display()),
        "tile_catalog_database_path":config.catalog_database_path,"tile_dataset_path":config.dataset_path,
        "tile_cache_path":config.cache_path,"tile_work_path":config.work_path,"local_tile_workers":"1"
    })).unwrap()).unwrap();
    path
}

fn bbox(tile: TileId) -> String {
    let bounds = tile.bounds();
    let x = (bounds.min_x + bounds.max_x) / 2.0;
    let y = (bounds.min_y + bounds.max_y) / 2.0;
    let lon = x * 360.0 - 180.0;
    let lat = libm::atan(libm::sinh(std::f64::consts::PI * (1.0 - 2.0 * y))) * 180.0
        / std::f64::consts::PI;
    format!(
        "{},{},{},{}",
        lon - 0.0000001,
        lat - 0.0000001,
        lon + 0.0000001,
        lat + 0.0000001
    )
}

fn cache_path(config: &LocalTileConfig, id: &str, render: &str, tile: TileId) -> PathBuf {
    config
        .cache_path
        .join(id)
        .join(render)
        .join(tile.z.to_string())
        .join(tile.x.to_string())
        .join(format!("{}.png", tile.y))
}

fn assert_pixels(dataset: &Dataset, cache: &Path, tile: TileId) {
    assert_pixels_with_options(dataset, cache, tile, RenderOptions::default());
}

fn assert_pixels_with_options(
    dataset: &Dataset,
    cache: &Path,
    tile: TileId,
    options: RenderOptions,
) {
    let mut session = dataset.create_session(options).unwrap();
    let sdk = session.render(tile, &CancellationToken::new()).unwrap();
    let generated =
        image::load_from_memory(&fs::read(cache).expect("実exeがPNGを保存しませんでした"))
            .unwrap()
            .to_rgba8();
    assert_eq!(generated.dimensions(), (256, 256));
    assert_eq!(
        generated.as_raw().as_slice(),
        sdk.image.rgba(),
        "実exeと試験用SDKの画素が異なります: {tile:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn 指定した配布用実行ファイルで地形生成と背景登録と再開が完結する() {
    verify_offline_executable("standard-v1", 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn 指定した配布用実行ファイルで新形式を取り込み原資料削除後も別設定で生成する() {
    verify_offline_executable("standard-v2", 3).await;
}

async fn verify_offline_executable(features: &str, schema: u32) {
    let Some(path) = std::env::var_os("GEOCODE_TEST_CLI_EXE") else {
        eprintln!("GEOCODE_TEST_CLI_EXE未指定のため、配布用実exeの検証をスキップします。");
        return;
    };
    let executable = PathBuf::from(path)
        .canonicalize()
        .expect("GEOCODE_TEST_CLI_EXEのファイルがありません");
    let executable_hash = Sha256::digest(fs::read(&executable).unwrap());
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path();
    let database = root_path.join("application.sqlite");
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&database)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    pool.close().await;
    let config = LocalTileConfig::defaults(root_path);
    let settings = write_settings(root_path, &database, &config);
    let settings_before = fs::read(&settings).unwrap();
    let cli = Executable {
        path: executable.clone(),
        root: root_path.to_owned(),
        settings,
        sequence: Cell::new(0),
        timeout: Duration::from_secs(60),
    };
    let build = cli.run(&["build-info"]);
    assert_eq!(build["execution"]["verified"], true, "{build}");
    assert_eq!(build["standard_generation_verified"], true, "{build}");
    assert_eq!(build["render_contract"]["identity_version"], 2);
    assert_eq!(build["standard_render_contract"]["identity_version"], 3);
    if schema == 3 {
        assert_eq!(build["osm_generation_verified"], true, "{build}");
        assert_eq!(build["osm_render_contract"]["identity_version"], 4);
    }

    let pbf = root_path.join("道路と建物.osm.pbf");
    let dem_directory = root_path.join("混在する地表標高");
    fs::create_dir(&dem_directory).unwrap();
    let dem = dem_directory.join("jgd2000.xml");
    fixture::write_inputs(&pbf, &dem);
    let original = fs::read_to_string(&dem).unwrap();
    fs::write(&dem, original.replace("jgd2024.bl", "jgd2000.bl")).unwrap();
    // 隣接する格子を別の原CRSにし、両資料からセルが採用されるようにする。
    let west = 139.7 - 4.0 / 3600.0;
    let east = 139.7 + 4.0 / 3600.0;
    let next_east = east + 8.0 / 3600.0;
    let adjacent_dem = dem_directory.join("jgd2011.xml");
    let adjacent_xml = original
        .replace("jgd2024.bl", "jgd2011.bl")
        .replace(
            &format!(" {west:.15}</gml:lowerCorner>"),
            &format!(" {east:.15}</gml:lowerCorner>"),
        )
        .replace(
            &format!(" {east:.15}</gml:upperCorner>"),
            &format!(" {next_east:.15}</gml:upperCorner>"),
        );
    fs::write(&adjacent_dem, adjacent_xml).unwrap();
    let inspected = cli.run(&[
        "elevation",
        "inspect",
        "--input",
        dem_directory.to_str().unwrap(),
        "--elevation-datum-policy",
        "allow-jgd2000-2011",
    ]);
    assert_eq!(inspected["allowed"], true, "{inspected}");
    assert_eq!(inspected["validation_scope"], "header-only");
    let legacy_path = root_path.join("legacy-roads.sqlite");
    let legacy = import::run(&ImportOptions {
        input: pbf.clone(),
        store: legacy_path.clone(),
        work_dir: root_path.join("legacy-work"),
        missing_nodes: MissingNodes::Error,
    })
    .unwrap();
    let legacy_before = fs::read(&legacy_path).unwrap();
    let legacy_registered = cli.run(&[
        "datasets",
        "register",
        "--database",
        legacy_path.to_str().unwrap(),
        "--name",
        "旧道路の共存",
    ]);
    assert_eq!(legacy_registered["id"], legacy.metadata.dataset_id);
    let imported = cli.run(&[
        "import",
        "--input",
        pbf.to_str().unwrap(),
        "--name",
        "建物と陰影と等高線",
        "--features",
        features,
        "--elevation-input",
        dem_directory.to_str().unwrap(),
        "--elevation-datum-policy",
        "allow-jgd2000-2011",
    ]);
    assert_eq!(imported["state"], "succeeded", "{imported}");
    let import_job = imported["id"].as_str().unwrap().to_owned();
    let id = imported["progress"]["dataset"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(id, legacy.metadata.dataset_id);
    let shown = cli.run(&["datasets", "show", "--dataset", &id]);
    assert_eq!(shown["info"]["schema_version"], schema);
    assert_eq!(
        shown["info"]["details"]["elevation"]["mixed_coordinate_systems"],
        true
    );
    let prepared = cli.run(&["datasets", "prepare", "--dataset", &id]);
    let render = prepared["render_id"].as_str().unwrap().to_owned();
    let url = cli.run(&["url", "--dataset", &id, "--render", &render]);
    assert_eq!(url["kind"], "raster");
    assert!(url["attribution"].as_str().unwrap().contains("国土地理院"));
    let relative = PathBuf::from(shown["database_path"].as_str().unwrap());
    let completed = if relative.is_absolute() {
        relative
    } else {
        config.dataset_path.join(relative)
    };
    let dataset = Dataset::open(&completed).unwrap();
    assert_eq!(dataset.info().dataset_id, id);
    let tile = TileId::from_lon_lat(18, 139.7, 35.7).unwrap();
    let first_bbox = bbox(tile);
    let zoom = tile.z.to_string();
    let plan = cli.run(&[
        "precompute",
        "plan",
        "--dataset",
        &id,
        "--render",
        &render,
        "--bbox",
        &first_bbox,
        "--min-zoom",
        &zoom,
        "--max-zoom",
        &zoom,
    ]);
    assert_eq!(plan["total_tiles"], 1);
    let generated = cli.run(&[
        "precompute",
        "run",
        "--dataset",
        &id,
        "--render",
        &render,
        "--bbox",
        &first_bbox,
        "--min-zoom",
        &zoom,
        "--max-zoom",
        &zoom,
    ]);
    assert_eq!(generated["state"], "succeeded", "{generated}");
    assert_eq!(generated["progress"]["completed"], 1);
    let first_png = cache_path(&config, &id, &render, tile);
    let first_bytes = fs::read(&first_png).unwrap();
    assert_pixels(&dataset, &first_png, tile);
    let background = cli.run(&["background", "add", "--dataset", &id, "--render", &render]);
    let app = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (kind, saved_url, attribution): (String, String, String) = app
        .query_row(
            "SELECT kind,url,attribution FROM tileserver_model WHERE id=?",
            [background["id"].as_i64().unwrap()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(kind, "raster");
    assert_eq!(saved_url, url["relative_url"].as_str().unwrap());
    assert!(attribution.contains("国土地理院"));
    drop(app);
    let before = cli.run(&["jobs", "show", "--job", &import_job]);
    fs::remove_file(&pbf).unwrap();
    fs::remove_file(&dem).unwrap();
    fs::remove_file(&adjacent_dem).unwrap();
    let next_render = if schema == 3 {
        let terrain = cli.run(&[
            "datasets",
            "prepare",
            "--dataset",
            &id,
            "--contours",
            "on",
            "--hillshade",
            "on",
        ]);
        let generation = terrain["render_id"].as_str().unwrap().to_owned();
        assert_ne!(generation, render);
        generation
    } else {
        render.clone()
    };
    let next_options = if schema == 3 {
        RenderOptions::with_spec(RenderSpec {
            contours: true,
            hillshade: true,
            ..RenderSpec::osm_like()
        })
    } else {
        RenderOptions::default()
    };
    let adjacent = TileId::new(tile.z, tile.x + 1, tile.y).unwrap();
    let adjacent_bbox = bbox(adjacent);
    let adjacent_png = cache_path(&config, &id, &next_render, adjacent);
    assert!(!adjacent_png.exists());
    let generated = cli.run(&[
        "precompute",
        "run",
        "--dataset",
        &id,
        "--render",
        &next_render,
        "--bbox",
        &adjacent_bbox,
        "--min-zoom",
        &zoom,
        "--max-zoom",
        &zoom,
    ]);
    assert_eq!(generated["state"], "succeeded", "{generated}");
    assert_eq!(generated["progress"]["reused_tiles"], 0);
    assert_pixels_with_options(&dataset, &adjacent_png, adjacent, next_options);
    let resumed = cli.run(&[
        "precompute",
        "resume",
        "--job",
        generated["id"].as_str().unwrap(),
    ]);
    assert_eq!(resumed["state"], "succeeded");
    assert_eq!(resumed["progress"]["reused_tiles"], 1);
    let after = cli.run(&["jobs", "show", "--job", &import_job]);
    assert_eq!(before, after);
    let history = cli.run(&["jobs", "list", "--limit", "20"]);
    assert_eq!(history.as_array().unwrap().len(), 4);
    let datasets = cli.run(&["datasets", "list"]);
    assert_eq!(datasets.as_array().unwrap().len(), 2);
    assert_eq!(fs::read(&legacy_path).unwrap(), legacy_before);
    assert_eq!(fs::read(&first_png).unwrap(), first_bytes);
    assert_eq!(fs::read(&cli.settings).unwrap(), settings_before);
    assert_eq!(
        Sha256::digest(fs::read(&executable).unwrap()),
        executable_hash
    );
}

/// 実資料は環境変数で明示指定し、生成物をworkspaceの隔離領域へ残す。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "実PBF・DEM・陸域を明示して、長時間の取り込みと画素照合を行う"]
async fn 指定した実資料の混在標高を隔離領域へ取り込み背景と画像を検証する() {
    if let Some(root) = std::env::var_os("GEOCODE_REAL_REUSE_ROOT") {
        verify_existing_real_dataset(PathBuf::from(root));
        return;
    }
    let started = Instant::now();
    fn required(name: &str) -> PathBuf {
        PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name}が必要です")))
            .canonicalize()
            .unwrap_or_else(|error| panic!("{name}: {error}"))
    }
    let executable = required("GEOCODE_TEST_CLI_EXE");
    let pbf = required("GEOCODE_REAL_PBF");
    let dem = required("GEOCODE_REAL_DEM");
    let land = required("GEOCODE_REAL_LANDMASK");
    let protected = [&*pbf, &*dem, land.parent().unwrap()];
    let input_before = input_snapshot(&protected);
    let modern = std::env::var("GEOCODE_REAL_FEATURES").as_deref() == Ok("standard-v2");
    let features = if modern { "standard-v2" } else { "standard-v1" };
    let verification = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if modern {
        "target/osm-style-verification"
    } else {
        "target/mixed-dem-verification"
    });
    fs::create_dir_all(&verification).unwrap();
    let root = verification.join(format!("real-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    fs::write(
        verification.join("last-real-run.json"),
        serde_json::to_vec_pretty(&json!({"root":root})).unwrap(),
    )
    .unwrap();
    println!("実資料試験の保存先: {}", root.display());
    let app_database = root.join("application.sqlite");
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&app_database)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    pool.close().await;
    drop(pool);
    let config = LocalTileConfig::defaults(&root);
    let settings = write_settings(&root, &app_database, &config);
    let settings_before = fs::read(&settings).unwrap();
    let cli = Executable {
        path: executable,
        root: root.clone(),
        settings,
        sequence: Cell::new(0),
        timeout: Duration::from_secs(3600),
    };
    let inspected = cli.run(&[
        "elevation",
        "inspect",
        "--input",
        dem.to_str().unwrap(),
        "--elevation-datum-policy",
        "allow-jgd2000-2011",
    ]);
    assert_eq!(inspected["allowed"], true, "{inspected}");
    assert_eq!(inspected["mixed_input_coordinate_systems"], true);
    let build = cli.run(&["build-info"]);
    assert_eq!(build["standard_generation_verified"], true, "{build}");
    if modern {
        assert_eq!(build["osm_generation_verified"], true, "{build}");
    }
    let imported = cli.run(&[
        "import",
        "--input",
        pbf.to_str().unwrap(),
        "--name",
        "実資料・建物と名称と混在標高",
        "--features",
        features,
        "--elevation-input",
        dem.to_str().unwrap(),
        "--elevation-datum-policy",
        "allow-jgd2000-2011",
        "--landmask-input",
        land.to_str().unwrap(),
        "--invalid-areas",
        "skip-feature",
    ]);
    assert_eq!(imported["state"], "succeeded", "{imported}");
    let id = imported["dataset_id"].as_str().unwrap();
    let shown = cli.run(&["datasets", "show", "--dataset", id]);
    let details = &shown["info"]["details"];
    assert!(details["counts"]["building"].as_u64().unwrap() > 0);
    assert_eq!(
        details["elevation"]["source_coordinate_systems"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(details["elevation"]["ground_cells"].as_u64().unwrap() > 0);
    assert!(details["elevation"]["contour_features"].as_u64().unwrap() > 0);
    if modern {
        assert!(
            details["labels"]["count"].as_u64().unwrap() > 0,
            "{details}"
        );
        assert_eq!(shown["info"]["schema_version"], 3);
    }
    let prepared = cli.run(&["datasets", "prepare", "--dataset", id]);
    let render = prepared["render_id"].as_str().unwrap();
    let mut profiles = vec![("通常地図", render.to_owned(), RenderOptions::default())];
    if modern {
        for (name, args, spec) in [
            (
                "地形付き",
                vec!["--contours", "on", "--hillshade", "on"],
                RenderSpec {
                    contours: true,
                    hillshade: true,
                    ..RenderSpec::osm_like()
                },
            ),
            (
                "道路なし",
                vec!["--roads", "off"],
                RenderSpec {
                    roads: false,
                    ..RenderSpec::osm_like()
                },
            ),
        ] {
            let mut command = vec!["datasets", "prepare", "--dataset", id];
            command.extend(args);
            let profile = cli.run(&command);
            let profile_id = profile["render_id"].as_str().unwrap().to_owned();
            assert_ne!(profile_id, render);
            profiles.push((name, profile_id, RenderOptions::with_spec(spec)));
        }
    }
    let database_path = PathBuf::from(shown["database_path"].as_str().unwrap());
    let completed = if database_path.is_absolute() {
        database_path
    } else {
        config.dataset_path.join(database_path)
    };
    let dataset = Dataset::open(&completed).unwrap();
    let mut verified_names = Vec::new();
    if modern {
        // 本体とは別のPBF読取器で、実資料の名称を完成DBと照合する。
        let conn = rusqlite::Connection::open_with_flags(
            &completed,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut statement = conn.prepare("SELECT osm_id,names FROM map_labels WHERE osm_type=0 AND (names LIKE '%高知%' OR names LIKE '%石鎚%') ORDER BY importance DESC,osm_id LIMIT 12").unwrap();
        let expected = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .map(|row| {
                let (id, names) = row.unwrap();
                (
                    id,
                    serde_json::from_str::<BTreeMap<String, String>>(&names).unwrap(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert!(!expected.is_empty(), "実資料の代表名称が収録されていません");
        let mut remaining = expected.clone();
        let mut reader = osmpbfreader::OsmPbfReader::new(File::open(&pbf).unwrap());
        for object in reader.iter() {
            let osmpbfreader::OsmObj::Node(node) = object.unwrap() else {
                continue;
            };
            let Some(names) = remaining.remove(&node.id.0) else {
                continue;
            };
            for (key, name) in &names {
                assert_eq!(
                    node.tags.get(key.as_str()).map(|s| s.trim()),
                    Some(name.as_str()),
                    "実PBFと完成DBの名称が一致しません: {} / {key}",
                    node.id.0
                );
            }
            verified_names.push(json!({"osm_type":"node","osm_id":node.id.0,"names":names}));
            if remaining.is_empty() {
                break;
            }
        }
        assert!(
            remaining.is_empty(),
            "完成DBの名称に対応する元Nodeが見つかりません"
        );
    }
    let mut images = Vec::new();
    let mut backgrounds = Vec::new();
    for (profile_name, render, options) in &profiles {
        assert_eq!(
            geocode_web_single::tilegen::identity::render_id(
                &dataset.info().dataset_id,
                &dataset.render_contract_for(options).unwrap()
            ),
            *render
        );
        let mut cases = vec![
            ("高知市街", 15, 133.5311, 33.5597),
            ("四国山地", 13, 133.2, 33.8),
        ];
        if modern && *profile_name == "通常地図" {
            cases.extend([
                ("四国全域", 6, 133.3, 33.6),
                ("四国広域", 10, 133.3, 33.6),
                ("高知駅", 16, 133.5438, 33.5666),
                ("高知城", 17, 133.5313, 33.5604),
            ]);
        }
        for (name, zoom, lon, lat) in cases {
            let tile = TileId::from_lon_lat(zoom, lon, lat).unwrap();
            let bounds = bbox(tile);
            let zoom = zoom.to_string();
            let generated = cli.run(&[
                "precompute",
                "run",
                "--dataset",
                id,
                "--render",
                render.as_str(),
                "--bbox",
                &bounds,
                "--min-zoom",
                &zoom,
                "--max-zoom",
                &zoom,
                "--max-tiles",
                "10",
            ]);
            assert_eq!(generated["state"], "succeeded", "{generated}");
            let png = cache_path(&config, id, render, tile);
            assert_pixels_with_options(&dataset, &png, tile, *options);
            let preview = root.join(format!("{profile_name}-{name}.png"));
            fs::copy(&png, &preview).unwrap();
            images.push(json!({"name":name,"profile":profile_name,"render_id":render,"tile":{"z":tile.z,"x":tile.x,"y":tile.y},"path":preview}));
        }
        let background = cli.run(&[
            "background",
            "add",
            "--dataset",
            id,
            "--render",
            render,
            "--name",
            profile_name,
        ]);
        assert!(!background.is_null());
        backgrounds.push(background);
    }
    assert_eq!(fs::read(&cli.settings).unwrap(), settings_before);
    assert_eq!(
        input_snapshot(&protected),
        input_before,
        "入力資料が変更されました"
    );
    fs::write(
        root.join("verification.json"),
        serde_json::to_vec_pretty(&json!({
        "dataset_id":id,"render_id":render,"build":build,"inspection":inspected,
        "dataset":shown,"backgrounds":backgrounds,"images":images,
        "names_verified_with_independent_pbf_reader":verified_names,
        "elapsed_seconds":started.elapsed().as_secs_f64(),"database_bytes":fs::metadata(&completed).unwrap().len(),
        "input_files_verified_unchanged":input_before.len(),
        }))
        .unwrap(),
    )
    .unwrap();
    println!(
        "実資料の取り込みと画素照合が完了しました: {}",
        root.display()
    );
}

/// 描画だけを変更した場合は、完成済みの実資料DBを再利用してexeとSDKを照合する。
fn verify_existing_real_dataset(root: PathBuf) {
    let started = Instant::now();
    let root = root.canonicalize().unwrap();
    let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/osm-style-verification")
        .canonicalize()
        .unwrap();
    assert!(
        root.starts_with(allowed),
        "実資料の再検証は隔離領域内だけを対象にします"
    );
    let record_path = root.join("verification.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    let archive = root.join("verification-before-low-zoom-adjustment.json");
    if !archive.exists() {
        fs::copy(&record_path, &archive).unwrap();
    }
    let imported: Value = serde_json::from_slice(&fs::read(&archive).unwrap()).unwrap();
    let cli = Executable {
        path: PathBuf::from(std::env::var_os("GEOCODE_TEST_CLI_EXE").unwrap())
            .canonicalize()
            .unwrap(),
        settings: root.join("geocode-web-single.env.json"),
        root: root.clone(),
        sequence: Cell::new(100),
        timeout: Duration::from_secs(300),
    };
    let settings_before = fs::read(&cli.settings).unwrap();
    let config = LocalTileConfig::defaults(&root);
    let id = record["dataset_id"].as_str().unwrap().to_owned();
    let shown = cli.run(&["datasets", "show", "--dataset", &id]);
    let path = PathBuf::from(shown["database_path"].as_str().unwrap());
    let completed = if path.is_absolute() {
        path
    } else {
        config.dataset_path.join(path)
    };
    let before = input_snapshot(&[&completed]);
    let dataset = Dataset::open(&completed).unwrap();
    let build = cli.run(&["build-info"]);
    assert_eq!(build["osm_generation_verified"], true, "{build}");
    let mut profiles = Vec::new();
    for (name, args, spec) in [
        ("通常地図", vec![], RenderSpec::osm_like()),
        (
            "地形付き",
            vec!["--contours", "on", "--hillshade", "on"],
            RenderSpec {
                contours: true,
                hillshade: true,
                ..RenderSpec::osm_like()
            },
        ),
        (
            "道路なし",
            vec!["--roads", "off"],
            RenderSpec {
                roads: false,
                ..RenderSpec::osm_like()
            },
        ),
    ] {
        let mut args_with_dataset = vec!["datasets", "prepare", "--dataset", &id];
        args_with_dataset.extend(args);
        let prepared = cli.run(&args_with_dataset);
        let render = prepared["render_id"].as_str().unwrap().to_owned();
        let options = RenderOptions::with_spec(spec);
        assert_eq!(
            render,
            geocode_web_single::tilegen::identity::render_id(
                &id,
                &dataset.render_contract_for(&options).unwrap()
            )
        );
        profiles.push((name, render, options));
    }
    assert_ne!(imported["render_id"].as_str().unwrap(), profiles[0].1);
    let mut images = Vec::new();
    let mut backgrounds = Vec::new();
    for (profile_name, render, options) in &profiles {
        let mut cases = vec![
            ("高知市街", 15, 133.5311, 33.5597),
            ("四国山地", 13, 133.2, 33.8),
        ];
        if *profile_name == "通常地図" {
            cases.extend([
                ("四国全域", 6, 133.3, 33.6),
                ("四国広域", 10, 133.3, 33.6),
                ("高知駅", 16, 133.5438, 33.5666),
                ("高知城", 17, 133.5313, 33.5604),
            ]);
        }
        for (name, zoom, lon, lat) in cases {
            let tile = TileId::from_lon_lat(zoom, lon, lat).unwrap();
            let bounds = bbox(tile);
            let zoom = zoom.to_string();
            let job = cli.run(&[
                "precompute",
                "run",
                "--dataset",
                &id,
                "--render",
                render,
                "--bbox",
                &bounds,
                "--min-zoom",
                &zoom,
                "--max-zoom",
                &zoom,
                "--max-tiles",
                "10",
            ]);
            assert_eq!(job["state"], "succeeded", "{job}");
            let png = cache_path(&config, &id, render, tile);
            assert_pixels_with_options(&dataset, &png, tile, *options);
            let preview = root.join(format!("最終-{profile_name}-{name}.png"));
            fs::copy(&png, &preview).unwrap();
            images.push(json!({"name":name,"profile":profile_name,"render_id":render,"tile":{"z":tile.z,"x":tile.x,"y":tile.y},"path":preview}));
        }
        backgrounds.push(cli.run(&[
            "background",
            "add",
            "--dataset",
            &id,
            "--render",
            render,
            "--name",
            &format!("最終・{profile_name}"),
        ]));
    }
    assert_eq!(
        input_snapshot(&[&completed]),
        before,
        "完成DBが変更されました"
    );
    assert_eq!(fs::read(&cli.settings).unwrap(), settings_before);
    record["import_build"] = imported["build"].clone();
    record["build"] = build;
    record["previous_render_id"] = imported["render_id"].clone();
    record["render_id"] = json!(profiles[0].1);
    record["images"] = json!(images);
    record["backgrounds"] = json!(backgrounds);
    record["dataset"] = cli.run(&["datasets", "show", "--dataset", &id]);
    record["render_recheck_elapsed_seconds"] = json!(started.elapsed().as_secs_f64());
    record["completed_database_verified_unchanged"] = json!(true);
    fs::write(&record_path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    println!(
        "完成DBを保持した描画再検証が完了しました: {}",
        root.display()
    );
}
