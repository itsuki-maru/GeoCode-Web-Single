#[allow(dead_code)]
#[path = "support/uuid_fixtures.rs"]
mod common;

use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::NaiveDateTime;
use geocode_web_single::{
    handler::onetime_url::*,
    model::{CreateUpdatedTemporaryUrlResponse, GenarateUrlPayload},
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::sync::Arc;
use tera::Tera;
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;

fn at(value: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .naive_utc()
}
fn past() -> NaiveDateTime {
    at("2020-01-01T00:00:00Z")
}
fn future() -> NaiveDateTime {
    (chrono::Utc::now() + chrono::Duration::days(2)).naive_utc()
}

#[test]
fn sqlite_expiry_precision_is_consistent_between_management_and_public_pages() {
    use geocode_web_single::model::TemporaryUrlFromDB;
    for (at, expired) in [(past(), true), (future(), false)] {
        for format in [
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M:%S%.3f",
            "%Y-%m-%d %H:%M:%S%.6f",
            "%Y-%m-%d %H:%M:%S%.9f",
        ] {
            let expiration = at.format(format).to_string();
            let stored: TemporaryUrlFromDB = serde_json::from_value(json!({
                "id": Uuid::nil().to_string(), "user_id": Uuid::nil().to_string(),
                "url": "/fixture", "expiration": expiration, "password_hash": null,
                "layers": "{}", "markers": "{}", "shapes": "{}",
                "include_tile_overlays": false, "create_at": "2020-01-01 00:00:00"
            }))
            .unwrap();
            assert_eq!(stored.is_expired(), expired, "public: {expiration}");
            assert_eq!(is_expired(&expiration), expired, "management: {expiration}");
        }
    }
}

fn payload(layers: Vec<Uuid>, password: Option<&str>, update: bool) -> GenarateUrlPayload {
    GenarateUrlPayload {
        minutes: 120,
        layers: layers.into_iter().map(|id| id.to_string()).collect(),
        update_url: update,
        share_password: password.map(str::to_owned),
        include_shapes: true,
        include_tile_overlays: false,
    }
}
async fn create(
    pool: &SqlitePool,
    user: Uuid,
    layers: Vec<Uuid>,
    password: Option<&str>,
    update: bool,
) -> CreateUpdatedTemporaryUrlResponse {
    generate_url_handler(
        Extension(user.to_string()),
        Extension(pool.clone()),
        Json(payload(layers, password, update)),
    )
    .await
    .unwrap()
    .0
}
fn templates() -> Arc<Mutex<Tera>> {
    let mut tera = Tera::default();
    tera.add_raw_template("notfound.html", "NOT_FOUND|{{ viewport_content }}")
        .unwrap();
    tera.add_raw_template(
        "temporary-password.html",
        "PASSWORD|{{ viewport_content }}|{{ error_message }}|{{ url_id }}|{{ mapStateQuery }}",
    )
    .unwrap();
    for (name, kind) in [
        ("temporary-map.html", "MAP_PC"),
        ("temporary-map-mobile.html", "MAP_MOBILE"),
    ] {
        tera.add_raw_template(name,&format!("{kind}|{{{{ latitude }}}}|{{{{ longitude }}}}|{{{{ zoom }}}}|{{{{ isChecked }}}}|{{{{ isMapUiHidden }}}}|{{{{ isOverlayTile }}}}|{{{{ markersObj | json_encode() | safe }}}}|{{{{ shapesObj | json_encode() | safe }}}}")).unwrap();
    }
    Arc::new(Mutex::new(tera))
}
fn app(pool: &SqlitePool, tera: Arc<Mutex<Tera>>) -> Router {
    Router::new()
        .route(
            "/onetime/{url_id}",
            get(temporary_map_get_handler).post(temporary_map_auth_handler),
        )
        .layer(Extension(pool.clone()))
        .layer(Extension(tera))
}
async fn send(app: &Router, path: &str, password: Option<&str>, mobile: bool) -> Response {
    let mut request = Request::builder()
        .method(if password.is_some() { "POST" } else { "GET" })
        .uri(path);
    if mobile {
        request = request.header("user-agent", "Fixture Mobile");
    }
    if password.is_some() {
        request = request.header("content-type", "application/x-www-form-urlencoded");
    }
    app.clone()
        .oneshot(
            request
                .body(Body::from(
                    password
                        .map(|p| format!("password={p}"))
                        .unwrap_or_default(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn body(response: Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}
async fn snapshot(pool: &SqlitePool, user: Uuid) -> Value {
    sqlx::query_scalar("SELECT json_object('id',id,'user_id',user_id,'url',url,'expiration',expiration,'layers',json(layers),'markers',json(markers),'shapes',json(shapes),'password_hash',password_hash,'include_tile_overlays',include_tile_overlays,'create_at',create_at) FROM temporary_urls WHERE user_id=$1")
        .bind(user.to_string())
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn set_expiration(pool: &SqlitePool, id: String, expiration: NaiveDateTime) {
    sqlx::query("UPDATE temporary_urls SET expiration=$1 WHERE id=$2")
        .bind(expiration)
        .bind(id.to_string())
        .execute(pool)
        .await
        .unwrap();
}
async fn fixture(pool: &SqlitePool, name: &str) -> (Uuid, Uuid, Uuid, Uuid) {
    let user = common::create_test_user(pool, name).await;
    let layer = common::master_layer_id(pool, &user).await;
    let marker = Uuid::new_v4();
    let shape = Uuid::new_v4();
    sqlx::query("INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) VALUES($1,$2,$3,'fixture',35,139,'private snapshot',$4,$4)")
        .bind(marker.to_string()).bind(user.to_string()).bind(layer.to_string()).bind(past()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO shape_model(id,user_id,layer_id,shape_type,name,geojson,created_at,updated_at) VALUES($1,$2,$3,'circle','fixture',$4,$5,$5)")
        .bind(shape.to_string()).bind(user.to_string()).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{"radius":10},"geometry":{"type":"Point","coordinates":[139,35]}})).bind(past()).execute(pool).await.unwrap();
    (user, layer, marker, shape)
}
async fn assert_error(response: Response, status: StatusCode) {
    assert_eq!(response.status(), status);
    let text = body(response).await;
    assert!(
        !text.contains("fixture rejection"),
        "database details must not be exposed: {text}"
    );
    assert!(!text.contains("private snapshot"));
}

#[tokio::test]
async fn shares_snapshot_only_owned_records_and_refresh_or_rotate_without_leaking_foreign_data() {
    let pool = common::test_pool().await;
    let (owner, layer, marker, shape) = fixture(&pool, "share-owner").await;
    let (other, foreign_layer, foreign_marker, foreign_shape) = fixture(&pool, "share-other").await;
    let created = create(&pool, owner, vec![layer, foreign_layer, layer], None, false).await;
    let initial = snapshot(&pool, owner).await;
    for (key, id, foreign) in [
        ("layers", layer, foreign_layer),
        ("markers", marker, foreign_marker),
        ("shapes", shape, foreign_shape),
    ] {
        assert_eq!(initial[key].as_object().unwrap().len(), 1);
        assert!(initial[key].get(id.to_string()).is_some());
        assert!(initial[key].get(foreign.to_string()).is_none());
    }
    sqlx::query("UPDATE marker_info_model SET detail='updated snapshot' WHERE id=$1")
        .bind(marker.to_string())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        snapshot(&pool, owner).await,
        initial,
        "a saved share remains a snapshot before explicit refresh"
    );
    let refreshed = create(&pool, owner, vec![layer], None, true).await;
    assert_eq!(
        (refreshed.id.clone(), refreshed.url.clone()),
        (created.id.clone(), created.url.clone())
    );
    assert_eq!(
        snapshot(&pool, owner).await["markers"][marker.to_string()]["detail"],
        "updated snapshot"
    );
    let foreign = create(&pool, other, vec![foreign_layer], None, false).await;
    let mut request = payload(vec![layer], None, false);
    request.include_shapes = false;
    let rotated = generate_url_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Json(request),
    )
    .await
    .unwrap()
    .0;
    assert_ne!(rotated.id, created.id);
    assert_eq!(snapshot(&pool, owner).await["shapes"], json!({}));
    assert_eq!(snapshot(&pool, other).await["id"], foreign.id.to_string());
    let public = app(&pool, templates());
    assert!(
        body(send(&public, &format!("/onetime/{}", created.id), None, false).await)
            .await
            .starts_with("NOT_FOUND|")
    );
}

#[tokio::test]
async fn invalid_passwords_and_empty_layers_preserve_existing_share_and_password_boundaries() {
    let pool = common::test_pool().await;
    let (owner, layer, _, _) = fixture(&pool, "share-validation").await;
    create(&pool, owner, vec![layer], Some("  pass  "), false).await;
    let before = snapshot(&pool, owner).await;
    assert!(bcrypt::verify("pass", before["password_hash"].as_str().unwrap()).unwrap());
    for request in [
        payload(vec![], None, false),
        payload(vec![layer], Some("abc"), false),
        payload(vec![layer], Some(&"a".repeat(65)), true),
    ] {
        let response = generate_url_handler(
            Extension(owner.to_string()),
            Extension(pool.clone()),
            Json(request),
        )
        .await
        .into_response();
        assert_error(response, StatusCode::BAD_REQUEST).await;
        assert_eq!(snapshot(&pool, owner).await, before);
    }
    create(&pool, owner, vec![layer], Some(&"a".repeat(64)), true).await;
    assert!(
        bcrypt::verify(
            "a".repeat(64),
            snapshot(&pool, owner).await["password_hash"]
                .as_str()
                .unwrap()
        )
        .unwrap()
    );
    create(&pool, owner, vec![layer], Some(" \t "), true).await;
    assert!(snapshot(&pool, owner).await["password_hash"].is_null());
}

#[tokio::test]
async fn expired_shares_are_removed_without_waiting() {
    let pool = common::test_pool().await;
    {
        let name = "expiry-user";
        let (owner, layer, _, _) = fixture(&pool, name).await;
        let public = app(&pool, templates());
        assert_eq!(
            current_url_handler(Extension(owner.to_string()), Extension(pool.clone()))
                .await
                .err()
                .unwrap()
                .into_response()
                .status(),
            StatusCode::NOT_FOUND
        );
        for mode in ["current", "get", "post"] {
            let created = create(&pool, owner, vec![layer], None, false).await;
            set_expiration(&pool, created.id.clone(), future()).await;
            assert!(
                current_url_handler(Extension(owner.to_string()), Extension(pool.clone()))
                    .await
                    .is_ok()
            );
            set_expiration(&pool, created.id.clone(), past()).await;
            if mode == "current" {
                assert_eq!(
                    current_url_handler(Extension(owner.to_string()), Extension(pool.clone()))
                        .await
                        .err()
                        .unwrap()
                        .into_response()
                        .status(),
                    StatusCode::NOT_FOUND
                );
            } else {
                let response = send(
                    &public,
                    &format!("/onetime/{}", created.id),
                    if mode == "post" { Some("unused") } else { None },
                    true,
                )
                .await;
                // 既存の公開 HTML ハンドラーは、未検出ページを HTTP 200 で描画する。
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(body(response).await, "NOT_FOUND|0.7");
            }
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM temporary_urls WHERE user_id=$1"
                )
                .bind(owner.to_string())
                .fetch_one(&pool)
                .await
                .unwrap(),
                0
            );
        }
        pool.close().await;
    }
}

#[tokio::test]
async fn password_pages_never_expose_snapshot_and_preserve_normalized_map_state() {
    let pool = common::test_pool().await;
    let (owner, layer, _, _) = fixture(&pool, "password-pages").await;
    let created = create(&pool, owner, vec![layer], Some("secure-pass"), false).await;
    set_expiration(&pool, created.id.clone(), future()).await;
    let public = app(&pool, templates());
    let path = format!(
        "/onetime/{}?lat=NaN&lng=181&zoom=23&is_checked=FALSE&isMapUiHidden=false&is_overlay_tile=false",
        created.id
    );
    for password in [None, Some("wrong")] {
        let response = send(&public, &path, password, true).await;
        assert_eq!(response.status(), StatusCode::OK);
        let text = body(response).await;
        assert!(text.starts_with("PASSWORD|0.7|"), "{text}");
        assert!(!text.contains("private snapshot"));
        for param in [
            "lat=39.2",
            "lng=138.5",
            "zoom=6",
            "is_checked=false",
            "isMapUiHidden=false",
            "is_overlay_tile=false",
        ] {
            assert!(text.contains(param), "{text}");
        }
        if password.is_some() {
            assert!(text.contains("パスワードが正しくありません。"));
        }
    }
    for (mobile, kind) in [(false, "MAP_PC"), (true, "MAP_MOBILE")] {
        let text = body(send(&public, &path, Some("secure-pass"), mobile).await).await;
        assert!(
            text.starts_with(&format!("{kind}|39.2|138.5|6|false|false|false|")),
            "{text}"
        );
        assert!(text.contains("private snapshot"));
    }
    sqlx::query("UPDATE temporary_urls SET password_hash='invalid-hash' WHERE id=$1")
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        body(send(&public, &path, Some("secure-pass"), false).await)
            .await
            .starts_with("PASSWORD|1.0|")
    );
    sqlx::query("UPDATE temporary_urls SET password_hash=NULL WHERE id=$1")
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        body(send(&public, &path, Some("unused"), true).await)
            .await
            .starts_with("MAP_MOBILE|")
    );
    for path in [
        "/onetime/not-a-uuid".to_string(),
        format!("/onetime/{}", Uuid::nil()),
    ] {
        assert_eq!(
            body(send(&public, &path, None, false).await).await,
            "NOT_FOUND|1.0"
        );
    }
    assert_eq!(
        body(
            send(
                &public,
                &format!("/onetime/{}", Uuid::nil()),
                Some("unused"),
                true
            )
            .await
        )
        .await,
        "NOT_FOUND|0.7"
    );
}

