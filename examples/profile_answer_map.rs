//! 明示的に指定したデータベースのコピーを使う、読み取り専用の回答地図 HTML/API 診断。
//! 非公開の成果物は、このチェックアウトの無視対象の target ディレクトリ内に限定する。
//! アプリの起動、dotenv の読み込み、マイグレーション、SQL・バインド値の出力、SQLite への書き込みは行わない。
use axum::{
    Form, Json, Router,
    body::to_bytes,
    extract::{DefaultBodyLimit, Extension, Request},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{Next, from_fn},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use geocode_web_single::{
    build_tera_extension,
    handler::{
        answer_map::{
            AnswerMapPrintRequest, AnswerMapRequest, answer_map_handler, answer_map_print_handler,
            load_answer_map,
        },
        answer_map_csv,
        answer_map_filter::{MapFilterRequest, filter_handler, filter_targets},
        assets::serve_static_file,
        form_answers::{AnswerCondition, AnswerQuery},
    },
};
use serde_json::{Value, json};
use sqlx::{
    ConnectOptions, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::HashMap,
    io::Write,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context, layer::SubscriberExt, util::SubscriberInitExt};

const JSON_SECTIONS: [&str; 9] = [
    "popupBodies",
    "answerPreview",
    "tileServers",
    "tileOverlays",
    "tileVisibilityAccountId",
    "layers",
    "markers",
    "shapes",
    "normalBodyReferences",
];

#[derive(serde::Serialize)]
struct SqlTiming {
    kind: &'static str,
    ms: f64,
    rows: u64,
}

#[derive(serde::Serialize)]
struct JsonTiming {
    section: &'static str,
    ms: f64,
    output_bytes: usize,
}

#[derive(Default)]
struct InitialObservation {
    active: bool,
    sql: Vec<SqlTiming>,
    json: Vec<JsonTiming>,
    render_started: Option<Instant>,
    render_ms: Option<f64>,
}

#[derive(Clone, Default)]
struct InitialTrace(Arc<Mutex<InitialObservation>>);

impl InitialTrace {
    fn start(&self) {
        *self.0.lock().unwrap() = InitialObservation {
            active: true,
            ..Default::default()
        };
    }

    fn finish(&self, handler_ms: f64) -> anyhow::Result<Value> {
        let observation = std::mem::take(&mut *self.0.lock().unwrap());
        anyhow::ensure!(
            !observation.sql.is_empty(),
            "SQL timing events were not observed"
        );
        let render_ms = observation
            .render_ms
            .ok_or_else(|| anyhow::anyhow!("Render markers were not observed"))?;
        anyhow::ensure!(
            matches!(observation.json.len(), 8 | 9),
            "Unexpected JSON section count"
        );
        let sql_ms: f64 = observation.sql.iter().map(|item| item.ms).sum();
        let json_ms: f64 = observation.json.iter().map(|item| item.ms).sum();
        Ok(json!({
            "handlerMs":handler_ms, "renderMs":render_ms,
            "sqlObservedMs":sql_ms, "jsonEncodeMs":json_ms,
            "unattributedMs":handler_ms-sql_ms-render_ms,
            "queries":observation.sql, "jsonSections":observation.json,
        }))
    }
}

fn query_kind(sql: &str) -> &'static str {
    let sql = sql.to_ascii_lowercase();
    if sql.contains("count(distinct target_type") {
        "answer_count"
    } else if sql.contains("select id,form_body_parts from marker_info_model") {
        "popup_parts_marker"
    } else if sql.contains("select id,form_body_parts from shape_model") {
        "popup_parts_shape"
    } else if sql.contains("s.rendered_markdown")
        && sql.contains("from marker_form_submission_model s")
    {
        "popup_answers_marker"
    } else if sql.contains("s.rendered_markdown")
        && sql.contains("from shape_form_submission_model s")
    {
        "popup_answers_shape"
    } else if sql.contains("from marker_info_model m") {
        "marker_records"
    } else if sql.contains("from shape_model s") {
        "shape_records"
    } else if sql.contains("from layer_model l") {
        "layers"
    } else if sql.contains("from tileserver_model") {
        "tile_servers"
    } else if sql.contains("from tile_overlay_model") {
        "tile_overlays"
    } else {
        "other"
    }
}

