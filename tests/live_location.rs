#[allow(dead_code)]
mod common;

use axum::{
    Form, Json,
    body::to_bytes,
    extract::{Extension, Path},
    http::{HeaderMap, HeaderValue, StatusCode, header::COOKIE},
    response::IntoResponse,
};
use chrono::{Duration, Utc};
use geocode_web_single::{
    handler::{
        live_location::{
            create_live_location_session_handler, update_live_location_session_handler,
        },
        live_map::{
            authenticate_live_map_handler, create_live_map_handler,
            get_public_live_map_positions_handler, list_live_maps_handler, live_map_page_handler,
            revoke_live_map_handler, update_live_location_permission_handler,
            update_live_map_handler,
        },
    },
    model::{
        CreateLiveMapMemberPayload, CreateLiveMapPayload, LiveLocationPositionPayload,
        LiveMapPasswordAction, LiveMapPasswordForm, UpdateLiveLocationPermissionPayload,
    },
};

fn position(sequence_no: i64) -> LiveLocationPositionPayload {
    LiveLocationPositionPayload {
        latitude: 35.681236,
        longitude: 139.767125,
        accuracy_m: Some(5.0),
        heading_deg: Some(90.0),
        speed_mps: Some(8.0),
        observed_at: Utc::now(),
        sequence_no,
    }
}

fn map_payload(user_id: &str, name: &str) -> CreateLiveMapPayload {
    CreateLiveMapPayload {
        name: name.into(),
        expires_at: Utc::now() + Duration::hours(1),
        members: vec![CreateLiveMapMemberPayload {
            user_id: user_id.to_string(),
            display_name: "共有者A".into(),
            marker_color: "#1a73e8".into(),
        }],
        password_action: LiveMapPasswordAction::Remove,
        share_password: None,
    }
}

fn public_id(share_url: &str) -> String {
    share_url
        .rsplit('/')
        .next()
        .expect("share URL should contain a public ID")
        .to_string()
}

