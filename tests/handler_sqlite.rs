mod common;

use axum::{
    Form, Json, Router,
    body::{Body, to_bytes},
    extract::{Extension, Path, Query},
    http::{HeaderMap, Request, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use chrono::Utc;
use geocode_web_single::{
    handler::{
        account::{
            account_password_update_handler, account_privacy_update_handler, auth_check_handler,
            disable_token, get_account_info_handler, refresh_token_handler, signup_handler,
            token_handler,
        },
        admin::{
            admin_index_get_handler, create_users_handler, get_users_handler,
            unlock_account_handler, update_users_handler,
        },
        assets::{image_preview_html_get_handler, serve_image_file, serve_static_file},
        files::{export_json_handler, import_json_handler},
        images::{
            delete_image_handler, get_enable_images_handler, get_enable_images_limit_handler,
            upload_image_handler,
        },
        layers::{
            create_layer_handler, delete_layer_handler, get_all_layers_handler,
            master_layer_get_handler, update_layername_handler,
        },
        map::{map_another_get_handler, map_get_handler},
        markers::{
            create_marker_handler, delete_marker_handler, marker_get_handler, query_marker_handler,
            update_marker_info_handler, update_marker_position_handler,
        },
        onetime_url::{
            current_url_handler, generate_url_handler, invalidate_url_handler,
            temporary_map_auth_handler, temporary_map_get_handler,
        },
        shapes::{
            create_shape_handler, delete_shape_handler, shapes_get_handler, update_shape_handler,
        },
        totp::{token_totp_handler, totp_disable_handler, totp_setup_handler, totp_verify_handler},
    },
    model::{
        ExportPackage, GenarateUrlPayload, LayerCreateQueryParams, LayerNameUpdatePayload,
        LoginPayload, MapAnotherWindowQueryParams, MapReadQueryPrams, MarkerCreateRequestParams,
        MarkerInfoUpdateJsonData, MarkerMoveRequestParams, MarkerQuerySearchParams,
        MarkerReadQueryPrams, OnetimePasswordForm, ShapeCreateJsonData, ShapeReadQueryParams,
        ShapeUpdateJsonData, SignupPayload, ThumbnailQueryParams, TotpLoginPayload,
        TotpVerifyRequest, UpdateAccountPasswordPayload, UpdateAccountPrivacyPayload,
        UpdateUserData,
    },
};
use serde_json::json;
use sqlx::SqlitePool;
use std::sync::Arc;
use tera::Tera;
use tokio::sync::Mutex;
use totp_rs::{Algorithm, TOTP};
use tower::ServiceExt;

// マーカー作成ヘルパー関数
async fn insert_marker(pool: &SqlitePool, user_id: &str, layer_id: &str) -> String {
    let marker_id = uuid::Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id, user_id, layer_id, marker_name, latitude, longitude, detail, create_at, update_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(&marker_id)
    .bind(user_id)
    .bind(layer_id)
    .bind("marker")
    .bind(35.0)
    .bind(139.0)
    .bind("detail")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .expect("test marker should be inserted");
    marker_id
}

// シェイプ作成ヘルパー関数
async fn insert_shape(pool: &SqlitePool, user_id: &str, layer_id: &str) -> String {
    let shape_id = uuid::Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();
    sqlx::query(
        r#"
        INSERT INTO shape_model (
            id, user_id, layer_id, shape_type, name, geojson, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(&shape_id)
    .bind(user_id)
    .bind(layer_id)
    .bind("polygon")
    .bind("shape")
    .bind(json!({"type": "Polygon", "coordinates": []}).to_string())
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .expect("test shape should be inserted");
    shape_id
}

// Tera テンプレートエンジン
fn test_tera() -> Arc<Mutex<Tera>> {
    Arc::new(Mutex::new(
        geocode_web_single::build_tera_from_embed().expect("embedded templates should load"),
    ))
}

// レイヤの取得・作成・更新・削除と、master layer が削除拒否されることを確認する。
#[tokio::test]
async fn layer_handlers_cover_create_read_update_delete() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "layer-user").await;

    let Json(master) =
        master_layer_get_handler(Extension(user_id.clone()), Extension(pool.clone()))
            .await
            .expect("master layer should be returned");
    assert!(!master.id.is_empty());

    let Json(created) = create_layer_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Query(LayerCreateQueryParams {
            name: Some("field notes".to_string()),
        }),
    )
    .await
    .expect("layer should be created");

    let _ = update_layername_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Path(created.id.clone()),
        Json(LayerNameUpdatePayload {
            name: "renamed layer".to_string(),
        }),
    )
    .await
    .expect("layer should be updated");

    let Json(layers) = get_all_layers_handler(Extension(user_id.clone()), Extension(pool.clone()))
        .await
        .expect("layers should be returned");
    assert_eq!(layers.get(&created.id).unwrap().layer_name, "renamed layer");

    delete_layer_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Path(created.id.clone()),
    )
    .await
    .expect("non-master layer should be deleted");

    assert!(
        delete_layer_handler(Extension(user_id), Extension(pool), Path(master.id))
            .await
            .is_err(),
        "master layer deletion should be rejected"
    );
}

