//! AI接続設定。鍵は専用の配備鍵で暗号化し、取得APIへ原文を返さない。
use crate::error::AppError;
use axum::http::HeaderValue;
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, types::Json};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    pub enabled: bool,
    pub write_enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub speech_enabled: bool,
    pub speech_base_url: String,
    pub speech_model: String,
    pub timeout_seconds: u64,
    pub max_output_tokens: u32,
    pub max_requests_per_minute: usize,
}
impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            write_enabled: false,
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: String::new(),
            speech_enabled: false,
            speech_base_url: "https://api.openai.com/v1".into(),
            speech_model: String::new(),
            timeout_seconds: 60,
            max_output_tokens: 2048,
            max_requests_per_minute: 20,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
    pub revision: Option<Uuid>,
    #[serde(flatten)]
    pub config: AiConfig,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    pub speech_api_key: Option<String>,
    #[serde(default)]
    pub clear_speech_api_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsView {
    pub revision: Option<Uuid>,
    #[serde(flatten)]
    pub config: AiConfig,
    pub has_api_key: bool,
    pub has_speech_api_key: bool,
    pub key_storage_configured: bool,
}

pub struct AiSettings {
    pub revision: Option<Uuid>,
    pub config: AiConfig,
    pub api_key: Option<HeaderValue>,
    pub speech_api_key: Option<HeaderValue>,
}

#[derive(sqlx::FromRow)]
struct StoredSettings {
    revision: String,
    config: Json<AiConfig>,
    encrypted_api_key: Option<Vec<u8>>,
    encrypted_speech_api_key: Option<Vec<u8>>,
}
const SELECT: &str = r#"
    SELECT
        revision,
        config,
        encrypted_api_key,
        encrypted_speech_api_key
    FROM ai_settings
    WHERE id = 1
"#;

pub fn invalid(message: &str) -> AppError {
    AppError::Validation(message.to_owned())
}

