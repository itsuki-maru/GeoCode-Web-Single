use crate::config::CONFIG;
use crate::model::{ApplicationInitSetup, ReturningId, ReturningId64};
use bcrypt::{DEFAULT_COST, hash};
use chrono::{TimeDelta, Utc};
use sqlx::Pool;
use sqlx::query_as;
use sqlx::sqlite::Sqlite;
use uuid::Uuid;

// 初期データの存在確認
pub async fn check_and_insert_initial_data(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    check_and_insert_initial_data_with_options(pool, || SeedOptions {
        admin_username: &CONFIG.admin_user_name,
        admin_password: &CONFIG.admin_user_password,
        failed_count: &CONFIG.failed_count,
        next_challenge_minutes: &CONFIG.next_challenge_minutes,
        challenge_limit_start: &CONFIG.challenge_limit_start,
    })
    .await
}

/// 初期設定ウィンドウ専用。CONFIGやプロセス環境を初期化せず、明示された設定だけを使う。
pub async fn check_and_insert_initial_data_with_settings(
    pool: &Pool<Sqlite>,
    settings: &ApplicationInitSetup,
) -> Result<(), sqlx::Error> {
    check_and_insert_initial_data_with_options(pool, || SeedOptions {
        admin_username: &settings.admin_username,
        admin_password: &settings.admin_passwotd,
        failed_count: &settings.failed_account_lock,
        next_challenge_minutes: &settings.next_challenge_minutes,
        challenge_limit_start: &settings.challenge_limit_time_failed_count,
    })
    .await
}

struct SeedOptions<'a> {
    admin_username: &'a str,
    admin_password: &'a str,
    failed_count: &'a str,
    next_challenge_minutes: &'a str,
    challenge_limit_start: &'a str,
}

async fn check_and_insert_initial_data_with_options<'a>(
    pool: &Pool<Sqlite>,
    options: impl FnOnce() -> SeedOptions<'a>,
) -> Result<(), sqlx::Error> {
    // タイルサーバー初期データの存在を確認するクエリ
    let row: (i64,) = query_as(
        r#"
        SELECT COUNT(*)
        FROM tileserver_model
        "#,
    )
    .fetch_one(pool)
    .await?;

    if row.0 == 0 {
        insert_initial_data(pool).await?;
    } else {
        tracing::info!("Init Tile Server Exists.");
    }

    // 管理者アカウント初期データの存在確認を確認
    let row: (i64,) = query_as(
        r#"
        SELECT
            COUNT(*)
        FROM user_model
        "#,
    )
    .fetch_one(pool)
    .await?;

    if row.0 == 0 {
        insert_initial_admin_data(pool, &options()).await?;
    } else {
        tracing::info!("Admin User Exists.");
    }

    Ok(())
}

