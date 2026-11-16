use crate::error::AppError;
use crate::model::{
    LayerCreateQueryParams, LayerCreatedResponse, LayerDeleteResponse, LayerNameUpdatePayload,
    LayerObject, MasterLayerIdResponse, MessageApi, ReturningId,
};
use crate::utils::vec_to_hashmap;
use axum::{
    Json,
    extract::{Extension, Path, Query},
    http::HeaderMap,
    response::IntoResponse,
};
use chrono::Utc;
use sqlx::sqlite::SqlitePool;
use sqlx::{Result, Sqlite, Transaction, query, query_as};
use std::collections::HashMap;
use uuid::Uuid;

// ユーザー毎のマスターレイヤID取得
pub async fn master_layer_get_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<MasterLayerIdResponse>, AppError> {
    let master_layer_data = query_as!(
        ReturningId,
        r#"
        SELECT id FROM layer_model
        WHERE user_id = $1 AND is_master = $2
        "#,
        user_id,
        true,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let id = master_layer_data.id;
    Ok(Json(MasterLayerIdResponse {
        id: id.clone(),
        message: format!("Your master layer is {}.", id.clone()),
    }))
}

// ユーザー毎の全レイヤを取得
pub async fn get_all_layers_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
) -> Result<Json<HashMap<String, LayerObject>>, AppError> {
    // AI作成後の同期だけ元の利用者を照合し、従来の手動取得契約は維持する。
    if headers.contains_key("x-ai-account-id") {
        crate::handler::ai::validate_account(&user_id, &headers)?;
    }
    let layer_objects = sqlx::query_as::<_, LayerObject>(
        r#"
        SELECT
            layer_model.id,
            layer_model.user_id,
            layer_model.layer_name,
            layer_model.is_master,
            layer_model.restrict_free_text,
            layer_model.marker_icon_id,
            marker_icon_model.uuid_filename AS marker_icon_filename
        FROM layer_model
        LEFT JOIN marker_icon_model ON marker_icon_model.id = layer_model.marker_icon_id
        WHERE layer_model.user_id = $1
        "#,
    )
    .bind(&user_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let layers_hash_map = vec_to_hashmap(layer_objects, |l| l.id.clone());
    Ok(Json(layers_hash_map))
}

// レイヤ作成ハンドラー
pub async fn create_layer_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(params): Query<LayerCreateQueryParams>,
) -> Result<Json<LayerCreatedResponse>, AppError> {
    let name = params
        .name
        .as_deref()
        .ok_or_else(|| AppError::Validation("レイヤ名を指定してください。".into()))?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let id = create_layer_tx(&mut tx, &user_id, name).await?;
    tx.commit().await?;
    Ok(Json(LayerCreatedResponse {
        id,
        message: "Layer Created.".into(),
    }))
}

pub(crate) fn validate_layer_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "レイヤ名は制御文字を含まない1〜100文字で入力してください。".into(),
        ));
    }
    Ok(name.to_owned())
}

/// 手動APIと確認済みAI操作で、名前の検証と所有者を固定した作成を共有する。
pub(crate) async fn create_layer_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    name: &str,
) -> Result<String, AppError> {
    let name = validate_layer_name(name)?;
    let now = Utc::now().naive_utc();
    Ok(sqlx::query_scalar(
        r#"
        INSERT INTO layer_model (
            id,
            user_id,
            layer_name,
            is_master,
            create_at,
            update_at
        ) VALUES (
            $1,
            $2,
            $3,
            false,
            $4,
            $4
        )
        RETURNING id
        "#,
    )
    .bind(Uuid::now_v7().to_string())
    .bind(user)
    .bind(name)
    .bind(now)
    .fetch_one(&mut **tx)
    .await?)
}

// レイヤ削除ハンドラー
pub async fn delete_layer_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(layer_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let query_result = query!(
        r#"
        DELETE FROM layer_model
        WHERE id = $1 AND user_id = $2 AND is_master = false
        "#,
        layer_id,
        user_id
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let affected_rows = query_result.rows_affected();
    if affected_rows > 0 {
        tx.commit().await?;
        Ok(Json(LayerDeleteResponse {
            message: "Layer successfully deleted.".to_string(),
        }))
    } else {
        Err(AppError::BadRequest)
    }
}

// レイヤ名変更ハンドラー
pub async fn update_layername_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(layer_id): Path<String>,
    Json(payload): Json<LayerNameUpdatePayload>,
) -> Result<Json<MessageApi>, AppError> {
    let now = Utc::now().naive_utc();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if payload.name.trim().is_empty() {
        return Err(AppError::Validation(
            "layer name must not be empty".to_string(),
        ));
    }
    if payload.update_marker_icon {
        if let Some(ref icon_id) = payload.marker_icon_id {
            let owned = sqlx::query_scalar::<_, bool>(
                r#"
                SELECT
                    EXISTS (
                    SELECT
                        1
                    FROM marker_icon_model
                    WHERE id = $1
                        AND user_id = $2
                )
                "#,
            )
            .bind(&icon_id)
            .bind(&user_id)
            .fetch_one(&mut *tx)
            .await?;
            if !owned {
                return Err(AppError::BadRequest);
            }
        }
    }
    let query_result = sqlx::query(
        r#"
        UPDATE layer_model
        SET layer_name = CASE WHEN is_master THEN layer_name ELSE $1 END,
            marker_icon_id = CASE WHEN $2 THEN $3 ELSE marker_icon_id END,
            update_at = $4
        WHERE id = $5 AND user_id = $6
        "#,
    )
    .bind(payload.name.trim())
    .bind(payload.update_marker_icon)
    .bind(&payload.marker_icon_id)
    .bind(now)
    .bind(&layer_id)
    .bind(&user_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    if query_result.rows_affected() > 0 {
        super::layer_forms::change(&mut tx, &user_id, &layer_id, &payload).await?;
        tx.commit().await?;
        Ok(Json(MessageApi {
            message: "Layer successfully updated.".to_string(),
        }))
    } else {
        Err(AppError::BadRequest)
    }
}
