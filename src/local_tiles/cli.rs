//! ローカル地図を本体バイナリから操作するCLI。HTTP管理APIには依存しない。

use super::{
    LocalTiles,
    catalog::{self, DatasetRecord, JobRecord, TileCatalog},
    config::LocalTileConfig,
    jobs::{ImportRequest, PrecomputeRequest},
    profile,
    runtime::Failure,
    service::{execution_diagnostics, tile_url},
};
use crate::tilegen::cancel::CancellationToken;
use crate::tilegen::{
    operation::OperationContext,
    render_spec::{LabelLanguage, RenderSpec},
    standard::model::{ContourData, ElevationDatumPolicy},
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{collections::HashMap, fmt, path::PathBuf, sync::Arc, time::Duration};

#[derive(Debug, Clone)]
pub struct CliError {
    pub exit_code: i32,
    pub message: String,
}

impl CliError {
    pub fn new(exit_code: i32, message: impl Into<String>) -> Self {
        Self {
            exit_code,
            message: message.into(),
        }
    }
    fn usage(message: impl Into<String>) -> Self {
        Self::new(2, message)
    }
    fn missing(message: impl Into<String>) -> Self {
        Self::new(4, message)
    }
}
impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for CliError {}
impl From<Failure> for CliError {
    fn from(failure: Failure) -> Self {
        let code = match failure.status {
            404 => 4,
            499 => 130,
            503 if failure.message.contains("別") && failure.message.contains("プロセス") => 3,
            _ => 1,
        };
        Self::new(code, failure.message)
    }
}
fn catalog_error(error: impl fmt::Display) -> CliError {
    CliError::new(1, error.to_string())
}

#[derive(Debug, Clone)]
pub enum Command {
    Help,
    BuildInfo,
    ElevationInspect {
        input: PathBuf,
        policy: ElevationDatumPolicy,
    },
    ConfigShow,
    Status,
    DatasetsList,
    DatasetShow {
        dataset: String,
    },
    Register {
        database: PathBuf,
        name: String,
    },
    Prepare {
        dataset: String,
        spec: Option<RenderSpec>,
    },
    Retire {
        dataset: String,
    },
    Import(ImportRequest),
    Plan(PrecomputeRequest),
    Precompute(PrecomputeRequest),
    Resume {
        job: String,
    },
    JobsList {
        limit: i64,
        offset: i64,
    },
    JobShow {
        job: String,
    },
    Watch {
        job: String,
    },
    Cancel {
        job: String,
    },
    Url {
        dataset: String,
        render: Option<String>,
        base_url: Option<String>,
    },
    BackgroundAdd {
        dataset: String,
        render: Option<String>,
        name: Option<String>,
    },
    Scan,
    Cleanup {
        dataset: String,
        render: String,
    },
}

#[derive(Debug, Clone)]
pub struct Invocation {
    pub command: Command,
    pub json: bool,
    pub config_path: Option<PathBuf>,
}

impl Invocation {
    pub fn requires_database(&self) -> bool {
        !matches!(
            self.command,
            Command::Help
                | Command::BuildInfo
                | Command::ElevationInspect { .. }
                | Command::ConfigShow
        )
    }
    pub fn is_writer(&self) -> bool {
        matches!(
            self.command,
            Command::Register { .. }
                | Command::Prepare { .. }
                | Command::Retire { .. }
                | Command::Import(_)
                | Command::Precompute(_)
                | Command::Resume { .. }
                | Command::BackgroundAdd { .. }
                | Command::Cleanup { .. }
        )
    }
}

pub fn help_text() -> &'static str {
    "GeoCode-Web-Single ローカル地図CLI\n\n\
使用方法: geocode_web_single.exe local-tiles <コマンド> [オプション]\n\n\
  build-info / config show / status\n\
  elevation inspect --input ABSOLUTE_PATH [--elevation-datum-policy strict|allow-jgd2000-2011]\n\
  datasets list / show --dataset ID\n\
  datasets register --database PATH --name NAME\n\
  datasets prepare --dataset ID [--style osm-like-v1]\n\
    [--roads on|off] [--buildings on|off] [--contours on|off] [--hillshade on|off] [--labels on|off] [--language ja|local|en]\n\
  datasets retire --dataset ID\n\
  import --input PATH --name NAME [--missing-nodes error|skip-way] [--request-id ID]\n\
    [--features roads-v1|standard-v1|standard-v2] [--elevation-input ABSOLUTE_PATH] [--landmask-input ABSOLUTE_SHP]\n\
    [--contour-data on|off（standard-v2専用、既定on）]\n\
    [--invalid-areas error|skip-feature]\n\
    [--elevation-datum-policy strict|allow-jgd2000-2011]\n\
  precompute plan|run --dataset ID [--render ID] --bbox WEST,SOUTH,EAST,NORTH --min-zoom N --max-zoom N [--max-tiles N]\n\
  precompute resume --job ID\n\
  jobs list [--limit N --offset N] / show|watch|cancel --job ID\n\
  url --dataset ID [--render ID] [--base-url http://127.0.0.1:3000]\n\
  background add --dataset ID [--render ID] [--name NAME]\n\
  cache scan / cleanup --dataset ID --render ID\n\n\
共通: --config ABSOLUTE_JSON_PATH  --json  --help\n\
標高の検査は設定JSON・本体DB・生成認定なしで利用できます。\n\
取り込み・事前生成は完了まで待機します。Ctrl+Cは処理を安全に取り消します。\n\
writer操作時は同じcatalogを使うGUI・-sを停止してください。照会は実行中も利用できます。\n"
}

