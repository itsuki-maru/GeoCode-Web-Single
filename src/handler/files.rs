use axum::{
    Json,
    extract::{Extension, Multipart, Path, Query},
    response::{IntoResponse, Response},
};
use std::collections::{HashMap, HashSet};
use std::path::{Path as FsPath, PathBuf};

use crate::model::MessageApi;
use chrono::Utc;
use serde::Deserialize;
use serde_json;
use sqlx::sqlite::SqlitePool;
use sqlx::{query, query_as};
use uuid::Uuid;

use crate::error::AppError;
use crate::model::{
    ExportJsonScheme, ExportLayers, ExportMarkers, ExportPackage, ExportShapeJsonScheme,
    ExportShapes, ImportMarkers, ImportPackage, ReturningId,
};
use crate::utils::check_ismaster_handler;

// インポートデータの正規化
fn normalize_import_package(content: &str) -> Result<ImportPackage, AppError> {
    if let Ok(package) = serde_json::from_str::<ImportPackage>(content) {
        return Ok(package);
    }

    let markers =
        serde_json::from_str::<Vec<ImportMarkers>>(content).map_err(|_| AppError::BadRequest)?;
    Ok(ImportPackage {
        version: Some(1),
        markers,
        shapes: Vec::new(),
    })
}

// 図形タイプの検証
fn validate_shape_type(shape_type: &str) -> Result<(), AppError> {
    if matches!(shape_type, "polygon" | "polyline" | "rectangle" | "circle") {
        return Ok(());
    }

    Err(AppError::BadRequest)
}

// エクスポートJSONのクエリパラメータの検証
#[derive(Debug, Deserialize)]
pub struct ExportJsonQueryParams {
    save_local: Option<bool>,
    filename: Option<String>,
}

// エクスポートファイル名の正規化
fn sanitize_export_filename(filename: &str) -> String {
    let sanitized = filename
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_string();

    let sanitized = if sanitized.is_empty() {
        "export.json".to_string()
    } else {
        sanitized
    };

    if sanitized.to_ascii_lowercase().ends_with(".json") {
        sanitized
    } else {
        format!("{sanitized}.json")
    }
}

// エクスポートファイルの一意のパスを生成
fn unique_export_path(dir: &FsPath, filename: &str) -> PathBuf {
    let first_path = dir.join(filename);
    if !first_path.exists() {
        return first_path;
    }

    let path = FsPath::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export");
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("json");

    for index in 1.. {
        let candidate = dir.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("unique export path search should always return");
}

// エクスポートJSONファイルを保存（Tauri の場合）
async fn save_export_json_file(filename: &str, content: &str) -> Result<PathBuf, AppError> {
    let export_dir = dirs::download_dir()
        .or_else(dirs::document_dir)
        .ok_or(AppError::InternalServerError)?;
    tokio::fs::create_dir_all(&export_dir).await.map_err(|e| {
        tracing::error!(error = %e, path = %export_dir.display(), "failed to create export directory.");
        AppError::InternalServerError
    })?;

    let filename = sanitize_export_filename(filename);
    let export_path = unique_export_path(&export_dir, &filename);
    tokio::fs::write(&export_path, content)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, path = %export_path.display(), "failed to write export json file.");
            AppError::InternalServerError
        })?;

    Ok(export_path)
}