// マーカーの作成・位置更新・情報更新・一覧取得・検索・削除を確認する。
#[tokio::test]
async fn marker_handlers_cover_create_read_update_delete() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "marker-user").await;
    let layer_id = common::master_layer_id(&pool, &user_id).await;

    let Json(created) = create_marker_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Query(MarkerCreateRequestParams {
            layer_id: Some(layer_id.clone()),
            latitude: Some(35.681236),
            longitude: Some(139.767125),
        }),
    )
    .await
    .expect("marker should be created");

    let _ = update_marker_position_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Query(MarkerMoveRequestParams {
            marker_id: Some(created.id.clone()),
            latitude: Some(35.0),
            longitude: Some(139.0),
        }),
    )
    .await
    .expect("marker position should be updated");

    let _ = update_marker_info_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Path(created.id.clone()),
        Json(MarkerInfoUpdateJsonData {
            name: "Tokyo".to_string(),
            detail: "Station area".to_string(),
            layer_id,
        }),
    )
    .await
    .expect("marker info should be updated");

    let Json(markers) = marker_get_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Query(MarkerReadQueryPrams {
            layer: None,
            is_master: None,
        }),
    )
    .await
    .expect("markers should be returned");
    let marker = markers.get(&created.id).unwrap();
    assert_eq!(marker.marker_name, "Tokyo");
    assert_eq!(marker.latitude, 35.0);

    let Json(query_results) = query_marker_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Query(MarkerQuerySearchParams {
            query1: "Tokyo".to_string(),
            query2: String::new(),
            layer: marker.layer_id.clone().unwrap(),
        }),
    )
    .await
    .expect("marker search should return matching markers");
    assert!(query_results.contains_key(&created.id));

    delete_marker_handler(Extension(user_id), Extension(pool), Path(created.id))
        .await
        .expect("marker should be deleted");
}

// 図形の作成・一覧取得・更新・削除と、不正な shape_type の拒否を確認する。
#[tokio::test]
async fn shape_handlers_cover_create_read_delete_and_validation() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "shape-user").await;
    let layer_id = common::master_layer_id(&pool, &user_id).await;

    let Json(created) = create_shape_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Json(ShapeCreateJsonData {
            layer_id: layer_id.clone(),
            shape_type: "polygon".to_string(),
            name: Some("Area".to_string()),
            geojson: json!({"type": "Polygon", "coordinates": []}),
        }),
    )
    .await
    .expect("shape should be created");

    assert!(
        create_shape_handler(
            Extension(user_id.clone()),
            Extension(pool.clone()),
            Json(ShapeCreateJsonData {
                layer_id: layer_id.clone(),
                shape_type: "triangle".to_string(),
                name: None,
                geojson: json!({}),
            }),
        )
        .await
        .is_err(),
        "unsupported shape type should be rejected"
    );

    let Json(shapes) = shapes_get_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Query(ShapeReadQueryParams {
            layer_id: Some(layer_id),
            is_master: Some(false),
        }),
    )
    .await
    .expect("shapes should be returned");
    assert_eq!(shapes.len(), 1);
    assert_eq!(shapes[0].id, created.id);

    let _ = update_shape_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Path(created.id.clone()),
        Json(ShapeUpdateJsonData {
            name: Some("Updated Area".to_string()),
            layer_id: None,
            geojson: Some(json!({"type": "Polygon", "coordinates": [[[0, 0]]]})),
        }),
    )
    .await
    .expect("shape should update");

    let _ = delete_shape_handler(Extension(user_id), Extension(pool), Path(created.id))
        .await
        .expect("shape should be deleted");
}

