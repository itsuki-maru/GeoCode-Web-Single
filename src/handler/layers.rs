use crate::error::AppError;
use crate::model::{
    LayerCreateQueryParams, LayerCreatedResponse, LayerDeleteResponse, LayerNameUpdatePayload,
    LayerObject, MasterLayerIdResponse, MessageApi, ReturningId,
};
use crate::utils::vec_to_hashmap;
use axum::{
    Json,
    extract::{Extension, Path, Query},
    response::IntoResponse,
};
use chrono::Utc;
use sqlx::sqlite::SqlitePool;
use sqlx::{Result, query, query_as};
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
) -> Result<Json<HashMap<String, LayerObject>>, AppError> {
    let layer_objects = query_as!(
        LayerObject,
        r#"
        SELECT
            id,
            user_id,
            layer_name,
            is_master
        FROM layer_model
        WHERE user_id = $1
        "#,
        user_id,
    )
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
    // 新規ID
    let new_layer_id = Uuid::now_v7().to_string();

    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    match params.name {
        Some(name) => {
            let new_layer_id = query_as!(
                ReturningId,
                r#"
                INSERT INTO layer_model (
                    id,
                    user_id,
                    layer_name,
                    is_master,
                    create_at,
                    update_at
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
                "#,
                new_layer_id,
                user_id,
                name,
                false,
                now,
                now,
            )
            .fetch_one(&pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "database error.");
                AppError::Sqlx(e)
            })?;

            Ok(Json(LayerCreatedResponse {
                id: new_layer_id.id,
                message: "Layer Created.".to_string(),
            }))
        },
        None => Err(AppError::InternalServerError),
    }
}

// レイヤ削除ハンドラー
pub async fn delete_layer_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(layer_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let query_result = query!(
        r#"
        DELETE FROM layer_model
        WHERE id = $1 AND user_id = $2 AND is_master = false
        "#,
        layer_id,
        user_id
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let affected_rows = query_result.rows_affected();
    if affected_rows > 0 {
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
    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    // レイヤのID、ユーザーIDが一致し、マスタレイヤでないもののみ変更可能
    let query_result = query!(
        r#"
        UPDATE layer_model
        SET layer_name = $1, update_at = $2
        WHERE id = $3 AND user_id = $4 AND is_master = false
        "#,
        payload.name,
        now,
        layer_id,
        user_id,
    )
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let affected_rows = query_result.rows_affected();
    if affected_rows > 0 {
        Ok(Json(MessageApi {
            message: "Layer successfully updated.".to_string(),
        }))
    } else {
        Err(AppError::BadRequest)
    }
}