#[tokio::test]
async fn management_requires_login_and_invalidation_is_scoped_to_the_authenticated_owner() {
    let pool = common::test_pool().await;
    let (owner, layer, _, _) = fixture(&pool, "manage-owner").await;
    let (other, foreign_layer, _, _) = fixture(&pool, "manage-other").await;
    let created = create(&pool, owner, vec![layer], None, false).await;
    create(&pool, other, vec![foreign_layer], None, false).await;
    let router = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    for (method, path) in [
        ("POST", "/onetimeurl/generate".to_string()),
        ("GET", "/onetimeurl/current".to_string()),
        ("DELETE", format!("/onetimeurl/delete/{}", created.id)),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = router
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/onetimeurl/delete/{}", created.id))
                .header(
                    "cookie",
                    format!(
                        "access_token={}",
                        geocode_web_single::auth::create_token(
                            &other.to_string(),
                            30,
                            "access_token",
                            0
                        )
                        .unwrap()
                    ),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(snapshot(&pool, owner).await["id"], created.id.to_string());
    assert!(
        current_url_handler(Extension(other.to_string()), Extension(pool.clone()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn storage_failures_are_reported_and_failed_updates_keep_the_existing_snapshot() {
    let pool = common::test_pool().await;
    let (owner, layer, _, _) = fixture(&pool, "storage-errors").await;
    for table in [
        "marker_info_model",
        "layer_model",
        "shape_model",
        "temporary_urls",
    ] {
        sqlx::query(&format!("ALTER TABLE {table} RENAME TO fixture_hidden"))
            .execute(&pool)
            .await
            .unwrap();
        assert_error(
            generate_url_handler(
                Extension(owner.to_string()),
                Extension(pool.clone()),
                Json(payload(vec![layer], None, false)),
            )
            .await
            .into_response(),
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .await;
        sqlx::query(&format!("ALTER TABLE fixture_hidden RENAME TO {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }

    sqlx::query("CREATE TRIGGER reject_share BEFORE INSERT ON temporary_urls BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END").execute(&pool).await.unwrap();
    assert_error(
        generate_url_handler(
            Extension(owner.to_string()),
            Extension(pool.clone()),
            Json(payload(vec![layer], None, false)),
        )
        .await
        .into_response(),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    sqlx::query("DROP TRIGGER reject_share")
        .execute(&pool)
        .await
        .unwrap();
    let created = create(&pool, owner, vec![layer], None, false).await;
    let before = snapshot(&pool, owner).await;
    sqlx::query("CREATE TRIGGER reject_share BEFORE UPDATE ON temporary_urls BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END").execute(&pool).await.unwrap();
    assert_error(
        generate_url_handler(
            Extension(owner.to_string()),
            Extension(pool.clone()),
            Json(payload(vec![layer], None, true)),
        )
        .await
        .into_response(),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_eq!(snapshot(&pool, owner).await, before);
    sqlx::query("DROP TRIGGER reject_share")
        .execute(&pool)
        .await
        .unwrap();
    set_expiration(&pool, created.id.clone(), past()).await;
    sqlx::query("CREATE TRIGGER reject_share BEFORE DELETE ON temporary_urls BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END").execute(&pool).await.unwrap();
    assert_error(
        invalidate_url_handler(Extension(owner.to_string()), Extension(pool.clone()))
            .await
            .into_response(),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_error(
        current_url_handler(Extension(owner.to_string()), Extension(pool.clone()))
            .await
            .into_response(),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    let public = app(&pool, templates());
    for password in [None, Some("unused")] {
        assert_error(
            send(
                &public,
                &format!("/onetime/{}", created.id),
                password,
                false,
            )
            .await,
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .await;
    }
    assert_eq!(snapshot(&pool, owner).await["id"], created.id.to_string());
}

#[tokio::test]
async fn database_and_template_failures_do_not_render_private_snapshots() {
    let pool = common::test_pool().await;
    let (owner, layer, _, _) = fixture(&pool, "render-errors").await;
    let created = create(&pool, owner, vec![layer], None, false).await;
    set_expiration(&pool, created.id.clone(), future()).await;
    let path = format!("/onetime/{}", created.id);
    let broken = app(&pool, Arc::new(Mutex::new(Tera::default())));
    assert_error(
        send(&broken, &path, None, false).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_error(
        send(&broken, "/onetime/invalid", None, false).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    sqlx::query("UPDATE temporary_urls SET password_hash='invalid-hash' WHERE id=$1")
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_error(
        send(&broken, &path, None, false).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    sqlx::query("UPDATE temporary_urls SET password_hash=NULL WHERE id=$1")
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();
    let public = app(&pool, templates());
    sqlx::query("ALTER TABLE tileserver_model RENAME TO fixture_tiles")
        .execute(&pool)
        .await
        .unwrap();
    assert_error(
        send(&public, &path, None, false).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    sqlx::query("ALTER TABLE fixture_tiles RENAME TO tileserver_model")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    assert_error(
        current_url_handler(Extension(owner.to_string()), Extension(pool.clone()))
            .await
            .into_response(),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_error(
        send(&public, &path, Some("unused"), false).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_eq!(
        body(send(&public, &path, None, false).await).await,
        "NOT_FOUND|1.0"
    );
}
