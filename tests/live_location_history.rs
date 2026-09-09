#[allow(dead_code)]
mod common;
use axum::{
    Json,
    extract::{Extension, Path},
};
use chrono::Utc;
use geocode_web_single::{
    config::CONFIG,
    db::run_migrations,
    handler::live_location::*,
    handler::live_map::update_live_location_permission_handler,
    model::{LiveLocationPositionPayload, UpdateLiveLocationPermissionPayload},
};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

fn position(sequence_no: i64) -> LiveLocationPositionPayload {
    LiveLocationPositionPayload {
        latitude: 35.0,
        longitude: 139.0,
        accuracy_m: Some(5.0),
        heading_deg: Some(90.0),
        speed_mps: Some(8.0),
        observed_at: Utc::now(),
        sequence_no,
    }
}
async fn allow(pool: &SqlitePool, user: &str) {
    sqlx::query("UPDATE user_model SET can_share_live_location = true WHERE id = $1")
        .bind(user)
        .execute(pool)
        .await
        .unwrap();
}
async fn start(pool: &SqlitePool, user: &str) -> String {
    create_live_location_session_handler(
        Extension(user.to_owned()),
        Extension(pool.clone()),
        Json(position(42)),
    )
    .await
    .unwrap()
    .0
    .session_id
}
async fn age(pool: &SqlitePool, user: &str) {
    sqlx::query("UPDATE live_location_session SET received_at = datetime('now', '-2 seconds') WHERE user_id = $1").bind(user).execute(pool).await.unwrap();
}
async fn count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM live_location_history")
        .fetch_one(pool)
        .await
        .unwrap()
}

// Execute in separate processes with LIVE_LOCATION_HISTORY_ENABLED=true and false.
#[tokio::test]
async fn history_lifecycle_and_types() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "history-user").await;
    assert!(
        create_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Json(position(0))
        )
        .await
        .is_err()
    );
    allow(&pool, &user).await;
    let session = start(&pool, &user).await;
    age(&pool, &user).await;
    update_live_location_session_handler(
        Extension(user.clone()),
        Extension(pool.clone()),
        Path(session.clone()),
        Json(position(1)),
    )
    .await
    .unwrap();
    assert!(
        update_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(session.clone()),
            Json(position(1))
        )
        .await
        .is_err()
    );
    // Move the timestamp forward to avoid a second-boundary-dependent rate-limit assertion.
    sqlx::query("UPDATE live_location_session SET received_at = datetime('now', '+1 second') WHERE user_id = $1").bind(&user).execute(&pool).await.unwrap();
    assert!(
        update_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(session.clone()),
            Json(position(2))
        )
        .await
        .is_err()
    );
    let mut invalid = position(3);
    invalid.latitude = 91.0;
    assert!(
        update_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(session.clone()),
            Json(invalid)
        )
        .await
        .is_err()
    );
    let rows: Vec<i64> =
        sqlx::query_scalar("SELECT sequence_no FROM live_location_history ORDER BY sequence_no")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        if CONFIG.live_location_history_enabled {
            vec![0, 1]
        } else {
            vec![]
        }
    );
    if CONFIG.live_location_history_enabled {
        let (observed, received): (chrono::DateTime<Utc>, chrono::DateTime<Utc>) = sqlx::query_as(
            "SELECT observed_at, received_at FROM live_location_history WHERE sequence_no = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(observed <= Utc::now());
        assert!(received <= Utc::now());
        let (id_type, coordinate_type, sequence_type, time_type): (String,String,String,String) = sqlx::query_as("SELECT typeof(user_id), typeof(latitude), typeof(sequence_no), typeof(received_at) FROM live_location_history LIMIT 1").fetch_one(&pool).await.unwrap();
        assert_eq!(
            (id_type, coordinate_type, sequence_type, time_type),
            (
                "text".into(),
                "real".into(),
                "integer".into(),
                "text".into()
            )
        );
    }
    stop_live_location_session_handler(
        Extension(user.clone()),
        Extension(pool.clone()),
        Path(session),
    )
    .await
    .unwrap();
    let restarted = start(&pool, &user).await;
    if CONFIG.live_location_history_enabled {
        let equal: bool = sqlx::query_scalar("SELECT h.received_at = s.received_at AND h.observed_at = s.observed_at FROM live_location_history h JOIN live_location_session s USING(session_id, sequence_no) WHERE s.session_id = $1").bind(&restarted).fetch_one(&pool).await.unwrap();
        assert!(equal);
    }
    let admin = common::create_test_admin(&pool, "history-admin").await;
    update_live_location_permission_handler(
        Extension(admin),
        Extension(pool.clone()),
        Path(user.clone()),
        Json(UpdateLiveLocationPermissionPayload { enabled: false }),
    )
    .await
    .unwrap();
    assert!(
        update_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(restarted),
            Json(position(1))
        )
        .await
        .is_err()
    );
    assert_eq!(
        count(&pool).await,
        if CONFIG.live_location_history_enabled {
            3
        } else {
            0
        }
    );
    run_migrations(&pool).await.unwrap();
    assert_eq!(
        count(&pool).await,
        if CONFIG.live_location_history_enabled {
            3
        } else {
            0
        }
    );
    sqlx::query("DELETE FROM user_model WHERE id = $1")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count(&pool).await, 0);
}

