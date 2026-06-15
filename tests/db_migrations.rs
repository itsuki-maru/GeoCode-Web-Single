use geocode_web_single::db::run_migrations;
use sqlx::{Row, SqlitePool};

async fn memory_pool() -> SqlitePool {
    SqlitePool::connect("sqlite::memory:")
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
    assert_eq!(migration_count, 3);

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
    assert_eq!(migration_count, 3);
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

    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].get::<i64, _>("version"), 1);
    assert_eq!(rows[0].get::<String, _>("name"), "create_initial_schema");
    assert_eq!(rows[1].get::<i64, _>("version"), 2);
    assert_eq!(rows[1].get::<String, _>("name"), "add_btree_indexes");
    assert_eq!(rows[2].get::<i64, _>("version"), 3);
    assert_eq!(
        rows[2].get::<String, _>("name"),
        "create_external_site_urls"
    );

    let legacy_user_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_model WHERE id = 'legacy-user'")
            .fetch_one(&pool)
            .await
            .expect("legacy user count should be returned");
    assert_eq!(legacy_user_count, 1);
}