/// `local-tiles`より後ろの引数だけを解析し、設定やファイルを読み書きしない。
pub fn parse(args: &[String]) -> Result<Invocation, CliError> {
    let mut words = Vec::new();
    let mut options = HashMap::new();
    let mut json_output = false;
    let mut help = args.is_empty();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        match argument.as_str() {
            "--json" => {
                if json_output {
                    return Err(CliError::usage("--jsonが重複しています。"));
                }
                json_output = true;
            },
            "--help" | "-h" => help = true,
            value if value.starts_with("--") => {
                let (name, value) = if let Some((name, value)) = value.split_once('=') {
                    (name.to_owned(), value.to_owned())
                } else {
                    index += 1;
                    let value = args
                        .get(index)
                        .filter(|value| !value.starts_with("--"))
                        .ok_or_else(|| {
                            CliError::usage(format!("{argument}の値を指定してください。"))
                        })?;
                    (argument.clone(), value.clone())
                };
                if value.trim().is_empty() || options.insert(name.clone(), value).is_some() {
                    return Err(CliError::usage(format!(
                        "{name}が空、または重複しています。"
                    )));
                }
            },
            value if value.starts_with('-') => {
                return Err(CliError::usage(format!("未対応の引数です: {value}")));
            },
            _ => words.push(argument.as_str()),
        }
        index += 1;
    }
    let config_path = options.remove("--config").map(PathBuf::from);
    if config_path.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err(CliError::usage(
            "--configには設定JSONの絶対パスを指定してください。",
        ));
    }
    if help {
        return Ok(Invocation {
            command: Command::Help,
            json: json_output,
            config_path,
        });
    }
    let required = |options: &mut HashMap<String, String>, key: &str| {
        options
            .remove(key)
            .ok_or_else(|| CliError::usage(format!("{key}を指定してください。")))
    };
    let contour_data_specified = options.contains_key("--contour-data");
    let command = match words.as_slice() {
        ["build-info"] => Command::BuildInfo,
        ["elevation", "inspect"] => Command::ElevationInspect {
            input: PathBuf::from(required(&mut options, "--input")?),
            policy: options
                .remove("--elevation-datum-policy")
                .unwrap_or_else(|| "strict".into())
                .parse::<ElevationDatumPolicy>()
                .map_err(|error| CliError::usage(error.to_string()))?,
        },
        ["config", "show"] => Command::ConfigShow,
        ["status"] => Command::Status,
        ["datasets", "list"] => Command::DatasetsList,
        ["datasets", "show"] => Command::DatasetShow {
            dataset: required(&mut options, "--dataset")?,
        },
        ["datasets", "register"] => Command::Register {
            database: PathBuf::from(required(&mut options, "--database")?),
            name: required(&mut options, "--name")?,
        },
        ["datasets", "prepare"] => Command::Prepare {
            dataset: required(&mut options, "--dataset")?,
            spec: parse_render_spec(&mut options)?,
        },
        ["datasets", "retire"] => Command::Retire {
            dataset: required(&mut options, "--dataset")?,
        },
        ["import"] => Command::Import(ImportRequest {
            name: required(&mut options, "--name")?,
            input_path: required(&mut options, "--input")?,
            missing_nodes: options
                .remove("--missing-nodes")
                .unwrap_or_else(|| "error".into()),
            request_id: options.remove("--request-id"),
            features: options
                .remove("--features")
                .unwrap_or_else(|| "roads-v1".into()),
            elevation_input: options.remove("--elevation-input"),
            landmask_input: options.remove("--landmask-input"),
            invalid_areas: options
                .remove("--invalid-areas")
                .unwrap_or_else(|| "error".into()),
            elevation_datum_policy: options
                .remove("--elevation-datum-policy")
                .unwrap_or_else(|| "strict".into()),
            contour_data: options
                .remove("--contour-data")
                .unwrap_or_else(|| "on".into()),
        }),
        ["precompute", operation @ ("plan" | "run")] => {
            let request = parse_precompute(&mut options)?;
            if *operation == "plan" {
                Command::Plan(request)
            } else {
                Command::Precompute(request)
            }
        },
        ["precompute", "resume"] => Command::Resume {
            job: required(&mut options, "--job")?,
        },
        ["jobs", "list"] => Command::JobsList {
            limit: number(
                options.remove("--limit").unwrap_or_else(|| "20".into()),
                "--limit",
            )?,
            offset: number(
                options.remove("--offset").unwrap_or_else(|| "0".into()),
                "--offset",
            )?,
        },
        ["jobs", "show"] => Command::JobShow {
            job: required(&mut options, "--job")?,
        },
        ["jobs", "watch"] => Command::Watch {
            job: required(&mut options, "--job")?,
        },
        ["jobs", "cancel"] => Command::Cancel {
            job: required(&mut options, "--job")?,
        },
        ["url"] => Command::Url {
            dataset: required(&mut options, "--dataset")?,
            render: options.remove("--render"),
            base_url: options.remove("--base-url"),
        },
        ["background", "add"] => Command::BackgroundAdd {
            dataset: required(&mut options, "--dataset")?,
            render: options.remove("--render"),
            name: options.remove("--name"),
        },
        ["cache", "scan"] => Command::Scan,
        ["cache", "cleanup"] => Command::Cleanup {
            dataset: required(&mut options, "--dataset")?,
            render: required(&mut options, "--render")?,
        },
        _ => {
            return Err(CliError::usage(
                "コマンドが不正です。local-tiles --helpを参照してください。",
            ));
        },
    };
    if !options.is_empty() {
        let mut unknown: Vec<_> = options.into_keys().collect();
        unknown.sort();
        return Err(CliError::usage(format!(
            "未対応のオプションです: {}",
            unknown.join(", ")
        )));
    }
    if matches!(command, Command::JobsList { limit, offset } if !(1..=200).contains(&limit) || offset < 0)
    {
        return Err(CliError::usage(
            "--limitは1〜200、--offsetは0以上で指定してください。",
        ));
    }
    if matches!(&command, Command::Import(request) if !matches!(request.missing_nodes.as_str(), "error" | "skip-way"))
    {
        return Err(CliError::usage(
            "--missing-nodesはerrorまたはskip-wayを指定してください。",
        ));
    }
    if let Command::Import(request) = &command {
        if !matches!(
            request.features.as_str(),
            "roads-v1" | "standard-v1" | "standard-v2"
        ) {
            return Err(CliError::usage(
                "--featuresはroads-v1・standard-v1・standard-v2のいずれかを指定してください。",
            ));
        }
        let contour_data = request
            .contour_data
            .parse::<ContourData>()
            .map_err(|error| CliError::usage(error.to_string()))?;
        if request.features != "standard-v2"
            && (contour_data_specified || contour_data != ContourData::On)
        {
            return Err(CliError::usage(
                "--contour-dataには--features standard-v2が必要です。",
            ));
        }
        if !matches!(request.invalid_areas.as_str(), "error" | "skip-feature") {
            return Err(CliError::usage(
                "--invalid-areasはerrorまたはskip-featureを指定してください。",
            ));
        }
        let elevation_datum_policy = request
            .elevation_datum_policy
            .parse::<ElevationDatumPolicy>()
            .map_err(|error| CliError::usage(error.to_string()))?;
        if request.features == "roads-v1"
            && (request.elevation_input.is_some()
                || request.landmask_input.is_some()
                || request.invalid_areas != "error"
                || elevation_datum_policy != ElevationDatumPolicy::Strict)
        {
            return Err(CliError::usage(
                "--elevation-input・--landmask-input・面除外方針にはstandard-v1またはstandard-v2が必要です。",
            ));
        }
        if elevation_datum_policy != ElevationDatumPolicy::Strict
            && request.elevation_input.is_none()
        {
            return Err(CliError::usage(
                "--elevation-datum-policyによる混在許可には--elevation-inputが必要です。",
            ));
        }
    }
    if let Command::ElevationInspect { input, .. } = &command {
        if !input.is_absolute() {
            return Err(CliError::usage(
                "--inputには標高入力の絶対パスを指定してください。",
            ));
        }
    }
    Ok(Invocation {
        command,
        json: json_output,
        config_path,
    })
}

