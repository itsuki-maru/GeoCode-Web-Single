use crate::config::CONFIG;
use crate::error::AppError;
use crate::image::resize::resizer;
use crate::image::validator::check_file_extension;
use crate::model::{
    DeletedImageResponse, ImageData, ImageIdNameDeleted, ReturningId, UploadResponseImage,
};
use crate::utils::{ensure_dir, vec_to_hashmap};
use axum::{
    Json,
    extract::{Extension, Path},
};
use chrono::Utc;
use futures_util::TryStreamExt as _;
use image::{ImageFormat, io::Reader as ImageReader};
use sqlx::query_as;
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path as StdPath;
use std::path::PathBuf;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
};
use tokio_util::io::StreamReader;
use uuid::Uuid;

const MAX_UPLOAD_FILE_SIZE_BYTES: usize = 100 * 1024 * 1024;

// 100MB の制限機構
async fn write_field_to_file_with_limit(
    field: axum::extract::multipart::Field<'_>,
    file: &mut File,
    max_size_bytes: usize,
) -> Result<(), AppError> {
    // フィールドのストリームを読み込む
    let mut stream =
        StreamReader::new(field.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
    let mut total_bytes = 0usize;
    let mut buffer = [0u8; 8192];

    // ファイルにデータを書き込む
    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|_| AppError::BadRequest)?;
        if read == 0 {
            break;
        }

        // バイト数をカウントし、100MB を超える場合はエラーを返す
        total_bytes += read;
        if total_bytes > max_size_bytes {
            return Err(AppError::PayloadTooLarge(
                "upload file must be 100MB or smaller".to_string(),
            ));
        }

        // バッファから読み込んだデータをファイルに書き込む
        file.write_all(&buffer[..read])
            .await
            .map_err(|_| AppError::InternalServerError)?;
    }

    Ok(())
}