struct QueryEvent {
    kind: &'static str,
    elapsed: Option<f64>,
    rows: u64,
}
impl Visit for QueryEvent {
    fn record_str(&mut self, field: &Field, value: &str) {
        if matches!(field.name(), "db.statement" | "summary") && !value.is_empty() {
            self.kind = query_kind(value);
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        if field.name() == "elapsed_secs" {
            self.elapsed = Some(value);
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        if field.name() == "rows_returned" {
            self.rows = value;
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if matches!(field.name(), "db.statement" | "summary") {
            self.kind = query_kind(&format!("{value:?}"));
        }
    }
}
impl<S: Subscriber> Layer<S> for InitialTrace {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        if event.metadata().target() != "sqlx::query" || !self.0.lock().unwrap().active {
            return;
        }
        // SQL 文のテキストを一時的に分類する。SQL の保持・出力や、バインド値へのアクセスは行わない。
        let mut value = QueryEvent {
            kind: "other",
            elapsed: None,
            rows: 0,
        };
        event.record(&mut value);
        if let Some(elapsed) = value.elapsed {
            let mut observation = self.0.lock().unwrap();
            if observation.active {
                observation.sql.push(SqlTiming {
                    kind: value.kind,
                    ms: elapsed * 1000.0,
                    rows: value.rows,
                });
            }
        }
    }
}

struct TimedJsonFilter {
    original: Arc<dyn tera::Filter>,
    trace: InitialTrace,
}
impl tera::Filter for TimedJsonFilter {
    fn filter(&self, value: &Value, args: &HashMap<String, Value>) -> tera::Result<Value> {
        let started = Instant::now();
        let result = self.original.filter(value, args);
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        if let Ok(Value::String(encoded)) = &result {
            let mut observation = self.trace.0.lock().unwrap();
            if observation.active {
                let section = JSON_SECTIONS
                    .get(observation.json.len())
                    .copied()
                    .unwrap_or("unexpected");
                observation.json.push(JsonTiming {
                    section,
                    ms: elapsed,
                    output_bytes: encoded.len(),
                });
            }
        }
        result
    }
    fn is_safe(&self) -> bool {
        self.original.is_safe()
    }
}

async fn instrument_templates(templates: &Templates, trace: &InitialTrace) -> anyhow::Result<()> {
    let source = include_str!("../dist/templates/form-answer-map.html");
    let context_names = [
        "popupBodies",
        "answerPreview",
        "tileServers",
        "tileOverlays",
        "tileVisibilityAccountId",
        "layersFromAxum",
        "markersFromAxum",
        "shapesFromAxum",
        "normalBodyReferences",
    ];
    let calls: Vec<_> = source
        .lines()
        .filter(|line| line.contains("| json_encode_for_html"))
        .collect();
    anyhow::ensure!(
        calls.len() == context_names.len(),
        "Template JSON calls changed"
    );
    for (line, name) in calls.iter().zip(context_names) {
        anyhow::ensure!(
            line.contains(&format!("{{{{ {name} ")),
            "Template JSON call order changed"
        );
    }
    let mut tera = templates.lock().await;
    let original = tera
        .filters
        .get("json_encode_for_html")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Production JSON filter is missing"))?;
    tera.register_filter(
        "json_encode_for_html",
        TimedJsonFilter {
            original,
            trace: trace.clone(),
        },
    );
    let start_trace = trace.clone();
    tera.register_function(
        "profile_render_start",
        move |_: &HashMap<String, Value>| -> tera::Result<Value> {
            let mut observation = start_trace.0.lock().unwrap();
            if observation.active {
                observation.render_started = Some(Instant::now());
            }
            Ok(Value::String(String::new()))
        },
    );
    let end_trace = trace.clone();
    tera.register_function(
        "profile_render_end",
        move |_: &HashMap<String, Value>| -> tera::Result<Value> {
            let mut observation = end_trace.0.lock().unwrap();
            if observation.active {
                observation.render_ms = observation
                    .render_started
                    .map(|started| started.elapsed().as_secs_f64() * 1000.0);
            }
            Ok(Value::String(String::new()))
        },
    );
    // 同じコンパイル済みの本番テンプレートの前後に、何も出力しない関数を配置する。
    // 最初のテンプレートノードより前のロック待ちや描画準備を、計測から除外する。
    tera.add_raw_template(
        "form-answer-map.html",
        &format!("{{{{ profile_render_start() }}}}{source}{{{{ profile_render_end() }}}}"),
    )?;
    Ok(())
}

struct Options {
    database: PathBuf,
    output: PathBuf,
    serve: bool,
    port: u16,
    initial_samples: Option<usize>,
    query_manifest: Option<PathBuf>,
}

fn loopback_origin(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "http"
            && matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            )
            && url.origin().ascii_serialization() == raw
    })
}