fn number<T: std::str::FromStr>(value: String, option: &str) -> Result<T, CliError> {
    value
        .parse()
        .map_err(|_| CliError::usage(format!("{option}の数値が不正です。")))
}

fn parse_render_spec(
    options: &mut HashMap<String, String>,
) -> Result<Option<RenderSpec>, CliError> {
    let style = options.remove("--style");
    if style.as_deref().is_some_and(|style| style != "osm-like-v1") {
        return Err(CliError::usage("--styleはosm-like-v1を指定してください。"));
    }
    let mut spec = RenderSpec::osm_like();
    let mut specified = style.is_some();
    for (option, target) in [
        ("--roads", &mut spec.roads),
        ("--buildings", &mut spec.buildings),
        ("--contours", &mut spec.contours),
        ("--hillshade", &mut spec.hillshade),
        ("--labels", &mut spec.labels),
    ] {
        if let Some(value) = options.remove(option) {
            specified = true;
            *target = match value.as_str() {
                "on" => true,
                "off" => false,
                _ => {
                    return Err(CliError::usage(format!(
                        "{option}はonまたはoffを指定してください。"
                    )));
                },
            };
        }
    }
    if let Some(language) = options.remove("--language") {
        specified = true;
        spec.language = match language.as_str() {
            "ja" => LabelLanguage::Ja,
            "local" => LabelLanguage::Local,
            "en" => LabelLanguage::En,
            _ => {
                return Err(CliError::usage(
                    "--languageはja・local・enのいずれかを指定してください。",
                ));
            },
        };
    }
    spec.validate()
        .map_err(|error| CliError::usage(error.to_string()))?;
    Ok(specified.then(|| spec.normalized()))
}
fn parse_precompute(options: &mut HashMap<String, String>) -> Result<PrecomputeRequest, CliError> {
    let mut take = |name: &str| {
        options
            .remove(name)
            .ok_or_else(|| CliError::usage(format!("{name}を指定してください。")))
    };
    let dataset_id = take("--dataset")?;
    let bbox = take("--bbox")?
        .split(',')
        .map(|value| value.trim().parse::<f64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CliError::usage("--bboxは西,南,東,北の4数値です。"))?;
    let bbox: [f64; 4] = bbox
        .try_into()
        .map_err(|_| CliError::usage("--bboxは西,南,東,北の4数値です。"))?;
    if !bbox.iter().all(|value| value.is_finite()) {
        return Err(CliError::usage("--bboxに有限の数値を指定してください。"));
    }
    let min_zoom = number(take("--min-zoom")?, "--min-zoom")?;
    let max_zoom = number(take("--max-zoom")?, "--max-zoom")?;
    let max_tiles = options
        .remove("--max-tiles")
        .map(|value| number(value, "--max-tiles"))
        .transpose()?;
    Ok(PrecomputeRequest {
        dataset_id,
        bbox,
        min_zoom,
        max_zoom,
        max_tiles,
        resume_job_id: None,
        render_id: options.remove("--render"),
    })
}

