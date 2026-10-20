use axum::{
    Json,
    extract::{Extension, Multipart, Path, Query},
    response::Response,
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
use crate::model::transfer::{LEGACY_LIMIT, TRANSFER_LIMIT, TransferPackage};
use crate::model::{ImportMarkers, ImportPackage, ReturningId};
use crate::shape_validation::validate_shape_geojson;

mod v3;
mod validation;

const MAX_IMPORT_FILE_SIZE_BYTES: usize = TRANSFER_LIMIT;

// インポートデータの正規化
fn normalize_import_package(content: &str) -> Result<ImportPackage, AppError> {
    if let Ok(package) = serde_json::from_str::<ImportPackage>(content) {
        if !matches!(package.version, None | Some(1 | 2)) {
            return Err(validation::invalid("対応していないバージョンです。"));
        }
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

// エクスポートJSONのクエリパラメータの検証
#[derive(Debug, Deserialize)]
pub struct ExportJsonQueryParams {
    version: Option<u32>,
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
) -> Result<Response, AppError> {
    if params.version.unwrap_or(3) != 3 {
        return Err(validation::invalid(
            "JSONの出力はversion 3のみ対応しています。最新のGeoCode-Webで読み込んでください。",
        ));
    }
    let text = v3::export(&pool, &user_id, &layer_id).await?;
    export_response(text, &params).await
}

async fn export_response(
    json_text: String,
    params: &ExportJsonQueryParams,
) -> Result<Response, AppError> {
    // ローカル保存が有効な場合、ファイルを保存してレスポンスを返す（Tauri）
    if params.save_local.unwrap_or(false) {
        let filename = params.filename.as_deref().unwrap_or("export.json");
        let export_path = save_export_json_file(filename, &json_text).await?;
        let response_body = serde_json::json!({
            "message": "Export Ok.",
            "file_path": export_path.to_string_lossy(),
        })
        .to_string();
        return Response::builder()
            .status(200)
            .header("Content-Type", "application/json")
            .header("Cache-Control", "no-store")
            .body(axum::body::Body::from(response_body))
            .map_err(|_e| AppError::InternalServerError);
    }

    // ローカル保存が無効な場合、ファイルをダウンロード用のレスポンスとして返す（ブラウザ）
    Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store")
        .header(
            "Content-Disposition",
            "attachment; filename=\"export.json\"",
        )
        .body(axum::body::Body::from(json_text))
        .map_err(|_e| AppError::InternalServerError)
}

fn multipart_error(error: axum::extract::multipart::MultipartError) -> AppError {
    if error.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
        AppError::PayloadTooLarge(
            "JSONファイルは20MiB以内、要求全体は21MiB以内にしてください。".into(),
        )
    } else {
        AppError::BadRequest
    }
}

// レイヤ情報インポートハンドラー
pub async fn import_json_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    mut payload: Multipart,
) -> Result<Json<MessageApi>, AppError> {
    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    // Multipartを読み込み
    while let Some(field) = payload.next_field().await.map_err(multipart_error)? {
        // JSONファイルかを拡張子により検証
        let file_name = field.file_name().unwrap_or("file").to_string();
        if file_name.to_ascii_lowercase().ends_with(".json") {
            let mut field = field;
            let mut bytes = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                if bytes.len().saturating_add(chunk.len()) > MAX_IMPORT_FILE_SIZE_BYTES {
                    return Err(AppError::PayloadTooLarge(
                        "JSONファイルは20MiB以内にしてください。".to_string(),
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            drop(field);
            if payload
                .next_field()
                .await
                .map_err(multipart_error)?
                .is_some()
            {
                return Err(validation::invalid(
                    "JSONファイルは1件だけ指定してください。",
                ));
            }
            let content = String::from_utf8(bytes).map_err(|_| AppError::BadRequest)?;
            let envelope: serde_json::Value =
                serde_json::from_str(&content).map_err(|_| AppError::BadRequest)?;
            if envelope.get("version").and_then(serde_json::Value::as_u64) == Some(3) {
                let package: TransferPackage = serde_json::from_value(envelope).map_err(|e| {
                    AppError::Validation(format!("version 3のデータ形式が不正です: {e}"))
                })?;
                v3::import(&pool, &user_id, package).await?;
                return Ok(Json(MessageApi {
                    message: "Upload Ok.".into(),
                }));
            }
            if content.len() > LEGACY_LIMIT {
                return Err(AppError::PayloadTooLarge(
                    "旧形式のJSONは5MiB以内にしてください。".into(),
                ));
            }
            let import_package = normalize_import_package(&content)?;
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

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
                validate_shape_geojson(&shape.shape_type, &shape.geojson)?;
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
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    RETURNING
                        id
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
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9
                    )
                    RETURNING
                        id
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
                super::layer_forms::sync_object(
                    &mut tx,
                    &user_id,
                    "marker",
                    &new_marker_id,
                    &layer_id,
                )
                .await?;
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
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8
                    )
                    "#,
                )
                .bind(&new_shape_id)
                .bind(&user_id)
                .bind(&layer_id)
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
                super::layer_forms::sync_object(
                    &mut tx,
                    &user_id,
                    "shape",
                    &new_shape_id,
                    &layer_id,
                )
                .await?;
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
