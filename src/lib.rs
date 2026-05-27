use axum::{
    Json,
    body::Body,
    http::{HeaderMap, Request, Response, StatusCode, header::CONTENT_TYPE},
    response::{Html, IntoResponse, Redirect},
};
use rust_embed::RustEmbed;
use std::sync::Arc;
use tera::Tera;
use tokio::sync::Mutex as TokioMutex;

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod handler;
pub mod image;
pub mod init;
pub mod middleware;
pub mod model;
pub mod router;
pub mod utils;

use config::CONFIG;
use error::AppError;
use model::{AppInit, MessageApi};

#[derive(RustEmbed)]
#[folder = "dist/"]
struct Asset;

#[derive(RustEmbed)]
#[folder = "dist/templates/"]
struct Templates;

// ルートへのアクセスは /index にリダイレクト
pub async fn root_handler() -> impl IntoResponse {
    Redirect::permanent("/index")
}

// ヘルスチェックAPI
pub async fn health_check_handler() -> Json<MessageApi> {
    Json(MessageApi {
        message: "Hello, I'm administrator.".to_string(),
    })
}

// アプリケーション初期設定情報の取得ハンドラ
pub async fn get_app_init_handler(_: Request<Body>) -> Json<AppInit> {
    Json(AppInit {
        app_title: CONFIG.app_title.clone(),
        allow_user_account_create: CONFIG.allow_user_create_account,
        allow_user_update_password: CONFIG.allow_user_update_password,
        allow_origins: CONFIG.allow_origins.clone(),
    })
}

// エントリーポイントの index.html をレスポンス
pub async fn index_handler(headers: HeaderMap) -> Result<Html<String>, AppError> {
    let user_agent = headers.get("user-agent").and_then(|ua| ua.to_str().ok());
    let is_mobile = user_agent.map_or(false, |ua| ua.contains("Mobile"));

    let render_html = if is_mobile {
        "index-mobile.html"
    } else {
        "index.html"
    };

    match Asset::get(render_html) {
        Some(content) => {
            let html_content = String::from_utf8(content.data.into_owned()).unwrap();
            Ok(Html(html_content))
        },
        None => Err(AppError::NotFound),
    }
}

// ライセンス情報HTMLをレスポンス
pub async fn licenses_get_handler() -> Result<Html<String>, AppError> {
    match Asset::get("licenses.html") {
        Some(content) => {
            let html_content = String::from_utf8(content.data.into_owned()).unwrap();
            Ok(Html(html_content))
        },
        None => Err(AppError::NotFound),
    }
}

// 404 のハンドリング（ /index にリダイレクト）
pub async fn custom_not_found_handler(_: Request<Body>) -> impl IntoResponse {
    Redirect::permanent("/index")
}

// favicon.ico をレスポンス
pub async fn serve_favicon() -> Result<Response<Body>, AppError> {
    match Asset::get("assets/favicon.ico") {
        Some(content) => {
            let body = content.data.into_owned();
            let response = Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "image/x-icon")
                .body(body.into())
                .expect("Failed to construct response");
            Ok(response)
        },
        None => Err(AppError::NotFound),
    }
}

// Teraに対してテンプレートファイルを rust_embed から登録
pub fn build_tera_from_embed() -> anyhow::Result<Tera> {
    let mut tera = Tera::default();
    for path in Templates::iter() {
        let path_str = path.as_ref();
        if let Some(file) = Templates::get(path_str) {
            let content = std::str::from_utf8(file.data.as_ref())?;
            tera.add_raw_template(path_str, content)?;
        }
    }
    Ok(tera)
}

pub fn build_tera_extension() -> anyhow::Result<Arc<TokioMutex<Tera>>> {
    Ok(Arc::new(TokioMutex::new(build_tera_from_embed()?)))
}
