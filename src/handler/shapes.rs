use crate::error::AppError;
use crate::model::{
    MessageApi, ShapeCreateJsonData, ShapeCreatedResponse, ShapeObject, ShapeReadQueryParams,
    ShapeUpdateJsonData,
};
use crate::shape_validation::validate_shape_geojson;
use crate::utils::ensure_owned_layer;
use axum::{
    Json,
    extract::{Extension, Path, Query},
};
use chrono::Utc;
use sqlx::sqlite::SqlitePool;
use uuid::Uuid;

// 図形名を正規化する関数
fn normalize_shape_name(raw_name: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(name) = raw_name.map(str::trim) else {
        return Ok(None);
    };

    if name.is_empty() {
        return Ok(None);
    }

    if name.chars().count() > 80 {
        return Err(AppError::Validation(
            "図形名は80文字以内で入力してください。".into(),
        ));
    }

    Ok(Some(name.to_string()))
}

// シェープの取得ハンドラ
pub async fn shapes_get_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Query(params): Query<ShapeReadQueryParams>,
) -> Result<Json<Vec<ShapeObject>>, AppError> {
    let use_layer_filter = matches!(params.is_master, Some(false)) && params.layer_id.is_some();

    let shapes = if use_layer_filter {
        sqlx::query_as::<_, ShapeObject>(
            r#"
            SELECT
                id,
                user_id,
                layer_id,
                shape_type,
                name,
                geojson,
                created_at,
                updated_at
            FROM shape_model
            WHERE user_id = $1 AND layer_id = $2
            ORDER BY created_at ASC
            "#,
        )
        .bind(user_id)
        .bind(params.layer_id)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query_as::<_, ShapeObject>(
            r#"
            SELECT
                id,
                user_id,
                layer_id,
                shape_type,
                name,
                geojson,
                created_at,
                updated_at
            FROM shape_model
            WHERE user_id = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(user_id)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    Ok(Json(shapes))
}

// シェープの作成ハンドラ
pub async fn create_shape_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<ShapeCreateJsonData>,
) -> Result<Json<ShapeCreatedResponse>, AppError> {
    // シェープの種類とGeoJSONをチェック
    validate_shape_geojson(&payload.shape_type, &payload.geojson)?;

    // 図形名を正規化
    let normalized_name = normalize_shape_name(payload.name.as_deref())?;

    ensure_owned_layer(&pool, &user_id, &payload.layer_id).await?;

    let new_shape_id = Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();

    let inserted_id: (String,) = sqlx::query_as(
        r#"
        INSERT INTO shape_model (
            id,
            user_id,
            layer_id,
            shape_type,
            name,
            geojson,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(new_shape_id)
    .bind(user_id)
    .bind(payload.layer_id)
    .bind(payload.shape_type)
    .bind(normalized_name)
    .bind(payload.geojson.to_string())
    .bind(now)
    .bind(now)
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    Ok(Json(ShapeCreatedResponse {
        id: inserted_id.0.to_string(),
        message: "Shape Created.".to_string(),
    }))
}

// シェープの削除ハンドラ
pub async fn delete_shape_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
) -> Result<Json<MessageApi>, AppError> {
    let query_result = sqlx::query(
        r#"
        DELETE FROM shape_model
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(shape_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    if query_result.rows_affected() == 0 {
        return Err(AppError::Validation("Failed to delete shape.".into()));
    }

    Ok(Json(MessageApi {
        message: "Shape Deleted.".to_string(),
    }))
}

// シェープ名の更新ハンドラ
pub async fn update_shape_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
    Json(payload): Json<ShapeUpdateJsonData>,
) -> Result<Json<MessageApi>, AppError> {
    let normalized_name = normalize_shape_name(payload.name.as_deref())?;

    let next_layer_id = payload.layer_id;
    let next_shape_type = payload.shape_type;
    let next_geojson = payload.geojson;

    // 図形種別またはGeoJSONを変更する場合、既存値と合成した更新後の状態を検証する
    if next_shape_type.is_some() || next_geojson.is_some() {
        let current_shape = sqlx::query_as::<_, (String, serde_json::Value)>(
            r#"
            SELECT shape_type, geojson
            FROM shape_model
            WHERE id = $1 AND user_id = $2
            "#,
        )
        .bind(&shape_id)
        .bind(&user_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "database error.");
            AppError::Sqlx(e)
        })?;
        let Some((current_shape_type, current_geojson)) = current_shape else {
            return Err(AppError::Validation("Failed to update shape.".into()));
        };
        let effective_shape_type = next_shape_type.as_deref().unwrap_or(&current_shape_type);
        let effective_geojson = next_geojson.as_ref().unwrap_or(&current_geojson);
        validate_shape_geojson(effective_shape_type, effective_geojson)?;
    }

    if let Some(ref layer_id) = next_layer_id {
        let layer_exists = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM layer_model
                WHERE id = $1 AND user_id = $2
            )
            "#,
        )
        .bind(layer_id)
        .bind(&user_id)
        .fetch_one(&pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "database error.");
            AppError::Sqlx(e)
        })?;

        if !layer_exists {
            return Err(AppError::Validation(
                "移動先のレイヤが見つかりません。".into(),
            ));
        }
    }

    let query_result = sqlx::query(
        r#"
        UPDATE shape_model
        SET
            name = $1,
            layer_id = COALESCE($2, layer_id),
            shape_type = COALESCE($3, shape_type),
            geojson = COALESCE($4, geojson),
            updated_at = $5
        WHERE id = $6 AND user_id = $7
        "#,
    )
    .bind(normalized_name)
    .bind(next_layer_id)
    .bind(next_shape_type)
    .bind(next_geojson)
    .bind(Utc::now().naive_utc())
    .bind(shape_id)
    .bind(&user_id)
    .execute(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    if query_result.rows_affected() == 0 {
        return Err(AppError::Validation("Failed to update shape.".into()));
    }

    Ok(Json(MessageApi {
        message: "Shape Updated.".to_string(),
    }))
}