// GET IMAGES LIMIT
pub async fn get_enable_images_limit_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(limit): Path<i64>,
) -> Result<Json<HashMap<String, ImageData>>, AppError> {
    let images = query_as!(
        ImageData,
        r#"
        SELECT
            id,
            user_id,
            filename,
            uuid_filename
        FROM image_model
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT $2
        "#,
        user_id,
        limit,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let images_hash_map = vec_to_hashmap(images, |i| i.id.clone());
    Ok(Json(images_hash_map))
}

// GET ALL IMAGES
pub async fn get_enable_images_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<HashMap<String, ImageData>>, AppError> {
    let images = query_as!(
        ImageData,
        r#"SELECT
            id,
            user_id,
            filename,
            uuid_filename
        FROM image_model
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

    let images_hash_map = vec_to_hashmap(images, |i| i.id.clone());
    Ok(Json(images_hash_map))
}

// UPLOAD IMAGE
pub async fn upload_image_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    mut payload: axum::extract::Multipart,
) -> Result<Json<UploadResponseImage>, AppError> {
    // 現在時刻を取得
    let now = Utc::now().naive_utc();

    // 新規ID
    let new_image_id = Uuid::now_v7().to_string();
    let upload_uuid = Uuid::now_v7();
    let mut original_filename = String::new();
    let mut unique_filename = String::new();
    let mut asset_kind = String::new();
    let mut poster_bytes: Option<Vec<u8>> = None;
    let mut upload_saved = false;

    // UUID文字列から先頭5文字を取得
    let sub_dir = &upload_uuid.to_string()[0..5];

    // 保存先とするディレクトリパスを作成
    let dir_path = PathBuf::from(CONFIG.upload_file_path.clone()).join(sub_dir);

    // ディレクトリを作成（既に存在する場合は何もしない）
    ensure_dir(&dir_path)
        .await
        .map_err(|_| AppError::InternalServerError)?;

    // サムネイル用のディレクトリを作成（既に存在する場合は何もしない）
    let thumb_dir = PathBuf::from(&dir_path).join("thumb");
    ensure_dir(&thumb_dir)
        .await
        .map_err(|_| AppError::InternalServerError)?;

    // ファイルを保存する
    while let Some(field) = payload
        .next_field()
        .await
        .map_err(|_e| AppError::BadRequest)?
    {
        // フィールド名を取得
        let field_name = field.name().unwrap_or_default().to_string();

        // フィールド名がasset_kindの場合、アセットの種類(image, video, pdf)を取得
        if field_name == "asset_kind" {
            asset_kind = field
                .text()
                .await
                .map_err(|_| AppError::BadRequest)?
                .to_string();
            continue;
        }

        // フィールド名がposter_fileの場合、ポスター画像を取得
        if field_name == "poster_file" {
            let bytes = field.bytes().await.map_err(|_| AppError::BadRequest)?;
            poster_bytes = Some(bytes.to_vec());
            continue;
        }

        // フィールド名がupload_file以外の場合、スキップ
        if field_name != "upload_file" {
            continue;
        }

        // アップロードされたファイル名を取得
        let original_name = field.file_name().unwrap_or("file").to_string();
        // Content-Typeを取得
        let content_type = field.content_type().unwrap_or("image/").to_string();

        let file_name_path = StdPath::new(&original_name);
        let ext = match file_name_path.extension() {
            Some(ext) => ext.to_string_lossy(),
            None => return Err(AppError::BadRequest),
        };

        // 拡張子によるファイル検査
        let valid_ext = match check_file_extension(ext.to_string()) {
            Ok(valid_ext) => valid_ext,
            Err(_) => return Err(AppError::BadRequest),
        };

        // 画像ファイルの場合の処理（EXIF情報などを除去して保存）
        if content_type.starts_with("image/") {
            // 一時ファイルのパスを作成
            let temp_file_path = format!(
                "{}/temp_{}.{}",
                CONFIG.upload_file_path, upload_uuid, valid_ext
            );

            // サムネイルファイルのパスを作成
            let thumbnail_filename = format!("{}.{}", upload_uuid, valid_ext);

            // 一時ファイルを作成
            let mut temp_file = File::create(&temp_file_path)
                .await
                .map_err(|_| AppError::BadRequest)?;

            // ファイルを一時ファイルに書き込む
            if let Err(error) =
                write_field_to_file_with_limit(field, &mut temp_file, MAX_UPLOAD_FILE_SIZE_BYTES)
                    .await
            {
                // 失敗したら一時ファイルを削除
                let _ = tokio::fs::remove_file(&temp_file_path).await;
                return Err(error);
            }

            // 一時ファイルを読み込む
            let temp_file_data = tokio::fs::read(&temp_file_path)
                .await
                .map_err(|_| AppError::InternalServerError)?;

            // 画像リーダーを作成
            let img_reader = ImageReader::new(Cursor::new(&temp_file_data))
                .with_guessed_format()
                .map_err(|_| AppError::InternalServerError)?;

            // 画像をデコード
            let img = &img_reader
                .decode()
                .map_err(|_| AppError::InternalServerError)?;

            // 画像のフォーマットを取得
            let format = ImageFormat::from_path(&temp_file_path)
                .map_err(|_| AppError::InternalServerError)?;

            // 最終ファイルパスを生成
            let final_file_path = format!(
                "{}/{}.{}",
                dir_path.to_string_lossy(),
                upload_uuid,
                valid_ext
            );

            // 最終ファイルを作成
            let mut final_file = File::create(&final_file_path)
                .await
                .map_err(|_| AppError::InternalServerError)?;

            // 画像を最終ファイルに書き込む
            let mut output_data = Vec::new();
            img.write_to(&mut Cursor::new(&mut output_data), format)
                .map_err(|_| AppError::InternalServerError)?;

            // 最終ファイルに書き込む
            final_file
                .write_all(&output_data)
                .await
                .map_err(|_| AppError::InternalServerError)?;

            // サムネイルを作成
            let thumb_target = PathBuf::from(&temp_file_path);

            // サムネイルファイルを作成
            if let Err(_) = resizer(&thumb_target, thumb_dir.clone(), 450, &thumbnail_filename) {
                tokio::fs::remove_file(&temp_file_path)
                    .await
                    .map_err(|_| AppError::InternalServerError)?;
                tokio::fs::remove_file(&final_file_path)
                    .await
                    .map_err(|_| AppError::InternalServerError)?;
                return Err(AppError::InternalServerError);
            }

            // 一時ファイルを削除
            tokio::fs::remove_file(&temp_file_path)
                .await
                .map_err(|_| AppError::InternalServerError)?;

        // 動画、PDFファイルの処理
        } else {
            let file_path = format!(
                "{}/{}.{}",
                dir_path.to_string_lossy(),
                upload_uuid,
                valid_ext
            );
            // ファイルを作成
            let mut file = File::create(&file_path)
                .await
                .map_err(|_| AppError::BadRequest)?;

            // ファイルに書き込む
            if let Err(error) =
                write_field_to_file_with_limit(field, &mut file, MAX_UPLOAD_FILE_SIZE_BYTES).await
            {
                // 書き込みに失敗した場合はファイルを削除
                let _ = tokio::fs::remove_file(&file_path).await;
                return Err(error);
            }
        }

        unique_filename = format!("{}.{}", upload_uuid, ext);
        original_filename = original_name;
        // ファイルが正常に保存されたことを示すフラグを立てる
        upload_saved = true;
    }

    // ファイルが正常に保存されていない場合はエラーを返す
    if !upload_saved {
        return Err(AppError::BadRequest);
    }

    // アセットが動画の場合はポスター画像を保存する
    // ポスター画像がない場合はこの処理はスキップされ、動画のみが保存される
    if asset_kind == "video" {
        // ポスター画像がある場合は保存する（None でない場合）
        if let Some(bytes) = poster_bytes {
            let poster_path = thumb_dir.join(format!("{}.jpg", upload_uuid));
            let mut poster_file = File::create(&poster_path)
                .await
                .map_err(|_| AppError::InternalServerError)?;
            poster_file
                .write_all(&bytes)
                .await
                .map_err(|_| AppError::InternalServerError)?;
        }
    }

    let new_id = new_image_id.clone();
    let uuid_filename = unique_filename.clone();

    query_as!(
        ReturningId,
        r#"
        INSERT INTO image_model (
            id,
            user_id,
            filename,
            uuid_filename,
            create_at
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
        new_id,
        user_id,
        original_filename,
        uuid_filename,
        now,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    Ok(Json(UploadResponseImage {
        new_image_id,
        user_id,
        filename: original_filename,
        uuid_filename: unique_filename,
    }))
}

// DELETE IMAGE
pub async fn delete_image_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(image_id): Path<String>,
) -> Result<Json<DeletedImageResponse>, AppError> {
    let deleted_image = query_as!(
        ImageIdNameDeleted,
        r#"
        DELETE FROM image_model
        WHERE id = $1 AND user_id = $2
        RETURNING id, uuid_filename
        "#,
        image_id,
        user_id
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let sub_dir = &deleted_image.uuid_filename[0..5];
    let dir_path = PathBuf::from(CONFIG.upload_file_path.clone()).join(sub_dir);

    // ファイル名から拡張子を除いた部分を取得する
    let stem = StdPath::new(&deleted_image.uuid_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or(AppError::InternalServerError)?;

    // 削除対象のファイルパス
    let file_path = format!(
        "{}/{}",
        dir_path.to_string_lossy(),
        &deleted_image.uuid_filename
    );

    // サムネイルファイルパス
    let thumb_file_path = format!(
        "{}/{}/{}",
        dir_path.to_string_lossy(),
        "thumb",
        deleted_image.uuid_filename.clone()
    );

    // ポスター画像ファイルパス
    let poster_file_path = format!("{}/{}/{}.jpg", dir_path.to_string_lossy(), "thumb", stem);

    // ファイルを削除する
    match std::fs::remove_file(file_path) {
        Ok(_) => {
            // 画像ファイルのサムネイルがあれば削除
            if PathBuf::from(&thumb_file_path).exists() {
                match std::fs::remove_file(thumb_file_path) {
                    Ok(_) => {},
                    Err(_) => {},
                }
            } else {
                // サムネイル画像がなければ（PDFや動画の場合を想定）何もしない
            }
            if PathBuf::from(&poster_file_path).exists() {
                let _ = std::fs::remove_file(poster_file_path);
            }
            return Ok(Json(DeletedImageResponse {
                id: deleted_image.id,
                message: "Delete Ok.".to_string(),
            }));
        },
        Err(_) => return Err(AppError::InternalServerError),
    }
}
