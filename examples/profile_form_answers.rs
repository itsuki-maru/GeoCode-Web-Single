//! 実際の回答ハンドラーの初回処理を読み取り専用で計測し、アプリの起動やマイグレーションは行わない。
use axum::{Json, extract::Extension};
use geocode_web_single::handler::form_answers::{
    AnswerQuery, answer_options_handler, search_answers_handler,
};
use serde_json::json;
use sqlx::{sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions};
use std::{path::PathBuf, time::Instant};

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
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(database)
                .read_only(true)
                .create_if_missing(false),
        )
        .await?;
    let user: String = sqlx::query_scalar(
        "SELECT user_id FROM (
            SELECT m.user_id FROM marker_form_submission_model s JOIN marker_info_model m ON m.id=s.marker_id
            UNION ALL
            SELECT m.user_id FROM shape_form_submission_model s JOIN shape_model m ON m.id=s.shape_id
        ) GROUP BY user_id ORDER BY count(*) DESC, user_id LIMIT 1",
    )
    .fetch_one(&pool)
    .await?;
    let query = || AnswerQuery {
        mode: "history".into(),
        limit: Some(50),
        ..Default::default()
    };
    let mut trials = Vec::new();
    // 一度ウォームアップしてから、互いに独立した選択肢取得と検索のリクエストを同時に実行する。
    for trial in 0..=samples {
        let started = Instant::now();
        let (options, page) = tokio::try_join!(
            async {
                let timer = Instant::now();
                let value = answer_options_handler(
                    Extension(user.clone()),
                    Extension(pool.clone()),
                    Json(query()),
                )
                .await?
                .0;
                Ok::<_, anyhow::Error>((value, timer.elapsed().as_secs_f64() * 1000.0))
            },
            async {
                let timer = Instant::now();
                let value = search_answers_handler(
                    Extension(user.clone()),
                    Extension(pool.clone()),
                    Json(query()),
                )
                .await?
                .0;
                Ok::<_, anyhow::Error>((value, timer.elapsed().as_secs_f64() * 1000.0))
            }
        )?;
        let ready_ms = started.elapsed().as_secs_f64() * 1000.0;
        let serialize = Instant::now();
        let options_bytes = serde_json::to_vec(&options.0)?.len();
        let search_bytes = serde_json::to_vec(&page.0)?.len();
        let serialize_ms = serialize.elapsed().as_secs_f64() * 1000.0;
        if trial > 0 {
            let result = json!({
                "trial":trial, "optionsMs":options.1, "searchMs":page.1,
                "readyMs":ready_ms, "serializationMs":serialize_ms,
                "optionsBytes":options_bytes, "searchBytes":search_bytes,
                "forms":options.0["forms"].as_array().unwrap().len(),
                "layers":options.0["layers"].as_array().unwrap().len(),
                "fields":options.0["fields"].as_array().unwrap().len(),
                "answers":page.0.total, "targets":page.0.target_count, "rows":page.0.rows.len(),
            });
            println!("{result}");
            trials.push(result);
        }
    }
    pool.close().await;
    if let Some(output) = output {
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let report = json!({
            "measuredAt":chrono::Utc::now().to_rfc3339(),
            "build":if cfg!(debug_assertions) { "debug" } else { "release" },
            "notes":[
                "Read-only existing SQLite DB; no migrations or application configuration changes.",
                "The account with the most answers is selected internally. No IDs, names, answers, or credentials are printed or saved.",
                "Real Rust/SQLx handlers and timestamp collations; two read-only pool connections; one warm-up before parallel-request trials.",
                "Includes JSON serialization separately, excludes HTTP transport, browser parsing, Vue, and painting."
            ],
            "trials":trials
        });
        std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    }
    Ok(())
}