fn cipher() -> Result<LessSafeKey, AppError> {
    let raw = std::env::var("AI_ENCRYPTION_KEY")
        .map_err(|_| invalid("AI設定の鍵保存にはAI_ENCRYPTION_KEYが必要です。"))?;
    cipher_from_base64(&raw)
}
fn cipher_from_base64(raw: &str) -> Result<LessSafeKey, AppError> {
    let bytes = STANDARD
        .decode(raw.trim())
        .map_err(|_| invalid("AI設定の暗号鍵は32バイトをBase64で指定してください。"))?;
    UnboundKey::new(&AES_256_GCM, &bytes)
        .map(LessSafeKey::new)
        .map_err(|_| invalid("AI設定の暗号鍵は32バイトをBase64で指定してください。"))
}
fn aad(config: &AiConfig, speech: bool) -> String {
    if speech {
        format!("geocode-ai:speech:{}", config.speech_base_url)
    } else {
        format!("geocode-ai:{}:{}", config.provider, config.base_url)
    }
}
fn seal(
    config: &AiConfig,
    speech: bool,
    key: Option<&HeaderValue>,
) -> Result<Option<Vec<u8>>, AppError> {
    let Some(key) = key else { return Ok(None) };
    let cipher = cipher()?;
    seal_with_cipher(&cipher, config, speech, key).map(Some)
}
fn seal_with_cipher(
    cipher: &LessSafeKey,
    config: &AiConfig,
    speech: bool,
    key: &HeaderValue,
) -> Result<Vec<u8>, AppError> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| AppError::InternalServerError)?;
    let mut body = key.as_bytes().to_vec();
    cipher
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad(config, speech).as_bytes()),
            &mut body,
        )
        .map_err(|_| AppError::InternalServerError)?;
    let mut stored = nonce.to_vec();
    stored.extend(body);
    Ok(stored)
}
fn open(
    config: &AiConfig,
    speech: bool,
    stored: Option<&[u8]>,
) -> Result<Option<HeaderValue>, AppError> {
    let Some(stored) = stored else {
        return Ok(None);
    };
    open_with_cipher(&cipher()?, config, speech, stored).map(Some)
}
fn open_with_cipher(
    cipher: &LessSafeKey,
    config: &AiConfig,
    speech: bool,
    stored: &[u8],
) -> Result<HeaderValue, AppError> {
    let (nonce, encrypted) = stored
        .split_first_chunk::<NONCE_LEN>()
        .ok_or(AppError::InternalServerError)?;
    let mut bytes = encrypted.to_vec();
    let clear = cipher
        .open_in_place(
            Nonce::assume_unique_for_key(*nonce),
            Aad::from(aad(config, speech).as_bytes()),
            &mut bytes,
        )
        .map_err(|_| {
            invalid("AI設定のAPIキーを復号できません。配備側の暗号鍵を確認してください。")
        })?;
    let mut key = HeaderValue::from_bytes(clear).map_err(|_| AppError::InternalServerError)?;
    key.set_sensitive(true);
    Ok(key)
}
pub fn validate_key(value: &str) -> Result<HeaderValue, AppError> {
    if value.is_empty()
        || value.len() > 4096
        || value.trim() != value
        || value.bytes().any(|b| !(b' '..=b'~').contains(&b))
    {
        return Err(invalid("APIキーに使用できない文字が含まれています。"));
    }
    let mut key = HeaderValue::from_str(value).map_err(|_| invalid("APIキーが不正です。"))?;
    key.set_sensitive(true);
    Ok(key)
}
fn validate_model(model: &str) -> Result<(), AppError> {
    if model.len() > 200
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
    {
        return Err(invalid(
            "モデル名は英数字と - _ . : / で200文字以内にしてください。",
        ));
    }
    Ok(())
}
pub fn validate_config(config: &AiConfig) -> Result<(), AppError> {
    if !matches!(config.provider.as_str(), "openai" | "anthropic" | "gemini") {
        return Err(invalid("対応するLLM接続方式を選択してください。"));
    }
    if !(5..=120).contains(&config.timeout_seconds)
        || !(128..=8192).contains(&config.max_output_tokens)
        || !(1..=60).contains(&config.max_requests_per_minute)
    {
        return Err(invalid("AIの時間・出力・実行回数の制限が範囲外です。"));
    }
    validate_model(&config.model)?;
    validate_model(&config.speech_model)?;
    if !config.base_url.is_empty() {
        super::provider::validate_base_url(&config.base_url)?;
    }
    if !config.speech_base_url.is_empty() {
        super::provider::validate_base_url(&config.speech_base_url)?;
    }
    if config.enabled && (config.base_url.is_empty() || config.model.is_empty()) {
        return Err(invalid(
            "AIを有効にするには接続先とモデルを指定してください。",
        ));
    }
    if config.speech_enabled
        && (config.speech_base_url.is_empty() || config.speech_model.is_empty())
    {
        return Err(invalid(
            "音声入力には音声認識の接続先とモデルを指定してください。",
        ));
    }
    Ok(())
}
impl AiSettings {
    pub fn view(&self) -> AiSettingsView {
        AiSettingsView {
            revision: self.revision,
            config: self.config.clone(),
            has_api_key: self.api_key.is_some(),
            has_speech_api_key: self.speech_api_key.is_some(),
            key_storage_configured: cipher().is_ok(),
        }
    }
    pub fn require_enabled(&self) -> Result<(), AppError> {
        if self.config.enabled {
            Ok(())
        } else {
            Err(AppError::Forbidden(
                "AI機能は管理者により無効になっています。".into(),
            ))
        }
    }
}
fn stored_revision(raw: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(raw).map_err(|_| AppError::InternalServerError)
}

pub async fn load(pool: &SqlitePool) -> Result<AiSettings, AppError> {
    let row = sqlx::query_as::<_, StoredSettings>(SELECT)
        .fetch_optional(pool)
        .await?;
    match row {
        Some(row) => Ok(AiSettings {
            revision: Some(stored_revision(&row.revision)?),
            api_key: open(&row.config.0, false, row.encrypted_api_key.as_deref())?,
            speech_api_key: open(&row.config.0, true, row.encrypted_speech_api_key.as_deref())?,
            config: row.config.0,
        }),
        None => Ok(AiSettings {
            revision: None,
            config: AiConfig::default(),
            api_key: None,
            speech_api_key: None,
        }),
    }
}

