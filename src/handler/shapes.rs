use crate::error::AppError;
use crate::model::{
    MessageApi, ShapeCreateJsonData, ShapeCreatedResponse, ShapeGeometryUpdateData, ShapeObject,
    ShapeReadQueryParams, ShapeUpdateJsonData, ShapeUpdatedResponse,
};
use crate::shape_validation::validate_shape_geojson;
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
        .bind(&user_id)
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
        .bind(&user_id)
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
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    // シェープの種類とGeoJSONをチェック
    validate_shape_geojson(&payload.shape_type, &payload.geojson)?;

    // 図形名を正規化
    let normalized_name = normalize_shape_name(payload.name.as_deref())?;

    super::layer_forms::ensure_owned(&mut tx, &user_id, &payload.layer_id).await?;

    let restricted =
        super::layer_input_policy::restricted(&mut tx, &user_id, &payload.layer_id).await?;
    let memo = payload
        .geojson
        .get("properties")
        .and_then(|v| v.get("memo"));
    super::layer_input_policy::reject_change(
        restricted,
        memo.is_some_and(|v| !v.is_null() && v.as_str() != Some("")),
    )?;

    let new_shape_id = Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();

    let saved = sqlx::query_as::<_, ShapeObject>(
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
        RETURNING id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at
        "#,
    )
    .bind(&new_shape_id)
    .bind(&user_id)
    .bind(&payload.layer_id)
    .bind(payload.shape_type)
    .bind(normalized_name)
    .bind(payload.geojson.to_string())
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    super::layer_forms::sync_object(&mut tx, &user_id, "shape", &new_shape_id, &payload.layer_id)
        .await?;
    tx.commit().await?;
    Ok(Json(ShapeCreatedResponse {
        id: saved.id.clone(),
        message: "Shape Created.".to_string(),
        object: saved,
    }))
}

// シェープの削除ハンドラ
pub async fn delete_shape_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
) -> Result<Json<MessageApi>, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let query_result = sqlx::query(
        r#"
        DELETE FROM shape_model
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(&shape_id)
    .bind(&user_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    if query_result.rows_affected() == 0 {
        return Err(AppError::Validation("Failed to delete shape.".into()));
    }

    tx.commit().await?;
    Ok(Json(MessageApi {
        message: "Shape Deleted.".to_string(),
    }))
}

// 頂点座標だけを更新し、本文・メモ・回答・スタイルは最新値を保持する。
pub async fn update_shape_geometry_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
    Json(payload): Json<ShapeGeometryUpdateData>,
) -> Result<Json<ShapeObject>, AppError> {
    let mut tx = super::answer_sqlite::begin_write(&pool).await?;
    let current = sqlx::query_as::<_, ShapeObject>(
        "SELECT id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at FROM shape_model WHERE id=$1 AND user_id=$2"
    ).bind(&shape_id).bind(&user_id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    let matches_base = current
        .geojson
        .get("geometry")
        .is_some_and(|geometry| super::answer_sqlite::json_equal(geometry, &payload.base_geometry));
    if current.shape_type != payload.base_shape_type || !matches_base {
        return Err(AppError::Conflict);
    }
    let allowed = matches!(
        current.shape_type.as_str(),
        "polyline" | "polygon" | "rectangle"
    ) && (payload.shape_type == current.shape_type
        || (current.shape_type == "rectangle" && payload.shape_type == "polygon"));
    if !allowed {
        return Err(AppError::Validation(
            "この図形種別の変更は頂点編集では許可されていません。".into(),
        ));
    }
    let mut geojson = current.geojson;
    let geometry = geojson
        .get_mut("geometry")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or(AppError::BadRequest)?;
    geometry.insert("coordinates".into(), payload.coordinates);
    validate_shape_geojson(&payload.shape_type, &geojson)?;
    let saved = sqlx::query_as::<_, ShapeObject>(
        "UPDATE shape_model SET geojson=$1,shape_type=$2,updated_at=$3 WHERE id=$4 AND user_id=$5 RETURNING id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at"
    ).bind(geojson).bind(payload.shape_type).bind(Utc::now().naive_utc()).bind(&shape_id).bind(&user_id)
        .fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(saved))
}

// シェープ情報の更新ハンドラ
pub async fn update_shape_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(shape_id): Path<String>,
    Json(payload): Json<ShapeUpdateJsonData>,
) -> Result<Json<ShapeUpdatedResponse>, AppError> {
    let mut tx = super::answer_sqlite::begin_write(&pool).await?;
    let previous_layer: String =
        sqlx::query_scalar("SELECT layer_id FROM shape_model WHERE id=$1 AND user_id=$2")
            .bind(&shape_id)
            .bind(&user_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    let normalized_name = normalize_shape_name(payload.name.as_deref())?;

    let next_layer_id = payload.layer_id;
    let next_shape_type = payload.shape_type;
    let mut next_geojson = payload.geojson;

    let source_restricted =
        super::layer_input_policy::restricted(&mut tx, &user_id, &previous_layer).await?;
    let target_restricted = super::layer_input_policy::restricted(
        &mut tx,
        &user_id,
        next_layer_id.as_deref().unwrap_or(&previous_layer),
    )
    .await?;

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
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "database error.");
            AppError::Sqlx(e)
        })?;
        let Some((current_shape_type, current_geojson)) = current_shape else {
            return Err(AppError::Validation("Failed to update shape.".into()));
        };
        if let Some(ref mut next) = next_geojson {
            let memo = next
                .get("properties")
                .and_then(|p| p.get("memo"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let memo = super::marker_forms::answer_edit::normal_body(
                &mut tx,
                &user_id,
                "shape",
                &shape_id,
                memo,
                payload.free_text.as_deref(),
                payload.body_token.as_deref(),
            )
            .await?;
            if payload.free_text.is_some() {
                let properties = next
                    .as_object_mut()
                    .ok_or(AppError::BadRequest)?
                    .entry("properties")
                    .or_insert_with(|| serde_json::json!({}));
                if !properties.is_object() {
                    *properties = serde_json::json!({});
                }
                properties["memo"] = serde_json::json!(memo);
            }
        }
        super::layer_input_policy::reject_change(
            source_restricted || target_restricted,
            next_shape_type
                .as_ref()
                .is_some_and(|v| v != &current_shape_type)
                || next_geojson.as_ref().is_some_and(|v| v != &current_geojson),
        )?;
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
        .bind(&layer_id)
        .bind(&user_id)
        .fetch_one(&mut *tx)
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

    let saved = sqlx::query_as::<_, ShapeObject>(
        r#"
        UPDATE shape_model
        SET
            name = $1,
            layer_id = COALESCE($2, layer_id),
            shape_type = COALESCE($3, shape_type),
            geojson = COALESCE($4, geojson),
            updated_at = $5
        WHERE id = $6 AND user_id = $7
        RETURNING id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at
        "#,
    )
    .bind(normalized_name)
    .bind(&next_layer_id)
    .bind(next_shape_type)
    .bind(next_geojson)
    .bind(Utc::now().naive_utc())
    .bind(&shape_id)
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let saved = saved.ok_or_else(|| AppError::Validation("Failed to update shape.".into()))?;

    if let Some(layer) = next_layer_id {
        if previous_layer != layer {
            super::layer_forms::sync_object(&mut tx, &user_id, "shape", &shape_id, &layer).await?;
        }
    }
    tx.commit().await?;
    Ok(Json(ShapeUpdatedResponse {
        message: "Shape Updated.".to_string(),
        object: saved,
    }))
}
