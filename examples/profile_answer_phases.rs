//! Read-only phase measurement of answer handlers; prints aggregate timings only.
use axum::{Json, extract::Extension};
use geocode_web_single::handler::form_answers::{
    AnswerQuery, answer_options_handler, search_answers_handler,
};
use serde_json::{Value, json};
use sqlx::{
    Row,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{
    Layer,
    layer::{Context, SubscriberExt},
    util::SubscriberInitExt,
};

#[derive(Default)]
struct QueryEvent {
    statement: String,
    elapsed: Option<f64>,
    rows: u64,
}
impl Visit for QueryEvent {
    fn record_str(&mut self, f: &Field, v: &str) {
        if f.name() == "db.statement" {
            self.statement = v.into();
        }
    }
    fn record_f64(&mut self, f: &Field, v: f64) {
        if f.name() == "elapsed_secs" {
            self.elapsed = Some(v);
        }
    }
    fn record_u64(&mut self, f: &Field, v: u64) {
        if f.name() == "rows_returned" {
            self.rows = v;
        }
    }
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        if f.name() == "db.statement" {
            self.statement = format!("{v:?}");
        }
    }
}
#[derive(Clone, Default)]
struct TimingLayer {
    events: Arc<Mutex<Vec<Value>>>,
}
impl<S: Subscriber> Layer<S> for TimingLayer {
    fn on_event(&self, e: &Event<'_>, _: Context<'_, S>) {
        if e.metadata().target() != "sqlx::query" {
            return;
        }
        let mut v = QueryEvent::default();
        e.record(&mut v);
        let Some(elapsed) = v.elapsed else {
            return;
        };
        let s = v.statement.to_lowercase();
        let phase = if s.contains("count(distinct target_type") {
            "count"
        } else if s.contains("definition_rank") {
            "field_definitions"
        } else if s.contains("from filtered") && s.contains("limit") {
            "page"
        } else if s.contains(") page order by") {
            "page_details"
        } else if s.contains("from common_form_revision_model") {
            "form_revisions"
        } else if s.contains("from common_form_model f") {
            "form_candidates"
        } else if s.contains("from layer_model") {
            "layers"
        } else {
            "other"
        };
        self.events
            .lock()
            .unwrap()
            .push(json!({"phase":phase, "ms":elapsed*1000.0, "rows":v.rows}));
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let mut database = None;
    let mut output = None;
    let mut samples = 3usize;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--database" => database = Some(PathBuf::from(args.next().expect("database path"))),
            "--output" => output = Some(PathBuf::from(args.next().expect("output path"))),
            "--samples" => samples = args.next().expect("sample count").parse()?,
            _ => anyhow::bail!("Unknown argument: {arg}"),
        }
    }
    anyhow::ensure!(samples > 0, "Samples must be positive");
    let database = database.ok_or_else(|| anyhow::anyhow!("--database PATH is required"))?;
    anyhow::ensure!(database.is_file(), "Database must already exist");
    let trace = TimingLayer::default();
    tracing_subscriber::registry().with(trace.clone()).init();
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(database)
                .read_only(true)
                .create_if_missing(false),
        )
        .await?;
    let user: String = sqlx::query_scalar("SELECT user_id FROM (SELECT m.user_id FROM marker_form_submission_model s JOIN marker_info_model m ON m.id=s.marker_id UNION ALL SELECT m.user_id FROM shape_form_submission_model s JOIN shape_model m ON m.id=s.shape_id) GROUP BY user_id ORDER BY count(*) DESC,user_id LIMIT 1").fetch_one(&pool).await?;
    let form: String = sqlx::query_scalar("SELECT form_id FROM (SELECT m.user_id,s.source_form->>'id' form_id FROM marker_form_submission_model s JOIN marker_info_model m ON m.id=s.marker_id UNION ALL SELECT m.user_id,s.source_form->>'id' form_id FROM shape_form_submission_model s JOIN shape_model m ON m.id=s.shape_id) a WHERE a.user_id=$1 AND form_id IN (SELECT id FROM common_form_model WHERE user_id=$1) GROUP BY form_id ORDER BY count(*) DESC,form_id LIMIT 1").bind(&user).fetch_one(&pool).await?;
    let stats = sqlx::query("WITH a AS (SELECT s.form_snapshot,s.create_at,s.source_form FROM marker_form_submission_model s JOIN marker_info_model m ON m.id=s.marker_id WHERE m.user_id=$1 UNION ALL SELECT s.form_snapshot,s.create_at,s.source_form FROM shape_form_submission_model s JOIN shape_model m ON m.id=s.shape_id WHERE m.user_id=$1) SELECT count(*) answers,count(DISTINCT create_at) timestamps,coalesce(sum(json_array_length(form_snapshot,'$.form_schema.fields')),0) field_occurrences,count(DISTINCT json_extract(form_snapshot,'$.form_schema.fields')) arrays,sum(CASE WHEN source_form->>'id'=$2 THEN 1 ELSE 0 END) largest_form_answers FROM a").bind(&user).bind(&form).fetch_one(&pool).await?;
    let dataset = json!({"answers":stats.get::<i64,_>("answers"),"distinctTimestampStrings":stats.get::<i64,_>("timestamps"),"fieldOccurrences":stats.get::<i64,_>("field_occurrences"),"distinctFieldArrays":stats.get::<i64,_>("arrays"),"largestFormAnswers":stats.get::<i64,_>("largest_form_answers")});
    println!("{dataset}");
    let mut trials = vec![];
    for (case, form_id, mode) in [
        ("all_history", None, "history"),
        ("largest_form_history", Some(form.clone()), "history"),
        ("largest_form_latest", Some(form), "latest"),
    ] {
        for trial in 0..=samples {
            let query = AnswerQuery {
                mode: mode.into(),
                common_form_id: form_id.clone(),
                limit: Some(50),
                ..Default::default()
            };
            trace.events.lock().unwrap().clear();
            let start = Instant::now();
            let options = answer_options_handler(
                Extension(user.clone()),
                Extension(pool.clone()),
                Json(query.clone()),
            )
            .await?
            .0;
            let options_ms = start.elapsed().as_secs_f64() * 1000.0;
            let options_phases = std::mem::take(&mut *trace.events.lock().unwrap());
            let start = Instant::now();
            let page = search_answers_handler(
                Extension(user.clone()),
                Extension(pool.clone()),
                Json(query),
            )
            .await?
            .0;
            let search_ms = start.elapsed().as_secs_f64() * 1000.0;
            let search_phases = std::mem::take(&mut *trace.events.lock().unwrap());
            if trial > 0 {
                let result = json!({"case":case,"trial":trial,"optionsMs":options_ms,"searchMs":search_ms,"optionsPhases":options_phases,"searchPhases":search_phases,"fields":options["fields"].as_array().unwrap().len(),"total":page.total,"targets":page.target_count,"rows":page.rows.len()});
                println!("{result}");
                trials.push(result);
            }
        }
    }
    pool.close().await;
    if let Some(output) = output {
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(
            output,
            serde_json::to_vec_pretty(&json!({
                "measuredAt":chrono::Utc::now().to_rfc3339(),
                "build":if cfg!(debug_assertions) { "debug" } else { "release" },
                "dataset":dataset,"trials":trials,"notes":[
                    "Real Rust/SQLx handlers on an explicitly selected read-only DB; no application startup or migrations.",
                "Read-only pool capped at two connections, sequential endpoints to separate phases, one warmup before measured trials.",
                    "Excludes HTTP, JSON serialization, browser parsing and UI. No response contents, IDs or names recorded.",
                    "Field aggregation is absent in all_history options. The largest account and its largest referenced form are selected internally. Requires at least one owned form referenced by answers.",
                    "Options always collects history definitions, including in the largest_form_latest case."
                ]
            }))?,
        )?;
    }
    Ok(())
}