/// キーを必要としない読み取り処理は暗号文を取得・復号しない。
pub(crate) async fn load_config(pool: &SqlitePool) -> Result<(Option<Uuid>, AiConfig), AppError> {
    let row: Option<(String, Json<AiConfig>)> =
        sqlx::query_as("SELECT revision, config FROM ai_settings WHERE id=1")
            .fetch_optional(pool)
            .await?;
    match row {
        Some((revision, config)) => Ok((Some(stored_revision(&revision)?), config.0)),
        None => Ok((None, AiConfig::default())),
    }
}
fn resolve_key(
    input: Option<&str>,
    clear: bool,
    same: bool,
    previous: Option<&HeaderValue>,
) -> Result<Option<HeaderValue>, AppError> {
    if clear && input.is_some() {
        return Err(invalid("APIキーの置換と削除を同時に指定できません。"));
    }
    if clear {
        Ok(None)
    } else if let Some(raw) = input {
        Ok(Some(validate_key(raw)?))
    } else if same {
        Ok(previous.cloned())
    } else {
        Ok(None)
    }
}
pub async fn candidate(pool: &SqlitePool, input: &AiSettingsInput) -> Result<AiSettings, AppError> {
    validate_config(&input.config)?;
    let previous = load(pool).await?;
    if previous.revision != input.revision {
        return Err(AppError::Conflict);
    }
    let api_key = resolve_key(
        input.api_key.as_deref(),
        input.clear_api_key,
        previous.config.provider == input.config.provider
            && previous.config.base_url == input.config.base_url,
        previous.api_key.as_ref(),
    )?;
    let speech_api_key = resolve_key(
        input.speech_api_key.as_deref(),
        input.clear_speech_api_key,
        previous.config.speech_base_url == input.config.speech_base_url,
        previous.speech_api_key.as_ref(),
    )?;
    let next = AiSettings {
        revision: previous.revision,
        config: input.config.clone(),
        api_key,
        speech_api_key,
    };
    if next.config.enabled {
        validate_connection(&next, false)?;
    }
    if next.config.enabled && next.config.speech_enabled {
        validate_connection(&next, true)?;
    }
    Ok(next)
}
pub fn validate_connection(settings: &AiSettings, speech: bool) -> Result<(), AppError> {
    let (base, model, key) = if speech {
        (
            &settings.config.speech_base_url,
            &settings.config.speech_model,
            &settings.speech_api_key,
        )
    } else {
        (
            &settings.config.base_url,
            &settings.config.model,
            &settings.api_key,
        )
    };
    if model.is_empty() {
        return Err(invalid("接続に使うモデルを入力してください。"));
    }
    let url = super::provider::validate_base_url(base)?;
    if key.is_none()
        && (!super::provider::is_explicitly_allowed(&url)
            || (!speech && settings.config.provider != "openai"))
    {
        return Err(invalid(
            "この接続先にはAPIキーが必要です。キーなしのOpenAI互換接続は配備側で許可した接続先だけ利用できます。",
        ));
    }
    Ok(())
}
pub async fn save(
    pool: &SqlitePool,
    user: &str,
    auth_version: i64,
    input: &AiSettingsInput,
) -> Result<AiSettingsView, AppError> {
    let next = candidate(pool, input).await?;
    let encrypted = seal(&next.config, false, next.api_key.as_ref())?;
    let encrypted_speech = seal(&next.config, true, next.speech_api_key.as_ref())?;
    let revision = Uuid::new_v4();
    // 初回保存も含め、リビジョンの確認から書き込みまでを直列化する。
    // 遅延トランザクションの読み取り後の昇格によるロック競合も避ける。
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    // 書き込み待ちの間に利用者や権限が失効しても、古い認証で設定を変更させない。
    let actor: Option<(i64, bool, bool)> =
        sqlx::query_as("SELECT auth_version,is_locked,is_superuser FROM user_model WHERE id=$1")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((current_auth_version, locked, superuser)) = actor else {
        return Err(AppError::Unauthorized("再ログインしてください。".into()));
    };
    if locked || current_auth_version != auth_version {
        return Err(AppError::Unauthorized("再ログインしてください。".into()));
    }
    if !superuser {
        return Err(AppError::Forbidden(
            "Administrator privileges are required.".into(),
        ));
    }
    let stored: Option<String> = sqlx::query_scalar("SELECT revision FROM ai_settings WHERE id=1")
        .fetch_optional(&mut *tx)
        .await?;
    let current = stored.as_deref().map(stored_revision).transpose()?;
    if current != input.revision {
        return Err(AppError::Conflict);
    }
    sqlx::query(
        r#"
        INSERT INTO ai_settings (
            id,
            revision,
            config,
            encrypted_api_key,
            encrypted_speech_api_key,
            updated_by
        ) VALUES (
            1,
            $1,
            $2,
            $3,
            $4,
            $5
        )
        ON CONFLICT (id) DO UPDATE SET
            revision = EXCLUDED.revision,
            config = EXCLUDED.config,
            encrypted_api_key = EXCLUDED.encrypted_api_key,
            encrypted_speech_api_key = EXCLUDED.encrypted_speech_api_key,
            updated_by = EXCLUDED.updated_by,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(revision.to_string())
    .bind(Json(&next.config))
    .bind(encrypted)
    .bind(encrypted_speech)
    .bind(user)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(AiSettings {
        revision: Some(revision),
        ..next
    }
    .view())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encryption_binds_keys_to_the_connection_and_rejects_tampering() {
        let cipher = cipher_from_base64(&STANDARD.encode([7u8; 32])).unwrap();
        let mut config = AiConfig::default();
        let key = validate_key("only-for-this-endpoint").unwrap();
        let encrypted = seal_with_cipher(&cipher, &config, false, &key).unwrap();
        assert!(
            !encrypted
                .windows(key.as_bytes().len())
                .any(|bytes| bytes == key.as_bytes())
        );
        assert_eq!(
            open_with_cipher(&cipher, &config, false, &encrypted).unwrap(),
            key
        );
        assert!(open_with_cipher(&cipher, &config, true, &encrypted).is_err());
        config.base_url = "https://different.example/v1".into();
        assert!(open_with_cipher(&cipher, &config, false, &encrypted).is_err());
        config = AiConfig::default();
        let mut corrupt = encrypted;
        corrupt[NONCE_LEN] ^= 1;
        assert!(open_with_cipher(&cipher, &config, false, &corrupt).is_err());
    }
    #[test]
    fn administration_input_keeps_secret_operations_separate_from_config() {
        let input:AiSettingsInput=serde_json::from_value(serde_json::json!({"revision":null,"enabled":false,"provider":"gemini","model":"test","apiKey":"test-secret","speechEnabled":false,"clearSpeechApiKey":true})).unwrap();
        assert_eq!(input.config.provider, "gemini");
        assert_eq!(input.api_key.as_deref(), Some("test-secret"));
        assert!(input.clear_speech_api_key);
        assert_eq!(input.config.timeout_seconds, 60);
        assert!(
            !serde_json::to_string(&input.config)
                .unwrap()
                .contains("test-secret")
        );
    }
    #[test]
    fn keys_are_not_retained_for_a_different_connection() {
        let key = validate_key("secret").unwrap();
        assert!(
            resolve_key(None, false, false, Some(&key))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            resolve_key(None, false, true, Some(&key)).unwrap().unwrap(),
            key
        );
        assert!(resolve_key(Some("other"), true, true, Some(&key)).is_err());
    }
    #[test]
    fn defaults_are_disabled_and_secrets_are_rejected_as_headers() {
        assert!(!AiConfig::default().enabled);
        assert!(validate_key("key\r\nX:bad").is_err());
        assert!(validate_key(" key").is_err());
        assert!(validate_key("secret").unwrap().is_sensitive());
    }
    #[test]
    fn settings_serialization_never_contains_keys() {
        let s = AiSettings {
            revision: None,
            config: AiConfig::default(),
            api_key: Some(validate_key("hidden-secret").unwrap()),
            speech_api_key: None,
        };
        let raw = serde_json::to_string(&s.view()).unwrap();
        assert!(!raw.contains("hidden-secret"));
        assert!(raw.contains("hasApiKey"));
    }
}
