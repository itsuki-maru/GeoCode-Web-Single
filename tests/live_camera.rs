#[allow(dead_code)]
mod common;
use axum::{
    Json,
    body::to_bytes,
    extract::{Extension, Path},
    http::HeaderMap,
    response::Response,
};
use geocode_web_single::handler::live_camera::{
    self as camera, CameraConfig, Exchange, Join, Leave, Outgoing, Start,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

fn config() -> CameraConfig {
    CameraConfig {
        provider: String::new(),
        cloudflare_key_id: String::new(),
        cloudflare_api_token: String::new(),
        enabled: true,
        stun_urls: vec![],
        urls: vec!["turn:localhost:3478".into()],
        secret: "test-only-secret-32-characters-long".into(),
        relay_only: true,
    }
}

#[tokio::test]
async fn production_router_registers_camera_routes_and_requires_publisher_login() {
    let pool = common::test_pool().await;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    common::init_test_env();
    let app = geocode_web_single::router::build_router(
        pool,
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let result = app
        .oneshot(
            Request::builder()
                .uri("/live-camera/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::UNAUTHORIZED);
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap()
}
#[tokio::test]
async fn p2p_start_without_ice_servers() {
    let pool = common::test_pool().await;
    let (user, location, _, _, id) = fixture(&pool).await;
    let mut c = config();
    c.urls.clear();
    c.secret.clear();
    c.relay_only = false;
    let result = camera::start(
        Extension(pool),
        Extension(c),
        Extension(user.clone()),
        Path(location.to_string()),
        Json(Start { id }),
    )
    .await
    .unwrap();
    let value = body(result).await;
    assert_eq!(value["ice_servers"], json!([]));
    assert_eq!(value["relay_only"], false);
}

#[tokio::test]
async fn failures_are_authenticated_retained_and_release_slots() {
    let pool = common::test_pool().await;
    let (user, _, public, member, camera_id) = fixture(&pool).await;
    let failed = Uuid::new_v4();
    let key = Uuid::new_v4();
    let healthy = Uuid::new_v4();
    join(&pool, public, member, failed, key).await.unwrap();
    join(&pool, public, member, healthy, Uuid::new_v4())
        .await
        .unwrap();
    join(&pool, public, member, Uuid::new_v4(), Uuid::new_v4())
        .await
        .unwrap();
    camera::leave(
        Extension(pool.clone()),
        Path((public.to_string(), failed)),
        Json(Leave {
            key: Uuid::new_v4(),
            failed: true,
        }),
    )
    .await
    .unwrap();
    let poll = || {
        camera::publisher_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Extension(user.clone()),
            Path(camera_id),
            Json(exchange(None)),
        )
    };
    assert_eq!(body(poll().await.unwrap()).await["failed_peers"], json!([]));
    camera::leave(
        Extension(pool.clone()),
        Path((public.to_string(), failed)),
        Json(Leave { key, failed: true }),
    )
    .await
    .unwrap();
    // 通知の再送や通常終了の遅延要求で失敗理由を失わない。
    camera::leave(
        Extension(pool.clone()),
        Path((public.to_string(), failed)),
        Json(Leave { key, failed: false }),
    )
    .await
    .unwrap();
    for _ in 0..2 {
        let value = body(poll().await.unwrap()).await;
        assert_eq!(value["failed_peers"], json!([failed]));
        assert_eq!(value["peers"].as_array().unwrap().len(), 2);
        assert!(value["peers"].as_array().unwrap().contains(&json!(healthy)));
    }
    assert!(
        camera::viewer_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Path((public.to_string(), failed)),
            HeaderMap::new(),
            Json(exchange(Some(key)))
        )
        .await
        .is_err()
    );
    assert!(
        join(&pool, public, member, Uuid::new_v4(), Uuid::new_v4())
            .await
            .is_ok()
    );
    let mut request = exchange(None);
    request.failed_viewers = vec![healthy];
    let value = body(
        camera::publisher_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Extension(user.clone()),
            Path(camera_id),
            Json(request),
        )
        .await
        .unwrap(),
    )
    .await;
    assert!(!value["peers"].as_array().unwrap().contains(&json!(healthy)));
    assert!(
        value["failed_peers"]
            .as_array()
            .unwrap()
            .contains(&json!(healthy))
    );
}

fn exchange(key: Option<Uuid>) -> Exchange {
    Exchange {
        failed_viewers: vec![],
        after: 0,
        messages: vec![],
        key,
    }
}

#[tokio::test]
async fn cleanup_cascades_signals_and_keeps_stopped_ids_until_retention_expires() {
    let pool = common::test_pool().await;
    let (user, _, public, member, id) = fixture(&pool).await;
    let viewer = Uuid::new_v4();
    join(&pool, public, member, viewer, Uuid::new_v4())
        .await
        .unwrap();
    let mut input = exchange(None);
    input.messages.push(Outgoing {
        message_id: Uuid::new_v4(),
        viewer_id: viewer,
        kind: "offer".into(),
        data: json!("v=0"),
    });
    camera::publisher_exchange(
        Extension(pool.clone()),
        Extension(config()),
        Extension(user.clone()),
        Path(id),
        Json(input),
    )
    .await
    .unwrap();
    camera::stop(Extension(pool.clone()), Extension(user), Path(id))
        .await
        .unwrap();
    camera::cleanup(&pool).await.unwrap();
    for table in ["live_camera_viewer", "live_camera_signal"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM live_camera_session")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("UPDATE live_camera_session SET expires_at=datetime('now','-2 days')")
        .execute(&pool)
        .await
        .unwrap();
    camera::cleanup(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM live_camera_session")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn disabled_camera_does_not_create_a_session() {
    let pool = common::test_pool().await;
    let (user, location, _, _, _) = fixture(&pool).await;
    let mut disabled = config();
    disabled.enabled = false;
    assert_eq!(
        body(camera::capabilities(Extension(disabled.clone())).await).await["enabled"],
        false
    );
    assert!(matches!(
        camera::start(
            Extension(pool.clone()),
            Extension(disabled),
            Extension(user),
            Path(location.to_string()),
            Json(Start { id: Uuid::new_v4() })
        )
        .await,
        Err(geocode_web_single::error::AppError::NotFound)
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM live_camera_session")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
async fn fixture(pool: &SqlitePool) -> (String, Uuid, Uuid, Uuid, Uuid) {
    let user = common::create_test_user(pool, "camera-publisher").await;
    sqlx::query("UPDATE user_model SET can_share_live_location=true WHERE id=$1")
        .bind(&user)
        .execute(pool)
        .await
        .unwrap();
    let location = Uuid::new_v4();
    let map = Uuid::new_v4();
    let public = Uuid::new_v4();
    let member = Uuid::new_v4();
    sqlx::query("INSERT INTO live_location_session(user_id,session_id,latitude,longitude,observed_at) VALUES($1,$2,35,139,CURRENT_TIMESTAMP)").bind(&user).bind(location.to_string()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO live_map(id,public_id,name,created_by,expires_at) VALUES($1,$2,'camera map',$3,datetime('now','+1 hour'))").bind(map.to_string()).bind(public.to_string()).bind(&user).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO live_map_member(id,map_id,user_id,display_name) VALUES($1,$2,$3,'publisher')",
    )
    .bind(member.to_string())
    .bind(map.to_string())
    .bind(&user)
    .execute(pool)
    .await
    .unwrap();
    let id = Uuid::new_v4();
    camera::start(
        Extension(pool.clone()),
        Extension(config()),
        Extension(user.clone()),
        Path(location.to_string()),
        Json(Start { id }),
    )
    .await
    .unwrap();
    (user, location, public, member, id)
}
async fn join(
    pool: &SqlitePool,
    public: Uuid,
    member: Uuid,
    id: Uuid,
    key: Uuid,
) -> Result<Response, geocode_web_single::error::AppError> {
    camera::join(
        Extension(pool.clone()),
        Extension(config()),
        Path((public.to_string(), member.to_string())),
        HeaderMap::new(),
        Json(Join { id, key }),
    )
    .await
}
#[tokio::test]
async fn three_slots_are_atomic_and_released() {
    common::init_test_env();
    let path = common::test_files_dir().join(format!("camera-{}.sqlite", Uuid::new_v4()));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true)
                .busy_timeout(std::time::Duration::from_secs(5)),
        )
        .await
        .unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    let (_, _, public, member, _) = fixture(&pool).await;
    let mut attempts = vec![];
    for _ in 0..4 {
        let p = pool.clone();
        attempts.push(tokio::spawn(async move {
            let id = Uuid::new_v4();
            let key = Uuid::new_v4();
            (id, key, join(&p, public, member, id, key).await)
        }));
    }
    let mut accepted = vec![];
    for task in attempts {
        let (id, key, ok) = task.await.unwrap();
        if ok.is_ok() {
            accepted.push((id, key));
        } else {
            assert!(matches!(
                ok,
                Err(geocode_web_single::error::AppError::TooManyRequests(_))
            ));
        }
    }
    assert_eq!(accepted.len(), 3);
    let (id, key) = accepted[0];
    camera::leave(
        Extension(pool.clone()),
        Path((public.to_string(), id)),
        Json(Leave { key, failed: false }),
    )
    .await
    .unwrap();
    assert!(
        join(&pool, public, member, Uuid::new_v4(), Uuid::new_v4())
            .await
            .is_ok()
    );
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}
#[tokio::test]
async fn revocation_removes_existing_peer_and_rejects_renewal() {
    let pool = common::test_pool().await;
    let (user, _, public, member, id) = fixture(&pool).await;
    let viewer = Uuid::new_v4();
    let key = Uuid::new_v4();
    join(&pool, public, member, viewer, key).await.unwrap();
    sqlx::query("UPDATE live_map SET access_version=access_version+1 WHERE public_id=$1")
        .bind(public.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let result = camera::publisher_exchange(
        Extension(pool.clone()),
        Extension(config()),
        Extension(user.clone()),
        Path(id),
        Json(exchange(None)),
    )
    .await
    .unwrap();
    assert_eq!(body(result).await["peers"], json!([]));
    assert!(
        camera::viewer_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Path((public.to_string(), viewer)),
            HeaderMap::new(),
            Json(exchange(Some(key)))
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn retries_are_deduplicated_and_viewer_secret_is_required() {
    let pool = common::test_pool().await;
    let (user, _, public, member, id) = fixture(&pool).await;
    let viewer = Uuid::new_v4();
    let key = Uuid::new_v4();
    let message_id = Uuid::new_v4();
    join(&pool, public, member, viewer, key).await.unwrap();
    let send = || Exchange {
        failed_viewers: vec![],
        after: 0,
        key: None,
        messages: vec![Outgoing {
            message_id,
            viewer_id: viewer,
            kind: "offer".into(),
            data: json!("v=0"),
        }],
    };
    camera::publisher_exchange(
        Extension(pool.clone()),
        Extension(config()),
        Extension(user.clone()),
        Path(id),
        Json(send()),
    )
    .await
    .unwrap();
    let receive = |key| {
        camera::viewer_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Path((public.to_string(), viewer)),
            HeaderMap::new(),
            Json(exchange(Some(key))),
        )
    };
    assert!(receive(Uuid::new_v4()).await.is_err());
    let first = body(receive(key).await.unwrap()).await;
    let after = first["messages"][0]["id"].as_i64().unwrap();
    camera::publisher_exchange(
        Extension(pool.clone()),
        Extension(config()),
        Extension(user.clone()),
        Path(id),
        Json(send()),
    )
    .await
    .unwrap();
    let mut ack = exchange(Some(key));
    ack.after = after;
    let result = camera::viewer_exchange(
        Extension(pool.clone()),
        Extension(config()),
        Path((public.to_string(), viewer)),
        HeaderMap::new(),
        Json(ack),
    )
    .await
    .unwrap();
    assert_eq!(body(result).await["messages"], json!([]));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM live_camera_signal")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn stopped_expired_and_replaced_sessions_cannot_resume() {
    let pool = common::test_pool().await;
    let (user, location, _, _, id) = fixture(&pool).await;
    // 有効な同一IDの再送は許可するが、停止後は即座に拒否する。
    let restart = || {
        camera::start(
            Extension(pool.clone()),
            Extension(config()),
            Extension(user.clone()),
            Path(location.to_string()),
            Json(Start { id }),
        )
    };
    assert!(restart().await.is_ok());
    let poll = || {
        camera::publisher_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Extension(user.clone()),
            Path(id),
            Json(exchange(None)),
        )
    };
    sqlx::query("UPDATE live_location_session SET session_id=$1 WHERE user_id=$2")
        .bind(Uuid::new_v4().to_string())
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    assert!(poll().await.is_err());
    sqlx::query("UPDATE live_location_session SET session_id=$1 WHERE user_id=$2")
        .bind(location.to_string())
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    camera::stop(Extension(pool.clone()), Extension(user.clone()), Path(id))
        .await
        .unwrap();
    assert!(poll().await.is_err());
    assert!(matches!(
        restart().await,
        Err(geocode_web_single::error::AppError::Conflict)
    ));
}
#[tokio::test]
async fn password_map_and_foreign_owner_are_rejected() {
    let pool = common::test_pool().await;
    let (_, _, public, member, id) = fixture(&pool).await;
    sqlx::query("UPDATE live_map SET password_hash='protected' WHERE public_id=$1")
        .bind(public.to_string())
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        join(&pool, public, member, Uuid::new_v4(), Uuid::new_v4())
            .await
            .is_err()
    );
    assert!(
        camera::publisher_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Extension(Uuid::new_v4().to_string()),
            Path(id),
            Json(exchange(None))
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn lease_expiry_cannot_be_renewed_and_frees_the_viewer_slot() {
    let pool = common::test_pool().await;
    let (user, location, public, member, id) = fixture(&pool).await;
    let viewer = Uuid::new_v4();
    let key = Uuid::new_v4();
    join(&pool, public, member, viewer, key).await.unwrap();
    sqlx::query("UPDATE live_camera_viewer SET expires_at=datetime('now','-1 second') WHERE id=$1")
        .bind(viewer)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        camera::viewer_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Path((public.to_string(), viewer)),
            HeaderMap::new(),
            Json(exchange(Some(key)))
        )
        .await
        .is_err()
    );
    let result = camera::publisher_exchange(
        Extension(pool.clone()),
        Extension(config()),
        Extension(user.clone()),
        Path(id),
        Json(exchange(None)),
    )
    .await
    .unwrap();
    assert_eq!(body(result).await["peers"], json!([]));
    sqlx::query(
        "UPDATE live_camera_session SET expires_at=datetime('now','-1 second') WHERE id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        camera::start(
            Extension(pool.clone()),
            Extension(config()),
            Extension(user.clone()),
            Path(location.to_string()),
            Json(Start { id })
        )
        .await,
        Err(geocode_web_single::error::AppError::Conflict)
    ));
    assert!(
        camera::publisher_exchange(
            Extension(pool.clone()),
            Extension(config()),
            Extension(user.clone()),
            Path(id),
            Json(exchange(None))
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn cloudflare_session_lifetime_and_preflight_authorization() {
    let pool = common::test_pool().await;
    use geocode_web_single::error::AppError;
    let (user, location, public, member, id) = fixture(&pool).await;
    let mut cloudflare = config();
    cloudflare.provider = "cloudflare".into();
    cloudflare.cloudflare_key_id = "a".repeat(32);
    cloudflare.cloudflare_api_token = "test-token".into();
    // 外部APIを呼ばずに拒否されることをエラー種別でも検証する。
    assert!(matches!(
        camera::start(
            Extension(pool.clone()),
            Extension(cloudflare.clone()),
            Extension(Uuid::new_v4().to_string()),
            Path(location.to_string()),
            Json(Start { id: Uuid::new_v4() })
        )
        .await,
        Err(AppError::Forbidden(_))
    ));
    sqlx::query(
        "UPDATE live_camera_session SET created_at=datetime('now','-24 hours') WHERE id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        camera::start(
            Extension(pool.clone()),
            Extension(cloudflare.clone()),
            Extension(user.clone()),
            Path(location.to_string()),
            Json(Start { id })
        )
        .await,
        Err(AppError::Conflict)
    ));
    assert!(matches!(
        camera::publisher_exchange(
            Extension(pool.clone()),
            Extension(cloudflare.clone()),
            Extension(user.clone()),
            Path(id),
            Json(exchange(None))
        )
        .await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        camera::join(
            Extension(pool.clone()),
            Extension(cloudflare),
            Path((public.to_string(), member.to_string())),
            HeaderMap::new(),
            Json(Join {
                id: Uuid::new_v4(),
                key: Uuid::new_v4()
            })
        )
        .await,
        Err(AppError::NotFound)
    ));
    // coturnの既存セッションにはCloudflare用の時間制限を適用しない。
    assert!(
        camera::publisher_exchange(
            Extension(pool),
            Extension(config()),
            Extension(user.clone()),
            Path(id),
            Json(exchange(None))
        )
        .await
        .is_ok()
    );
}
