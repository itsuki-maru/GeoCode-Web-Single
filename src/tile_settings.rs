use std::sync::RwLock;

use axum::http::HeaderValue;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use reqwest::Url;
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use serde::Serialize;
use sqlx::{SqlitePool, types::Json};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    config::{CONFIG, parse_vector_tile_allowed_origins},
    error::AppError,
    middleware::security::content_security_policy_for_origins,
    tile_upstream::validate_managed_base_url,
};

#[derive(Clone)]
pub struct ManagedTileUpstream {
    pub base_url: Url,
    pub api_key: HeaderValue,
}

#[derive(Clone)]
pub struct TileSettingsSnapshot {
    revision: Option<Uuid>,
    pub proxy_revision: Option<Uuid>,
    pub managed_upstream: Option<ManagedTileUpstream>,
    pub vector_origins: Vec<String>,
    pub vector_policy: HeaderValue,
    vector_origins_managed: bool,
    updated_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct SettingsRow {
    revision: String,
    proxy_revision: Option<String>,
    proxy_base_url: Option<String>,
    encrypted_api_key: Option<Vec<u8>>,
    vector_origins: Option<Json<Vec<String>>>,
    updated_at: DateTime<Utc>,
}

const SELECT_SETTINGS: &str = "SELECT revision, proxy_revision, proxy_base_url, \
    encrypted_api_key, vector_origins, updated_at FROM tile_server_settings WHERE id = 1";

struct ApiKeyCipher(LessSafeKey);

impl ApiKeyCipher {
    fn from_base64(value: &str) -> Option<Self> {
        let bytes = STANDARD.decode(value.trim()).ok()?;
        let key = UnboundKey::new(&AES_256_GCM, &bytes).ok()?;
        Some(Self(LessSafeKey::new(key)))
    }

    fn seal(&self, upstream: &ManagedTileUpstream) -> Result<Vec<u8>, AppError> {
        let mut nonce = [0; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| AppError::InternalServerError)?;
        let mut encrypted = upstream.api_key.as_bytes().to_vec();
        self.0
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(upstream.base_url.as_str().as_bytes()),
                &mut encrypted,
            )
            .map_err(|_| AppError::InternalServerError)?;
        let mut stored = Vec::with_capacity(NONCE_LEN + encrypted.len());
        stored.extend_from_slice(&nonce);
        stored.extend_from_slice(&encrypted);
        Ok(stored)
    }

    fn open(&self, base_url: &Url, stored: &[u8]) -> Result<HeaderValue, AppError> {
        let (nonce, encrypted) = stored
            .split_first_chunk::<NONCE_LEN>()
            .ok_or(AppError::InternalServerError)?;
        let mut encrypted = encrypted.to_vec();
        let clear = self
            .0
            .open_in_place(
                Nonce::assume_unique_for_key(*nonce),
                Aad::from(base_url.as_str().as_bytes()),
                &mut encrypted,
            )
            .map_err(|_| AppError::InternalServerError)?;
        let mut key = HeaderValue::from_bytes(clear).map_err(|_| AppError::InternalServerError)?;
        key.set_sensitive(true);
        Ok(key)
    }
}