pub fn report_error(error: &CliError, json_output: bool) -> i32 {
    if json_output {
        println!(
            "{}",
            json!({"error":error.message,"exit_code":error.exit_code})
        );
    }
    eprintln!("{}", error.message);
    error.exit_code
}

pub struct CommandOutput {
    pub value: Value,
    pub exit_code: i32,
    pub streamed: bool,
}
impl CommandOutput {
    fn success(value: Value) -> Self {
        Self {
            value,
            exit_code: 0,
            streamed: false,
        }
    }
    fn terminal(value: Value) -> Self {
        let exit_code = match value["state"].as_str() {
            Some("succeeded") => 0,
            Some("cancelled") => 130,
            _ => 1,
        };
        Self {
            value,
            exit_code,
            streamed: false,
        }
    }
}

pub async fn run(invocation: Invocation, config: LocalTileConfig, pool: Option<SqlitePool>) -> i32 {
    if matches!(invocation.command, Command::Help) {
        print!("{}", help_text());
        return 0;
    }
    if matches!(invocation.command, Command::BuildInfo) {
        return print_build_info(invocation.json);
    }
    match execute(&invocation, config, pool).await {
        Ok(output) => {
            if !output.streamed {
                print_value(&output.value, invocation.json);
            }
            output.exit_code
        },
        Err(error) if invocation.json && matches!(invocation.command, Command::Watch { .. }) => {
            println!(
                "{}",
                json!({"event":"error","error":error.message,"exit_code":error.exit_code})
            );
            eprintln!("{}", error.message);
            error.exit_code
        },
        Err(error) => report_error(&error, invocation.json),
    }
}

fn print_value(value: &Value, compact: bool) {
    if compact {
        println!("{value}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(value).expect("JSON結果を文字列へ変換")
        );
    }
}

fn build_info() -> Value {
    let mut font: Value = serde_json::from_str(include_str!("../../res/fonts/manifest.json"))
        .expect("同梱フォントのマニフェストが有効なJSONであること");
    font["license_text"] = json!(include_str!("../../res/fonts/OFL.txt"));
    json!({
        "app_build_id": env!("TILEGEN_BUILD_ID"),
        "render_contract": crate::tilegen::identity::RenderContract::for_format(1, 1),
        "standard_render_contract": crate::tilegen::identity::RenderContract::for_format(2, 2),
        "standard_generation_verified": crate::tilegen::execution::ensure_standard_generation_allowed().is_ok(),
        "osm_render_contract": crate::tilegen::identity::RenderContract::for_format(3, 2),
        "osm_generation_verified": crate::tilegen::execution::ensure_osm_generation_allowed().is_ok(),
        "font": font,
        "execution": execution_diagnostics(),
    })
}

/// 設定やDBへ接続せず、配布用exe自身の描画構成を照会する。
pub fn print_build_info(json_output: bool) -> i32 {
    print_value(&build_info(), json_output);
    0
}