#[tokio::test]
async fn shares_the_latest_position_without_redis_and_revokes_public_access() {
    let pool = common::test_pool().await;
    let admin_id = common::create_test_admin(&pool, "live-map-admin").await;
    let user_id = common::create_test_user(&pool, "location-user-01").await;

    let denied = create_live_location_session_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Json(position(0)),
    )
    .await
    .expect_err("sharing should require account permission")
    .into_response();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    update_live_location_permission_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Path(user_id.clone()),
        Json(UpdateLiveLocationPermissionPayload { enabled: true }),
    )
    .await
    .expect("admin should enable location sharing");

    let Json(session) = create_live_location_session_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Json(position(0)),
    )
    .await
    .expect("permitted account should start sharing");

    sqlx::query(
        "UPDATE live_location_session SET received_at = datetime('now', '-2 seconds') WHERE user_id = $1",
    )
    .bind(&user_id)
    .execute(&pool)
    .await
    .expect("test should move the rate-limit timestamp");
    update_live_location_session_handler(
        Extension(user_id.clone()),
        Extension(pool.clone()),
        Path(session.session_id),
        Json(position(1)),
    )
    .await
    .expect("newer position should replace the previous one");

    let stored_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM live_location_session WHERE user_id = $1")
            .bind(&user_id)
            .fetch_one(&pool)
            .await
            .expect("session row count should be available");
    assert_eq!(stored_rows, 1);

    let Json(created_map) = create_live_map_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Json(map_payload(&user_id, "現在位置共有マップ")),
    )
    .await
    .expect("admin should create a live map without Redis");

    let duplicate = create_live_map_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Json(map_payload(&user_id, "2件目")),
    )
    .await
    .expect_err("only one unrevoked map may exist")
    .into_response();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);

    let Json(maps) = list_live_maps_handler(Extension(admin_id.clone()), Extension(pool.clone()))
        .await
        .expect("admin should retrieve the current map");
    assert_eq!(maps.len(), 1);
    assert_eq!(maps[0].share_url, created_map.share_url);
    assert_eq!(maps[0].members[0].display_name, "共有者A");

    let member_id_before: String =
        sqlx::query_scalar("SELECT id FROM live_map_member WHERE map_id = $1 AND user_id = $2")
            .bind(&created_map.id)
            .bind(&user_id)
            .fetch_one(&pool)
            .await
            .expect("member ID should be available");
    update_live_map_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(created_map.id.clone()),
        Json(map_payload(&user_id, "更新後の現在位置共有マップ")),
    )
    .await
    .expect("current map should be editable without Redis");
    let member_id_after: String =
        sqlx::query_scalar("SELECT id FROM live_map_member WHERE map_id = $1 AND user_id = $2")
            .bind(&created_map.id)
            .bind(&user_id)
            .fetch_one(&pool)
            .await
            .expect("updated member ID should be available");
    assert_eq!(member_id_after, member_id_before);

    let public_id = public_id(&created_map.share_url);
    let response = get_public_live_map_positions_handler(
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(public_id.clone()),
        HeaderMap::new(),
    )
    .await
    .expect("SQLite should provide positions when Redis is absent");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("public response should be readable");
    let snapshot: serde_json::Value =
        serde_json::from_slice(&body).expect("public response should be JSON");
    assert_eq!(snapshot["positions"][0]["display_name"], "共有者A");
    assert_eq!(snapshot["positions"][0]["status"], "live");

    revoke_live_map_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(created_map.id),
    )
    .await
    .expect("admin should revoke the live map");
    let revoked = get_public_live_map_positions_handler(
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(public_id.clone()),
        HeaderMap::new(),
    )
    .await
    .expect_err("revoked map should no longer be public")
    .into_response();
    assert_eq!(revoked.status(), StatusCode::NOT_FOUND);

    let invalid_url_page = live_map_page_handler(
        HeaderMap::new(),
        Extension(geocode_web_single::build_tera_extension().unwrap()),
        Extension(pool),
        Path("invalid-public-id".to_string()),
    )
    .await
    .expect("invalid URL should render the not-found page");
    assert_eq!(invalid_url_page.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn password_protects_live_map_when_redis_is_absent() {
    let pool = common::test_pool().await;
    let admin_id = common::create_test_admin(&pool, "protected-map-admin").await;
    let user_id = common::create_test_user(&pool, "protected-location-user").await;
    update_live_location_permission_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Path(user_id.clone()),
        Json(UpdateLiveLocationPermissionPayload { enabled: true }),
    )
    .await
    .expect("admin should enable location sharing");

    let mut payload = map_payload(&user_id, "パスワード保護マップ");
    payload.password_action = LiveMapPasswordAction::Set;
    payload.share_password = Some("test-password".into());
    let Json(created) = create_live_map_handler(
        Extension(admin_id.clone()),
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Json(payload),
    )
    .await
    .expect("password-protected map should be created without Redis");
    let public_id = public_id(&created.share_url);

    let denied = get_public_live_map_positions_handler(
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(public_id.clone()),
        HeaderMap::new(),
    )
    .await
    .expect_err("password-protected API should reject an unauthenticated request")
    .into_response();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let auth_response = authenticate_live_map_handler(
        HeaderMap::new(),
        Extension(pool.clone()),
        Extension(geocode_web_single::build_tera_extension().unwrap()),
        Path(public_id.clone()),
        Form(LiveMapPasswordForm {
            password: "test-password".into(),
        }),
    )
    .await
    .expect("correct password should authenticate");
    assert_eq!(auth_response.status(), StatusCode::SEE_OTHER);
    let cookie = auth_response
        .headers()
        .get("set-cookie")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .expect("authentication should issue a cookie");
    let mut headers = HeaderMap::new();
    headers.insert(COOKIE, HeaderValue::from_str(cookie).unwrap());
    let allowed = get_public_live_map_positions_handler(
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(public_id.clone()),
        headers.clone(),
    )
    .await
    .expect("authenticated request should access positions without Redis");
    assert_eq!(allowed.status(), StatusCode::OK);

    let mut changed = map_payload(&user_id, "パスワード保護マップ");
    changed.password_action = LiveMapPasswordAction::Set;
    changed.share_password = Some("new-password".into());
    update_live_map_handler(
        Extension(admin_id),
        Extension(pool.clone()),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(created.id),
        Json(changed),
    )
    .await
    .expect("password should be changed");
    let expired_cookie = get_public_live_map_positions_handler(
        Extension(pool),
        Extension(None::<redis::aio::ConnectionManager>),
        Path(public_id),
        headers,
    )
    .await
    .expect_err("password change should invalidate an existing viewer cookie")
    .into_response();
    assert_eq!(expired_cookie.status(), StatusCode::UNAUTHORIZED);
}
