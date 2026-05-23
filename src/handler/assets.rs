use axum::{
    body::Body,
    extract::{Extension, Path, Query},
    http::{HeaderValue, Response, StatusCode, header::CONTENT_TYPE},
    response::{Html, IntoResponse, Response as HttpResponse},
};
use sqlx::query_as;
use sqlx::sqlite::SqlitePool;
use std::path::{Path as StdPath, PathBuf};
use std::sync::Arc;
use tera::{Context, Tera};
use tokio::fs::File;
use tokio::sync::Mutex;
use tokio_util::codec::{BytesCodec, FramedRead};

use crate::config::CONFIG;
use crate::error::AppError;
use crate::model::ThumbnailQueryParams;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "dist/assets"]
struct Asset;

// STATIC JS & CSS & IMAGE RESPONSE
pub async fn serve_static_file(Path(uri): Path<String>) -> Result<Response<Body>, AppError> {
    match Asset::get(&uri) {
        Some(content) => {
            // 指定されたファイル名を検証する（ディレクトリトラバーサル攻撃対策）
            if let Some(safe_file_name) = sanitize_filename(&uri) {
                let content_type = match safe_file_name.rsplit('.').next() {
                    Some("css") => "text/css",
                    Some("js") | Some("mjs") => "application/javascript",
                    Some("png") => "image/png",
                    Some("jpg") | Some("jpeg") => "image/jpeg",
                    Some("svg") => "image/svg+xml",
                    Some("html") => "text/html",
                    // 他の拡張子があれば適宜追加
                    _ => "application/octet-stream", // 不明なファイルタイプ
                };

                let body = content.data.into_owned();
                let response = Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, content_type)
                    .body(body.into())
                    .expect("Failed to construct response");
                Ok(response)
            } else {
                Err(AppError::NotFound)
            }
        },
        None => Err(AppError::NotFound),
    }
}

// USER UPLOAD IMAGE RESPONSE
pub async fn serve_image_file(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(image_name): Path<String>,
    Query(params): Query<ThumbnailQueryParams>,
) -> Result<Response<Body>, AppError> {
    // 指定されたファイル名を検証する（ディレクトリトラバーサル攻撃対策）
    if let Some(safe_file_name) = sanitize_filename(&image_name) {
        struct ImageOwner {
            user_id: String,
        }

        struct IsPrivateUser {
            is_private: bool,
        }

        // 非公開ユーザーの画像データでないか検証
        let query_image_name = image_name.clone();
        let owner = query_as!(
            ImageOwner,
            r#"
            SELECT user_id
            FROM image_model
            WHERE uuid_filename = $1
            "#,
            query_image_name,
        )
        .fetch_optional(&pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "failed to database access");
            AppError::Sqlx(e)
        })?;

        let owner = match owner {
            Some(owner) => owner,
            None => return Err(AppError::BadRequest),
        };

        // 画像のオーナーとアクセスしたユーザーのIDが異なる場合
        if owner.user_id != user_id {
            let is_private_user_db = query_as!(
                IsPrivateUser,
                r#"
                SELECT is_private
                FROM user_model
                WHERE id = $1
                "#,
                owner.user_id,
            )
            .fetch_one(&pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "failed to database access");
                AppError::Sqlx(e)
            })?;

            // プライバシー設定がされている場合は NOT FOUND
            if is_private_user_db.is_private {
                return Err(AppError::NotFound);
            }
        }

        // サムネイル用のパス
        let mut thumb_file_path = PathBuf::from(&CONFIG.images_path);
        // サムネイルが存在しなかった場合のオリジナルファイル
        let mut origin_file_path = PathBuf::from(&CONFIG.images_path);

        // ファイル名のUUID文字列から先頭5文字を取得
        let sub_dir = &safe_file_name[0..5];

        // サブディレクトリを結合
        thumb_file_path.push(sub_dir);
        origin_file_path.push(sub_dir);

        // 要求に?thumb=trueを含むか検証
        match params.thumb {
            Some(is_thumb) => {
                if is_thumb {
                    thumb_file_path.push("thumb");
                }
            },
            None => {},
        }

        // ファイル名を結合
        let requested_file_name = safe_file_name.trim_start_matches('/');
        let thumb_file_name = match params.thumb {
            Some(true)
                if matches!(safe_file_name.rsplit('.').next(), Some("mp4") | Some("MP4")) =>
            {
                let stem = StdPath::new(requested_file_name)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or(AppError::NotFound)?;
                format!("{}.jpg", stem)
            },
            _ => requested_file_name.to_string(),
        };

        thumb_file_path.push(&thumb_file_name);
        origin_file_path.push(safe_file_name.trim_start_matches('/'));

        if thumb_file_path.is_dir() {
            return Err(AppError::NotFound);
        }

        // レスポンス対象ファイル実体パスをサムネイルファイルが、万が一存在しなければオリジナルに変更
        let mut read_file = thumb_file_path.clone();
        if !thumb_file_path.exists() {
            read_file = origin_file_path.clone();
        }

        let content_type = match read_file.extension().and_then(|ext| ext.to_str()) {
            Some("jpg") | Some("JPG") | Some("jpeg") => "image/jpeg",
            Some("png") | Some("PNG") => "image/png",
            Some("gif") | Some("GIF") => "image/gif",
            Some("webp") | Some("WEBP") => "image/webp",
            Some("mp4") | Some("MP4") => "video/mp4",
            Some("pdf") => "application/pdf",
            _ => "application/octet-stream", // 不明なファイルタイプ
        };

        // parseに失敗した場合はINTERNAL_SERVER_ERRORを早期リターン
        let parsed_content_type = content_type
            .parse()
            .map_err(|_e| AppError::InternalServerError)?;

        let mut builder = HttpResponse::builder();
        if let Some(headers) = builder.headers_mut() {
            headers.append(
                "Cache-Control",
                HeaderValue::from_static(&CONFIG.cache_control),
            );
            headers.append(CONTENT_TYPE, parsed_content_type);
        }

        let file = match File::open(read_file).await {
            Ok(file) => file,
            Err(_) => return Err(AppError::NotFound),
        };

        let stream = FramedRead::new(file, BytesCodec::new());
        let body = Body::from_stream(stream);

        let response = builder
            .status(StatusCode::OK)
            .body(body)
            .expect("Failed to construct response");

        Ok(response)

    // 存在しないファイル
    } else {
        Err(AppError::NotFound)
    }
}

// SANITAIZE UPLOAD IMAGE FILENAME
fn sanitize_filename(file_name: &str) -> Option<String> {
    let file_name = file_name.split('/').last()?;

    if file_name.contains("..") || file_name.contains("\\") || file_name.contains("/") {
        return None;
    }
    Some(file_name.to_string())
}

// IMAGE PREVIEW HTML
pub async fn image_preview_html_get_handler(
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Path(image_name): Path<String>,
) -> impl IntoResponse {
    let url = format!("/static/images/{}", image_name);

    let mut context = Context::new();
    context.insert("url", &url);

    let tera = tera.lock().await;

    match tera.render("image-preview.html", &context) {
        Ok(rendered) => Ok(Html(rendered).into_response()),
        Err(e) => {
            tracing::error!("{}", e);
            Err(AppError::InternalServerError)
        },
    }
}