// アカウント作成、ログイン、認証確認、プライバシー/パスワード更新、トークン発行/無効化を確認する。
#[tokio::test]
async fn account_handlers_cover_signup_login_profile_and_tokens() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "account-user").await;

    let Json(created) = signup_handler(
        Extension(pool.clone()),
        Json(SignupPayload {
            username: "signed-up-user".to_string(),
            password: "password123".to_string(),
        }),
    )
    .await
    .expect("signup should create a user");
    assert!(!created.id.is_empty());

    let login_response = token_handler(
        Extension(pool.clone()),
        Json(LoginPayload {
            username: "account-user".to_string(),
            password: "password123".to_string(),
        }),
    )
    .await
    .expect("login should succeed")
    .into_response();
    assert_eq!(login_response.status(), StatusCode::OK);
    assert!(
        login_response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .count()
            >= 2
    );

    let Json(authenticated) =
        auth_check_handler(Extension(user_id.clone()), Extension(pool.clone()))
            .await
            .expect("auth check should return user");
    assert_eq!(authenticated.username, "account-user");

    let _ = account_privacy_update_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Json(UpdateAccountPrivacyPayload { is_private: false }),
    )
    .await
    .expect("privacy should update");

    let Json(info) = get_account_info_handler(Extension(user_id.clone()), Extension(pool.clone()))
        .await
        .expect("account info should be returned");
    assert!(!info.is_private);

    let _ = account_password_update_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Json(UpdateAccountPasswordPayload {
            new_password: "newpassword123".to_string(),
        }),
    )
    .await
    .expect("password should update");

    let refresh_response = refresh_token_handler(Extension(user_id.clone()))
        .await
        .expect("refresh token response should be built")
        .into_response();
    assert_eq!(refresh_response.status(), StatusCode::OK);

    let disabled_response = disable_token(Extension(user_id))
        .await
        .expect("disable token response should be built")
        .into_response();
    assert_eq!(disabled_response.status(), StatusCode::OK);
}

// 管理者権限での管理画面表示、ユーザー一覧、パスワードリセット、ロック解除、ユーザー作成を確認する。
#[tokio::test]
async fn admin_handlers_cover_user_management() {
    let pool = common::test_pool().await;
    let admin_id = common::create_test_admin(&pool, "admin-user").await;
    let target_id = common::create_test_user(&pool, "managed-user").await;

    let admin_html = admin_index_get_handler(Extension(admin_id.clone()), Extension(pool.clone()))
        .await
        .expect("admin index should render for superuser");
    assert!(admin_html.0.contains("<!doctype html>") || admin_html.0.contains("<!DOCTYPE html>"));

    let Json(users) = get_users_handler(Extension(admin_id.clone()), Extension(pool.clone()))
        .await
        .expect("admin should list users");
    assert!(users.contains_key(&target_id));

    let _ = update_users_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Path(target_id.clone()),
        Json(UpdateUserData {
            new_password: "changed123".to_string(),
        }),
    )
    .await
    .expect("admin should reset password");

    sqlx::query("UPDATE user_model SET is_locked = true WHERE id = $1")
        .bind(&target_id)
        .execute(&pool)
        .await
        .expect("target user should be locked for test");

    let _ = unlock_account_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Path(target_id.clone()),
    )
    .await
    .expect("admin should unlock account");

    let created_response = create_users_handler(
        Extension(admin_id),
        Extension(pool),
        Json(SignupPayload {
            username: "created-by-admin".to_string(),
            password: "password123".to_string(),
        }),
    )
    .await
    .expect("admin should create users")
    .into_response();
    assert_eq!(created_response.status(), StatusCode::OK);
}

