//! レイヤ管理フォーム。書き込み元は必ずBEGIN IMMEDIATEで全体を原子的に保存する。
use crate::{error::AppError, model::LayerNameUpdatePayload};
use axum::{
    Json,
    extract::{Extension, Path},
    http::header,
    response::{IntoResponse, Response},
};
use serde_json::json;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

pub async fn get_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    let mut tx = pool.begin().await?;
    let (form, version, revision): (Option<String>, Option<i32>, i64) = sqlx::query_as(
        r#"
        SELECT common_form_id, common_form_version, form_binding_revision FROM layer_model WHERE
        id=$1 AND user_id=$2
        "#,
    )
    .bind(&id)
    .bind(&user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let (markers, shapes): (i64, i64) = sqlx::query_as(
        r#"
        SELECT (SELECT count(*) FROM marker_info_model WHERE layer_id=$1 AND user_id=$2),
        (SELECT count(*) FROM shape_model WHERE layer_id=$1 AND user_id=$2)
        "#,
    )
    .bind(&id)
    .bind(&user)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL,"no-store")],Json(json!({"common_form_id":form,"common_form_version":version,"revision":revision,"marker_count":markers,"shape_count":shapes}))).into_response())
}
async fn apply_object(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    id: &str,
    layer: &str,
    form: &str,
) -> Result<(), AppError> {
    // IDは既存SQLiteと同じUUID文字列。既存公開URLと公開可否はON CONFLICTで保持する。
    sqlx::query(&format!(
        r#"
        INSERT INTO {kind}_form_config_model (
            {kind}_id,
            public_id,
            enabled,
            form_title,
            form_description,
            form_schema,
            password_hash,
            source_form,
            managed_layer_id,
            create_at,
            update_at
        )
        SELECT
            $1,
            $2,
            false,
            form_title,
            form_description,
            form_schema,
            password_hash,
            json_object('id', id, 'version', version),
            $3,
            $4,
            $4
        FROM common_form_model
        WHERE id = $5
            AND user_id = $6
            AND NOT deleted
        ON CONFLICT ({kind}_id) DO UPDATE SET
            form_title = excluded.form_title,
            form_description = excluded.form_description,
            form_schema = excluded.form_schema,
            password_hash = excluded.password_hash,
            source_form = excluded.source_form,
            managed_layer_id = excluded.managed_layer_id,
            update_at = excluded.update_at
        "#
    ))
    .bind(id)
    .bind(Uuid::new_v4().to_string())
    .bind(layer)
    .bind(chrono::Utc::now().naive_utc())
    .bind(form)
    .bind(user)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
async fn apply_layer(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    layer: &str,
    form: &str,
) -> Result<(), AppError> {
    for (kind, table) in [("marker", "marker_info_model"), ("shape", "shape_model")] {
        let ids: Vec<String> = sqlx::query_scalar(&format!(
            r#"
            SELECT id FROM {table} WHERE layer_id=$1 AND user_id=$2 ORDER BY id
            "#
        ))
        .bind(layer)
        .bind(user)
        .fetch_all(&mut **tx)
        .await?;
        for id in ids {
            apply_object(tx, user, kind, &id, layer, form).await?;
        }
    }
    Ok(())
}
pub(crate) async fn change(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    layer: &str,
    p: &LayerNameUpdatePayload,
) -> Result<(), AppError> {
    if !p.update_common_form {
        return Ok(());
    }
    let revision: i64 = sqlx::query_scalar(
        r#"
        SELECT form_binding_revision FROM layer_model WHERE id=$1 AND user_id=$2
        "#,
    )
    .bind(layer)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT (SELECT count(*) FROM marker_info_model WHERE layer_id=$1 AND user_id=$2)+(SELECT
        count(*) FROM shape_model WHERE layer_id=$1 AND user_id=$2)
        "#,
    )
    .bind(layer)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    if p.form_binding_revision != Some(revision) || p.form_target_count != Some(count) {
        return Err(AppError::Conflict);
    }
    let version = if let Some(form) = &p.common_form_id {
        let v: i32 = sqlx::query_scalar(
            r#"
            SELECT version FROM common_form_model WHERE id=$1 AND user_id=$2 AND NOT deleted
            "#,
        )
        .bind(form)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
        if p.common_form_version != Some(v) {
            return Err(AppError::Conflict);
        }
        apply_layer(tx, user, layer, form).await?;
        Some(v)
    } else {
        for kind in ["marker", "shape"] {
            let ids: Vec<String> = sqlx::query_scalar(&format!(
                r#"
                SELECT {kind}_id FROM {kind}_form_config_model WHERE managed_layer_id=$1
                "#
            ))
            .bind(layer)
            .fetch_all(&mut **tx)
            .await?;
            for id in ids {
                sqlx::query(&format!(
                    r#"
                    UPDATE {kind}_form_config_model
                    SET
                        enabled = false,
                        public_id = $1,
                        form_title = '',
                        form_description = '',
                        form_schema = '{{"fields":[]}}',
                        password_hash = NULL,
                        source_form = NULL,
                        managed_layer_id = NULL,
                        update_at = $2
                    WHERE {kind}_id = $3
                    "#
                ))
                .bind(Uuid::new_v4().to_string())
                .bind(chrono::Utc::now().naive_utc())
                .bind(id)
                .execute(&mut **tx)
                .await?;
            }
        }
        None
    };
    sqlx::query(
        r#"
        UPDATE layer_model
        SET
            common_form_id = $1,
            common_form_version = $2,
            form_binding_revision = form_binding_revision + 1
        WHERE id = $3
            AND user_id = $4
        "#,
    )
    .bind(&p.common_form_id)
    .bind(version)
    .bind(layer)
    .bind(user)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
pub(crate) async fn sync_object(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    kind: &str,
    id: &str,
    layer: &str,
) -> Result<(), AppError> {
    let form: Option<String> = sqlx::query_scalar(
        r#"
        SELECT common_form_id FROM layer_model WHERE id=$1 AND user_id=$2
        "#,
    )
    .bind(layer)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if let Some(form) = form {
        apply_object(tx, user, kind, id, layer, &form).await?;
    } else {
        sqlx::query(&format!(
            r#"
            UPDATE {kind}_form_config_model
            SET
                managed_layer_id = NULL,
                update_at = $1
            WHERE {kind}_id = $2
                AND managed_layer_id IS NOT NULL
            "#
        ))
        .bind(chrono::Utc::now().naive_utc())
        .bind(id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}
pub(crate) async fn propagate(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    form: &str,
    password_changed: bool,
) -> Result<(), AppError> {
    let layers: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT id FROM layer_model WHERE user_id=$1 AND common_form_id=$2 ORDER BY id
        "#,
    )
    .bind(user)
    .bind(form)
    .fetch_all(&mut **tx)
    .await?;
    for layer in layers {
        apply_layer(tx, user, &layer, form).await?;
        sqlx::query(
            r#"
            UPDATE layer_model SET common_form_version=(SELECT version FROM common_form_model WHERE
            id=$1), form_binding_revision=form_binding_revision+1 WHERE id=$2
            "#,
        )
        .bind(form)
        .bind(layer)
        .execute(&mut **tx)
        .await?;
    }
    if password_changed {
        for (kind, table) in [("marker", "marker_info_model"), ("shape", "shape_model")] {
            sqlx::query(&format!(
                r#"
                UPDATE {kind}_form_config_model
                SET
                    password_hash = (
                        SELECT
                            password_hash
                        FROM common_form_model
                        WHERE id = $1
                            AND user_id = $2
                    ),
                    update_at = $3
                WHERE source_form ->> 'id' = $1
                    AND {kind}_id IN (
                    SELECT
                        id
                    FROM {table}
                    WHERE user_id = $2
                )
                "#
            ))
            .bind(form)
            .bind(user)
            .bind(chrono::Utc::now().naive_utc())
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}
pub(crate) async fn usage(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    form: &str,
) -> Result<(i64, i64, i64), AppError> {
    let layers: i64 = sqlx::query_scalar(
        r#"
        SELECT count(*) FROM layer_model WHERE user_id=$1 AND common_form_id=$2
        "#,
    )
    .bind(user)
    .bind(form)
    .fetch_one(&mut **tx)
    .await?;
    let (mut managed, mut applied) = (0, 0);
    for (kind, table) in [("marker", "marker_info_model"), ("shape", "shape_model")] {
        let (m, a): (i64, i64) = sqlx::query_as(&format!(
            r#"
            SELECT count(*) FILTER(WHERE c.managed_layer_id IS NOT NULL), count(*) FROM
            {kind}_form_config_model c JOIN {table} o ON o.id=c.{kind}_id WHERE o.user_id=$1 AND
            c.source_form->>'id'=$2
            "#
        ))
        .bind(user)
        .bind(form)
        .fetch_one(&mut **tx)
        .await?;
        managed += m;
        applied += a;
    }
    Ok((layers, managed, applied))
}

pub(crate) async fn ensure_owned(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    layer: &str,
) -> Result<(), AppError> {
    let owned: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(SELECT 1 FROM layer_model WHERE id=$1 AND user_id=$2)
        "#,
    )
    .bind(layer)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    if !owned {
        return Err(AppError::NotFound);
    }
    Ok(())
}
