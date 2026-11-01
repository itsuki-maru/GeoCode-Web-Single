use crate::error::AppError;
use axum::{
    Json,
    extract::{Extension, Path},
};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};

#[derive(Deserialize, Serialize)]
pub struct InputPolicy {
    pub restrict_free_text: bool,
}

// BEGIN IMMEDIATE serializes policy changes, object writes and form submissions.
pub async fn update_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(layer): Path<String>,
    Json(policy): Json<InputPolicy>,
) -> Result<Json<InputPolicy>, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let updated = sqlx::query(
        r#"
        UPDATE layer_model
        SET
            restrict_free_text = $1,
            update_at = $4
        WHERE id = $2
            AND user_id = $3
        "#,
    )
    .bind(policy.restrict_free_text)
    .bind(layer)
    .bind(user)
    .bind(chrono::Utc::now().naive_utc())
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    tx.commit().await?;
    Ok(Json(policy))
}

pub(crate) async fn restricted(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    layer: &str,
) -> Result<bool, AppError> {
    sqlx::query_scalar(
        r#"
        SELECT
            restrict_free_text
        FROM layer_model
        WHERE id = $1
            AND user_id = $2
        "#,
    )
    .bind(layer)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::NotFound)
}

pub(crate) fn reject_change(restricted: bool, changed: bool) -> Result<(), AppError> {
    if restricted && changed {
        return Err(AppError::Validation(
            "入力が制限されています。名前と所属レイヤのみ変更できます。".into(),
        ));
    }
    Ok(())
}