async fn require_local_post_origin(request: Request, next: Next) -> Response {
    if !request
        .headers()
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .is_some_and(|host| loopback_origin(&format!("http://{host}")))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.method() == Method::POST
        && !request
            .headers()
            .get_all(header::ORIGIN)
            .iter()
            .all(|origin| origin.to_str().is_ok_and(loopback_origin))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

type Templates = std::sync::Arc<tokio::sync::Mutex<tera::Tera>>;

async fn local_map_handler(
    user: Extension<String>,
    pool: Extension<SqlitePool>,
    templates: Extension<Templates>,
    Form(request): Form<AnswerMapRequest>,
) -> Result<Response, geocode_web_single::error::AppError> {
    if !loopback_origin(&request.parent_origin) {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }
    let started = Instant::now();
    let mut response = answer_map_handler(user, pool, templates, Form(request)).await?;
    let duration = HeaderValue::from_str(&format!(
        "handler;dur={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    ))
    .map_err(|_| geocode_web_single::error::AppError::InternalServerError)?;
    response.headers_mut().insert("server-timing", duration);
    Ok(response)
}

async fn local_print_handler(
    user: Extension<String>,
    templates: Extension<Templates>,
    Form(request): Form<AnswerMapPrintRequest>,
) -> Result<Response, geocode_web_single::error::AppError> {
    if !loopback_origin(&request.parent_origin) {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }
    answer_map_print_handler(user, templates, Form(request)).await
}

fn options() -> anyhow::Result<Options> {
    let mut args = std::env::args().skip(1);
    let mut database = None;
    let mut output = None;
    let mut serve = false;
    let mut port = 0;
    let mut initial_samples = None;
    let mut query_manifest = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--database" => database = args.next().map(PathBuf::from),
            "--output-directory" => output = args.next().map(PathBuf::from),
            "--serve" => serve = true,
            "--query-manifest" => {
                query_manifest =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        anyhow::anyhow!("--query-manifest requires a private path")
                    })?))
            },
            "--initial-samples" => {
                let count: usize = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--initial-samples requires a count"))?
                    .parse()?;
                anyhow::ensure!(
                    (1..=20).contains(&count),
                    "Initial samples must be between 1 and 20"
                );
                initial_samples = Some(count);
            },
            "--port" => {
                port = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--port requires a value"))?
                    .parse()?
            },
            _ => anyhow::bail!("Unsupported argument"),
        }
    }
    let database = database.ok_or_else(|| anyhow::anyhow!("--database COPY is required"))?;
    anyhow::ensure!(database.is_file(), "Database copy must already exist");
    let database = database.canonicalize()?;
    let target = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .canonicalize()?;
    anyhow::ensure!(
        database.starts_with(target),
        "Database copy must be inside this checkout's target directory"
    );
    let query_manifest = query_manifest
        .map(|path| -> anyhow::Result<PathBuf> {
            let path = path.canonicalize()?;
            let target = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .canonicalize()?;
            anyhow::ensure!(
                path.starts_with(target) && path.is_file(),
                "Query manifest must be a private target file"
            );
            Ok(path)
        })
        .transpose()?;
    let output =
        output.ok_or_else(|| anyhow::anyhow!("--output-directory target/PRIVATE is required"))?;
    Ok(Options {
        database,
        output,
        serve,
        port,
        initial_samples,
        query_manifest,
    })
}

