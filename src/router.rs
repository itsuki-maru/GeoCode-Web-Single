use axum::{
    extract::{DefaultBodyLimit, Extension},
    http::{
        header::{self, HeaderName, HeaderValue},
        Method,
    },
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use sqlx::sqlite::SqlitePool;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tera::Tera;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

use crate::config::CONFIG;
use crate::handler::account::{
    account_password_update_handler, account_privacy_update_handler, auth_check_handler,
    disable_token, get_account_info_handler, refresh_token_handler, signup_handler, token_handler,
};
use crate::handler::admin::{
    admin_index_get_handler, create_users_handler, get_users_handler, unlock_account_handler,
    update_users_handler,
};
use crate::handler::assets::{image_preview_html_get_handler, serve_image_file, serve_static_file};
use crate::handler::files::{export_json_handler, import_json_handler};
use crate::handler::images::{
    delete_image_handler, get_enable_images_handler, get_enable_images_limit_handler,
    upload_image_handler,
};
use crate::handler::layers::{
    create_layer_handler, delete_layer_handler, get_all_layers_handler, master_layer_get_handler,
    update_layername_handler,
};
use crate::handler::map::{map_another_get_handler, map_get_handler};
use crate::handler::markers::{
    create_marker_handler, delete_marker_handler, marker_get_handler, query_marker_handler,
    update_marker_info_handler, update_marker_position_handler,
};
use crate::handler::onetime_url::{
    current_url_handler, generate_url_handler, invalidate_url_handler, temporary_map_auth_handler,
    temporary_map_get_handler,
};
use crate::handler::shapes::{
    create_shape_handler, delete_shape_handler, shapes_get_handler, update_shape_handler,
};
use crate::handler::tiles::proxy_tile_handler;
use crate::handler::totp::{
    token_totp_handler, totp_disable_handler, totp_setup_handler, totp_verify_handler,
};
use crate::middleware::{
    cookie_validator::CookieValidator, flexible_cookie_validator::FlexibleCookieValidator,
    print_req_res::print_request_response, refresh_cookie_validator::RefreshCookieValidator,
};

pub fn build_router(pool: SqlitePool, tera: Arc<Mutex<Tera>>) -> Router {
    // タイルプロキシ用のクライアントを作成
    let tile_proxy_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("Failed to create reqwest client for tile proxy.");

    // CORSの設定
    let mut cors = CorsLayer::new()
        .allow_methods(vec![Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(vec![
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::ORIGIN,
            HeaderName::from_str("X-Requested-With").unwrap(),
        ])
        .allow_credentials(true)
        .expose_headers(vec![header::CONTENT_TYPE]);

    // 開発時のみ Vue3 のサーバを許可オリジンに追加
    if cfg!(debug_assertions) {
        cors = cors.allow_origin("http://localhost:5173".parse::<HeaderValue>().unwrap());
    }

    // アクセストークンによる認可を要する
    let mut secured_routes = Router::new()
        .route("/map", get(map_get_handler))
        .route("/map-another", get(map_another_get_handler))
        .route("/account/auth", get(auth_check_handler))
        .route("/images/eneble-images", get(get_enable_images_handler))
        .route(
            "/images/eneble-images/{limit}",
            get(get_enable_images_limit_handler),
        )
        .route("/images/upload", post(upload_image_handler))
        .route("/images/delete/{image_id}", delete(delete_image_handler))
        .route("/layer", post(create_layer_handler))
        .route("/layer/masterid", get(master_layer_get_handler))
        .route("/layer/read/all", get(get_all_layers_handler))
        .route("/layer/delete/{layer_id}", delete(delete_layer_handler))
        .route("/layer/update/{layer_id}", put(update_layername_handler))
        .route("/marker", post(create_marker_handler))
        .route("/marker/read/all", get(marker_get_handler))
        .route("/marker/delete/{marker_id}", delete(delete_marker_handler))
        .route(
            "/marker/update-marker-latlng",
            put(update_marker_position_handler),
        )
        .route(
            "/marker/update/{marker_id}",
            put(update_marker_info_handler),
        )
        .route("/marker/read/query", get(query_marker_handler))
        .route("/shapes", get(shapes_get_handler))
        .route("/shape", post(create_shape_handler))
        .route("/shape/{shape_id}", put(update_shape_handler))
        .route("/shape/{shape_id}", delete(delete_shape_handler))
        .route("/file/export/{layer_id}", get(export_json_handler))
        .route("/file/import", post(import_json_handler))
        .route("/admin", get(admin_index_get_handler))
        .route("/admin/users", get(get_users_handler))
        .route(
            "/admin/user/password-reset/{update_user_id}",
            post(update_users_handler),
        )
        .route(
            "/admin/user/unlock/{unlock_user_id}",
            post(unlock_account_handler),
        )
        .route("/admin/user/create", post(create_users_handler))
        .route("/onetimeurl/generate", post(generate_url_handler))
        .route("/onetimeurl/current", get(current_url_handler))
        .route(
            "/onetimeurl/delete/{id_url}",
            delete(invalidate_url_handler),
        )
        .route("/account/info", get(get_account_info_handler))
        .route("/account/privacy", put(account_privacy_update_handler))
        .route("/account/totp/setup", get(totp_setup_handler))
        .route("/account/totp/verify", post(totp_verify_handler))
        .route("/account/totp/disable", get(totp_disable_handler))
        .route("/account/token/disable", get(disable_token));

    if CONFIG.allow_user_update_password {
        secured_routes = secured_routes.route(
            "/account/password-update",
            post(account_password_update_handler),
        );
    }

    let secured_routes = secured_routes.layer(CookieValidator);

    // アクセストークン不要
    let mut not_secured_routes = Router::new()
        .route("/", get(crate::root_handler))
        .route("/index", get(crate::index_handler))
        .route("/health-check", get(crate::health_check_handler))
        .route("/app-init", get(crate::get_app_init_handler))
        .route("/favicon.ico", get(crate::serve_favicon))
        .route("/assets/{uri}", get(serve_static_file))
        .route("/account/token", post(token_handler))
        .route("/account/totp/token", post(token_totp_handler))
        .route("/licanses", get(crate::licenses_get_handler))
        .route(
            "/onetime/{url_id}",
            get(temporary_map_get_handler).post(temporary_map_auth_handler),
        )
        .route(
            "/images/html/{image_name}",
            get(image_preview_html_get_handler),
        );

    // 環境変数によりルート登録を切り替え
    if CONFIG.allow_user_create_account {
        not_secured_routes = not_secured_routes.route("/account/signup", post(signup_handler));
    }

    // リフレッシュトークンを要する
    let token_refresh_routes = Router::new()
        .route("/account/refresh", post(refresh_token_handler))
        .layer(RefreshCookieValidator);

    // アクセストークンを持たない場合においても内部サービスへ接続
    let flex_secured_routes = Router::new()
        .route("/static/images/{image_name}", get(serve_image_file))
        .route("/tile/{z}/{x}/{y_png}", get(proxy_tile_handler))
        .layer(FlexibleCookieValidator);

    // 最終的なAPIルート
    Router::new()
        .merge(secured_routes)
        .merge(not_secured_routes)
        .merge(token_refresh_routes)
        .merge(flex_secured_routes)
        .layer(cors)
        .layer(Extension(pool))
        .layer(Extension(tile_proxy_client))
        .layer(Extension(tera))
        .layer(middleware::from_fn(print_request_response))
        .layer(DefaultBodyLimit::max(100 * 1024 * 1024))
        .fallback(crate::custom_not_found_handler)
}
