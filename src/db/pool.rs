use crate::config::CONFIG;
use crate::error::AppError;
use crate::model::ReturningId;
use chrono::{TimeDelta, Utc};
use sqlx::Error;
use sqlx::query_as;
use sqlx::sqlite::SqlitePool;
use std::fs;
use std::path::Path;
use tracing::info;
use uuid::Uuid;

// データベース接続の確立
pub async fn setup_database_pool() -> Result<SqlitePool, Error> {
    if !Path::new(&CONFIG.database_path).exists() {
        info!("The SQLite database file does not exists so create it.");
        fs::File::create(&CONFIG.database_path).expect("Faild to create SQLite database file.");
        info!("The SQLite database created...Ok");
        let pool = SqlitePool::connect(&CONFIG.database_url).await?;
        run_migrations(&pool).await?;
        info!("The SQLite database migration...Ok");
        Ok(pool)
    } else {
        let pool = SqlitePool::connect(&CONFIG.database_url).await?;
        Ok(pool)
    }
}

// ユーザーとマスターレイヤを作成する共通関数
pub async fn create_user_with_master_layer(
    pool: &SqlitePool,
    username: &str,
    hashed_password: &str,
    is_superuser: bool,
) -> Result<ReturningId, AppError> {
    let now = Utc::now().naive_utc();
    let yesterday = match TimeDelta::try_days(1) {
        Some(one_day_delta) => now - one_day_delta,
        None => {
            tracing::error!("TimeDelta creation error.");
            return Err(AppError::InternalServerError);
        },
    };

    let mut tx = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "failed to begin transaction");
        AppError::InternalServerError
    })?;

    let new_user_id = Uuid::now_v7().to_string();
    let brank_text = "".to_string();
    let returning_user_id = query_as!(
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
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id
        "#,
        new_user_id,
        username,
        hashed_password,
        now,
        is_superuser,
        0,
        yesterday,
        false,
        true,
        false,
        yesterday,
        brank_text,
        brank_text,
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "failed to user create");
        AppError::Sqlx(e)
    })?;

    let new_layer_id = Uuid::now_v7().to_string();
    let now = Utc::now().naive_utc();
    let master_layer_name = "master".to_string();

    let _returning_layer_id = query_as!(
        ReturningId,
        r#"
        INSERT INTO layer_model (
            id,
            user_id,
            layer_name,
            is_master,
            create_at,
            update_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
        new_layer_id,
        new_user_id,
        master_layer_name,
        true,
        now,
        now,
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "failed to layer create");
        AppError::Sqlx(e)
    })?;

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "failed to commit transaction");
        AppError::Sqlx(e)
    })?;

    Ok(returning_user_id)
}

// データベースのマイグレーション
async fn run_migrations(pool: &SqlitePool) -> Result<(), Error> {
    let schemas = vec![
        r#"
        CREATE TABLE IF NOT EXISTS user_model (
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
        r#"
        CREATE TABLE IF NOT EXISTS image_model (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            uuid_filename TEXT NOT NULL,
            create_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS layer_model (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            layer_name TEXT NOT NULL,
            is_master BOOLEAN DEFAULT FALSE NOT NULL,
            create_at TEXT NOT NULL,
            update_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS marker_info_model (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            layer_id TEXT NOT NULL,
            marker_name TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            detail CHARACTER VARYING NOT NULL,
            create_at TEXT NOT NULL,
            update_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE,
            FOREIGN KEY (layer_id) REFERENCES layer_model(id) ON DELETE CASCADE ON UPDATE CASCADE
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS tileserver_model (
            id INTEGER PRIMARY KEY NOT NULL,
            layer_name CHARACTER VARYING(255) NOT NULL,
            label CHARACTER VARYING(255) NOT NULL,
            url CHARACTER VARYING(255) NOT NULL,
            attribution CHARACTER VARYING(255) NOT NULL,
            include_foreign_tiles BOOLEAN DEFAULT FALSE NOT NULL,
            min_zoom INTEGER,
            max_zoom INTEGER,
            create_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS temporary_urls (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            url TEXT NOT NULL,
            expiration TEXT NOT NULL,
            layers TEXT NOT NULL,
            markers TEXT NOT NULL,
            shapes TEXT NOT NULL DEFAULT '{}',
            create_at TEXT NOT NULL,
            password_hash CHARACTER VARYING(256)
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS application_settings (
            id TEXT PRIMARY KEY NOT NULL,
            setting_key VARCHAR(255) NOT NULL UNIQUE,
            setting_value VARCHAR(255) NOT NULL,
            description TEXT,
            create_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS shape_model (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT,
            shape_type CHARACTER VARYING(32) NOT NULL,
            geojson TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            layer_id TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE,
            FOREIGN KEY (layer_id) REFERENCES layer_model(id) ON DELETE CASCADE ON UPDATE CASCADE
        );
        "#,
        r#"
        CREATE INDEX IF NOT EXISTS idx_shape_model_user_layer
        ON shape_model(user_id, layer_id);
        "#,
    ];

    let mut tx = pool.begin().await?;
    for schema in schemas {
        sqlx::query(schema).execute(&mut *tx).await?;
    }
    tx.commit().await?;

    Ok(())
}
