use crate::error::AppError;
use crate::model::{
    MarkerCreateRequestParams, MarkerCreatedResponse, MarkerDeleteResponse,
    MarkerInfoUpdateJsonData, MarkerMoveRequestParams, MarkerObject, MarkerQuerySearchParams,
    MarkerReadQueryPrams, MessageApi, ReturningId,
};
use crate::utils::{check_ismaster_handler, vec_to_hashmap};
use axum::{
    Json,
    extract::{Extension, Path, Query},
    response::IntoResponse,
};
use chrono::Utc;
use sqlx::sqlite::SqlitePool;
use sqlx::{query, query_as};
use std::collections::HashMap;
use uuid::Uuid;

// マーカー取得ハンドラー
pub async fn marker_get_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(params): Query<MarkerReadQueryPrams>,
) -> Result<Json<HashMap<String, MarkerObject>>, AppError> {
    // is_master=true または is_master指定なし → 全マーカー取得
    // is_master=false かつ layer指定あり → そのレイヤのマーカーのみ取得
    // is_master=false かつ layer指定なし → 全マーカー取得
    let use_layer_filter = matches!(params.is_master, Some(false)) && params.layer.is_some();

    let markers = if use_layer_filter {
        query_as!(
            MarkerObject,
            r#"
            SELECT
                id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail
            FROM marker_info_model
            WHERE user_id = $1 AND layer_id = $2
            "#,
            user_id,
            params.layer,
        )
        .fetch_all(&pool)
        .await
    } else {
        query_as!(
            MarkerObject,
            r#"
            SELECT
                id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail
            FROM marker_info_model
            WHERE user_id = $1
            "#,
            user_id,
        )
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let markers_hash_map = vec_to_hashmap(markers, |m| m.id.clone());
    Ok(Json(markers_hash_map))
}

// マーカー作成ハンドラー
pub async fn create_marker_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(params): Query<MarkerCreateRequestParams>,
) -> Result<Json<MarkerCreatedResponse>, AppError> {
    // 新規ID
    let new_marker_id = Uuid::now_v7().to_string();

    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    match (params.layer_id, params.latitude, params.longitude) {
        (Some(layer_id), Some(latitude), Some(longitude)) => {
            let blank_text = "".to_string();
            let new_id = query_as!(
                ReturningId,
                r#"
                INSERT INTO marker_info_model (
                    id,
                    user_id,
                    layer_id,
                    marker_name,
                    latitude,
                    longitude,
                    detail,
                    create_at,
                    update_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
                "#,
                new_marker_id,
                user_id,
                layer_id,
                blank_text,
                latitude,
                longitude,
                blank_text,
                now,
                now,
            )
            .fetch_one(&pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "database error.");
                AppError::Sqlx(e)
            })?;

            Ok(Json(MarkerCreatedResponse {
                id: new_id.id,
                message: "Marker Created.".to_string(),
            }))
        },
        _ => Err(AppError::BadRequest),
    }
}

// マーカー位置の更新ハンドラー
pub async fn update_marker_position_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(params): Query<MarkerMoveRequestParams>,
) -> Result<Json<MessageApi>, AppError> {
    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    match (params.marker_id, params.latitude, params.longitude) {
        (Some(marker_id), Some(latitude), Some(longitude)) => {
            let query_result = query!(
                r#"
                UPDATE marker_info_model
                SET
                    latitude = $1,
                    longitude = $2,
                    update_at = $3
                WHERE id = $4 AND user_id = $5
                "#,
                latitude,
                longitude,
                now,
                marker_id,
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
                    message: "Update Ok.".to_string(),
                }))
            } else {
                Err(AppError::Validation(
                    "Failed to marker location update.".into(),
                ))
            }
        },
        _ => Err(AppError::BadRequest),
    }
}

// マーカー情報（名前、詳細）の更新ハンドラー
pub async fn update_marker_info_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(marker_id): Path<String>,
    Json(payload): Json<MarkerInfoUpdateJsonData>,
) -> Result<Json<MessageApi>, AppError> {
    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    let query_result = query!(
        r#"
        UPDATE marker_info_model
        SET
            marker_name = $1,
            layer_id = $2,
            detail = $3,
            update_at = $4
        WHERE id = $5 AND user_id = $6
        "#,
        payload.name,
        payload.layer_id,
        payload.detail,
        now,
        marker_id,
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
            message: "Update Ok.".to_string(),
        }))
    } else {
        Err(AppError::Validation("Failed to update marker info.".into()))
    }
}

