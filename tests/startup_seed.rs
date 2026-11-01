#[allow(dead_code)]
#[path = "support/uuid_fixtures.rs"]
mod common;
use geocode_web_single::{config::CONFIG, db::check_and_insert_initial_data};
use sqlx::Row;

#[tokio::test]
async fn first_start_creates_admin_master_layer_and_login_limits_once() {
    let pool = common::test_pool().await;
    common::init_test_env();
    check_and_insert_initial_data(&pool).await.unwrap();
    let admin = sqlx::query(
        r#"
        SELECT
            id,
            username,
            password,
            is_superuser,
            is_locked,
            failed_count
        FROM user_model
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let id: String = admin.get("id");
    let password: String = admin.get("password");
    assert_eq!(admin.get::<String, _>("username"), CONFIG.admin_user_name);
    assert!(admin.get::<bool, _>("is_superuser"));
    assert!(!admin.get::<bool, _>("is_locked"));
    assert_eq!(admin.get::<i32, _>("failed_count"), 0);
    assert_ne!(password, CONFIG.admin_user_password);
    assert!(bcrypt::verify(&CONFIG.admin_user_password, &password).unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM layer_model
            WHERE user_id = $1
                AND is_master
                AND layer_name = 'master'
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let tiles = sqlx::query(
        r#"
        SELECT
            url,
            min_zoom,
            max_zoom
        FROM tileserver_model
        ORDER BY id
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(tiles.len(), 2);
    for tile in tiles {
        assert!(
            tile.get::<String, _>("url")
                .starts_with("https://cyberjapandata.gsi.go.jp/xyz/")
        );
        assert_eq!(tile.get::<Option<i32>, _>("min_zoom"), Some(5));
        assert_eq!(tile.get::<Option<i32>, _>("max_zoom"), Some(18));
    }
    let settings = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT
            setting_key,
            setting_value
        FROM application_settings
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for (key, value) in [
        ("login_attempts_limit", &CONFIG.failed_count),
        ("next_challenge_minutes", &CONFIG.next_challenge_minutes),
        ("challenge_limit_start", &CONFIG.challenge_limit_start),
    ] {
        assert!(settings.contains(&(key.to_string(), value.to_string())));
    }
    sqlx::query(
        r#"
        UPDATE application_settings
        SET
            setting_value = '9'
        WHERE setting_key = 'login_attempts_limit'
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    check_and_insert_initial_data(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM user_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM tileserver_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM application_settings
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT
                password
            FROM user_model
            WHERE id = $1
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        password
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT
                setting_value
            FROM application_settings
            WHERE setting_key = 'login_attempts_limit'
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "9"
    );
}

#[tokio::test]
async fn existing_users_and_custom_tiles_are_not_replaced_or_promoted() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "existing-user").await;
    sqlx::query(
        r#"
        INSERT INTO tileserver_model (
            layer_name,
            label,
            url,
            attribution,
            include_foreign_tiles,
            create_at,
            updated_at
        ) VALUES (
            'custom',
            'custom',
            'https://example.test/{z}/{x}/{y}.png',
            'custom',
            false,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let password = sqlx::query_scalar::<_, String>(
        r#"
        SELECT
            password
        FROM user_model
        WHERE id = $1
        "#,
    )
    .bind(user.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    check_and_insert_initial_data(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM user_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(
            r#"
            SELECT
                is_superuser
            FROM user_model
            WHERE id = $1
            "#,
        )
        .bind(user.to_string())
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT
                password
            FROM user_model
            WHERE id = $1
            "#,
        )
        .bind(user.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        password
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM tileserver_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT
                layer_name
            FROM tileserver_model
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "custom"
    );
}

#[tokio::test]
async fn startup_database_failure_is_returned_to_the_caller() {
    let pool = common::test_pool().await;
    common::init_test_env();
    pool.close().await;
    assert!(matches!(
        check_and_insert_initial_data(&pool).await,
        Err(sqlx::Error::PoolClosed)
    ));
}
