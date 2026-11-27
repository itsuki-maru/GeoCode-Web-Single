use super::{LocalRoutingListener, Osrm, REQUESTS_PER_MINUTE};
use crate::{
    error::AppError,
    handler::live_map::require_superuser,
    routing::{Coordinate, TravelMode},
};
use axum::{
    Json,
    extract::{Extension, rejection::JsonRejection},
    http::{HeaderValue, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Url;
use ring::{
    aead::{self, AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;
use uuid::Uuid;

pub(super) struct ApiKeyCipher(LessSafeKey);

impl ApiKeyCipher {
    pub(super) fn from_base64(value: &str) -> Option<Self> {
        let bytes = STANDARD.decode(value.trim()).ok()?;
        let key = UnboundKey::new(&AES_256_GCM, &bytes).ok()?;
        Some(Self(LessSafeKey::new(key)))
    }

    fn seal(
        &self,
        mode: TravelMode,
        endpoint: &Url,
        api_key: &HeaderValue,
    ) -> Result<Vec<u8>, AppError> {
        let mut nonce = [0; aead::NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| AppError::InternalServerError)?;
        let mut bytes = api_key.as_bytes().to_vec();
        self.0
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(key_scope(mode, endpoint)),
                &mut bytes,
            )
            .map_err(|_| AppError::InternalServerError)?;
        Ok([nonce.as_slice(), bytes.as_slice()].concat())
    }

    fn open(
        &self,
        mode: TravelMode,
        endpoint: &Url,
        stored: &[u8],
    ) -> Result<HeaderValue, AppError> {
        let (nonce, encrypted) = stored
            .split_first_chunk::<{ aead::NONCE_LEN }>()
            .ok_or(AppError::BadGateway)?;
        let mut bytes = encrypted.to_vec();
        let decrypted = self
            .0
            .open_in_place(
                Nonce::assume_unique_for_key(*nonce),
                Aad::from(key_scope(mode, endpoint)),
                &mut bytes,
            )
            .map_err(|_| AppError::BadGateway)?;
        let mut key = HeaderValue::from_bytes(decrypted).map_err(|_| AppError::BadGateway)?;
        key.set_sensitive(true);
        Ok(key)
    }
}

fn key_scope(mode: TravelMode, endpoint: &Url) -> String {
    let scope = match mode {
        TravelMode::Drive => "drive",
        TravelMode::Walk => "walk",
    };
    format!("geocode-osrm-api-key-v1\0{scope}\0{endpoint}")
}

#[derive(sqlx::FromRow)]
struct StoredSettings {
    revision: Option<String>,
    drive_base_url: Option<String>,
    walk_base_url: Option<String>,
    encrypted_drive_key: Option<Vec<u8>>,
    encrypted_walk_key: Option<Vec<u8>>,
}

impl StoredSettings {
    fn base_url(&self, mode: TravelMode) -> Option<&str> {
        match mode {
            TravelMode::Drive => self.drive_base_url.as_deref(),
            TravelMode::Walk => self.walk_base_url.as_deref(),
        }
    }

    fn endpoint(&self, mode: TravelMode) -> Result<Option<Url>, AppError> {
        self.base_url(mode)
            .map(|url| Url::parse(url).map_err(|_| AppError::BadGateway))
            .transpose()
    }

    fn candidate_endpoint(
        &self,
        service: &Osrm,
        mode: TravelMode,
        base_url: &str,
    ) -> Result<Url, AppError> {
        let base_url = base_url.trim();
        if self.base_url(mode) == Some(base_url) {
            // 旧環境で末尾が // のURLは保存値が / で終わる。保存値には再正規化を適用しない。
            let url = Url::parse(base_url).map_err(|_| AppError::BadGateway)?;
            service.upstream.client(&url)?;
            return Ok(url);
        }
        service.upstream.validate_base_url(base_url)
    }

    fn allowed_endpoint(&self, service: &Osrm, mode: TravelMode) -> Result<Option<Url>, AppError> {
        let endpoint = self.endpoint(mode)?;
        if let Some(url) = endpoint.as_ref() {
            service
                .upstream
                .client(url)
                .map_err(|_| AppError::BadGateway)?;
        }
        Ok(endpoint)
    }

    fn encrypted_key(&self, mode: TravelMode) -> Option<&[u8]> {
        match mode {
            TravelMode::Drive => self.encrypted_drive_key.as_deref(),
            TravelMode::Walk => self.encrypted_walk_key.as_deref(),
        }
    }

    fn api_key(
        &self,
        service: &Osrm,
        mode: TravelMode,
        endpoint: &Url,
    ) -> Result<Option<HeaderValue>, AppError> {
        self.encrypted_key(mode)
            .map(|encrypted| open_key(service, mode, endpoint, encrypted))
            .transpose()
    }

    fn retained_key(
        &self,
        service: &Osrm,
        mode: TravelMode,
        endpoint: &Url,
    ) -> Result<Option<&[u8]>, AppError> {
        let Some(key) = self.encrypted_key(mode) else {
            return Ok(None);
        };
        match self.base_url(mode) {
            Some(current) if current == endpoint.as_str() => Ok(Some(key)),
            // 接続先がDBに未登録の暗号文は、旧環境のURLと一致する場合に取り込める。
            None if open_key(service, mode, endpoint, key).is_ok() => Ok(Some(key)),
            _ => Err(AppError::Validation(
                "接続先を設定するには、APIキーを入力し直すか削除してください。".into(),
            )),
        }
    }

    fn view(&self, service: &Osrm) -> SettingsView {
        let mode_view = |mode| {
            let has_api_key = self.encrypted_key(mode).is_some();
            ModeView {
                base_url: self.base_url(mode).map(str::to_owned),
                has_api_key,
                key_usable: has_api_key
                    && self.endpoint(mode).is_ok_and(|endpoint| {
                        endpoint.is_some_and(|url| {
                            service.upstream.client(&url).is_ok()
                                && self.api_key(service, mode, &url).is_ok()
                        })
                    }),
            }
        };
        SettingsView {
            revision: self.revision.clone(),
            key_storage_configured: service.cipher.is_some(),
            drive: mode_view(TravelMode::Drive),
            walk: mode_view(TravelMode::Walk),
        }
    }
}

fn open_key(
    service: &Osrm,
    mode: TravelMode,
    endpoint: &Url,
    encrypted: &[u8],
) -> Result<HeaderValue, AppError> {
    let cipher = service.cipher.as_ref().ok_or(AppError::BadGateway)?;
    cipher.open(mode, endpoint, encrypted)
}

async fn load_settings(pool: &SqlitePool) -> Result<StoredSettings, AppError> {
    Ok(sqlx::query_as(
        r#"
        SELECT
            revision,
            drive_base_url,
            walk_base_url,
            encrypted_drive_key,
            encrypted_walk_key
        FROM osrm_settings
        WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await?)
}

pub(super) async fn load_endpoint(
    pool: &SqlitePool,
    service: &Osrm,
    mode: TravelMode,
) -> Result<Option<(Url, Option<HeaderValue>)>, AppError> {
    let settings = load_settings(pool).await?;
    let Some(drive) = settings.allowed_endpoint(service, TravelMode::Drive)? else {
        return Ok(None);
    };
    let endpoint = match mode {
        TravelMode::Drive => drive,
        TravelMode::Walk => {
            let Some(walk) = settings.allowed_endpoint(service, TravelMode::Walk)? else {
                return Ok(None);
            };
            walk
        },
    };
    let key = settings.api_key(service, mode, &endpoint)?;
    Ok(Some((endpoint, key)))
}

pub(super) async fn available_modes(
    pool: &SqlitePool,
    service: &Osrm,
) -> Result<Vec<TravelMode>, AppError> {
    let settings = load_settings(pool).await?;
    if !matches!(
        settings.allowed_endpoint(service, TravelMode::Drive),
        Ok(Some(_))
    ) {
        return Ok(Vec::new());
    }
    let mut modes = vec![TravelMode::Drive];
    if matches!(
        settings.allowed_endpoint(service, TravelMode::Walk),
        Ok(Some(_))
    ) {
        modes.push(TravelMode::Walk);
    }
    Ok(modes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    revision: Option<String>,
    key_storage_configured: bool,
    drive: ModeView,
    walk: ModeView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModeView {
    base_url: Option<String>,
    has_api_key: bool,
    key_usable: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum KeyAction {
    Set {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
    Clear {},
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateInput {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    revision: Option<Uuid>,
    drive: Option<ModeInput>,
    walk: Option<ModeInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModeInput {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    base_url: Option<String>,
    key: Option<KeyAction>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CheckInput {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    revision: Option<Uuid>,
    travel_mode: TravelMode,
    base_url: String,
    origin: Coordinate,
    destination: Coordinate,
    key: Option<KeyAction>,
}

fn validate_api_key(value: &str) -> Result<HeaderValue, AppError> {
    let invalid = || AppError::Validation("APIキーの形式を確認してください。".into());
    if value.is_empty()
        || value.len() > 4096
        || value.trim() != value
        || !value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
    {
        return Err(invalid());
    }
    let mut key = HeaderValue::from_str(value).map_err(|_| invalid())?;
    key.set_sensitive(true);
    Ok(key)
}

fn apply_mode_update(
    settings: &mut StoredSettings,
    service: &Osrm,
    mode: TravelMode,
    input: ModeInput,
) -> Result<(), AppError> {
    let (base_url, encrypted_key) = if let Some(base_url) = input.base_url {
        let endpoint = settings.candidate_endpoint(service, mode, &base_url)?;
        let key = match input.key {
            Some(KeyAction::Clear {}) => None,
            Some(KeyAction::Set { api_key }) => {
                let cipher = service.cipher.as_ref().ok_or_else(|| {
                    AppError::Validation(
                        "OSRM用暗号鍵を設定JSONのosrm_encryption_keyまたはOSRM_ENCRYPTION_KEYに設定してください。".into(),
                    )
                })?;
                let key = validate_api_key(&api_key)?;
                Some(cipher.seal(mode, &endpoint, &key)?)
            },
            None => settings
                .retained_key(service, mode, &endpoint)?
                .map(<[u8]>::to_vec),
        };
        (Some(endpoint.to_string()), key)
    } else {
        if matches!(input.key, Some(KeyAction::Set { .. })) {
            return Err(AppError::Validation(
                "APIキーを保存するにはOSRMの接続先が必要です。".into(),
            ));
        }
        (None, None)
    };
    match mode {
        TravelMode::Drive => {
            settings.drive_base_url = base_url;
            settings.encrypted_drive_key = encrypted_key;
        },
        TravelMode::Walk => {
            settings.walk_base_url = base_url;
            settings.encrypted_walk_key = encrypted_key;
        },
    }
    Ok(())
}

pub(crate) async fn osrm_admin_get(
    Extension(account): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<Osrm>>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&account, &pool).await?;
    let settings = load_settings(&pool).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(settings.view(&service)),
    ))
}

pub(crate) async fn osrm_admin_update(
    Extension(account): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<Osrm>>,
    payload: Result<Json<UpdateInput>, JsonRejection>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&account, &pool).await?;
    let Json(input) = payload.map_err(|_| AppError::BadRequest)?;
    let mut settings = load_settings(&pool).await?;
    let revision = input.revision.map(|revision| revision.to_string());
    if revision != settings.revision {
        return Err(AppError::Conflict);
    }
    if input.drive.is_some() || input.walk.is_some() {
        if let Some(drive) = input.drive {
            apply_mode_update(&mut settings, &service, TravelMode::Drive, drive)?;
        }
        if let Some(walk) = input.walk {
            apply_mode_update(&mut settings, &service, TravelMode::Walk, walk)?;
        }
        if let Some(walk) = settings.walk_base_url.as_deref() {
            let drive = settings.drive_base_url.as_deref().ok_or_else(|| {
                AppError::Validation("徒歩を設定するには車の接続先も設定してください。".into())
            })?;
            if drive.trim_end_matches('/') == walk.trim_end_matches('/') {
                return Err(AppError::Validation(
                    "車と徒歩は異なるOSRMの接続先を指定してください。".into(),
                ));
            }
        }
        settings.revision = Some(Uuid::new_v4().to_string());
        let result = sqlx::query(
            r#"
            UPDATE osrm_settings
            SET
                revision = $1,
                drive_base_url = $2,
                walk_base_url = $3,
                encrypted_drive_key = $4,
                encrypted_walk_key = $5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1 AND revision IS $6
            "#,
        )
        .bind(&settings.revision)
        .bind(&settings.drive_base_url)
        .bind(&settings.walk_base_url)
        .bind(&settings.encrypted_drive_key)
        .bind(&settings.encrypted_walk_key)
        .bind(&revision)
        .execute(&pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(AppError::Conflict);
        }
    }
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(settings.view(&service)),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckView {
    route_found: bool,
}

pub(crate) async fn osrm_admin_check(
    Extension(account): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(service): Extension<Arc<Osrm>>,
    local: Option<Extension<LocalRoutingListener>>,
    payload: Result<Json<CheckInput>, JsonRejection>,
) -> Result<impl IntoResponse, AppError> {
    require_superuser(&account, &pool).await?;
    let Json(input) = payload.map_err(|_| AppError::BadRequest)?;
    if !input.origin.valid() || !input.destination.valid() {
        return Err(AppError::BadRequest);
    }
    let settings = load_settings(&pool).await?;
    let revision = input.revision.map(|revision| revision.to_string());
    if revision != settings.revision {
        return Err(AppError::Conflict);
    }
    let mode = input.travel_mode;
    let endpoint = settings.candidate_endpoint(&service, mode, &input.base_url)?;
    let api_key = match input.key {
        Some(KeyAction::Set { api_key }) => Some(validate_api_key(&api_key)?),
        Some(KeyAction::Clear {}) => None,
        None => settings
            .retained_key(&service, mode, &endpoint)?
            .map(|encrypted| {
                open_key(&service, mode, &endpoint, encrypted).map_err(|_| {
                    AppError::Validation(
                        "保存済みのAPIキーを利用できません。APIキーを入力し直してください。".into(),
                    )
                })
            })
            .transpose()?,
    };
    let _permit = service.limits.acquire(account, REQUESTS_PER_MINUTE).await?;
    let route = service
        .fetch_route(
            &endpoint,
            mode,
            &input.origin,
            &input.destination,
            api_key,
            local.map(|Extension(listener)| listener),
        )
        .await
        .map_err(|error| error.into_check_error())?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(CheckView {
            route_found: route.is_some(),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_keys_require_the_same_encryption_key_mode_and_endpoint() {
        let cipher = ApiKeyCipher::from_base64(&STANDARD.encode([7; 32])).unwrap();
        let other_cipher = ApiKeyCipher::from_base64(&STANDARD.encode([8; 32])).unwrap();
        assert!(ApiKeyCipher::from_base64(&STANDARD.encode([7; 31])).is_none());
        let endpoint = Url::parse("https://osrm.example/routed-car").unwrap();
        let other_endpoint = Url::parse("https://osrm.example/routed-foot").unwrap();
        let key = validate_api_key("fixture-key").unwrap();
        let stored = cipher.seal(TravelMode::Drive, &endpoint, &key).unwrap();
        assert_ne!(
            stored,
            cipher.seal(TravelMode::Drive, &endpoint, &key).unwrap()
        );
        let restored = cipher.open(TravelMode::Drive, &endpoint, &stored).unwrap();
        assert_eq!(restored, key);
        assert!(restored.is_sensitive());
        assert!(cipher.open(TravelMode::Walk, &endpoint, &stored).is_err());
        assert!(
            cipher
                .open(TravelMode::Drive, &other_endpoint, &stored)
                .is_err()
        );
        assert!(
            other_cipher
                .open(TravelMode::Drive, &endpoint, &stored)
                .is_err()
        );
        assert!(cipher.open(TravelMode::Drive, &endpoint, b"short").is_err());
    }

    #[test]
    fn keys_must_be_valid_sensitive_header_values() {
        for invalid in [
            "",
            " key",
            "key ",
            "key\nleak",
            "key\tpart",
            "キー",
            &"a".repeat(4097),
        ] {
            assert!(validate_api_key(invalid).is_err());
        }
        assert!(validate_api_key("valid key_+/=").unwrap().is_sensitive());
        assert!(
            serde_json::from_value::<KeyAction>(serde_json::json!({
                "action": "clear",
                "apiKey": "must be rejected"
            }))
            .is_err()
        );
    }

    #[test]
    fn admin_input_requires_revision_even_before_initial_save() {
        assert!(serde_json::from_value::<UpdateInput>(serde_json::json!({})).is_err());
        assert!(
            serde_json::from_value::<UpdateInput>(serde_json::json!({"revision": null})).is_ok()
        );
        let mut check = serde_json::json!({
            "travelMode": "DRIVE",
            "baseUrl": "https://example.com/car",
            "origin": {"lat": 35.68, "lng": 139.76},
            "destination": {"lat": 35.70, "lng": 139.77},
        });
        assert!(serde_json::from_value::<CheckInput>(check.clone()).is_err());
        check["revision"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<CheckInput>(check).is_ok());
    }

    #[test]
    fn migrated_trailing_slash_url_retains_its_key_when_saved_again() {
        let service = Osrm::new(
            super::super::UpstreamPolicy::new(None),
            Some(&STANDARD.encode([7; 32])),
        );
        let old_base_url = "https://example.com/osrm//";
        let endpoint = service.upstream.validate_base_url(old_base_url).unwrap();
        assert_eq!(endpoint.as_str(), "https://example.com/osrm/");
        let stored = service
            .cipher
            .as_ref()
            .unwrap()
            .seal(
                TravelMode::Drive,
                &endpoint,
                &validate_api_key("fixture-key").unwrap(),
            )
            .unwrap();
        let mut settings = StoredSettings {
            revision: Some(Uuid::nil().to_string()),
            drive_base_url: None,
            walk_base_url: None,
            encrypted_drive_key: Some(stored.clone()),
            encrypted_walk_key: None,
        };
        for base_url in [old_base_url, endpoint.as_str()] {
            apply_mode_update(
                &mut settings,
                &service,
                TravelMode::Drive,
                ModeInput {
                    base_url: Some(base_url.to_owned()),
                    key: None,
                },
            )
            .unwrap();
            assert_eq!(settings.drive_base_url.as_deref(), Some(endpoint.as_str()));
            assert_eq!(
                settings.encrypted_drive_key.as_deref(),
                Some(stored.as_slice())
            );
            assert!(settings.view(&service).drive.key_usable);
        }
    }
}
