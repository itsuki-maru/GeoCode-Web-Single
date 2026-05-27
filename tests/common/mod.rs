use bcrypt::{DEFAULT_COST, hash};
use geocode_web_single::db::create_user_with_master_layer;
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use std::{path::PathBuf, sync::Once};

static TEST_ENV: Once = Once::new();
const TEST_FILES_DIR: &str = "target\\handler-tests";

pub fn init_test_env() {
    TEST_ENV.call_once(|| unsafe {
        std::env::set_var("APP_TITLE", "GeoCode Test");
        std::env::set_var("CREATEDATABASE_PATH", ":memory:");
        std::env::set_var("DATABASE_URL", "sqlite::memory:");
        std::env::set_var("SECRET_KEY", "test-secret-key");
        std::fs::create_dir_all(TEST_FILES_DIR).expect("test files directory should be created");
        std::env::set_var("IMAGE_FILES_PATH", TEST_FILES_DIR);
        std::env::set_var("UPLOAD_FILE_PATH", TEST_FILES_DIR);
        std::env::set_var("FAILED_ACCOUNT_LOCK", "5");
        std::env::set_var("NEXT_CHALLENGE_MINUTES", "5");
        std::env::set_var("CHALLENGE_LIMIT_TIME_FAILEDCOUNT", "3");
        std::env::set_var("ADMIN_USERNAME", "admin");
        std::env::set_var("ADMIN_PASSWORD", "password123");
        std::env::set_var("ACCESS_TOKEN_EXP_MINUTUES", "30");
        std::env::set_var("REFRESH_TOKEN_EXP_MINUTUES", "1440");
        std::env::set_var("CACHE_CONTROL", "no-cache");
        std::env::set_var("SECURE_COOKIE", "false");
        std::env::set_var("SERVICE_NAME", "GeoCode Test");
        std::env::set_var("RUST_LOG", "off");
        std::env::set_var("ALLOW_USER_CREATE_ACCOUNT", "true");
        std::env::set_var("ALLOW_USER_UPDATE_PASSWORD", "true");
        std::env::set_var("ALLOW_ORIGINS", "http://localhost:3000");
        std::env::set_var("TILE_SERVER_BASE_URL", "http://localhost");
        std::env::set_var("TILE_SERVER_API_KEY", "test-api-key");
    });
}

pub fn test_files_dir() -> PathBuf {
    init_test_env();
    PathBuf::from(TEST_FILES_DIR)
}

pub async fn test_pool() -> SqlitePool {
    init_test_env();

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("test sqlite pool should connect");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations should run");

    pool
}

pub async fn create_test_user(pool: &SqlitePool, username: &str) -> String {
    let hashed_password =
        hash("password123", DEFAULT_COST).expect("test password should hash successfully");

    create_user_with_master_layer(pool, username, &hashed_password, false)
        .await
        .expect("test user should be created")
        .id
}

pub async fn create_test_admin(pool: &SqlitePool, username: &str) -> String {
    let user_id = create_test_user(pool, username).await;
    sqlx::query(
        r#"
        UPDATE user_model
        SET is_superuser = true
        WHERE id = $1
        "#,
    )
    .bind(&user_id)
    .execute(pool)
    .await
    .expect("test admin should be promoted");
    user_id
}

pub async fn master_layer_id(pool: &SqlitePool, user_id: &str) -> String {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM layer_model
        WHERE user_id = $1 AND is_master = true
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("master layer should exist")
}