#[tokio::test]
async fn failure_rolls_back_and_releases_transaction() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "history-failure").await;
    allow(&pool, &user).await;
    let session = start(&pool, &user).await;
    age(&pool, &user).await;
    sqlx::query("CREATE TRIGGER reject_history BEFORE INSERT ON live_location_history BEGIN SELECT RAISE(ABORT, 'test failure'); END").execute(&pool).await.unwrap();
    let result = update_live_location_session_handler(
        Extension(user.clone()),
        Extension(pool.clone()),
        Path(session.clone()),
        Json(position(1)),
    )
    .await;
    assert_eq!(result.is_err(), CONFIG.live_location_history_enabled);
    let sequence: i64 = sqlx::query_scalar("SELECT sequence_no FROM live_location_session")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        sequence,
        if CONFIG.live_location_history_enabled {
            0
        } else {
            1
        }
    );
    let result = create_live_location_session_handler(
        Extension(user.clone()),
        Extension(pool.clone()),
        Json(position(0)),
    )
    .await;
    assert_eq!(result.is_err(), CONFIG.live_location_history_enabled);
    if CONFIG.live_location_history_enabled {
        let current: String = sqlx::query_scalar("SELECT session_id FROM live_location_session")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(current, session);
    }
    sqlx::query("DROP TRIGGER reject_history")
        .execute(&pool)
        .await
        .unwrap();
    start(&pool, &user).await;
}

#[tokio::test]
async fn concurrent_updates_and_revocation_are_serialized() {
    common::init_test_env();
    let path = std::env::temp_dir().join(format!("geocode-history-{}.sqlite", Uuid::new_v4()));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true)
                .busy_timeout(std::time::Duration::from_secs(5)),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    let user = common::create_test_user(&pool, "history-concurrent").await;
    let admin = common::create_test_admin(&pool, "history-concurrent-admin").await;
    allow(&pool, &user).await;
    let session = start(&pool, &user).await;
    age(&pool, &user).await;
    let (a, b) = tokio::join!(
        update_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(session.clone()),
            Json(position(1))
        ),
        update_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(session.clone()),
            Json(position(1))
        )
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(
        count(&pool).await,
        if CONFIG.live_location_history_enabled {
            2
        } else {
            0
        }
    );
    age(&pool, &user).await;
    let (update, revoke) = tokio::join!(
        update_live_location_session_handler(
            Extension(user.clone()),
            Extension(pool.clone()),
            Path(session.clone()),
            Json(position(2))
        ),
        update_live_location_permission_handler(
            Extension(admin),
            Extension(pool.clone()),
            Path(user.clone()),
            Json(UpdateLiveLocationPermissionPayload { enabled: false })
        )
    );
    revoke.unwrap();
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM live_location_session")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(live, 0);
    assert_eq!(
        count(&pool).await,
        if CONFIG.live_location_history_enabled {
            2 + i64::from(update.is_ok())
        } else {
            0
        }
    );
    assert!(
        update_live_location_session_handler(
            Extension(user),
            Extension(pool.clone()),
            Path(session),
            Json(position(3))
        )
        .await
        .is_err()
    );
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn upgrades_existing_database_without_backfilling_history() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "history-upgrade").await;
    sqlx::query("DROP TABLE live_location_history")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version = 10")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO live_location_session (user_id, session_id, latitude, longitude, observed_at) VALUES ($1, $2, 35, 139, CURRENT_TIMESTAMP)").bind(&user).bind(Uuid::now_v7().to_string()).execute(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    assert_eq!(count(&pool).await, 0);
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM live_location_session")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(live, 1);
    let index: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_live_location_history_user_received'").fetch_one(&pool).await.unwrap();
    assert_eq!(index, 1);
}
