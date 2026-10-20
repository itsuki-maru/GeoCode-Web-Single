use geocode_web_single as app;
use sqlx::SqlitePool as Pool;

const POSTGRES: bool = false;

async fn connect(profile: &str, verify_only: bool) -> anyhow::Result<Pool> {
    use sqlx::sqlite::SqliteConnectOptions;
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/analysis-test");
    let path = if profile == "basic" {
        base.join("geocode-web.sqlite")
    } else {
        base.join(profile).join("geocode-web.sqlite")
    };
    if !verify_only {
        std::fs::create_dir_all(path.parent().unwrap())?;
    }
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(!verify_only)
        .foreign_keys(true);
    let pool = Pool::connect_with(options).await?;
    let populated: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='user_model') AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name='analysis_fixture_metadata')",
    ).fetch_one(&pool).await?;
    anyhow::ensure!(populated == 0, "既存のアプリDBへの投入は拒否します");
    if !verify_only {
        sqlx::query("CREATE TABLE IF NOT EXISTS analysis_fixture_metadata (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL)").execute(&pool).await?;
        app::db::run_migrations(&pool).await?;
    }
    println!("検証DB: {}", path.display());
    Ok(pool)
}

async fn csv_count(
    pool: &Pool,
    user: &str,
    q: app::handler::form_answers::AnswerQuery,
) -> anyhow::Result<i64> {
    let response = app::handler::form_answers::export_answers_handler(
        axum::extract::Extension(user.to_string()),
        axum::extract::Extension(pool.clone()),
        axum::Json(q),
    )
    .await?;
    csv_body_count(response).await
}

async fn search(
    pool: &Pool,
    user: &str,
    q: app::handler::form_answers::AnswerQuery,
) -> anyhow::Result<i64> {
    Ok(app::handler::form_answers::search_answers_handler(
        axum::extract::Extension(user.to_string()),
        axum::extract::Extension(pool.clone()),
        axum::Json(q),
    )
    .await?
    .0
    .total)
}

async fn map_counts(
    pool: &Pool,
    user: &str,
    q: &app::handler::form_answers::AnswerQuery,
) -> anyhow::Result<(i64, i64)> {
    let data = app::handler::answer_map::load_answer_map(pool, user, q).await?;
    anyhow::ensure!(
        data.markers.len() + data.shapes.len() == data.target_count as usize,
        "地図データ件数が不一致です"
    );
    Ok((data.answer_count, data.target_count))
}

include!("analysis_data/common.rs");
