//! 地図に反映済みの回答条件と表示対象に限定したCSV。列定義・出力処理は回答一覧と共通。
use super::{
    answer_map_filter::{self, MapFilterRequest},
    form_answers::{self, ExportScope, FieldOption},
};
use crate::error::AppError;
use axum::{
    Form, Json,
    extract::Extension,
    http::header,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::{Sqlite, SqlitePool, Transaction};

async fn prepare(
    pool: &SqlitePool,
    user: &str,
    request: MapFilterRequest,
) -> Result<
    (
        Transaction<'static, Sqlite>,
        i64,
        Vec<FieldOption>,
        ExportScope,
        DateTime<Utc>,
    ),
    AppError,
> {
    let at = answer_map_filter::validate_request(&request)?;
    if request.options_only {
        return Err(AppError::Validation("CSV出力の要求情報が不正です。".into()));
    }
    let scope = answer_map_filter::scope(&request.targets)?;
    let mut tx = super::answer_sqlite::begin_read(pool).await?;
    answer_map_filter::validate_conditions(&mut tx, user, &request, at, &scope, true).await?;
    let scope = ExportScope::Map { request, scope };
    let count: i64 = scope
        .build(user, at)
        .push(" SELECT count(*) FROM export_rows")
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await?;
    if count > form_answers::EXPORT_LIMIT {
        return Err(AppError::Validation(
            "CSVは10,000回答まで出力できます。地図の条件を絞り込んでください。".into(),
        ));
    }
    let fields =
        form_answers::fields_from_query(&mut tx, scope.build(user, at), "export_rows", &mut vec![])
            .await?
            .into_values()
            .collect();
    Ok((tx, count, fields, scope, at))
}

pub async fn check_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(request): Json<MapFilterRequest>,
) -> Result<Response, AppError> {
    let (tx, count, _, _, _) = prepare(&pool, &user, request).await?;
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"count":count})),
    )
        .into_response())
}

pub async fn download_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Form(form): Form<form_answers::CsvDownload>,
) -> Result<Response, AppError> {
    let request = serde_json::from_str::<MapFilterRequest>(&form.query)
        .map_err(|_| AppError::Validation("CSV検索条件が不正です。".into()))?;
    let (tx, count, fields, scope, at) = prepare(&pool, &user, request).await?;
    form_answers::stream_csv(user, tx, count, fields, scope, at, "geocode-answer-map.csv")
}
