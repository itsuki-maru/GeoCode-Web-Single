use axum::{
    Router,
    extract::{DefaultBodyLimit, Extension},
    http::{
        Method,
        header::{self, HeaderName, HeaderValue},
    },
    middleware,
    routing::{delete, get, post, put},
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
use crate::handler::assets::{
    image_preview_html_get_handler, serve_image_file, serve_marker_icon_file, serve_static_file,
};
use crate::handler::external_site::{
    get_external_site_url_handler, update_external_site_url_handler,
};
use crate::handler::files::{export_json_handler, import_json_handler};
use crate::handler::images::{
    delete_image_handler, get_enable_images_handler, get_enable_images_limit_handler,
    query_image_handler, upload_image_handler,
};
use crate::handler::layers::{
    create_layer_handler, delete_layer_handler, get_all_layers_handler, master_layer_get_handler,
    update_layername_handler,
};
use crate::handler::map::{map_another_get_handler, map_get_handler, query_map_objects_handler};
use crate::handler::marker_forms::{
    get_marker_form_config_handler, get_shape_form_config_handler, public_marker_form_get_handler,
    public_shape_form_get_handler, rotate_marker_form_url_handler, rotate_shape_form_url_handler,
    submit_marker_form_handler, submit_shape_form_handler, update_marker_form_config_handler,
    update_shape_form_config_handler,
};
use crate::handler::marker_icons::{
    delete_marker_icon_handler, get_marker_icons_handler, search_marker_icons_handler,
    upload_marker_icon_handler,
};
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
    security::security_headers_and_origin,
};

pub fn build_router(
    pool: SqlitePool,
    tera: Arc<Mutex<Tera>>,
    tile_cache: Option<redis::aio::ConnectionManager>,
) -> Router {
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

    let mut allowed_origins: Vec<HeaderValue> = CONFIG
        .allow_origins
        .split(',')
        .filter_map(|origin| origin.trim().parse::<HeaderValue>().ok())
        .collect();
    if cfg!(debug_assertions) {
        allowed_origins.push(HeaderValue::from_static("http://localhost:5173"));
    }
    if !allowed_origins.is_empty() {
        cors = cors.allow_origin(allowed_origins);
    }

    // アクセストークンによる認可を要する
    let mut secured_routes = Router::new()
        .route("/map", get(map_get_handler))
        .route("/map-another", get(map_another_get_handler))
        .route("/account/auth", get(auth_check_handler))
        .route("/images/eneble-images", get(get_enable_images_handler))
        .route("/images/eneble-images/search", get(query_image_handler))
        .route(
            "/images/eneble-images/{limit}",
            get(get_enable_images_limit_handler),
        )
        .route("/images/delete/{image_id}", delete(delete_image_handler))
        .route("/layer", post(create_layer_handler))
        .route("/layer/masterid", get(master_layer_get_handler))
        .route("/marker-icons", get(get_marker_icons_handler))
        .route("/marker-icons/search", get(search_marker_icons_handler))
        .route(
            "/marker-icons/{icon_id}",
            delete(delete_marker_icon_handler),
        )
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
        .route(
            "/marker/{marker_id}/form",
            get(get_marker_form_config_handler).put(update_marker_form_config_handler),
        )
        .route(
            "/marker/{marker_id}/form/rotate-url",
            post(rotate_marker_form_url_handler),
        )
        .route("/marker/read/query", get(query_marker_handler))
        .route("/map-objects/read/query", get(query_map_objects_handler))
        .route("/shapes", get(shapes_get_handler))
        .route("/shape", post(create_shape_handler))
        .route("/shape/{shape_id}", put(update_shape_handler))
        .route("/shape/{shape_id}", delete(delete_shape_handler))
        .route(
            "/shape/{shape_id}/form",
            get(get_shape_form_config_handler).put(update_shape_form_config_handler),
        )
        .route(
            "/shape/{shape_id}/form/rotate-url",
            post(rotate_shape_form_url_handler),
        )
        .route("/file/export/{layer_id}", get(export_json_handler))
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
        .route("/account/totp/setup", post(totp_setup_handler))
        .route("/account/totp/verify", post(totp_verify_handler))
        .route("/account/totp/disable", post(totp_disable_handler))
        .route(
            "/external-site-url",
            get(get_external_site_url_handler).put(update_external_site_url_handler),
        )
        .route("/account/token/disable", post(disable_token));

    if CONFIG.allow_user_update_password {
        secured_routes = secured_routes.route(
            "/account/password-update",
            post(account_password_update_handler),
        );
    }

    let secured_routes = secured_routes
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(CookieValidator);

    let image_upload_route = Router::new()
        .route("/images/upload", post(upload_image_handler))
        .layer(DefaultBodyLimit::max(105 * 1024 * 1024))
        .layer(CookieValidator);
    let marker_icon_upload_route = Router::new()
        .route("/marker-icons/upload", post(upload_marker_icon_handler))
        .layer(DefaultBodyLimit::max(6 * 1024 * 1024))
        .layer(CookieValidator);
    let import_route = Router::new()
        .route("/file/import", post(import_json_handler))
        .layer(DefaultBodyLimit::max(6 * 1024 * 1024))
        .layer(CookieValidator);

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
    let not_secured_routes = not_secured_routes.layer(DefaultBodyLimit::max(1024 * 1024));

    let public_form_routes = Router::new()
        .route(
            "/forms/{public_id}",
            get(public_marker_form_get_handler).post(submit_marker_form_handler),
        )
        .route(
            "/shape-forms/{public_id}",
            get(public_shape_form_get_handler).post(submit_shape_form_handler),
        )
        .layer(DefaultBodyLimit::max(6 * 1024 * 1024));

    // リフレッシュトークンを要する
    let token_refresh_routes = Router::new()
        .route("/account/refresh", post(refresh_token_handler))
        .layer(RefreshCookieValidator);

    // アクセストークンを持たない場合においても内部サービスへ接続
    let flex_secured_routes = Router::new()
        .route("/static/images/{image_name}", get(serve_image_file))
        .route(
            "/static/marker-icons/{icon_name}",
            get(serve_marker_icon_file),
        )
        .route("/tile/{z}/{x}/{y_png}", get(proxy_tile_handler))
        .layer(FlexibleCookieValidator);

    // 最終的なAPIルート
    Router::new()
        .merge(secured_routes)
        .merge(not_secured_routes)
        .merge(public_form_routes)
        .merge(image_upload_route)
        .merge(marker_icon_upload_route)
        .merge(import_route)
        .merge(token_refresh_routes)
        .merge(flex_secured_routes)
        .layer(cors)
        .layer(Extension(pool))
        .layer(Extension(tile_proxy_client))
        .layer(Extension(tile_cache))
        .layer(Extension(tera))
        .layer(middleware::from_fn(print_request_response))
        .layer(middleware::from_fn(security_headers_and_origin))
        .layer(DefaultBodyLimit::max(105 * 1024 * 1024))
        .fallback(crate::custom_not_found_handler)
}
