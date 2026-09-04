use geocode_web_single::db::run_migrations;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};

async fn memory_pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("test sqlite pool should connect")
}

#[tokio::test]
async fn migrations_create_schema_and_record_versions() {
    let pool = memory_pool().await;

    run_migrations(&pool)
        .await
        .expect("migrations should run on a new database");

    let user_table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table' AND name = 'user_model'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("user_model table count should be returned");
    assert_eq!(user_table_count, 1);

    let index_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_marker_info_user_layer'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("index count should be returned");
    assert_eq!(index_count, 1);

    let migration_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(&pool)
        .await
        .expect("migration count should be returned");
    assert_eq!(migration_count, 9);

    let live_location_table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table' AND name IN (
            'live_location_session',
            'live_map',
            'live_map_member',
            'live_map_password_rate_limit'
        )
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("live location table count should be returned");
    assert_eq!(live_location_table_count, 4);

    let can_share_live_location: bool =
        sqlx::query_scalar("SELECT can_share_live_location FROM user_model LIMIT 1")
            .fetch_optional(&pool)
            .await
            .expect("live location permission column should be readable")
            .unwrap_or(false);
    assert!(!can_share_live_location);

    let single_map_index_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_live_map_single_unrevoked'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("single live map index count should be returned");
    assert_eq!(single_map_index_count, 1);

    let external_site_urls_table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table' AND name = 'external_site_urls'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("external_site_urls table count should be returned");
    assert_eq!(external_site_urls_table_count, 1);

    let marker_form_table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table' AND name = 'marker_form_config_model'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("marker form table count should be returned");
    assert_eq!(marker_form_table_count, 1);

    let marker_form_security_table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('marker_form_rate_limit_model', 'marker_form_image_model')
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("marker form security table count should be returned");
    assert_eq!(marker_form_security_table_count, 2);

    let marker_form_image_index_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_marker_form_image_owner'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("marker form image index count should be returned");
    assert_eq!(marker_form_image_index_count, 1);

    let shape_form_table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name IN (
            'shape_form_config_model',
            'shape_form_submission_model',
            'shape_form_rate_limit_model'
        )
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("shape form tables should be returned");
    assert_eq!(shape_form_table_count, 3);
}

#[tokio::test]
async fn migrations_are_idempotent() {
    let pool = memory_pool().await;

    run_migrations(&pool)
        .await
        .expect("first migration run should succeed");
    run_migrations(&pool)
        .await
        .expect("second migration run should succeed");

    let migration_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(&pool)
        .await
        .expect("migration count should be returned");
    assert_eq!(migration_count, 9);
}

