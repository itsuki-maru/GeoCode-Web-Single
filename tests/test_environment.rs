#[allow(dead_code)]
mod common;

#[test]
fn user_fixture_initializes_settings_without_a_development_database() {
    const CHILD: &str = "GEOCODE_USER_FIXTURE_ENV_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "user_fixture_initializes_settings_without_a_development_database",
                "--nocapture",
            ])
            .env(CHILD, "1");
        for name in [
            "APP_TITLE",
            "DATABASE_URL",
            "CREATEDATABASE_PATH",
            "SECRET_KEY",
            "ADMIN_USERNAME",
            "ADMIN_PASSWORD",
            "IMAGE_FILES_PATH",
            "UPLOAD_FILE_PATH",
            "ACCESS_TOKEN_EXP_MINUTUES",
            "REFRESH_TOKEN_EXP_MINUTUES",
        ] {
            command.env_remove(name);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        // test_pool() による初期化には頼らず、sqlx::test から渡されるDBと同じ経路を通す。
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        geocode_web_single::db::run_migrations(&pool).await.unwrap();
        let user = common::create_test_user(&pool, "isolated-fixture").await;
        let config = &geocode_web_single::config::CONFIG;
        assert_eq!(config.database_url, "sqlite::memory:");
        assert_eq!(config.database_path, ":memory:");
        assert_eq!(config.app_title, "GeoCode Test");
        let token = geocode_web_single::auth::create_token(&user, 30, "access_token", 0).unwrap();
        assert_eq!(
            geocode_web_single::auth::verify_access_token(&token)
                .unwrap()
                .sub,
            user
        );
        pool.close().await;
    });
}
