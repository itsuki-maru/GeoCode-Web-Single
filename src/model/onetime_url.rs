use chrono::{NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::{collections::HashMap, time::Duration};
use thiserror::Error;

use super::layer::LayerObjectFromRow;
use super::marker::MarkerObjectFromRow;
use super::shape::ShapeObject;

// URL作成のエラーハンドリング
#[derive(Debug, Error)]
pub enum TempUrlError {
    #[error("Time error: {0}")]
    TimeError(#[from] std::time::SystemTimeError),
    #[error("Duration overflow")]
    DurationOverflow,
}

// 一時URLと有効期限を保存するデータ構造
#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct TemporaryUrl {
    pub id: String,
    pub user_id: String,
    pub url: String,
    pub expiration: NaiveDateTime,
    pub password_hash: Option<String>,
    pub layers: HashMap<String, LayerObjectFromRow>,
    pub markers: HashMap<String, MarkerObjectFromRow>,
    pub shapes: HashMap<String, ShapeObject>,
}

impl TemporaryUrl {
    pub fn new(
        uuid: String,
        user_id: String,
        url: String,
        ttl: Duration,
        password_hash: Option<String>,
        layers: HashMap<String, LayerObjectFromRow>,
        markers: HashMap<String, MarkerObjectFromRow>,
        shapes: HashMap<String, ShapeObject>,
    ) -> Result<Self, TempUrlError> {
        let expiration = Utc::now()
            .naive_utc()
            .checked_add_signed(
                chrono::Duration::from_std(ttl).map_err(|_| TempUrlError::DurationOverflow)?,
            )
            .ok_or(TempUrlError::DurationOverflow)?;
        Ok(Self {
            id: uuid,
            user_id,
            url,
            expiration,
            password_hash,
            layers,
            markers,
            shapes,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct TemporaryUrlFromDB {
    pub id: String,
    pub user_id: String,
    pub url: String,
    pub expiration: String,
    pub password_hash: Option<String>,
    pub layers: String,
    pub markers: String,
    pub shapes: String,
    pub create_at: String,
}

impl TemporaryUrlFromDB {
    pub fn is_expired(&self) -> bool {
        // SQLiteでの文字列から日付型に戻す
        let expiration = NaiveDateTime::parse_from_str(&self.expiration, "%Y-%m-%d %H:%M:%S%.s");
        match expiration {
            Ok(exp) => exp < Utc::now().naive_utc(),
            Err(_e) => false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenarateUrlPayload {
    pub minutes: u64,
    pub layers: Vec<String>,
    pub update_url: bool,
    pub share_password: Option<String>,
    #[serde(default)]
    pub include_shapes: bool,
}

// 一時URL作成・更新後のレスポンス構造体
#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct CreateUpdatedTemporaryUrlResponse {
    pub id: String,
    pub url: String,
    pub expiration: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct CurrentTemporaryUrlResponse {
    pub id: String,
    pub url: String,
    pub expiration: String,
    pub is_password_protected: bool,
}

#[derive(Debug, Deserialize)]
pub struct OnetimePasswordForm {
    pub password: String,
}