// 画像一覧、件数制限一覧、画像ファイル配信、静的アセット配信、プレビューHTML、画像削除を確認する。
#[tokio::test]
async fn image_and_asset_handlers_cover_listing_serving_preview_and_delete() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "image-user").await;
    let uuid_filename = format!("{}{}", "abcde", "-image.png");
    let image_id = uuid::Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();

    let image_dir = common::test_files_dir().join(&uuid_filename[0..5]);
    tokio::fs::create_dir_all(image_dir.join("thumb"))
        .await
        .expect("image directories should be created");
    tokio::fs::write(image_dir.join(&uuid_filename), b"png bytes")
        .await
        .expect("image file should be written");

    sqlx::query(
        r#"
        INSERT INTO image_model (id, user_id, filename, uuid_filename, create_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(&image_id)
    .bind(&user_id)
    .bind("image.png")
    .bind(&uuid_filename)
    .bind(now)
    .execute(&pool)
    .await
    .expect("image record should be inserted");

    let Json(images) =
        get_enable_images_handler(Extension(user_id.clone()), Extension(pool.clone()))
            .await
            .expect("images should be listed");
    assert!(images.contains_key(&image_id));

    let Json(limited) = get_enable_images_limit_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Path(1),
    )
    .await
    .expect("limited images should be listed");
    assert_eq!(limited.len(), 1);

    let served = serve_image_file(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Path(uuid_filename.clone()),
        Query(ThumbnailQueryParams { thumb: None }),
    )
    .await
    .expect("image file should be served");
    assert_eq!(served.status(), StatusCode::OK);

    let static_response = serve_static_file(Path("service-worker.js".to_string()))
        .await
        .expect("embedded static asset should be served");
    assert_eq!(static_response.status(), StatusCode::OK);

    let preview =
        image_preview_html_get_handler(Extension(test_tera()), Path(uuid_filename.clone()))
            .await
            .into_response();
    assert_eq!(preview.status(), StatusCode::OK);

    let Json(deleted) =
        delete_image_handler(Extension(user_id), Extension(pool), Path(image_id.clone()))
            .await
            .expect("image should be deleted");
    assert_eq!(deleted.id, image_id);
}

// Multipart アップロードをRouter経由で実行し、アップロードハンドラが保存とDB登録を完了できることを確認する。
#[tokio::test]
async fn upload_image_handler_accepts_multipart_payload() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "upload-user").await;
    let pdf = b"%PDF-1.7\n% test\n";
    let boundary = "BOUNDARY";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"asset_kind\"\r\n\r\nfile\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"upload_file\"; filename=\"tiny.pdf\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: application/pdf\r\n\r\n");
    body.extend_from_slice(pdf);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let app = Router::new()
        .route("/upload", post(upload_image_handler))
        .layer(Extension(user_id))
        .layer(Extension(pool));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/upload")
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .expect("request should build"),
        )
        .await
        .expect("upload request should execute");

    assert_eq!(response.status(), StatusCode::OK);
}

// マーカー/図形を含むJSONエクスポートと、Multipart JSONインポートによるDB登録を確認する。
#[tokio::test]
async fn file_handlers_cover_export_and_import() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "file-user").await;
    let layer_id = common::master_layer_id(&pool, &user_id).await;
    insert_marker(&pool, &user_id, &layer_id).await;
    insert_shape(&pool, &user_id, &layer_id).await;

    let export_app = Router::new()
        .route("/export/{layer_id}", get(export_json_handler))
        .layer(Extension(user_id.clone()))
        .layer(Extension(pool.clone()));
    let response = export_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/export/{layer_id}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("export request should execute");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("export body should be readable");
    let package: ExportPackage = serde_json::from_slice(&bytes).expect("export should be json");
    assert_eq!(package.markers.len(), 1);
    assert_eq!(package.shapes.len(), 1);

    let boundary = "IMPORT";
    let import_json = json!({
        "version": 2,
        "markers": [{
            "marker_name": "imported",
            "latitude": 1.0,
            "longitude": 2.0,
            "detail": "detail",
            "layer": {"layer_name": "imported layer", "is_master": false}
        }],
        "shapes": [{
            "shape_type": "circle",
            "name": "circle",
            "geojson": {"type": "Feature"},
            "layer": {"layer_name": "imported layer", "is_master": false}
        }]
    })
    .to_string();
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"import.json\"\r\nContent-Type: application/json\r\n\r\n{import_json}\r\n--{boundary}--\r\n"
    );
    let app = Router::new()
        .route("/import", post(import_json_handler))
        .layer(Extension(user_id.clone()))
        .layer(Extension(pool.clone()));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/import")
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .expect("request should build"),
        )
        .await
        .expect("import request should execute");
    assert_eq!(response.status(), StatusCode::OK);

    let imported_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM marker_info_model WHERE user_id = $1 AND marker_name = 'imported'",
    )
    .bind(&user_id)
    .fetch_one(&pool)
    .await
    .expect("imported marker count should be returned");
    assert_eq!(imported_count, 1);
}

// 地図画面と別ウィンドウ地図画面がSQLite上のレイヤ/マーカー/図形/タイル情報で描画できることを確認する。
#[tokio::test]
async fn map_handlers_render_templates_with_sqlite_data() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "map-user").await;
    let layer_id = common::master_layer_id(&pool, &user_id).await;
    insert_marker(&pool, &user_id, &layer_id).await;
    insert_shape(&pool, &user_id, &layer_id).await;

    let response = map_get_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Extension(test_tera()),
        Query(MapReadQueryPrams {
            marker_id: None,
            latitude: None,
            longitude: None,
            layer: Some(layer_id),
            is_master: Some(true),
        }),
        HeaderMap::new(),
    )
    .await
    .expect("map should render")
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let response = map_another_get_handler(
        Extension(user_id),
        Extension(pool),
        Extension(test_tera()),
        Query(MapAnotherWindowQueryParams {
            is_cluster: Some(false),
        }),
    )
    .await
    .expect("another map should render")
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
}

