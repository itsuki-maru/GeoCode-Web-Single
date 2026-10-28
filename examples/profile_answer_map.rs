//! Read-only answer-map HTML/API diagnostics against an explicit database copy.
//! Private artifacts are restricted to this checkout's ignored target directory.
//! No application startup, dotenv loading, migrations, SQL/bind logging or writes to SQLite.
use axum::{
    Form, Json, Router,
    body::to_bytes,
    extract::{DefaultBodyLimit, Extension, Request},
    http::{Method, StatusCode, header},
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
    io::Write,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Component, Path, PathBuf},
    time::Instant,
};

struct Options {
    database: PathBuf,
    output: PathBuf,
    serve: bool,
    port: u16,
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
    answer_map_handler(user, pool, templates, Form(request)).await
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
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--database" => database = args.next().map(PathBuf::from),
            "--output-directory" => output = args.next().map(PathBuf::from),
            "--serve" => serve = true,
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
    let output =
        output.ok_or_else(|| anyhow::anyhow!("--output-directory target/PRIVATE is required"))?;
    Ok(Options {
        database,
        output,
        serve,
        port,
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
    // Resolve existing ancestors before creating anything, including Windows junctions.
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
    // This runs on the initial single thread, before a Tokio runtime exists.
    // Only this process's environment is changed; no existing config file is read.
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
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&options.database)
                .read_only(true)
                .immutable(true)
                .create_if_missing(false)
                .disable_statement_logging(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Cannot open read-only database copy"))?;
    let owner: String = sqlx::query_scalar(r#"
        SELECT user_id FROM (
            SELECT m.user_id FROM marker_form_submission_model s JOIN marker_info_model m ON m.id=s.marker_id
            UNION ALL
            SELECT m.user_id FROM shape_form_submission_model s JOIN shape_model m ON m.id=s.shape_id
        ) GROUP BY user_id ORDER BY count(*) DESC,user_id LIMIT 1
    "#).fetch_one(&pool).await.map_err(|_| anyhow::anyhow!("Cannot select diagnostic account"))?;
    let query = AnswerQuery {
        mode: "history".into(),
        as_of: Some(chrono::Utc::now()),
        limit: Some(50),
        ..Default::default()
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
    let timer = Instant::now();
    let response = answer_map_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Extension(tera.clone()),
        Form(AnswerMapRequest {
            query: serde_json::to_string(&query)?,
            parent_origin: "http://127.0.0.1".into(),
            request_id: "private-profile".into(),
            analysis: None,
            initial_view: None,
        }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Answer-map HTML generation failed"))?;
    anyhow::ensure!(
        response.status().is_success(),
        "Answer-map HTML generation failed"
    );
    let html = to_bytes(response.into_body(), usize::MAX).await?;
    let html_ms = timer.elapsed().as_secs_f64() * 1000.0;
    write_private(&output, "map.html", &html)?;
    let html_bytes = html.len();
    drop(html);

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
        "answers":answer_count,"targets":target_count,"markers":marker_count,"shapes":shape_count,"htmlBytes":html_bytes,"loadMs":load_ms,"htmlHandlerMs":html_ms,"bodyLimitBytes":1024*1024});
    write_private(
        &output,
        "manifest.json",
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!(
        "{}",
        json!({"answers":answer_count,"targets":target_count,"markers":marker_count,"shapes":shape_count,"htmlBytes":html_bytes,"loadMs":load_ms,"htmlHandlerMs":html_ms,"scenarios":names.len(),"manifest":"manifest.json"})
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
        // Only our known private artifacts are removed, never the input copy.
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