// レイヤ情報エクスポートハンドラー
pub async fn export_json_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(layer_id): Path<String>,
    Query(params): Query<ExportJsonQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let is_master_layer = check_ismaster_handler(&user_id, &layer_id, &pool).await;

    let marker_records = if is_master_layer {
        query_as::<_, ExportJsonScheme>(
            r#"
            SELECT
                marker_info_model.id,
                marker_info_model.user_id,
                marker_info_model.layer_id,
                marker_name,
                latitude,
                longitude,
                detail,
                layer_model.id as layer_model_id,
                layer_model.user_id as layer_model_user_id,
                layer_name,
                is_master
            FROM marker_info_model
            INNER JOIN layer_model
            ON marker_info_model.layer_id = layer_model.id
            WHERE marker_info_model.user_id = $1
            "#,
        )
        .bind(&user_id)
        .fetch_all(&pool)
        .await
    } else {
        query_as::<_, ExportJsonScheme>(
            r#"
            SELECT
                marker_info_model.id,
                marker_info_model.user_id,
                marker_info_model.layer_id,
                marker_name,
                latitude,
                longitude,
                detail,
                layer_model.id as layer_model_id,
                layer_model.user_id as layer_model_user_id,
                layer_name,
                is_master
            FROM marker_info_model
            INNER JOIN layer_model
            ON marker_info_model.layer_id = layer_model.id
            WHERE marker_info_model.user_id = $1 AND marker_info_model.layer_id = $2
            "#,
        )
        .bind(&user_id)
        .bind(&layer_id)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let shape_records = if is_master_layer {
        query_as::<_, ExportShapeJsonScheme>(
            r#"
            SELECT
                shape_model.id,
                shape_model.user_id,
                shape_model.layer_id,
                shape_type,
                name,
                geojson,
                layer_name,
                is_master
            FROM shape_model
            INNER JOIN layer_model
            ON shape_model.layer_id = layer_model.id
            WHERE shape_model.user_id = $1
            ORDER BY shape_model.created_at ASC
            "#,
        )
        .bind(&user_id)
        .fetch_all(&pool)
        .await
    } else {
        query_as::<_, ExportShapeJsonScheme>(
            r#"
            SELECT
                shape_model.id,
                shape_model.user_id,
                shape_model.layer_id,
                shape_type,
                name,
                geojson,
                layer_name,
                is_master
            FROM shape_model
            INNER JOIN layer_model
            ON shape_model.layer_id = layer_model.id
            WHERE shape_model.user_id = $1 AND shape_model.layer_id = $2
            ORDER BY shape_model.created_at ASC
            "#,
        )
        .bind(&user_id)
        .bind(&layer_id)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let markers_vec: Vec<ExportMarkers> = marker_records
        .into_iter()
        .map(|row| {
            let layer = ExportLayers {
                id: row.layer_model_id,
                user_id: row.layer_model_user_id,
                layer_name: row.layer_name,
                is_master: row.is_master,
            };

            ExportMarkers {
                id: row.id,
                user_id: row.user_id,
                layer_id: row.layer_id,
                marker_name: row.marker_name,
                latitude: row.latitude,
                longitude: row.longitude,
                detail: row.detail,
                layer,
            }
        })
        .collect();

    let shapes_vec: Vec<ExportShapes> = shape_records
        .into_iter()
        .map(|row| ExportShapes {
            id: row.id,
            user_id: row.user_id.clone(),
            layer_id: row.layer_id.clone(),
            shape_type: row.shape_type,
            name: row.name,
            geojson: row.geojson,
            layer: ExportLayers {
                id: row.layer_id,
                user_id: row.user_id,
                layer_name: row.layer_name,
                is_master: row.is_master,
            },
        })
        .collect();

    let export_package = ExportPackage {
        version: 2,
        markers: markers_vec,
        shapes: shapes_vec,
    };

    let json_text = serde_json::to_string(&export_package).unwrap_or("".to_string());

    // ローカル保存が有効な場合、ファイルを保存してレスポンスを返す（Tauri）
    if params.save_local.unwrap_or(false) {
        let filename = params.filename.as_deref().unwrap_or("export.json");
        let export_path = save_export_json_file(filename, &json_text).await?;
        let response_body = serde_json::json!({
            "message": "Export Ok.",
            "file_path": export_path.to_string_lossy(),
        })
        .to_string();
        let response = Response::builder()
            .status(200)
            .header("Content-Type", "application/json")
            .body(response_body)
            .map_err(|_e| AppError::InternalServerError);
        return Ok(response);
    }

    // ローカル保存が無効な場合、ファイルをダウンロード用のレスポンスとして返す（ブラウザ）
    let response = Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .header(
            "Content-Disposition",
            "attachment; filename=\"export.json\"",
        )
        .body(json_text)
        .map_err(|_e| AppError::InternalServerError);
    Ok(response)
}

// レイヤ情報インポートハンドラー
pub async fn import_json_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    mut payload: Multipart,
) -> Result<Json<MessageApi>, AppError> {
    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    // トランザクションの開始
    let mut tx = pool.begin().await?;

    // Multipartを読み込み
    while let Some(field) = payload
        .next_field()
        .await
        .map_err(|_e| AppError::BadRequest)?
    {
        // JSONファイルかを拡張子により検証
        let file_name = field.file_name().unwrap_or("file").to_string();
        if file_name.ends_with(".json") {
            let content = match field.text().await {
                Ok(text) => text,
                Err(_) => return Err(AppError::BadRequest),
            };

            let import_package = normalize_import_package(&content)?;

            let mut imported_layer_names = HashSet::new();
            for marker in &import_package.markers {
                if marker.layer.layer_name.trim().is_empty() {
                    return Err(AppError::BadRequest);
                }
                imported_layer_names.insert(marker.layer.layer_name.trim().to_string());
            }
            for shape in &import_package.shapes {
                if shape.layer.layer_name.trim().is_empty() {
                    return Err(AppError::BadRequest);
                }
                validate_shape_type(&shape.shape_type)?;
                imported_layer_names.insert(shape.layer.layer_name.trim().to_string());
            }

            // データベースにレイヤ名をインサートし、レイヤ名と割り当てられたIDのHashMapを作成
            let mut new_layers_hash_map: HashMap<String, String> = HashMap::new();
            for layer_name in imported_layer_names {
                let new_layer_id = Uuid::now_v7().to_string();
                query_as!(
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
                    layer_name,
                    false,
                    now,
                    now,
                )
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "database error.");
                    AppError::Sqlx(e)
                })?;

                new_layers_hash_map.insert(layer_name, new_layer_id);
            }

            // データベースにマーカーをインサート
            for marker in &import_package.markers {
                let new_marker_id = Uuid::now_v7().to_string();
                let layer_key = marker.layer.layer_name.trim().to_string();
                let Some(layer_id) = new_layers_hash_map.get(&layer_key).cloned() else {
                    return Err(AppError::BadRequest);
                };

                query_as!(
                    ReturningId,
                    r#"INSERT INTO marker_info_model (
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
                    marker.marker_name,
                    marker.latitude,
                    marker.longitude,
                    marker.detail,
                    now,
                    now,
                )
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "database error.");
                    AppError::Sqlx(e)
                })?;
            }

            // データベースに図形をインサート
            for shape in &import_package.shapes {
                let new_shape_id = Uuid::now_v7().to_string();
                let layer_key = shape.layer.layer_name.trim().to_string();
                let Some(layer_id) = new_layers_hash_map.get(&layer_key).cloned() else {
                    return Err(AppError::BadRequest);
                };

                query(
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
                    "#,
                )
                .bind(new_shape_id)
                .bind(&user_id)
                .bind(layer_id)
                .bind(&shape.shape_type)
                .bind(&shape.name)
                .bind(&shape.geojson)
                .bind(now)
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "database error.");
                    AppError::Sqlx(e)
                })?;
            }

            tx.commit().await?;
            return Ok(Json(MessageApi {
                message: "Upload Ok.".to_string(),
            }));
        } else {
            return Err(AppError::BadRequest);
        }
    }
    Err(AppError::BadRequest)
}