pub struct TileSettings {
    environment_url: Option<String>,
    environment_key: Option<String>,
    image_origins: Vec<String>,
    environment_snapshot: TileSettingsSnapshot,
    cipher: Option<ApiKeyCipher>,
    current: RwLock<TileSettingsSnapshot>,
    // 設定の再取得と公開を直列化し、保存直後のスナップショットがポーリングで置き換わることを防ぐ。
    sync: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TileSettingsView {
    revision: Option<Uuid>,
    proxy: ProxyView,
    vector_origins: OriginsView,
    key_storage_configured: bool,
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyView {
    source: &'static str,
    base_url: Option<String>,
    has_api_key: bool,
}

#[derive(Serialize)]
struct OriginsView {
    source: &'static str,
    origins: Vec<String>,
}

impl TileSettings {
    pub fn from_env() -> Self {
        let cipher = std::env::var("TILE_SETTINGS_ENCRYPTION_KEY")
            .ok()
            .and_then(|value| {
                let cipher = ApiKeyCipher::from_base64(&value);
                if cipher.is_none() {
                    tracing::warn!(
                        "Invalid TILE_SETTINGS_ENCRYPTION_KEY; expected 32 Base64-encoded bytes"
                    );
                }
                cipher
            });
        Self::new(
            CONFIG.tile_server_base_url.clone(),
            CONFIG.tile_server_api_key.clone(),
            CONFIG.http_image_allowed_origins.clone(),
            CONFIG.vector_tile_allowed_origins.clone(),
            cipher,
        )
    }

    fn new(
        environment_url: Option<String>,
        environment_key: Option<String>,
        image_origins: Vec<String>,
        vector_origins: Vec<String>,
        cipher: Option<ApiKeyCipher>,
    ) -> Self {
        let environment_snapshot = TileSettingsSnapshot {
            revision: None,
            proxy_revision: None,
            managed_upstream: None,
            vector_policy: content_security_policy_for_origins(&image_origins, &vector_origins),
            vector_origins,
            vector_origins_managed: false,
            updated_at: None,
        };
        Self {
            environment_url,
            environment_key,
            image_origins,
            current: RwLock::new(environment_snapshot.clone()),
            environment_snapshot,
            cipher,
            sync: Mutex::new(()),
        }
    }

    pub fn snapshot(&self) -> TileSettingsSnapshot {
        self.current.read().expect("tile settings lock").clone()
    }

    fn publish(&self, snapshot: TileSettingsSnapshot) {
        *self.current.write().expect("tile settings lock") = snapshot;
    }

    pub async fn refresh(&self, pool: &SqlitePool) -> Result<(), AppError> {
        let _guard = self.sync.lock().await;
        let row = sqlx::query_as::<_, SettingsRow>(SELECT_SETTINGS)
            .fetch_optional(pool)
            .await?;
        let snapshot = match row.as_ref() {
            Some(row) => self.load_snapshot(row)?,
            None => self.environment_snapshot.clone(),
        };
        self.publish(snapshot);
        Ok(())
    }

    fn load_snapshot(&self, row: &SettingsRow) -> Result<TileSettingsSnapshot, AppError> {
        let managed_upstream = match (&row.proxy_base_url, &row.encrypted_api_key) {
            (Some(url), Some(encrypted)) => {
                let base_url =
                    validate_managed_base_url(url).map_err(|_| AppError::InternalServerError)?;
                let cipher = self.cipher.as_ref().ok_or(AppError::InternalServerError)?;
                let api_key = cipher.open(&base_url, encrypted)?;
                Some(ManagedTileUpstream { base_url, api_key })
            },
            (None, None) => None,
            _ => return Err(AppError::InternalServerError),
        };
        let vector_origins = match &row.vector_origins {
            Some(origins) => {
                validate_vector_origins(&origins.0).map_err(|_| AppError::InternalServerError)?
            },
            None => self.environment_snapshot.vector_origins.clone(),
        };
        Ok(TileSettingsSnapshot {
            revision: Some(
                Uuid::parse_str(&row.revision).map_err(|_| AppError::InternalServerError)?,
            ),
            proxy_revision: row
                .proxy_revision
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()
                .map_err(|_| AppError::InternalServerError)?,
            managed_upstream,
            vector_policy: content_security_policy_for_origins(
                &self.image_origins,
                &vector_origins,
            ),
            vector_origins,
            vector_origins_managed: row.vector_origins.is_some(),
            updated_at: Some(row.updated_at),
        })
    }

    pub(crate) fn view(&self) -> TileSettingsView {
        self.view_of(&self.snapshot())
    }

    fn view_of(&self, snapshot: &TileSettingsSnapshot) -> TileSettingsView {
        let proxy = match &snapshot.managed_upstream {
            Some(upstream) => ProxyView {
                source: "managed",
                base_url: Some(upstream.base_url.to_string()),
                has_api_key: true,
            },
            None => ProxyView {
                source: "environment",
                base_url: self
                    .environment_url
                    .as_deref()
                    .and_then(public_environment_url),
                has_api_key: self
                    .environment_key
                    .as_ref()
                    .is_some_and(|key| !key.is_empty()),
            },
        };
        TileSettingsView {
            revision: snapshot.revision,
            proxy,
            vector_origins: OriginsView {
                source: if snapshot.vector_origins_managed {
                    "managed"
                } else {
                    "environment"
                },
                origins: snapshot.vector_origins.clone(),
            },
            key_storage_configured: self.cipher.is_some(),
            updated_at: snapshot.updated_at,
        }
    }

    pub(crate) fn prepare_upstream(
        &self,
        revision: Option<Uuid>,
        base_url: &str,
        api_key: Option<&str>,
    ) -> Result<ManagedTileUpstream, AppError> {
        let snapshot = self.snapshot();
        if snapshot.revision != revision {
            return Err(AppError::Conflict);
        }
        if self.cipher.is_none() {
            return Err(AppError::Validation(
                "上流設定の保存には暗号鍵の設定が必要です。".into(),
            ));
        }
        let base_url = validate_managed_base_url(base_url)?;
        let api_key = match api_key {
            Some(key) => validate_api_key(key)?,
            None => self.retained_key(&snapshot, &base_url).ok_or_else(|| {
                AppError::Validation("この接続先で使用するAPIキーを入力してください。".into())
            })?,
        };
        Ok(ManagedTileUpstream { base_url, api_key })
    }

    fn retained_key(&self, snapshot: &TileSettingsSnapshot, base_url: &Url) -> Option<HeaderValue> {
        if let Some(upstream) = &snapshot.managed_upstream {
            return (upstream.base_url == *base_url).then(|| upstream.api_key.clone());
        }
        let current_url = validate_managed_base_url(self.environment_url.as_deref()?).ok()?;
        if current_url != *base_url {
            return None;
        }
        validate_api_key(self.environment_key.as_deref()?).ok()
    }

    pub(crate) async fn set_proxy(
        &self,
        pool: &SqlitePool,
        user_id: &str,
        expected_revision: Option<Uuid>,
        upstream: Option<ManagedTileUpstream>,
    ) -> Result<TileSettingsView, AppError> {
        let proxy = upstream
            .map(|upstream| {
                let cipher = self.cipher.as_ref().ok_or(AppError::InternalServerError)?;
                Ok::<_, AppError>((upstream.base_url.to_string(), cipher.seal(&upstream)?))
            })
            .transpose()?;
        self.update(pool, user_id, expected_revision, move |row| {
            row.proxy_revision = Some(Uuid::new_v4().to_string());
            (row.proxy_base_url, row.encrypted_api_key) = match proxy {
                Some((url, key)) => (Some(url), Some(key)),
                None => (None, None),
            };
        })
        .await
    }

    pub(crate) async fn set_vector_origins(
        &self,
        pool: &SqlitePool,
        user_id: &str,
        expected_revision: Option<Uuid>,
        origins: Option<Vec<String>>,
    ) -> Result<TileSettingsView, AppError> {
        let origins = origins
            .as_deref()
            .map(validate_vector_origins)
            .transpose()?;
        self.update(pool, user_id, expected_revision, move |row| {
            row.vector_origins = origins.map(Json);
        })
        .await
    }

    async fn update(
        &self,
        pool: &SqlitePool,
        user_id: &str,
        expected_revision: Option<Uuid>,
        patch: impl FnOnce(&mut SettingsRow),
    ) -> Result<TileSettingsView, AppError> {
        let _guard = self.sync.lock().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let current = sqlx::query_as::<_, SettingsRow>(SELECT_SETTINGS)
            .fetch_optional(&mut *tx)
            .await?;
        if current.as_ref().map(|row| row.revision.as_str())
            != expected_revision.as_ref().map(Uuid::to_string).as_deref()
        {
            return Err(AppError::Conflict);
        }
        let mut row = current.unwrap_or(SettingsRow {
            revision: Uuid::nil().to_string(),
            proxy_revision: None,
            proxy_base_url: None,
            encrypted_api_key: None,
            vector_origins: None,
            updated_at: Utc::now(),
        });
        row.revision = Uuid::new_v4().to_string();
        row.updated_at = Utc::now();
        patch(&mut row);
        let snapshot = self.load_snapshot(&row)?;
        // 設定版の一致条件により、異なるプロセスからの同時初回保存にも対応する。
        let result = sqlx::query(
            "INSERT INTO tile_server_settings (id, revision, proxy_revision, proxy_base_url,
                encrypted_api_key, vector_origins, updated_by, updated_at)
             VALUES (1, $1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision,
                proxy_revision = EXCLUDED.proxy_revision, proxy_base_url = EXCLUDED.proxy_base_url,
                encrypted_api_key = EXCLUDED.encrypted_api_key, vector_origins = EXCLUDED.vector_origins,
                updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
             WHERE tile_server_settings.revision = $8",
        )
        .bind(&row.revision)
        .bind(&row.proxy_revision)
        .bind(&row.proxy_base_url)
        .bind(&row.encrypted_api_key)
        .bind(&row.vector_origins)
        .bind(user_id)
        .bind(row.updated_at)
        .bind(expected_revision.map(|revision| revision.to_string()))
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::Conflict);
        }
        tx.commit().await?;
        let view = self.view_of(&snapshot);
        self.publish(snapshot);
        Ok(view)
    }
}