async fn execute_inspection(
    input: PathBuf,
    policy: ElevationDatumPolicy,
    cancellation: CancellationToken,
) -> Result<CommandOutput, CliError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::tilegen::standard::elevation::inspect_input(
            &input,
            policy,
            &OperationContext::new(cancellation),
        )
    })
    .await
    .map_err(|error| CliError::new(1, error.to_string()))?;
    if let Some(error) = &result.error {
        eprintln!("{error}");
    }
    Ok(CommandOutput {
        exit_code: result.exit_code,
        value: serde_json::to_value(result).map_err(catalog_error)?,
        streamed: false,
    })
}

/// 設定・本体DB・生成認定を使わず、入力資料だけを検査する。
pub async fn print_elevation_inspection(invocation: &Invocation) -> i32 {
    let Command::ElevationInspect { input, policy } = &invocation.command else {
        return report_error(
            &CliError::usage("標高の検査コマンドが必要です。"),
            invocation.json,
        );
    };
    let cancellation = CancellationToken::new();
    let signal = {
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                cancellation.cancel();
            }
        })
    };
    let result = execute_inspection(input.clone(), *policy, cancellation).await;
    signal.abort();
    let _ = signal.await;
    match result {
        Ok(output) => {
            print_value(&output.value, invocation.json);
            output.exit_code
        },
        Err(error) => report_error(&error, invocation.json),
    }
}

/// テストも同じ実行経路を使う。呼出側から渡された設定と接続プール以外には接続しない。
pub async fn execute(
    invocation: &Invocation,
    config: LocalTileConfig,
    pool: Option<SqlitePool>,
) -> Result<CommandOutput, CliError> {
    let cancellation = CancellationToken::new();
    let signal = {
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                cancellation.cancel();
            }
        })
    };
    let result = execute_with_cancellation(invocation, config, pool, cancellation).await;
    signal.abort();
    let _ = signal.await;
    result
}

pub async fn execute_with_cancellation(
    invocation: &Invocation,
    config: LocalTileConfig,
    pool: Option<SqlitePool>,
    cancellation: CancellationToken,
) -> Result<CommandOutput, CliError> {
    if matches!(invocation.command, Command::Help) {
        return Ok(CommandOutput::success(json!({"help":help_text()})));
    }
    if matches!(invocation.command, Command::BuildInfo) {
        return Ok(CommandOutput::success(build_info()));
    }
    if matches!(invocation.command, Command::ConfigShow) {
        return Ok(CommandOutput::success(config_json(&config)));
    }
    if let Command::ElevationInspect { input, policy } = &invocation.command {
        return execute_inspection(input.clone(), *policy, cancellation).await;
    }
    let pool = pool.ok_or_else(|| CliError::new(1, "本体DBが指定されていません。"))?;
    if invocation.is_writer() {
        let service = LocalTiles::new(config, pool);
        let result = execute_writer(&service, &invocation.command, &cancellation).await;
        service.shutdown().await;
        return result;
    }
    if matches!(invocation.command, Command::Scan) {
        let service = LocalTiles::reader(config, pool);
        let result = service
            .scan_storage()
            .await
            .map(CommandOutput::success)
            .map_err(CliError::from);
        service.shutdown().await;
        return result;
    }
    let catalog_missing = match std::fs::symlink_metadata(&config.catalog_database_path) {
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(catalog_error(error)),
    };
    if catalog_missing {
        return match invocation.command {
            Command::Status => Ok(CommandOutput::success(
                json!({"config":config_json(&config),"catalog_exists":false,"owner_available":true,
                    "app_build_id":env!("TILEGEN_BUILD_ID"),"execution":execution_diagnostics()}),
            )),
            Command::DatasetsList | Command::JobsList { .. } => {
                Ok(CommandOutput::success(json!([])))
            },
            _ => Err(CliError::missing(
                "タイル管理DBがありません。先にimportまたはdatasets registerを実行してください。",
            )),
        };
    }
    if let Command::Plan(request) = &invocation.command {
        let service = LocalTiles::reader(config, pool);
        let result = service
            .plan_precompute_readonly(request.clone())
            .await
            .map(CommandOutput::success)
            .map_err(CliError::from);
        service.shutdown().await;
        return result;
    }
    let catalog = if matches!(invocation.command, Command::Cancel { .. }) {
        TileCatalog::control(config.catalog_database_path.clone(), pool)
    } else {
        TileCatalog::read_only(config.catalog_database_path.clone(), pool)
    }
    .with_storage_roots([
        config.dataset_path.clone(),
        config.cache_path.clone(),
        config.work_path.clone(),
    ]);
    let result = execute_reader(&catalog, &config, invocation, &cancellation).await;
    catalog.close().await;
    result
}