async fn insert_initial_data(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    // トランザクション開始
    let mut tx = pool.begin().await?;

    // 現在時刻を取得
    let create_at = Utc::now().naive_utc();
    let update_at = Utc::now().naive_utc();

    let result = query_as!(
        ReturningId64,
        r#"
        INSERT INTO tileserver_model (
            layer_name,
            label,
            url,
            attribution,
            include_foreign_tiles,
            min_zoom,
            max_zoom,
            create_at,
            updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        "#,
        "国土地理院（航空写真）",
        "航空写真",
        "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
        "<a href='https://maps.gsi.go.jp/development/ichiran.html' target='_blank'>国土地理院</a>",
        false,
        5,
        18,
        create_at,
        update_at,
    )
    .fetch_one(&mut *tx)
    .await;

    match result {
        Ok(init_data) => tracing::info!("Created Tile Sever Data: {}", init_data.id),
        Err(error) => return Err(error),
    }

    let create_at = Utc::now().naive_utc();
    let update_at = Utc::now().naive_utc();
    let result = query_as!(
        ReturningId64,
        r#"
        INSERT INTO tileserver_model (
            layer_name,
            label,
            url,
            attribution,
            include_foreign_tiles,
            min_zoom,
            max_zoom,
            create_at,
            updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        "#,
        "国土地理院（通常地図）",
        "地理院地図",
        "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
        "<a href='https://maps.gsi.go.jp/development/ichiran.html' target='_blank'>国土地理院</a>",
        false,
        5,
        18,
        create_at,
        update_at,
    )
    .fetch_one(&mut *tx)
    .await;

    match result {
        Ok(init_data) => tracing::info!("Created Tile Sever Data: {}", init_data.id),
        Err(error) => return Err(error),
    }

    // トランザクション終了
    tx.commit().await?;

    Ok(())
}

// 管理者アカウント作成、アカウントロック回数設定
async fn insert_initial_admin_data(
    pool: &Pool<Sqlite>,
    options: &SeedOptions<'_>,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().naive_utc();
    let yesterday;
    match TimeDelta::try_days(1) {
        Some(one_day_delta) => {
            yesterday = now - one_day_delta;
        },
        None => {
            tracing::error!("Initial Data Create Error.");
            panic!("Initial Data Create Error.");
        },
    }

    // パスワードをハッシュ化(ソルト値はハッシュ値に組み込んで管理)
    let hashed_password = hash(options.admin_password, DEFAULT_COST)
        .map_err(|error| sqlx::Error::Protocol(format!("Admin password hash error: {error}")))?;

    // 新規ID
    let new_admin_id = Uuid::now_v7().to_string();
    let totp_secret = "".to_string();
    let totp_temp_secret = "".to_string();

    // トランザクション開始
    let mut tx = pool.begin().await?;

    let result = query_as!(
        ReturningId,
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
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id
        "#,
        new_admin_id,
        options.admin_username,
        hashed_password,
        now,
        true,
        0,
        yesterday,
        false,
        true,
        false,
        yesterday,
        totp_secret,
        totp_temp_secret,
    )
    .fetch_one(&mut *tx)
    .await;

    // 新規ID
    let new_layer_id = Uuid::now_v7().to_string();
    let default_layer_name = "master".to_string();

    match result {
        Ok(_user_id) => {
            // ユーザーのマスターレイヤを作成
            let returnig_layer_id = query_as!(
                ReturningId,
                r#"
                INSERT INTO layer_model (
                    id,
                    user_id,
                    layer_name,
                    is_master,
                    create_at,
                    update_at
                ) VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
                "#,
                new_layer_id,
                new_admin_id,
                default_layer_name,
                true,
                now,
                now,
            )
            .fetch_one(&mut *tx)
            .await;

            match returnig_layer_id {
                Ok(_) => {
                    tracing::info!("Created admin user: {}", options.admin_username);
                },
                Err(e) => {
                    tracing::error!("Master Layer Create Error: {}.", e);
                    return Err(e);
                },
            }
        },
        Err(e) => {
            tracing::error!("Master Layer Create Error: {}.", e);
            return Err(e);
        },
    }

    // アカウントロックまでの時間を設定
    let failed_count_parsed = options
        .failed_count
        .parse::<u32>()
        .map_err(|error| sqlx::Error::Protocol(format!("Failed count: {error}")))?;

    // 新規ID
    let new_settings_id = Uuid::now_v7().to_string();

    // 設定項目と説明
    let setting_value = "login_attempts_limit".to_string();
    let description =
        "Number of allowed failed login attempts before locking the account".to_string();

    let result = query_as!(
        ReturningId,
        r#"
        INSERT INTO application_settings (
            id,
            setting_key,
            setting_value,
            description,
            create_at,
            updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
        new_settings_id,
        setting_value,
        options.failed_count,
        description,
        now,
        now,
    )
    .fetch_one(&mut *tx)
    .await;

    match result {
        Ok(_) => tracing::info!("Failed Count: {}", failed_count_parsed),
        Err(error) => return Err(error),
    }

    // 複数回のログインに失敗した際の時間制限（分）を設定
    let next_challenge_minutes_parsed = options
        .next_challenge_minutes
        .parse::<u32>()
        .map_err(|error| sqlx::Error::Protocol(format!("Next challenge minutes: {error}")))?;

    // 新規ID
    let new_settings_id = Uuid::now_v7().to_string();

    // 設定項目と説明
    let setting_value = "next_challenge_minutes".to_string();
    let description = "Time limit measures in case of multiple failed login attempts.".to_string();

    let result = query_as!(
        ReturningId,
        r#"
        INSERT INTO application_settings (
            id,
            setting_key,
            setting_value,
            description,
            create_at,
            updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
        new_settings_id,
        setting_value,
        options.next_challenge_minutes,
        description,
        now,
        now,
    )
    .fetch_one(&mut *tx)
    .await;

    match result {
        Ok(_) => tracing::info!("Next Challenge Minutes: {}", next_challenge_minutes_parsed),
        Err(error) => return Err(error),
    }

    // ログイン試行時間制限を開始するまでの回数を設定
    let challenge_limit_start_parsed = options
        .challenge_limit_start
        .parse::<u32>()
        .map_err(|error| sqlx::Error::Protocol(format!("Challenge limit start: {error}")))?;

    // 新規ID
    let new_settings_id = Uuid::now_v7().to_string();

    // 設定項目と説明
    let setting_value = "challenge_limit_start".to_string();
    let description = "Set the number of login attempts before the time limit begins.".to_string();

    let result = query_as!(
        ReturningId,
        r#"
        INSERT INTO application_settings (
            id,
            setting_key,
            setting_value,
            description,
            create_at,
            updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
        new_settings_id,
        setting_value,
        options.challenge_limit_start,
        description,
        now,
        now,
    )
    .fetch_one(&mut *tx)
    .await;

    match result {
        Ok(_) => tracing::info!(
            "Next Challenge Limit Start: {}",
            challenge_limit_start_parsed
        ),
        Err(error) => return Err(error),
    }

    // トランザクションの終了
    tx.commit().await?;

    Ok(())
}