fn private_directory(requested: &Path) -> anyhow::Result<PathBuf> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"));
    let target = workspace.join("target").canonicalize()?;
    let requested = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        workspace.join(requested)
    };
    anyhow::ensure!(
        !requested
            .components()
            .any(|part| part == Component::ParentDir),
        "Output must stay below target"
    );
    // Windows のジャンクションも含め、既存の親ディレクトリを解決してから作成を始める。
    let mut ancestor = requested.as_path();
    let mut missing = vec![];
    while !ancestor.exists() {
        missing.push(
            ancestor
                .file_name()
                .ok_or_else(|| anyhow::anyhow!("Invalid output directory"))?
                .to_owned(),
        );
        ancestor = ancestor
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid output directory"))?;
    }
    let mut output = ancestor.canonicalize()?;
    for part in missing.into_iter().rev() {
        output.push(part);
    }
    anyhow::ensure!(
        output.starts_with(&target) && output != target,
        "Output must stay below target"
    );
    std::fs::create_dir_all(&output)?;
    let output = output.canonicalize()?;
    anyhow::ensure!(
        output.starts_with(&target) && output != target,
        "Output must stay below target"
    );
    anyhow::ensure!(
        std::fs::read_dir(&output)?.next().is_none(),
        "Output directory must be empty"
    );
    Ok(output)
}

fn isolated_config(output: &Path) {
    // Tokio ランタイムが存在しない、起動直後の単一スレッド上で実行する。
    // このプロセスの環境変数だけを変更し、既存の設定ファイルは読み込まない。
    let remove: Vec<_> = std::env::vars_os()
        .filter_map(|(key, _)| {
            let name = key.to_string_lossy();
            (name.starts_with("GEOCODER_")
                || name.starts_with("HTTP_IMAGE_")
                || name.starts_with("LIVE_")
                || name.starts_with("TILE_")
                || name.starts_with("REDIS_")
                || name == "MARKER_FORM_STORAGE_QUOTA_BYTES")
                .then_some(key)
        })
        .collect();
    unsafe {
        for key in remove {
            std::env::remove_var(key);
        }
        for (key, value) in [
            ("APP_TITLE", "Private answer-map diagnostic"),
            ("CREATEDATABASE_PATH", ":memory:"),
            ("DATABASE_URL", "sqlite::memory:"),
            ("SECRET_KEY", "unused-local-profile-secret-0123456789"),
            ("ADMIN_USERNAME", "unused-profile-account"),
            ("ADMIN_PASSWORD", "unused-local-profile-password"),
            ("ACCESS_TOKEN_EXP_MINUTUES", "30"),
            ("REFRESH_TOKEN_EXP_MINUTUES", "30"),
            ("FAILED_ACCOUNT_LOCK", "5"),
            ("NEXT_CHALLENGE_MINUTES", "5"),
            ("CHALLENGE_LIMIT_TIME_FAILEDCOUNT", "3"),
            ("CACHE_CONTROL", "no-store"),
            ("SECURE_COOKIE", "false"),
            ("SERVICE_NAME", "Private diagnostic"),
            ("ALLOW_USER_CREATE_ACCOUNT", "false"),
            ("ALLOW_USER_UPDATE_PASSWORD", "false"),
            ("ALLOW_ORIGINS", "http://127.0.0.1"),
            ("GEOCODER_PROVIDER", "csis"),
            ("RUST_LOG", "off"),
        ] {
            std::env::set_var(key, value);
        }
        std::env::set_var("IMAGE_FILES_PATH", output);
        std::env::set_var("UPLOAD_FILE_PATH", output);
    }
    once_cell::sync::Lazy::force(&geocode_web_single::config::CONFIG);
}

fn write_private(output: &Path, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output.join(name))?
        .write_all(bytes)?;
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let options = options()?;
    let output = private_directory(&options.output)?;
    isolated_config(&output);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(options, output))
}

