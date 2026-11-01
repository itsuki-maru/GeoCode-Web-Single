use geocode_web_single::db::run_migrations;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};

#[allow(dead_code)]
mod common;

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

    let migration_count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            COUNT(*)
        FROM schema_migrations
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("migration count should be returned");
    assert_eq!(migration_count, 22);

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

    let can_share_live_location: bool = sqlx::query_scalar(
        r#"
        SELECT
            can_share_live_location
        FROM user_model
        LIMIT 1
        "#,
    )
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

    let migration_count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            COUNT(*)
        FROM schema_migrations
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("migration count should be returned");
    assert_eq!(migration_count, 22);
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
        ) VALUES (
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

    assert_eq!(rows.len(), 22);
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

    let auth_version: i64 = sqlx::query_scalar(
        r#"
        SELECT
            auth_version
        FROM user_model
        WHERE id = 'legacy-user'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("legacy user auth version should be returned");
    assert_eq!(auth_version, 0);
    let can_share_live_location: bool = sqlx::query_scalar(
        r#"
        SELECT
            can_share_live_location
        FROM user_model
        WHERE id = 'legacy-user'
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("legacy user live location permission should be returned");
    assert!(!can_share_live_location);
    let legacy_user_count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            COUNT(*)
        FROM user_model
        WHERE id = 'legacy-user'
        "#,
    )
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
        ) VALUES (
            $1,
            'admin',
            'password',
            CURRENT_TIMESTAMP,
            true,
            0,
            CURRENT_TIMESTAMP,
            false,
            true,
            false,
            CURRENT_TIMESTAMP,
            '',
            ''
        )
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("test admin should be inserted");

    sqlx::query(
        r#"
        INSERT INTO live_map (
            id,
            public_id,
            name,
            created_by,
            expires_at
        ) VALUES ('map-1', 'public-1', 'map 1', $1, datetime('now', '+1 hour'))
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("first active map should be inserted");

    let second_active = sqlx::query(
        r#"
        INSERT INTO live_map (
            id,
            public_id,
            name,
            created_by,
            expires_at
        ) VALUES ('map-2', 'public-2', 'map 2', $1, datetime('now', '+1 hour'))
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await;
    assert!(
        second_active.is_err(),
        "a second unrevoked map must be rejected"
    );

    sqlx::query(
        r#"
        UPDATE live_map
        SET
            revoked_at = CURRENT_TIMESTAMP
        WHERE id = 'map-1'
        "#,
    )
    .execute(&pool)
    .await
    .expect("first map should be revoked");
    sqlx::query(
        r#"
        INSERT INTO live_map (
            id,
            public_id,
            name,
            created_by,
            expires_at
        ) VALUES ('map-2', 'public-2', 'map 2', $1, datetime('now', '+1 hour'))
        "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("a replacement map should be allowed after revocation");

    sqlx::query(
        r#"
        UPDATE live_map
        SET
            revoked_at = CURRENT_TIMESTAMP
        WHERE id = 'map-2'
        "#,
    )
    .execute(&pool)
    .await
    .expect("replacement map should be revoked");
    let duplicate_public_id = sqlx::query(
        r#"
        INSERT INTO live_map (
            id,
            public_id,
            name,
            created_by,
            expires_at
        ) VALUES ('map-3', 'public-1', 'map 3', $1, datetime('now', '+1 hour'))
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

#[tokio::test]
async fn overlay_sharing_migration_preserves_existing_links_and_runs_once() {
    let pool = memory_pool().await;
    run_migrations(&pool).await.unwrap();
    // 代表的な既存リンクを二つ用意し、バージョン 12 より前のカラム構成を再現する。
    sqlx::query(
        r#"
        ALTER TABLE temporary_urls
        DROP COLUMN include_tile_overlays
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        DELETE FROM schema_migrations
        WHERE version = 12
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        PRAGMA foreign_keys = OFF
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO temporary_urls (
            id,
            user_id,
            url,
            expiration,
            layers,
            markers,
            shapes,
            create_at
        ) VALUES (
            'legacy',
            'owner',
            '/legacy',
            '2099-01-01',
            '{}',
            '{}',
            '{}',
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    run_migrations(&pool).await.unwrap();
    let enabled: bool = sqlx::query_scalar(
        r#"
        SELECT
            include_tile_overlays
        FROM temporary_urls
        WHERE id = 'legacy'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(enabled);
    sqlx::query(
        r#"
        INSERT INTO temporary_urls (
            id,
            user_id,
            url,
            expiration,
            layers,
            markers,
            shapes,
            create_at
        ) VALUES (
            'new',
            'other',
            '/new',
            '2099-01-01',
            '{}',
            '{}',
            '{}',
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    run_migrations(&pool).await.unwrap();
    let enabled: bool = sqlx::query_scalar(
        r#"
        SELECT
            include_tile_overlays
        FROM temporary_urls
        WHERE id = 'new'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!enabled);
}

#[tokio::test]
async fn live_map_settings_upgrade_preserves_existing_maps_and_runs_once() {
    let pool = memory_pool().await;
    run_migrations(&pool).await.unwrap();
    sqlx::query(
        r#"
        PRAGMA foreign_keys = OFF
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        DROP TABLE live_camera_signal;

        DROP TABLE live_camera_viewer;

        DROP TABLE live_camera_session;

        DROP TABLE live_map_layer;

        ALTER TABLE live_map
        DROP COLUMN layers_configured_by;

        ALTER TABLE live_map
        DROP COLUMN use_tile_overlays;

        DELETE FROM schema_migrations
        WHERE version BETWEEN 13 AND 15;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO live_map (
            id,
            public_id,
            name,
            created_by,
            expires_at
        ) VALUES ('legacy', 'public', 'existing', 'owner', '2099-01-01')
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    run_migrations(&pool).await.unwrap();
    let settings: (bool, Option<String>, String) = sqlx::query_as(
        r#"
        SELECT
            use_tile_overlays,
            layers_configured_by,
            name
        FROM live_map
        WHERE id = 'legacy'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(settings, (true, None, "existing".into()));
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            COUNT(*)
        FROM live_map_layer
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    sqlx::query(
        r#"
        UPDATE live_map
        SET
            use_tile_overlays = false
        WHERE id = 'legacy'
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    run_migrations(&pool).await.unwrap();
    let enabled: bool = sqlx::query_scalar(
        r#"
        SELECT
            use_tile_overlays
        FROM live_map
        WHERE id = 'legacy'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!enabled);
}

#[tokio::test]
async fn common_form_upgrade_preserves_legacy_config_answers_and_markdown() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "legacy-forms").await;
    let layer = common::master_layer_id(&pool, &user).await;
    sqlx::raw_sql(
        r#"
        DROP INDEX idx_layer_common_form;
        DROP INDEX idx_marker_form_managed_layer;
        DROP INDEX idx_shape_form_managed_layer;
        ALTER TABLE marker_form_config_model DROP COLUMN managed_layer_id;
        ALTER TABLE shape_form_config_model DROP COLUMN managed_layer_id;
        ALTER TABLE layer_model DROP COLUMN restrict_free_text;
        ALTER TABLE layer_model DROP COLUMN common_form_version;
        ALTER TABLE layer_model DROP COLUMN common_form_id;
        ALTER TABLE layer_model DROP COLUMN form_binding_revision;
        DROP INDEX idx_marker_answer_form_target_time;
        DROP INDEX idx_shape_answer_form_target_time;
        ALTER TABLE marker_form_config_model DROP COLUMN source_form;
        ALTER TABLE shape_form_config_model DROP COLUMN source_form;
        ALTER TABLE marker_form_submission_model DROP COLUMN source_form;
        ALTER TABLE marker_form_submission_model DROP COLUMN form_snapshot;
        ALTER TABLE shape_form_submission_model DROP COLUMN source_form;
        ALTER TABLE shape_form_submission_model DROP COLUMN form_snapshot;
        DROP TABLE common_form_revision_model;
        DROP TABLE common_form_model;
        DROP TABLE json_import_receipt_model;
        DROP TABLE answer_map_saved_condition_model;
        ALTER TABLE marker_form_submission_model DROP COLUMN revision;
        ALTER TABLE marker_form_submission_model DROP COLUMN edited_at;
        ALTER TABLE shape_form_submission_model DROP COLUMN revision;
        ALTER TABLE shape_form_submission_model DROP COLUMN edited_at;
        ALTER TABLE marker_info_model DROP COLUMN form_body_parts;
        ALTER TABLE shape_model DROP COLUMN form_body_parts;
        DELETE FROM schema_migrations WHERE version >= 16;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        ) VALUES (
            'legacy-marker',
            $1,
            $2,
            '既存対象',
            35,
            139,
            '既存本文',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(&user)
    .bind(&layer)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO marker_form_config_model (
            marker_id,
            public_id,
            enabled,
            form_title,
            form_description,
            form_schema,
            create_at,
            update_at
        ) VALUES (
            'legacy-marker',
            'legacy-public',
            1,
            '既存フォーム',
            '',
            '{"fields":[]}',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        );

        INSERT INTO marker_form_submission_model (
            id,
            marker_id,
            submitted_values,
            rendered_markdown,
            create_at
        ) VALUES (
            'legacy-answer',
            'legacy-marker',
            '{"note":"以前の記録"}',
            '以前のMarkdown',
            CURRENT_TIMESTAMP
        );
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let restricted: bool = sqlx::query_scalar(
        r#"
        SELECT
            restrict_free_text
        FROM layer_model
        WHERE id = $1
        "#,
    )
    .bind(&layer)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !restricted,
        "existing layer remains unrestricted after upgrade"
    );
    let row: (String, String, Option<String>, Option<String>) = sqlx::query_as(
        r#"
        SELECT submitted_values,rendered_markdown,source_form,form_snapshot
        FROM marker_form_submission_model WHERE id='legacy-answer'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "{\"note\":\"以前の記録\"}".into(),
            "以前のMarkdown".into(),
            None,
            None
        )
    );
    let config: (bool, String, Option<String>) = sqlx::query_as(
        r#"
        SELECT
            enabled,
            public_id,
            source_form
        FROM marker_form_config_model
        WHERE marker_id = 'legacy-marker'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(config, (true, "legacy-public".into(), None));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM schema_migrations
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        22
    );
}

#[tokio::test]
async fn answer_edit_upgrade_keeps_legacy_rows_and_starts_revision_one() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "answer-upgrade").await;
    let layer = common::master_layer_id(&pool, &user).await;
    sqlx::raw_sql(
        r#"
        ALTER TABLE marker_form_submission_model
        DROP COLUMN revision;

        ALTER TABLE marker_form_submission_model
        DROP COLUMN edited_at;

        ALTER TABLE shape_form_submission_model
        DROP COLUMN revision;

        ALTER TABLE shape_form_submission_model
        DROP COLUMN edited_at;

        ALTER TABLE marker_info_model
        DROP COLUMN form_body_parts;

        ALTER TABLE shape_model
        DROP COLUMN form_body_parts;

        DELETE FROM schema_migrations
        WHERE version = 20;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        ) VALUES (
            'legacy-edit-marker',
            $1,
            $2,
            '既存対象',
            35,
            139,
            '既存本文',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(&user)
    .bind(&layer)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO marker_form_submission_model (
            id,
            marker_id,
            submitted_values,
            rendered_markdown,
            create_at
        ) VALUES (
            'legacy-edit-answer',
            'legacy-edit-marker',
            '{}',
            '旧回答',
            CURRENT_TIMESTAMP
        );
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let row: (i64, bool, String, bool) = sqlx::query_as(
        r#"
        SELECT
            s.revision,
            s.edited_at IS NULL,
            m.detail,
            m.form_body_parts IS NULL
        FROM marker_form_submission_model s
        JOIN marker_info_model m ON m.id = s.marker_id
        WHERE s.id = 'legacy-edit-answer'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, (1, true, "既存本文".into(), true));
}

async fn assert_receipt_constraints(pool: &SqlitePool) {
    let first = common::create_test_user(pool, "receipt-first").await;
    let second = common::create_test_user(pool, "receipt-second").await;
    let request = uuid::Uuid::new_v4().to_string();
    let hash = vec![7_u8; 32];
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            PRAGMA foreign_keys
            "#,
        )
        .fetch_one(pool)
        .await
        .unwrap(),
        1
    );
    for user in [&first, &second] {
        sqlx::query(
            r#"
            INSERT INTO json_import_receipt_model (
                user_id,
                request_id,
                payload_sha256
            ) VALUES ($1, $2, $3)
            "#,
        )
        .bind(user)
        .bind(&request)
        .bind(&hash)
        .execute(pool)
        .await
        .unwrap();
    }
    assert!(
        sqlx::query(
            r#"
            INSERT INTO json_import_receipt_model (
                user_id,
                request_id,
                payload_sha256
            ) VALUES ($1, $2, $3)
            "#,
        )
        .bind(&first)
        .bind(&request)
        .bind(&hash)
        .execute(pool)
        .await
        .is_err()
    );
    for bytes in [vec![0_u8; 31], vec![0_u8; 33]] {
        assert!(
            sqlx::query(
                r#"
                INSERT INTO json_import_receipt_model (
                    user_id,
                    request_id,
                    payload_sha256
                ) VALUES ($1, $2, $3)
                "#,
            )
            .bind(&first)
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(bytes)
            .execute(pool)
            .await
            .is_err()
        );
    }
    // SQLite's type affinity alone does not enforce BLOB: reject 32-char TEXT too.
    assert!(
        sqlx::query(
            r#"
            INSERT INTO json_import_receipt_model (
                user_id,
                request_id,
                payload_sha256
            ) VALUES ($1, $2, $3)
            "#,
        )
        .bind(&first)
        .bind(uuid::Uuid::new_v4().to_string())
        .bind("x".repeat(32))
        .execute(pool)
        .await
        .is_err()
    );
    assert!(
        sqlx::query(
            r#"
            INSERT INTO json_import_receipt_model (
                user_id,
                request_id,
                payload_sha256
            ) VALUES ($1, $2, $3)
            "#,
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&hash)
        .execute(pool)
        .await
        .is_err()
    );
    let rows: Vec<(String, i64, bool)> = sqlx::query_as(
        r#"
        SELECT
            typeof(payload_sha256),
            length(payload_sha256),
            completed_at IS NOT NULL
        FROM json_import_receipt_model
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(rows, vec![("blob".into(), 32, true); 2]);
    sqlx::query(
        r#"
        DELETE FROM user_model
        WHERE id = $1
        "#,
    )
    .bind(&first)
    .execute(pool)
    .await
    .unwrap();
    let owners: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT
            user_id
        FROM json_import_receipt_model
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(owners, vec![second]);
}

#[tokio::test]
async fn runtime_and_sqlx_migrations_create_the_same_constrained_receipt_schema() {
    let runtime = common::test_pool().await;
    let cli = memory_pool().await;
    sqlx::migrate::Migrator::new(std::path::Path::new("./migrations"))
        .await
        .unwrap()
        .run(&cli)
        .await
        .unwrap();
    let schema = r#"
        SELECT
            type,
            name,
            tbl_name,
            sql
        FROM sqlite_master
        WHERE tbl_name = 'json_import_receipt_model'
        ORDER BY type, name
        "#;
    let runtime_schema: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as(schema).fetch_all(&runtime).await.unwrap();
    let cli_schema: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as(schema).fetch_all(&cli).await.unwrap();
    assert!(!runtime_schema.is_empty());
    assert_eq!(runtime_schema, cli_schema);
    assert_receipt_constraints(&runtime).await;
    assert_receipt_constraints(&cli).await;
}

#[tokio::test]
async fn receipt_upgrade_from_version_twenty_preserves_data_and_is_repeatable() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "receipt-upgrade").await;
    let master = common::master_layer_id(&pool, &user).await;
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        ) VALUES (
            'existing-marker',
            $1,
            $2,
            '既存対象',
            35,
            139,
            '保持する本文',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(&user)
    .bind(&master)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        DROP TABLE answer_map_saved_condition_model;

        DROP TABLE json_import_receipt_model;

        DELETE FROM schema_migrations
        WHERE version >= 21;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let before: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT
            version,
            name,
            applied_at
        FROM schema_migrations
        ORDER BY version
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(before.len(), 20);
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let after: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT
            version,
            name,
            applied_at
        FROM schema_migrations
        ORDER BY version
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(after.len(), 22);
    assert_eq!(&after[..20], before);
    let detail: String = sqlx::query_scalar(
        r#"
        SELECT
            detail
        FROM marker_info_model
        WHERE id = 'existing-marker'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(detail, "保持する本文");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM json_import_receipt_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    assert_receipt_constraints(&pool).await;
}

#[tokio::test]
async fn receipt_upgrade_preserves_receipts_when_sql_was_applied_before_runtime_migration() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "receipt-preapplied").await;
    let master = common::master_layer_id(&pool, &user).await;
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        ) VALUES (
            'preapplied-marker',
            $1,
            $2,
            '既存対象',
            35,
            139,
            '先行適用前の本文',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(&user)
    .bind(&master)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        DROP TABLE answer_map_saved_condition_model;

        DROP TABLE json_import_receipt_model;

        DELETE FROM schema_migrations
        WHERE version >= 21;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/20261023120000_json_import_receipts.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let hash = vec![19_u8; 32];
    sqlx::query(
        r#"
        INSERT INTO json_import_receipt_model (
            user_id,
            request_id,
            payload_sha256,
            completed_at
        ) VALUES ($1, $2, $3, '2026-10-23 01:02:03')
        "#,
    )
    .bind(&user)
    .bind(&request)
    .bind(&hash)
    .execute(&pool)
    .await
    .unwrap();
    let receipt_query = r#"
        SELECT
            user_id,
            request_id,
            payload_sha256,
            completed_at
        FROM json_import_receipt_model
        "#;
    let before: Vec<(String, String, Vec<u8>, String)> = sqlx::query_as(receipt_query)
        .fetch_all(&pool)
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let after: Vec<(String, String, Vec<u8>, String)> = sqlx::query_as(receipt_query)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(after, before);
    let versions: Vec<i64> = sqlx::query_scalar(
        r#"
        SELECT
            version
        FROM schema_migrations
        WHERE version = 21
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(versions, vec![21]);
    let total: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM schema_migrations
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(total, 22);
    let detail: String = sqlx::query_scalar(
        r#"
        SELECT
            detail
        FROM marker_info_model
        WHERE id = 'preapplied-marker'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(detail, "先行適用前の本文");
    let layer: String = sqlx::query_scalar(
        r#"
        SELECT
            layer_id
        FROM marker_info_model
        WHERE id = 'preapplied-marker'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(layer, master);
}

async fn insert_saved_condition(
    pool: &SqlitePool,
    user: &str,
    id: &str,
    kind: &str,
    name: &str,
    version: i64,
    definition: &str,
    display: &str,
) -> Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO answer_map_saved_condition_model (
            id,
            user_id,
            kind,
            name,
            schema_version,
            definition,
            display,
            create_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-25 01:02:03.000004')
        "#,
    )
    .bind(id)
    .bind(user)
    .bind(kind)
    .bind(name)
    .bind(version)
    .bind(definition)
    .bind(display)
    .execute(pool)
    .await
}

async fn assert_saved_condition_constraints(pool: &SqlitePool) {
    let first = common::create_test_user(pool, "preset-constraint-first").await;
    let second = common::create_test_user(pool, "preset-constraint-second").await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            PRAGMA foreign_keys
            "#,
        )
        .fetch_one(pool)
        .await
        .unwrap(),
        1
    );
    let first_id = uuid::Uuid::new_v4().to_string();
    let second_id = uuid::Uuid::new_v4().to_string();
    for (user, id, kind) in [
        (&first, &first_id, "filter"),
        (&second, &second_id, "coloring"),
    ] {
        insert_saved_condition(pool, user, id, kind, "同名の保存条件", 1, "{}", "{}")
            .await
            .unwrap();
    }
    assert!(
        insert_saved_condition(pool, &first, &first_id, "filter", "重複ID", 1, "{}", "{}")
            .await
            .is_err()
    );
    let hundred_chars = "🚧".repeat(100);
    insert_saved_condition(
        pool,
        &first,
        &uuid::Uuid::new_v4().to_string(),
        "filter",
        &hundred_chars,
        1,
        "{}",
        "{}",
    )
    .await
    .unwrap();
    let long_name = "🚧".repeat(101);
    for (kind, name, version, definition, display) in [
        ("other", "名前", 1, "{}", "{}"),
        ("filter", "", 1, "{}", "{}"),
        ("filter", "   ", 1, "{}", "{}"),
        ("filter", long_name.as_str(), 1, "{}", "{}"),
        ("filter", "名前", 0, "{}", "{}"),
        ("filter", "名前", 1, "invalid-json", "{}"),
        ("filter", "名前", 1, "[]", "{}"),
        ("filter", "名前", 1, "null", "{}"),
        ("filter", "名前", 1, "{}", "invalid-json"),
        ("filter", "名前", 1, "{}", "[]"),
    ] {
        assert!(
            insert_saved_condition(
                pool,
                &first,
                &uuid::Uuid::new_v4().to_string(),
                kind,
                name,
                version,
                definition,
                display
            )
            .await
            .is_err(),
            "accepted {kind}/{name}/{version}/{definition}/{display}"
        );
    }
    assert!(
        insert_saved_condition(
            pool,
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
            "filter",
            "他人",
            1,
            "{}",
            "{}"
        )
        .await
        .is_err()
    );
    let types: Vec<(String, String, String, String)> = sqlx::query_as(
        r#"
        SELECT
            typeof(id),
            typeof(user_id),
            typeof(definition),
            typeof(display)
        FROM answer_map_saved_condition_model
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(
        types,
        vec![("text".into(), "text".into(), "text".into(), "text".into()); 3]
    );
    let index: Vec<(String, bool)> = sqlx::query_as(
        r#"
        SELECT
            name,
            "desc"
        FROM pragma_index_xinfo ('idx_answer_map_saved_condition_owner')
        WHERE key = 1
        ORDER BY seqno
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(
        index,
        vec![
            ("user_id".into(), false),
            ("create_at".into(), true),
            ("id".into(), true)
        ]
    );
    sqlx::query(
        r#"
        DELETE FROM user_model
        WHERE id = $1
        "#,
    )
    .bind(&first)
    .execute(pool)
    .await
    .unwrap();
    let remaining: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT
            id,
            user_id
        FROM answer_map_saved_condition_model
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(remaining, vec![(second_id, second)]);
}

#[tokio::test]
async fn runtime_and_sqlx_migrations_create_the_same_constrained_saved_condition_schema() {
    let runtime = common::test_pool().await;
    let cli = memory_pool().await;
    sqlx::migrate::Migrator::new(std::path::Path::new("./migrations"))
        .await
        .unwrap()
        .run(&cli)
        .await
        .unwrap();
    let schema = r#"
        SELECT
            type,
            name,
            tbl_name,
            sql
        FROM sqlite_master
        WHERE tbl_name = 'answer_map_saved_condition_model'
        ORDER BY type, name
        "#;
    let runtime_schema: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as(schema).fetch_all(&runtime).await.unwrap();
    let cli_schema: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as(schema).fetch_all(&cli).await.unwrap();
    assert!(!runtime_schema.is_empty());
    assert_eq!(runtime_schema, cli_schema);
    assert_saved_condition_constraints(&runtime).await;
    assert_saved_condition_constraints(&cli).await;
}

async fn seed_pre_preset_data(pool: &SqlitePool) -> String {
    let owner = common::create_test_user(pool, "preset-upgrade").await;
    let layer = common::master_layer_id(pool, &owner).await;
    sqlx::query(
        r#"
        INSERT INTO common_form_model (
            id,
            user_id,
            version,
            form_title,
            form_description,
            form_schema,
            create_at,
            update_at
        ) VALUES (
            'existing-form',
            $1,
            1,
            '既存フォーム',
            '保持する説明',
            '{"fields":[]}',
            '2026-10-20 01:00:00',
            '2026-10-20 01:00:00'
        )
        "#,
    )
    .bind(&owner)
    .execute(pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO common_form_revision_model (
            form_id,
            version,
            form_schema
        ) VALUES ('existing-form', 1, '{"fields":[]}');
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE layer_model
        SET
            common_form_id = 'existing-form',
            common_form_version = 1,
            restrict_free_text = true
        WHERE id = $1
        "#,
    )
    .bind(&layer)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        ) VALUES (
            'existing-marker',
            $1,
            $2,
            '既存地点',
            35,
            139,
            '保持する地点本文',
            '2026-10-20 01:00:00',
            '2026-10-20 01:00:00'
        )
        "#,
    )
    .bind(&owner)
    .bind(&layer)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO shape_model (
            id,
            user_id,
            layer_id,
            name,
            shape_type,
            geojson,
            created_at,
            updated_at
        ) VALUES (
            'existing-shape',
            $1,
            $2,
            '既存図形',
            'polygon',
            '{"properties":{"memo":"保持する図形本文"}}',
            '2026-10-20 01:00:00',
            '2026-10-20 01:00:00'
        )
        "#,
    )
    .bind(&owner)
    .bind(&layer)
    .execute(pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO marker_form_config_model (
            marker_id,
            public_id,
            enabled,
            form_title,
            form_description,
            form_schema,
            create_at,
            update_at,
            source_form
        ) VALUES (
            'existing-marker',
            'existing-marker-public',
            1,
            '地点フォーム',
            '',
            '{"fields":[]}',
            '2026-10-20 01:00:00',
            '2026-10-20 01:00:00',
            '{"id":"existing-form","version":1}'
        );

        INSERT INTO marker_form_submission_model (
            id,
            marker_id,
            submitted_values,
            rendered_markdown,
            create_at,
            source_form,
            form_snapshot
        ) VALUES (
            'existing-marker-answer',
            'existing-marker',
            '{"note":"地点回答"}',
            '地点Markdown',
            '2026-10-20 02:00:00',
            '{"id":"existing-form","version":1}',
            '{"form_title":"既存フォーム","form_schema":{"fields":[]}}'
        );

        INSERT INTO shape_form_config_model (
            shape_id,
            public_id,
            enabled,
            form_title,
            form_description,
            form_schema,
            create_at,
            update_at,
            source_form
        ) VALUES (
            'existing-shape',
            'existing-shape-public',
            1,
            '図形フォーム',
            '',
            '{"fields":[]}',
            '2026-10-20 01:00:00',
            '2026-10-20 01:00:00',
            '{"id":"existing-form","version":1}'
        );

        INSERT INTO shape_form_submission_model (
            id,
            shape_id,
            submitted_values,
            rendered_markdown,
            create_at,
            source_form,
            form_snapshot
        ) VALUES (
            'existing-shape-answer',
            'existing-shape',
            '{"note":"図形回答"}',
            '図形Markdown',
            '2026-10-20 02:00:00',
            '{"id":"existing-form","version":1}',
            '{"form_title":"既存フォーム","form_schema":{"fields":[]}}'
        );
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO json_import_receipt_model (
            user_id,
            request_id,
            payload_sha256,
            completed_at
        ) VALUES ($1, 'existing-request', $2, '2026-10-23 01:02:03')
        "#,
    )
    .bind(&owner)
    .bind(vec![17_u8; 32])
    .execute(pool)
    .await
    .unwrap();
    owner
}

// Capture every column, including BLOB values, without changing SQLite's stored types.
async fn existing_data_snapshot(pool: &SqlitePool) -> Vec<(String, Vec<String>)> {
    let mut result = vec![];
    for table in [
        "user_model",
        "layer_model",
        "marker_info_model",
        "shape_model",
        "common_form_model",
        "common_form_revision_model",
        "marker_form_config_model",
        "marker_form_submission_model",
        "shape_form_config_model",
        "shape_form_submission_model",
        "json_import_receipt_model",
    ] {
        let columns: Vec<String> = sqlx::query(&format!(
            r#"
            PRAGMA table_info ({table})
            "#,
        ))
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get("name"))
        .collect();
        let quoted = columns
            .iter()
            .map(|column| format!("quote(\"{column}\")"))
            .collect::<Vec<_>>()
            .join(",");
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            r#"
            SELECT
                json_array({quoted})
            FROM {table}
            ORDER BY rowid
            "#
        ))
        .fetch_all(pool)
        .await
        .unwrap();
        result.push((table.to_string(), rows));
    }
    result
}

#[tokio::test]
async fn saved_condition_upgrade_from_twenty_one_preserves_all_existing_data_and_is_repeatable() {
    let (pool, path) = common::file_test_pool().await;
    sqlx::raw_sql(
        r#"
        DROP TABLE answer_map_saved_condition_model;

        DELETE FROM schema_migrations
        WHERE version = 22;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let owner = seed_pre_preset_data(&pool).await;
    let before = existing_data_snapshot(&pool).await;
    let migrations_before: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT
            version,
            name,
            applied_at
        FROM schema_migrations
        ORDER BY version
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(migrations_before.len(), 21);
    run_migrations(&pool).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    insert_saved_condition(
        &pool,
        &owner,
        &id,
        "filter",
        "更新後に保存",
        1,
        "{\"common_form_id\":null,\"conditions\":[]}",
        "{\"form_label\":null,\"fields\":[]}",
    )
    .await
    .unwrap();
    let preset_query = r#"
        SELECT
            id,
            user_id,
            kind,
            name,
            schema_version,
            definition,
            display,
            create_at
        FROM answer_map_saved_condition_model
        "#;
    let preset_before: Vec<(String, String, String, String, i64, String, String, String)> =
        sqlx::query_as(preset_query).fetch_all(&pool).await.unwrap();
    // Reopen the file as the next application startup would, preserving saved conditions.
    pool.close().await;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    let migrations_after: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT
            version,
            name,
            applied_at
        FROM schema_migrations
        ORDER BY version
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(migrations_after.len(), 22);
    assert_eq!(&migrations_after[..21], migrations_before);
    assert_eq!(migrations_after[21].0, 22);
    assert_eq!(existing_data_snapshot(&pool).await, before);
    let preset_after: Vec<(String, String, String, String, i64, String, String, String)> =
        sqlx::query_as(preset_query).fetch_all(&pool).await.unwrap();
    assert_eq!(preset_after, preset_before);
    common::close_file_test_pool(pool, path).await;
}

#[tokio::test]
async fn saved_condition_upgrade_keeps_rows_when_sql_was_applied_before_runtime_migration() {
    let pool = common::test_pool().await;
    sqlx::raw_sql(
        r#"
        DROP TABLE answer_map_saved_condition_model;

        DELETE FROM schema_migrations
        WHERE version = 22;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let owner = seed_pre_preset_data(&pool).await;
    let existing_before = existing_data_snapshot(&pool).await;
    sqlx::raw_sql(include_str!(
        "../migrations/20261025120000_answer_map_saved_conditions.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    insert_saved_condition(
        &pool,
        &owner,
        &uuid::Uuid::new_v4().to_string(),
        "filter",
        "CLI先行適用の保存条件",
        1,
        "{\"common_form_id\":null,\"conditions\":[]}",
        "{\"form_label\":null,\"fields\":[]}",
    )
    .await
    .unwrap();
    let query = r#"
        SELECT
            id,
            user_id,
            kind,
            name,
            schema_version,
            definition,
            display,
            create_at
        FROM answer_map_saved_condition_model
        "#;
    let before: Vec<(String, String, String, String, i64, String, String, String)> =
        sqlx::query_as(query).fetch_all(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let after: Vec<(String, String, String, String, i64, String, String, String)> =
        sqlx::query_as(query).fetch_all(&pool).await.unwrap();
    assert_eq!(after, before);
    assert_eq!(existing_data_snapshot(&pool).await, existing_before);
    let versions: Vec<i64> = sqlx::query_scalar(
        r#"
        SELECT
            version
        FROM schema_migrations
        ORDER BY version
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(versions, (1..=22).collect::<Vec<_>>());
}