fn public_environment_url(value: &str) -> Option<String> {
    let mut url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn validate_api_key(value: &str) -> Result<HeaderValue, AppError> {
    let invalid = || AppError::Validation("APIキーに使用できない文字が含まれています。".into());
    if value.is_empty()
        || value.len() > 4096
        || value.trim() != value
        || value.bytes().any(|byte| !(b' '..=b'~').contains(&byte))
    {
        return Err(invalid());
    }
    let mut key = HeaderValue::from_str(value).map_err(|_| invalid())?;
    key.set_sensitive(true);
    Ok(key)
}

fn validate_vector_origins(values: &[String]) -> Result<Vec<String>, AppError> {
    if values.len() > 64 || values.iter().map(|value| value.len() + 1).sum::<usize>() > 4096 {
        return Err(AppError::Validation(
            "許可する接続先の一覧が長すぎます。".into(),
        ));
    }
    let mut origins = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let invalid = || {
            AppError::Validation(format!(
                "{}件目はHTTPSオリジンを1つ指定してください。",
                index + 1
            ))
        };
        if value.contains(',') {
            return Err(invalid());
        }
        let parsed = parse_vector_tile_allowed_origins(Some(value)).map_err(|_| invalid())?;
        let [origin] = parsed.as_slice() else {
            return Err(invalid());
        };
        if !origins.contains(origin) {
            origins.push(origin.clone());
        }
    }
    Ok(origins)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_user_with_master_layer;

    async fn test_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        pool
    }

    fn test_cipher() -> ApiKeyCipher {
        ApiKeyCipher::from_base64(&STANDARD.encode([7; 32])).unwrap()
    }

    fn test_settings() -> TileSettings {
        TileSettings::new(
            Some("https://tiles.example/tile".into()),
            Some("original-test-key".into()),
            Vec::new(),
            vec!["https://vector-env.example".into()],
            Some(test_cipher()),
        )
    }

    /// 暗号化したキーの復号には同じ接続先が必要で、改ざんを検出する。
    #[test]
    fn encrypted_key_authenticates_the_base_url_and_is_sensitive_after_decryption() {
        let cipher = test_cipher();
        let upstream = ManagedTileUpstream {
            base_url: Url::parse("https://tiles.example/a").unwrap(),
            api_key: validate_api_key("a-test-key").unwrap(),
        };
        let stored = cipher.seal(&upstream).unwrap();
        assert_ne!(cipher.seal(&upstream).unwrap(), stored);
        assert!(!stored.windows(10).any(|bytes| bytes == b"a-test-key"));
        let restored = cipher.open(&upstream.base_url, &stored).unwrap();
        assert_eq!(restored, upstream.api_key);
        assert!(restored.is_sensitive());
        assert!(
            cipher
                .open(&Url::parse("https://tiles.example/b").unwrap(), &stored)
                .is_err()
        );
        let mut corrupted = stored;
        corrupted[NONCE_LEN] ^= 1;
        assert!(cipher.open(&upstream.base_url, &corrupted).is_err());
    }

    /// 保存済みキーは同じ接続先でのみ再利用し、応答本文へ含めない。
    #[test]
    fn saved_key_is_reused_only_for_the_same_validated_base_url() {
        let settings = test_settings();
        let same = settings
            .prepare_upstream(None, "https://tiles.example/tile/", None)
            .unwrap();
        assert_eq!(same.api_key, "original-test-key");
        assert!(same.api_key.is_sensitive());
        assert!(
            settings
                .prepare_upstream(None, "https://tiles.example/other", None)
                .is_err()
        );
        assert!(
            settings
                .prepare_upstream(None, "https://other.example/tile", None)
                .is_err()
        );
        assert!(
            settings
                .prepare_upstream(None, "https://tiles.example/tile", Some("bad\nkey"))
                .is_err()
        );

        let encoded = serde_json::to_string(&settings.view()).unwrap();
        assert!(encoded.contains("\"hasApiKey\":true"));
        assert!(!encoded.contains("original-test-key"));
        assert_eq!(
            public_environment_url("https://user:password@tiles.example/tile?key=secret#fragment"),
            Some("https://tiles.example/tile".into())
        );
    }

    /// 配信元の形式を検証し、重複を正規化する。
    #[test]
    fn origins_validate_each_entry_and_normalize_duplicates() {
        let origins = validate_vector_origins(&[
            "https://EXAMPLE.test:443/".into(),
            "https://example.test".into(),
            "https://tiles.example:8443".into(),
        ])
        .unwrap();
        assert_eq!(
            origins,
            ["https://example.test", "https://tiles.example:8443"]
        );
        for value in [
            "",
            "http://example.test",
            "https://example.test/a",
            "https://*.example.test",
            "https://a.test,https://b.test",
        ] {
            assert!(validate_vector_origins(&[value.into()]).is_err());
        }
    }

    /// 中継先と配信元許可を独立して保存・再取得・切り戻しできる。
    #[tokio::test]
    async fn proxy_and_vector_settings_persist_and_roll_back_independently() {
        let pool = test_pool().await;
        let admin = create_user_with_master_layer(&pool, "tile-setting-admin", "test-hash", true)
            .await
            .unwrap()
            .id;
        let settings = test_settings();
        settings.refresh(&pool).await.unwrap();
        let candidate = settings
            .prepare_upstream(None, "https://new.example/tile", Some("new-test-key"))
            .unwrap();
        let applied = settings
            .set_proxy(&pool, &admin, None, Some(candidate))
            .await
            .unwrap();
        let proxy_revision = settings.snapshot().proxy_revision.unwrap();
        assert_eq!(applied.proxy.source, "managed");
        assert_eq!(applied.vector_origins.source, "environment");
        assert!(
            !serde_json::to_string(&applied)
                .unwrap()
                .contains("new-test-key")
        );
        let stored =
            sqlx::query_scalar::<_, Vec<u8>>("SELECT encrypted_api_key FROM tile_server_settings")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_ne!(stored.as_slice(), b"new-test-key");
        assert_eq!(
            settings
                .prepare_upstream(applied.revision, "https://new.example/tile", None)
                .unwrap()
                .api_key,
            "new-test-key"
        );

        let managed = settings
            .set_vector_origins(&pool, &admin, applied.revision, Some(vec![]))
            .await
            .unwrap();
        assert_eq!(managed.vector_origins.source, "managed");
        assert!(managed.vector_origins.origins.is_empty());
        assert_eq!(settings.snapshot().proxy_revision, Some(proxy_revision));
        assert!(matches!(
            settings
                .set_proxy(&pool, &admin, applied.revision, None)
                .await,
            Err(AppError::Conflict)
        ));

        let other_process = test_settings();
        other_process.refresh(&pool).await.unwrap();
        let persisted = other_process.snapshot();
        assert_eq!(persisted.revision, managed.revision);
        assert_eq!(persisted.managed_upstream.unwrap().api_key, "new-test-key");
        assert!(
            !persisted
                .vector_policy
                .to_str()
                .unwrap()
                .contains("https://vector-env.example")
        );

        sqlx::query("UPDATE tile_server_settings SET encrypted_api_key = $1")
            .bind(vec![0_u8; 28])
            .execute(&pool)
            .await
            .unwrap();
        assert!(other_process.refresh(&pool).await.is_err());
        assert_eq!(other_process.snapshot().revision, managed.revision);
        assert_eq!(
            other_process.snapshot().managed_upstream.unwrap().api_key,
            "new-test-key"
        );

        let rolled_back = other_process
            .set_proxy(&pool, &admin, managed.revision, None)
            .await
            .unwrap();
        assert_eq!(rolled_back.proxy.source, "environment");
        assert_eq!(rolled_back.vector_origins.source, "managed");
        assert_ne!(
            other_process.snapshot().proxy_revision,
            Some(proxy_revision)
        );
        let defaults = settings
            .set_vector_origins(&pool, &admin, rolled_back.revision, None)
            .await
            .unwrap();
        assert_eq!(defaults.vector_origins.source, "environment");
        assert_eq!(
            defaults.vector_origins.origins,
            ["https://vector-env.example"]
        );
        assert_eq!(
            settings.snapshot().proxy_revision,
            other_process.snapshot().proxy_revision
        );
    }

    /// 別の設定管理インスタンスによる同時初回保存は、片方だけを確定する。
    #[tokio::test]
    async fn concurrent_first_writes_detect_conflict_across_processes() {
        let path = std::path::PathBuf::from("target")
            .join(format!("tile-settings-{}.sqlite", Uuid::new_v4()));
        std::fs::create_dir_all("target").unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let admin = create_user_with_master_layer(&pool, "tile-setting-admin", "test-hash", true)
            .await
            .unwrap()
            .id;
        let first = test_settings();
        let second = test_settings();
        let (left, right) = tokio::join!(
            first.set_vector_origins(
                &pool,
                &admin,
                None,
                Some(vec!["https://first.example".into()])
            ),
            second.set_vector_origins(
                &pool,
                &admin,
                None,
                Some(vec!["https://second.example".into()])
            ),
        );
        let winner = match (left, right) {
            (Ok(winner), Err(AppError::Conflict)) | (Err(AppError::Conflict), Ok(winner)) => winner,
            _ => panic!("片方の保存が成功し、もう片方は競合として拒否される必要があります。"),
        };
        first.refresh(&pool).await.unwrap();
        second.refresh(&pool).await.unwrap();
        assert_eq!(first.snapshot().revision, winner.revision);
        assert_eq!(
            second.snapshot().vector_origins,
            winner.vector_origins.origins
        );
        pool.close().await;
        drop(pool);
        // WindowsでSQLiteワーカーが接続を解放するまで、一時ファイルの削除を再試行する。
        for attempt in 0..100 {
            match std::fs::remove_file(&path) {
                Ok(()) => return,
                Err(error)
                    if attempt < 99
                        && (error.kind() == std::io::ErrorKind::PermissionDenied
                            || error.raw_os_error() == Some(32)) =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                },
                Err(error) => panic!("一時DBを削除できませんでした: {error}"),
            }
        }
    }
}