async fn run(options: Options, output: PathBuf) -> anyhow::Result<()> {
    let trace = options.initial_samples.map(|_| InitialTrace::default());
    if let Some(trace) = &trace {
        // ログの整形層は使わず、SQLx のイベントを固定の種別・ミリ秒・行数のみに集約し、
        // 順次実行する初回サンプルの計測中だけ収集する。
        tracing_subscriber::registry()
            .with((*trace).clone())
            .try_init()?;
    }
    let mut connect = SqliteConnectOptions::new()
        .filename(&options.database)
        .read_only(true)
        .immutable(true)
        .create_if_missing(false);
    if trace.is_none() {
        connect = connect.disable_statement_logging();
    }
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(connect)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot open read-only database copy"))?;
    let owner: String = sqlx::query_scalar(r#"
        SELECT user_id FROM (
            SELECT m.user_id FROM marker_form_submission_model s JOIN marker_info_model m ON m.id=s.marker_id
            UNION ALL
            SELECT m.user_id FROM shape_form_submission_model s JOIN shape_model m ON m.id=s.shape_id
        ) GROUP BY user_id ORDER BY count(*) DESC,user_id LIMIT 1
    "#).fetch_one(&pool).await.map_err(|_| anyhow::anyhow!("Cannot select diagnostic account"))?;
    let query = if let Some(path) = &options.query_manifest {
        let manifest: Value = serde_json::from_slice(&std::fs::read(path)?)
            .map_err(|_| anyhow::anyhow!("Cannot read private query manifest"))?;
        let query: AnswerQuery =
            serde_json::from_value(manifest.get("query").cloned().unwrap_or(Value::Null))
                .map_err(|_| anyhow::anyhow!("Private query is invalid"))?;
        anyhow::ensure!(
            query.as_of.is_some(),
            "Private query must have a frozen as_of"
        );
        query
    } else {
        AnswerQuery {
            mode: "history".into(),
            as_of: Some(chrono::Utc::now()),
            limit: Some(50),
            ..Default::default()
        }
    };
    let timer = Instant::now();
    let data = load_answer_map(&pool, &owner, &query)
        .await
        .map_err(|_| anyhow::anyhow!("Answer-map loading failed"))?;
    let load_ms = timer.elapsed().as_secs_f64() * 1000.0;
    let answer_count = data.answer_count;
    let target_count = data.target_count;
    let marker_count = data.markers.len();
    let shape_count = data.shapes.len();
    let targets: Vec<_> = data
        .markers
        .iter()
        .map(|m| format!("marker:{}", m.id))
        .chain(data.shapes.iter().map(|s| format!("shape:{}", s.id)))
        .collect();
    drop(data);
    let tera = build_tera_extension()
        .map_err(|_| anyhow::anyhow!("Cannot load embedded production templates"))?;
    if let Some(trace) = &trace {
        instrument_templates(&tera, trace).await?;
    }
    let warmups = usize::from(trace.is_some());
    let trials = options.initial_samples.unwrap_or(1);
    let mut initial_samples = Vec::new();
    let mut html_ms = 0.0;
    let mut html_bytes = 0;
    for trial in 0..warmups + trials {
        let request = AnswerMapRequest {
            query: serde_json::to_string(&query)?,
            parent_origin: "http://127.0.0.1".into(),
            request_id: "private-profile".into(),
            analysis: None,
            initial_view: None,
        };
        let measured = trace.is_some() && trial >= warmups;
        if measured {
            trace.as_ref().unwrap().start();
        }
        let timer = Instant::now();
        let response = answer_map_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Extension(tera.clone()),
            Form(request),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Answer-map HTML generation failed"))?;
        let handler_ms = timer.elapsed().as_secs_f64() * 1000.0;
        anyhow::ensure!(
            response.status().is_success(),
            "Answer-map HTML generation failed"
        );
        let observation = if measured {
            Some(trace.as_ref().unwrap().finish(handler_ms)?)
        } else {
            None
        };
        let body_started = Instant::now();
        let html = to_bytes(response.into_body(), usize::MAX).await?;
        let body_ms = body_started.elapsed().as_secs_f64() * 1000.0;
        html_ms = timer.elapsed().as_secs_f64() * 1000.0;
        html_bytes = html.len();
        if let Some(mut observation) = observation {
            observation["trial"] = json!(trial - warmups + 1);
            observation["htmlBytes"] = json!(html_bytes);
            observation["bodyMaterializeMs"] = json!(body_ms);
            initial_samples.push(observation);
        }
        if trial + 1 == warmups + trials {
            write_private(&output, "map.html", &html)?;
        }
    }
    let initial_profile = if trace.is_some() {
        let median = |key: &str| {
            let mut values: Vec<f64> = initial_samples
                .iter()
                .filter_map(|row| row[key].as_f64())
                .collect();
            values.sort_by(f64::total_cmp);
            let mid = values.len() / 2;
            if values.len() % 2 == 0 {
                (values[mid - 1] + values[mid]) / 2.0
            } else {
                values[mid]
            }
        };
        json!({
            "warmupHandlerCalls":warmups,"samples":initial_samples,
            "medians":{
                "handlerMs":median("handlerMs"),"renderMs":median("renderMs"),
                "sqlObservedMs":median("sqlObservedMs"),"jsonEncodeMs":median("jsonEncodeMs"),
                "unattributedMs":median("unattributedMs")
            },
            "scope":{
                "handler":"Actual answer_map_handler await wall time; request construction and response-body materialization/transmission excluded.",
                "render":"Empty-output functions immediately before/after production template nodes; includes JSON filters and template output construction, excludes mutex waiting and Tera setup before the first node.",
                "json":"Original json_encode_for_html filter wall time and escaped output UTF-8 bytes, static section names in validated call order; a subset of renderMs, never add to renderMs.",
                "sql":"SQLx QueryLogger elapsed_secs observations: statement setup/execution/fetch and potentially consumer/row decoding time; not database-only. Unlogged work may remain.",
                "unattributed":"handlerMs minus summed observed SQL durations minus renderMs; includes Context conversion, body processing, scheduling, lock waits, unobserved setup/cleanup and instrumentation. Not strict pure CPU; overlapping observations may yield negative residuals.",
                "warmup":"An existing preliminary load_answer_map call precedes one warmup handler call; measured calls are sequential on the same read-only pool and fixed query/as_of."
            }
        })
    } else {
        Value::Null
    };

    let mut request = MapFilterRequest {
        query: query.clone(),
        targets,
        common_form_id: None,
        conditions: vec![],
        options_only: false,
    };
    let mut cases = vec![];
    let mut scenarios = vec![];
    let mut names = vec!["all_targets"];
    let initial = filter_targets(&pool, &owner, &request)
        .await
        .map_err(|_| anyhow::anyhow!("Initial map filtering failed"))?;
    let allowed_forms = json!(initial.forms.iter().map(|f| &f.id).collect::<Vec<_>>());
    let form: Option<String> = sqlx::query_scalar(r#"
        SELECT form_id FROM (
            SELECT s.source_form->>'id' AS form_id FROM marker_form_submission_model s JOIN marker_info_model m ON m.id=s.marker_id WHERE m.user_id=$1
            UNION ALL
            SELECT s.source_form->>'id' AS form_id FROM shape_form_submission_model s JOIN shape_model m ON m.id=s.shape_id WHERE m.user_id=$1
        ) WHERE form_id IN (SELECT value FROM json_each($2)) GROUP BY form_id ORDER BY count(*) DESC,form_id LIMIT 1
    "#).bind(&owner).bind(allowed_forms).fetch_optional(&pool).await.map_err(|_| anyhow::anyhow!("Cannot select diagnostic form"))?;
    scenarios.push(json!({"name":"all_targets","formId":null,"conditions":[],"answerCount":initial.answer_count,"targetCount":initial.target_count}));
    cases.push(json!({"name":"all_targets","request":request,"response":initial}));
    drop(initial);
    if let Some(form) = form {
        request.common_form_id = Some(form);
        let definitions = filter_targets(&pool, &owner, &request)
            .await
            .map_err(|_| anyhow::anyhow!("Form map filtering failed"))?;
        let field = definitions
            .fields
            .first()
            .map(|field| (field.id.clone(), field.field_type.clone()));
        names.push("selected_form");
        scenarios.push(json!({"name":"selected_form","formId":request.common_form_id,"conditions":[],"answerCount":definitions.answer_count,"targetCount":definitions.target_count}));
        cases.push(json!({"name":"selected_form","request":request,"response":definitions}));
        drop(definitions);
        if let Some((id, kind)) = field {
            for op in ["filled", "empty", "missing"] {
                request.conditions = vec![AnswerCondition {
                    field_id: id.clone(),
                    field_type: kind.clone(),
                    op: op.into(),
                    value: Value::Null,
                    upper: Value::Null,
                }];
                let timer = Instant::now();
                let result = filter_targets(&pool, &owner, &request)
                    .await
                    .map_err(|_| anyhow::anyhow!("Conditional map filtering failed"))?;
                names.push(op);
                scenarios.push(json!({"name":op,"formId":request.common_form_id,"conditions":request.conditions,"fieldId":id,"fieldType":kind,"answerCount":result.answer_count,"targetCount":result.target_count,"filterMs":timer.elapsed().as_secs_f64()*1000.0}));
                cases.push(json!({"name":op,"request":request,"response":result}));
            }
        }
    }
    write_private(&output, "filter-cases.json", &serde_json::to_vec(&cases)?)?;
    drop(cases);
    drop(request);
    let manifest = json!({"backend":"sqlite","html":"map.html","filterCases":"filter-cases.json","query":query,"scenarios":scenarios,
        "answers":answer_count,"targets":target_count,"markers":marker_count,"shapes":shape_count,"htmlBytes":html_bytes,"loadMs":load_ms,"htmlHandlerMs":html_ms,"bodyLimitBytes":1024*1024,"initialProfile":initial_profile});
    write_private(
        &output,
        "manifest.json",
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!(
        "{}",
        json!({"answers":answer_count,"targets":target_count,"markers":marker_count,"shapes":shape_count,"htmlBytes":html_bytes,"loadMs":load_ms,"htmlHandlerMs":html_ms,"initialProfile":initial_profile,"scenarios":names.len(),"manifest":"manifest.json"})
    );

    if options.serve {
        let stop = std::sync::Arc::new(tokio::sync::Notify::new());
        let stop_request = stop.clone();
        let app = Router::new()
            .route(
                "/",
                get(|| async {
                    Html("<!doctype html><title>Private diagnostic controller</title>")
                }),
            )
            .route("/form-answers/map", post(local_map_handler))
            // 任意の親地図・キャッシュ共存診断に使う、読み取り専用の編集画面の枠組み。
            .route(
                "/profile/parent-map",
                get(geocode_web_single::handler::map::map_get_handler),
            )
            .route("/form-answers/map-filter", post(filter_handler))
            .route("/form-answers/map-print", post(local_print_handler))
            .route(
                "/form-answers/map-csv-check",
                post(answer_map_csv::check_handler),
            )
            .route("/assets/{uri}", get(serve_static_file))
            .route(
                "/profile/manifest",
                get(move || {
                    let value = manifest.clone();
                    async move { Json(value) }
                }),
            )
            .route(
                "/profile/shutdown",
                post(move || {
                    let stop = stop_request.clone();
                    async move {
                        stop.notify_one();
                        Json(json!({"stopping":true}))
                    }
                }),
            )
            .layer(DefaultBodyLimit::max(1024 * 1024))
            .layer(from_fn(require_local_post_origin))
            .layer(Extension(owner))
            .layer(Extension(pool.clone()))
            .layer(Extension(tera));
        let listener =
            tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, options.port))
                .await?;
        println!(
            "{}",
            json!({"serverUrl":format!("http://{}",listener.local_addr()?),"bodyLimitBytes":1024*1024})
        );
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = stop.notified() => {} }
            })
            .await;
        pool.close().await;
        // ここで把握している非公開の成果物だけを削除し、入力のコピーは削除しない。
        for name in ["map.html", "filter-cases.json", "manifest.json"] {
            std::fs::remove_file(output.join(name))?;
        }
        std::fs::remove_dir(output)?;
        result?;
    } else {
        pool.close().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::loopback_origin;

    #[test]
    fn only_http_loopback_origins_are_accepted() {
        for origin in [
            "http://127.0.0.1",
            "http://127.0.0.1:8123",
            "http://localhost:8124",
            "http://[::1]:8125",
        ] {
            assert!(loopback_origin(origin));
        }
        for origin in [
            "null",
            "https://localhost",
            "http://example.com",
            "http://localhost.example.com",
            "http://127.0.0.2",
            "http://localhost/path",
            "http://localhost/",
            "http://user@localhost",
            "http://localhost?next=http://example.com",
            "http://localhost#fragment",
        ] {
            assert!(!loopback_origin(origin));
        }
    }
}