async fn execute_writer(
    service: &Arc<LocalTiles>,
    command: &Command,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, CliError> {
    service.ensure_writer().await?;
    if cancellation.is_cancelled() {
        return Err(CliError::new(130, "処理を取り消しました。"));
    }
    let value = match command {
        Command::Register { database, name } => {
            service
                .register_database(name.clone(), database.clone(), false)
                .await?
        },
        Command::Prepare { dataset, spec } => {
            service.prepare_dataset_with_spec(dataset, *spec).await?
        },
        Command::Retire { dataset } => service.retire(dataset).await?,
        Command::Import(request) => {
            let accepted = service.start_import(request.clone()).await?;
            return wait_owned_job(service, accepted, cancellation).await;
        },
        Command::Precompute(request) => {
            let accepted = service.start_precompute(request.clone()).await?;
            return wait_owned_job(service, accepted, cancellation).await;
        },
        Command::Resume { job } => {
            let previous = catalog::get_job(&service.catalog, job)
                .await
                .map_err(catalog_error)?
                .ok_or_else(|| CliError::missing("再開元ジョブが見つかりません。"))?;
            if previous.kind != "precompute" || is_running(&previous.state) {
                return Err(CliError::new(
                    1,
                    "停止済みの事前生成ジョブだけを再開できます。",
                ));
            }
            let mut request: PrecomputeRequest =
                serde_json::from_str(&previous.request_json).map_err(catalog_error)?;
            request.resume_job_id = Some(job.clone());
            let accepted = service.start_precompute(request).await?;
            return wait_owned_job(service, accepted, cancellation).await;
        },
        Command::BackgroundAdd {
            dataset,
            render,
            name,
        } => {
            service
                .add_background_with_options(dataset, render.as_deref(), name.as_deref())
                .await?
        },
        Command::Cleanup { dataset, render } => service.cleanup(dataset, render).await?,
        _ => return Err(CliError::new(1, "writerコマンドの分類が不正です。")),
    };
    Ok(CommandOutput::success(value))
}

async fn wait_owned_job(
    service: &Arc<LocalTiles>,
    accepted: Value,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, CliError> {
    let id = accepted["id"]
        .as_str()
        .ok_or_else(|| CliError::new(1, "受付ジョブIDがありません。"))?;
    eprintln!("ジョブ {id} を受け付けました。");
    let mut last = String::new();
    let mut requested = false;
    loop {
        let job = service.get_job_json(id).await?;
        let state = job["state"].as_str().unwrap_or("");
        if !is_running(state) {
            return Ok(CommandOutput::terminal(job));
        }
        if cancellation.is_cancelled() && !requested {
            service.cancel_job(id).await?;
            requested = true;
            eprintln!("ジョブ {id} の取消を要求しました。実処理の終了を待ちます。");
        }
        let snapshot = job.to_string();
        if snapshot != last {
            eprintln!("ジョブ {id}: {state} {}", job["progress"]);
            last = snapshot;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn execute_reader(
    catalog: &TileCatalog,
    config: &LocalTileConfig,
    invocation: &Invocation,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, CliError> {
    catalog.initialize().await.map_err(catalog_error)?;
    let value = match &invocation.command {
        Command::Status => json!({"config":config_json(config),"catalog_exists":true,
            "app_build_id":env!("TILEGEN_BUILD_ID"),"execution":execution_diagnostics(),
            "owner_available":catalog.owner_available().await.map_err(catalog_error)?,
            "datasets":catalog::list_datasets(catalog).await.map_err(catalog_error)?.len(),
            "jobs":catalog::total_jobs(catalog).await.map_err(catalog_error)?}),
        Command::DatasetsList => {
            let mut values = Vec::new();
            for record in catalog::list_datasets(catalog)
                .await
                .map_err(catalog_error)?
            {
                values.push(dataset_value(catalog, record).await?);
            }
            json!(values)
        },
        Command::DatasetShow { dataset } => {
            let record = catalog::get_dataset(catalog, dataset)
                .await
                .map_err(catalog_error)?
                .ok_or_else(|| CliError::missing("データセットが見つかりません。"))?;
            dataset_value(catalog, record).await?
        },
        Command::JobsList { limit, offset } => json!(
            catalog::list_jobs(catalog, *limit, *offset)
                .await
                .map_err(catalog_error)?
                .into_iter()
                .map(job_value)
                .collect::<Vec<_>>()
        ),
        Command::JobShow { job } => job_value(get_job(catalog, job).await?),
        Command::Cancel { job } => {
            let previous = get_job(catalog, job).await?;
            if is_running(&previous.state) {
                catalog::request_job_cancel(catalog, job)
                    .await
                    .map_err(catalog_error)?;
            }
            let mut value = job_value(get_job(catalog, job).await?);
            value["cancel_requested"] = json!(is_running(&previous.state));
            value
        },
        Command::Watch { job } => {
            return watch_job(catalog, job, invocation.json, cancellation).await;
        },
        Command::Url {
            dataset,
            render,
            base_url,
        } => url_value(catalog, dataset, render.as_deref(), base_url.as_deref()).await?,
        _ => return Err(CliError::new(1, "照会コマンドの分類が不正です。")),
    };
    Ok(CommandOutput::success(value))
}

async fn dataset_value(catalog: &TileCatalog, record: DatasetRecord) -> Result<Value, CliError> {
    let profiles = catalog::list_profiles(catalog, &record.id)
        .await
        .map_err(catalog_error)?;
    let expected = super::service::default_profile_id(&record);
    let current_profile_prepared = !record.retired
        && profiles
            .iter()
            .any(|p| expected.as_deref() == Some(p.id.as_str()) && profile::is_compatible(p));
    Ok(
        json!({"id":record.id,"name":record.name,"storage_kind":record.storage_kind,
        "database_path":record.database_path,"dataset_key":record.dataset_key,"created_at":record.created_at,
        "retired":record.retired,"info":serde_json::from_str::<Value>(&record.info_json).map_err(catalog_error)?,
        "profiles":profiles,"current_profile_prepared":current_profile_prepared,
        "app_build_id":env!("TILEGEN_BUILD_ID"),"execution":execution_diagnostics()}),
    )
}
async fn get_job(catalog: &TileCatalog, id: &str) -> Result<JobRecord, CliError> {
    catalog::get_job(catalog, id)
        .await
        .map_err(catalog_error)?
        .ok_or_else(|| CliError::missing("ジョブが見つかりません。"))
}
fn job_value(record: JobRecord) -> Value {
    json!({"id":record.id,"kind":record.kind,"dataset_id":record.dataset_id,"state":record.state,
        "request":serde_json::from_str::<Value>(&record.request_json).unwrap_or(Value::Null),
        "progress":serde_json::from_str::<Value>(&record.progress_json).unwrap_or(Value::Null),
        "error":record.error,"created_at":record.created_at,"updated_at":record.updated_at,"owner_id":record.owner_id})
}
fn is_running(state: &str) -> bool {
    matches!(state, "queued" | "running" | "cancelling")
}
async fn watch_job(
    catalog: &TileCatalog,
    id: &str,
    json_output: bool,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, CliError> {
    let mut last = String::new();
    loop {
        if cancellation.is_cancelled() {
            return Err(CliError::new(
                130,
                "監視を終了しました。ジョブは取り消していません。",
            ));
        }
        let job = job_value(get_job(catalog, id).await?);
        let terminal = !is_running(job["state"].as_str().unwrap_or(""));
        let serialized = job.to_string();
        if serialized != last || terminal {
            if json_output {
                println!(
                    "{}",
                    json!({"event":if terminal {"terminal"} else {"progress"},"job":job})
                );
            } else if terminal {
                print_value(&job, false);
            } else {
                eprintln!("ジョブ {id}: {} {}", job["state"], job["progress"]);
            }
            last = serialized;
        }
        if terminal {
            let mut output = CommandOutput::terminal(job);
            output.streamed = true;
            return Ok(output);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn url_value(
    catalog: &TileCatalog,
    dataset: &str,
    render: Option<&str>,
    base_url: Option<&str>,
) -> Result<Value, CliError> {
    let record = catalog::get_dataset(catalog, dataset)
        .await
        .map_err(catalog_error)?
        .ok_or_else(|| CliError::missing("データセットが見つかりません。"))?;
    if record.retired {
        return Err(CliError::new(1, "このデータセットは利用停止されています。"));
    }
    let profiles = catalog::list_profiles(catalog, dataset)
        .await
        .map_err(catalog_error)?;
    let info: Value = serde_json::from_str(&record.info_json).map_err(catalog_error)?;
    let expected = info["schema_version"]
        .as_u64()
        .zip(info["geometry_version"].as_u64())
        .and_then(|(s, g)| u32::try_from(s).ok().zip(u32::try_from(g).ok()))
        .and_then(|(s, g)| crate::tilegen::identity::RenderContract::for_format(s, g))
        .map(|contract| crate::tilegen::identity::render_id(dataset, &contract));
    let profile = if let Some(render) = render {
        profiles.into_iter().find(|profile| profile.id == render)
    } else {
        profiles
            .into_iter()
            .find(|p| expected.as_deref() == Some(p.id.as_str()) && profile::is_compatible(p))
    }
    .filter(|profile| !profile.retired)
    .ok_or_else(|| {
        CliError::missing(
            "対象の描画世代が未準備です。datasets prepare --dataset IDを実行してください。",
        )
    })?;
    let relative_url = tile_url(dataset, &profile.id);
    let url = if let Some(base) = base_url {
        let parsed = reqwest::Url::parse(base)
            .map_err(|_| CliError::usage("--base-urlにHTTP(S)の絶対URLを指定してください。"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(CliError::usage(
                "--base-urlに認証情報・query・fragmentを含まないHTTP(S) URLを指定してください。",
            ));
        }
        format!("{}{}", parsed.as_str().trim_end_matches('/'), relative_url)
    } else {
        relative_url.clone()
    };
    let attribution = super::service::attribution_html(&info["attribution"])?;
    let current = profile.build_id == env!("TILEGEN_BUILD_ID");
    let compatible = profile::is_compatible(&profile);
    let layer_name = format!(
        "local_{dataset}_{}",
        profile.id.chars().take(12).collect::<String>()
    );
    Ok(
        json!({"dataset_id":dataset,"render_id":profile.id,"build_id":profile.build_id,"current_build":current,
        "app_build_id":env!("TILEGEN_BUILD_ID"),"render_compatible":compatible,"execution":execution_diagnostics(),
        "url":url,"relative_url":relative_url,"label":record.name,"kind":"raster","style_url":null,
        "layer_name":layer_name,
        "attribution":attribution,"min_zoom":0,"max_zoom":22,"include_foreign_tiles":false,
        "old_generation_cache_miss_status":if compatible {Value::Null} else {json!(410)}}),
    )
}

fn config_json(config: &LocalTileConfig) -> Value {
    json!({"tile_catalog_database_path":config.catalog_database_path,"tile_dataset_path":config.dataset_path,
        "tile_cache_path":config.cache_path,"tile_work_path":config.work_path,"local_tile_workers":config.workers,
        "local_tile_queue_capacity":config.queue_capacity,"local_tile_max_subscribers":config.max_subscribers,
        "local_tile_background_queue_capacity":config.background_queue_capacity,
        "local_tile_job_timeout_seconds":config.job_timeout_seconds,"local_tile_http_timeout_seconds":config.http_timeout_seconds,
        "local_tile_precompute_max_tiles":config.precompute_max_tiles})
}

#[cfg(test)]
mod standard_argument_tests {
    use super::*;
    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn 標高地形の取り込みと描画世代を解析する() {
        let invocation=parse(&args("import --input D:/map.pbf --name 地形 --features standard-v1 --elevation-input E:/dem --landmask-input E:/land.shp --invalid-areas skip-feature")).unwrap();
        let Command::Import(request) = invocation.command else {
            panic!("importが必要です")
        };
        assert_eq!(request.features, "standard-v1");
        assert_eq!(request.elevation_input.as_deref(), Some("E:/dem"));
        assert_eq!(request.invalid_areas, "skip-feature");
        let invocation=parse(&args("precompute plan --dataset abc --render def --bbox 139,35,140,36 --min-zoom 10 --max-zoom 14")).unwrap();
        let Command::Plan(request) = invocation.command else {
            panic!("planが必要です")
        };
        assert_eq!(request.render_id.as_deref(), Some("def"));
        let invocation = parse(&args("background add --dataset abc --render def")).unwrap();
        assert!(
            matches!(invocation.command,Command::BackgroundAdd{render:Some(ref value),..} if value=="def")
        );
    }

    #[test]
    fn 道路既定を維持し誤った地形オプションを拒否する() {
        let Command::Import(request) = parse(&args("import --input D:/map.pbf --name 道路"))
            .unwrap()
            .command
        else {
            panic!("importが必要です")
        };
        assert_eq!(request.features, "roads-v1");
        assert!(
            parse(&args(
                "import --input D:/map.pbf --name 道路 --elevation-input E:/dem"
            ))
            .is_err()
        );
        assert!(
            parse(&args(
                "import --input D:/map.pbf --name 地形 --features future-v9"
            ))
            .is_err()
        );
        assert!(parse(&args("import --input D:/map.pbf --name 地形 --features standard-v1 --invalid-areas ignore")).is_err());
    }

    #[test]
    fn 新形式の描画設定を正規化し既定の旧世代準備を維持する() {
        let Command::Prepare { spec, .. } = parse(&args("datasets prepare --dataset abc"))
            .unwrap()
            .command
        else {
            panic!()
        };
        assert!(spec.is_none());
        let Command::Prepare { spec: Some(spec), .. } = parse(&args("datasets prepare --dataset abc --style osm-like-v1 --roads off --buildings off --contours on --hillshade on --labels off --language en")).unwrap().command else { panic!() };
        assert!(!spec.roads && !spec.buildings && !spec.labels);
        assert!(spec.contours && spec.hillshade);
        assert_eq!(spec.language, LabelLanguage::Local);
        let Command::Import(request) = parse(&args(
            "import --input D:/map.pbf --name 地図 --features standard-v2 --contour-data off",
        ))
        .unwrap()
        .command
        else {
            panic!()
        };
        assert_eq!(request.features, "standard-v2");
        assert_eq!(request.contour_data, "off");
        for invalid in [
            "datasets prepare --dataset abc --style future-v9",
            "datasets prepare --dataset abc --roads true",
            "datasets prepare --dataset abc --labels yes",
            "datasets prepare --dataset abc --language de",
            "import --input D:/map.pbf --name 地図 --contour-data off",
            "import --input D:/map.pbf --name 地図 --features standard-v1 --contour-data off",
            "import --input D:/map.pbf --name 地図 --features standard-v1 --contour-data on",
            "import --input D:/map.pbf --name 地図 --features standard-v2 --contour-data maybe",
        ] {
            assert!(parse(&args(invalid)).is_err(), "{invalid}");
        }
        let Command::BackgroundAdd { name, .. } =
            parse(&args("background add --dataset abc --name 地形付き"))
                .unwrap()
                .command
        else {
            panic!()
        };
        assert_eq!(name.as_deref(), Some("地形付き"));
    }
}