// 共有URLの生成、現在URL取得、パスワード付き共有ページ表示、パスワード認証、無効化を確認する。
#[tokio::test]
async fn onetime_url_handlers_cover_generate_current_render_and_invalidate() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "share-user").await;
    let layer_id = common::master_layer_id(&pool, &user_id).await;
    insert_marker(&pool, &user_id, &layer_id).await;
    insert_shape(&pool, &user_id, &layer_id).await;

    assert!(
        generate_url_handler(
            Extension(user_id.clone()),
            Extension(pool.clone()),
            Json(GenarateUrlPayload {
                minutes: 10,
                layers: Vec::new(),
                update_url: false,
                share_password: None,
                include_shapes: false,
            }),
        )
        .await
        .is_err(),
        "empty layer share should be rejected"
    );

    let Json(created) = generate_url_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Json(GenarateUrlPayload {
            minutes: 10,
            layers: vec![layer_id],
            update_url: false,
            share_password: Some("pass1234".to_string()),
            include_shapes: true,
        }),
    )
    .await
    .expect("share url should be generated");
    assert!(created.url.starts_with("/onetime/"));

    let Json(current) = current_url_handler(Extension(user_id.clone()), Extension(pool.clone()))
        .await
        .expect("current url should be returned");
    assert!(current.is_password_protected);

    let response = temporary_map_get_handler(
        HeaderMap::new(),
        Extension(pool.clone()),
        Extension(test_tera()),
        Ok(Path(created.id)),
    )
    .await
    .expect("temporary map request should render password page")
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let response = temporary_map_auth_handler(
        HeaderMap::new(),
        Extension(pool.clone()),
        Extension(test_tera()),
        Path(current.id),
        Form(OnetimePasswordForm {
            password: "pass1234".to_string(),
        }),
    )
    .await
    .expect("temporary map password auth should render map")
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let status = invalidate_url_handler(Extension(user_id), Extension(pool))
        .await
        .expect("share url should invalidate");
    assert_eq!(status, StatusCode::NO_CONTENT);
}

// TOTPのセットアップ、検証による有効化、TOTPログイン、無効化を確認する。
#[tokio::test]
async fn totp_handlers_cover_setup_verify_login_and_disable() {
    let pool = common::test_pool().await;
    let user_id = common::create_test_user(&pool, "totp-user").await;

    let setup_response = totp_setup_handler(Extension(user_id.clone()), Extension(pool.clone()))
        .await
        .expect("totp setup should succeed")
        .into_response();
    assert_eq!(setup_response.status(), StatusCode::OK);

    let temp_secret: String =
        sqlx::query_scalar("SELECT totp_temp_secret FROM user_model WHERE id = $1")
            .bind(&user_id)
            .fetch_one(&pool)
            .await
            .expect("temp secret should be stored");
    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        temp_secret.clone().into(),
        "GeoCode Test".to_string().into(),
        user_id.clone(),
    )
    .expect("totp should build");
    let token = totp
        .generate_current()
        .expect("current token should generate");

    let _ = totp_verify_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Json(TotpVerifyRequest { token }),
    )
    .await
    .expect("totp verification should enable totp");

    sqlx::query(
        "UPDATE user_model SET is_basic_authed = true, is_basic_authed_at = $1 WHERE id = $2",
    )
    .bind(Utc::now().naive_utc())
    .bind(&user_id)
    .execute(&pool)
    .await
    .expect("basic auth flag should be set");
    let login_token = totp
        .generate_current()
        .expect("login token should generate");
    let login_response = token_totp_handler(
        Extension(pool.clone()),
        Json(TotpLoginPayload {
            totp_token: login_token,
            user_id: user_id.clone(),
        }),
    )
    .await
    .expect("totp login should succeed")
    .into_response();
    assert_eq!(login_response.status(), StatusCode::OK);

    let Json(disabled) = totp_disable_handler(Extension(user_id), Extension(pool))
        .await
        .expect("totp should disable");
    assert!(disabled.message.contains("disabled"));
}