#[tokio::test]
async fn migrations_record_versions_for_existing_schema() {
    let pool = memory_pool().await;

    sqlx::query(
        r#"
        CREATE TABLE user_model (
            id TEXT PRIMARY KEY NOT NULL,
            username CHARACTER VARYING(256) NOT NULL UNIQUE,
            password CHARACTER VARYING(256) NOT NULL,
            create_at TEXT NOT NULL,
            is_superuser BOOLEAN NOT NULL,
            failed_count INTEGER NOT NULL,
            next_challenge_time TEXT NOT NULL,
            is_locked BOOLEAN NOT NULL,
            is_private BOOLEAN NOT NULL,
            is_basic_authed BOOLEAN DEFAULT FALSE NOT NULL,
            is_basic_authed_at TEXT NOT NULL,
            totp_secret CHARACTER VARYING(256) NOT NULL,
            totp_temp_secret CHARACTER VARYING(256) NOT NULL
        );
        "#,
    )
    .execute(&pool)
    .await
    .expect("legacy user_model table should be created");

    sqlx::query(
        r#"
        INSERT INTO user_model (
            id,
            username,
            password,
            create_at,
            is_superuser,
            failed_count,
            next_challenge_time,
            is_locked,
            is_private,
            is_basic_authed,
            is_basic_authed_at,
            totp_secret,
            totp_temp_secret
        )
        VALUES (
            'legacy-user',
            'legacy',
            'password',
            '2026-01-01 00:00:00',
            false,
            0,
            '2026-01-01 00:00:00',
            false,
            true,
            false,
            '2026-01-01 00:00:00',
            '',
            ''
        );
        "#,
    )
    .execute(&pool)
    .await
    .expect("legacy data should be inserted");

    run_migrations(&pool)
        .await
        .expect("migrations should run against an existing schema");

    let rows = sqlx::query(
        r#"
        SELECT version, name
        FROM schema_migrations
        ORDER BY version
        "#,
    )
    .fetch_all(&pool)
    .await
    .expect("migration rows should be returned");

    assert_eq!(rows.len(), 9);
    assert_eq!(rows[0].get::<i64, _>("version"), 1);
    assert_eq!(rows[0].get::<String, _>("name"), "create_initial_schema");
    assert_eq!(rows[1].get::<i64, _>("version"), 2);
    assert_eq!(rows[1].get::<String, _>("name"), "add_btree_indexes");
    assert_eq!(rows[2].get::<i64, _>("version"), 3);
    assert_eq!(
        rows[2].get::<String, _>("name"),
        "create_external_site_urls"
    );
    assert_eq!(rows[3].get::<i64, _>("version"), 4);
    assert_eq!(
        rows[3].get::<String, _>("name"),
        "add_marker_icon_id_to_layer_model"
    );

    assert_eq!(rows[4].get::<i64, _>("version"), 5);
    assert_eq!(
        rows[4].get::<String, _>("name"),
        "add_auth_session_security"
    );
    assert_eq!(rows[5].get::<i64, _>("version"), 6);
    assert_eq!(
        rows[5].get::<String, _>("name"),
        "create_marker_form_models"
    );
    assert_eq!(rows[6].get::<i64, _>("version"), 7);
    assert_eq!(rows[6].get::<String, _>("name"), "harden_marker_forms");
    assert_eq!(rows[7].get::<i64, _>("version"), 8);
    assert_eq!(rows[7].get::<String, _>("name"), "create_shape_form_models");
    assert_eq!(rows[8].get::<i64, _>("version"), 9);
    assert_eq!(
        rows[8].get::<String, _>("name"),
        "create_live_location_models"
    );

    let auth_version: i64 =
        sqlx::query_scalar("SELECT auth_version FROM user_model WHERE id = 'legacy-user'")
            .fetch_one(&pool)
            .await
            .expect("legacy user auth version should be returned");
    assert_eq!(auth_version, 0);
    let can_share_live_location: bool = sqlx::query_scalar(
        "SELECT can_share_live_location FROM user_model WHERE id = 'legacy-user'",
    )
    .fetch_one(&pool)
    .await
    .expect("legacy user live location permission should be returned");
    assert!(!can_share_live_location);
    let legacy_user_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_model WHERE id = 'legacy-user'")
            .fetch_one(&pool)
            .await
            .expect("legacy user count should be returned");
    assert_eq!(legacy_user_count, 1);
}

#[tokio::test]
async fn live_map_constraints_allow_only_one_unrevoked_map_and_unique_public_ids() {
    let pool = memory_pool().await;
    run_migrations(&pool)
        .await
        .expect("migrations should create live map constraints");

    let admin_id = "admin-id";
    sqlx::query(
        r#"
        INSERT INTO user_model (
            id, username, password, create_at, is_superuser, failed_count,
            next_challenge_time, is_locked, is_private, is_basic_authed,
            is_basic_authed_at, totp_secret, totp_temp_secret
        ) VALUES (
            $1, 'admin', 'password', CURRENT_TIMESTAMP, true, 0,
            CURRENT_TIMESTAMP, false, true, false, CURRENT_TIMESTAMP, '', ''
        )
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("test admin should be inserted");

    sqlx::query(
        r#"
        INSERT INTO live_map (id, public_id, name, created_by, expires_at)
        VALUES ('map-1', 'public-1', 'map 1', $1, datetime('now', '+1 hour'))
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("first active map should be inserted");

    let second_active = sqlx::query(
        r#"
        INSERT INTO live_map (id, public_id, name, created_by, expires_at)
        VALUES ('map-2', 'public-2', 'map 2', $1, datetime('now', '+1 hour'))
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await;
    assert!(
        second_active.is_err(),
        "a second unrevoked map must be rejected"
    );

    sqlx::query("UPDATE live_map SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'map-1'")
        .execute(&pool)
        .await
        .expect("first map should be revoked");
    sqlx::query(
        r#"
        INSERT INTO live_map (id, public_id, name, created_by, expires_at)
        VALUES ('map-2', 'public-2', 'map 2', $1, datetime('now', '+1 hour'))
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("a replacement map should be allowed after revocation");

    sqlx::query("UPDATE live_map SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'map-2'")
        .execute(&pool)
        .await
        .expect("replacement map should be revoked");
    let duplicate_public_id = sqlx::query(
        r#"
        INSERT INTO live_map (id, public_id, name, created_by, expires_at)
        VALUES ('map-3', 'public-1', 'map 3', $1, datetime('now', '+1 hour'))
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await;
    assert!(
        duplicate_public_id.is_err(),
        "public IDs must remain unique after revocation"
    );
}