// マーカー削除ハンドラー
pub async fn delete_marker_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(marker_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let query_result = query!(
        r#"
        DELETE FROM marker_info_model
        WHERE id = $1 AND user_id = $2
        "#,
        marker_id,
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
        Ok(Json(MarkerDeleteResponse {
            message: "Marker successfully deleted.".to_string(),
        }))
    } else {
        Err(AppError::Validation("Not Delete Marker.".into()))
    }
}

// マーカー検索ハンドラー
pub async fn query_marker_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(params): Query<MarkerQuerySearchParams>,
) -> Result<Json<HashMap<String, MarkerObject>>, AppError> {
    let query1 = params.query1;
    let query2 = params.query2;
    let layer_id = params.layer;

    let is_master_layer = check_ismaster_handler(&user_id, &layer_id, &pool).await;

    // 検索語のフィルタを構築
    let mut search_terms: Vec<String> = Vec::new();
    if !query1.is_empty() {
        search_terms.push(format!("%\\{}%", query1));
    }
    if !query2.is_empty() {
        search_terms.push(format!("%\\{}%", query2));
    }

    let markers = if is_master_layer {
        // マスターレイヤの場合は全マーカー対象
        match search_terms.len() {
            0 => {
                query_as!(
                    MarkerObject,
                    "SELECT
                        id,
                        layer_id,
                        marker_name,
                        latitude,
                        longitude,
                        detail
                    FROM marker_info_model
                    WHERE user_id = $1",
                    user_id
                )
                .fetch_all(&pool)
                .await
            },
            1 => {
                query_as!(
                    MarkerObject,
                    "SELECT
                        id,
                        layer_id,
                        marker_name,
                        latitude,
                        longitude,
                        detail
                    FROM marker_info_model
                    WHERE user_id = $1
                    AND (marker_name LIKE $2 ESCAPE '\\' OR detail LIKE $2 ESCAPE '\\')",
                    user_id,
                    search_terms[0],
                )
                .fetch_all(&pool)
                .await
            },
            _ => {
                query_as!(
                    MarkerObject,
                    "SELECT
                        id,
                        layer_id,
                        marker_name,
                        latitude,
                        longitude,
                        detail
                    FROM marker_info_model
                    WHERE user_id = $1
                    AND (marker_name LIKE $2 ESCAPE '\\' OR detail LIKE $2 ESCAPE '\\')
                    AND (marker_name LIKE $3 ESCAPE '\\' OR detail LIKE $3 ESCAPE '\\')",
                    user_id,
                    search_terms[0],
                    search_terms[1],
                )
                .fetch_all(&pool)
                .await
            },
        }
    } else {
        // 特定レイヤのみ対象
        match search_terms.len() {
            0 => {
                query_as!(
                    MarkerObject,
                    "SELECT
                        id,
                        layer_id,
                        marker_name,
                        latitude,
                        longitude,
                        detail
                    FROM marker_info_model
                    WHERE user_id = $1 AND layer_id = $2",
                    user_id,
                    layer_id,
                )
                .fetch_all(&pool)
                .await
            },
            1 => {
                query_as!(
                    MarkerObject,
                    "SELECT
                        id,
                        layer_id,
                        marker_name,
                        latitude,
                        longitude,
                        detail
                    FROM marker_info_model
                    WHERE user_id = $1 AND layer_id = $2
                    AND (marker_name LIKE $3 ESCAPE '\\' OR detail LIKE $3 ESCAPE '\\')",
                    user_id,
                    layer_id,
                    search_terms[0],
                )
                .fetch_all(&pool)
                .await
            },
            _ => {
                query_as!(
                    MarkerObject,
                    "SELECT
                        id,
                        layer_id,
                        marker_name,
                        latitude,
                        longitude,
                        detail
                    FROM marker_info_model
                    WHERE user_id = $1 AND layer_id = $2
                    AND (marker_name LIKE $3 ESCAPE '\\' OR detail LIKE $3 ESCAPE '\\')
                    AND (marker_name LIKE $4 ESCAPE '\\' OR detail LIKE $4 ESCAPE '\\')",
                    user_id,
                    layer_id,
                    search_terms[0],
                    search_terms[1],
                )
                .fetch_all(&pool)
                .await
            },
        }
    }
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let markers_hash_map = vec_to_hashmap(markers, |m| m.id.clone());
    Ok(Json(markers_hash_map))
}
