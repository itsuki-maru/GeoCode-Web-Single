//! AI用配備鍵の補完。既存暗号文がある場合は鍵の再生成を禁止する。
use super::EnvJsonReadError;
use crate::model::AiEncryptionKey;
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use rusqlite::{Connection, OpenFlags};
use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};
use std::{ffi::OsStr, str::FromStr, time::Duration};

const INSPECTION_FAILED: &str =
    "既存DBのAI設定を確認できません。設定JSONとDBを確認してから再起動してください。";
const RESTORE_REQUIRED: &str = "保存済みAPIキーがありますがAI用暗号鍵がありません。元のai_encryption_keyまたはAI_ENCRYPTION_KEYを復元してください。";

pub(super) fn complete(
    stored: Option<AiEncryptionKey>,
    inherited: Option<&OsStr>,
    database_url: &str,
) -> Result<AiEncryptionKey, EnvJsonReadError> {
    // 明示された環境変数は、JSON側の鍵が存在する場合も検証する。
    let inherited = inherited
        .map(|raw| {
            raw.to_str()
                .ok_or(AiEncryptionKey::INVALID_MESSAGE)
                .and_then(|raw| AiEncryptionKey::new(raw.to_owned()))
                .map_err(|message| EnvJsonReadError::InvalidJson(message.into()))
        })
        .transpose()?;
    if let Some(stored) = stored {
        return Ok(stored);
    }
    if let Some(inherited) = inherited {
        return Ok(inherited);
    }
    if has_encrypted_keys(database_url)? {
        return Err(EnvJsonReadError::InvalidJson(RESTORE_REQUIRED.into()));
    }
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| EnvJsonReadError::Io("AI用暗号鍵を生成できません。".into()))?;
    AiEncryptionKey::new(STANDARD.encode(bytes))
        .map_err(|message| EnvJsonReadError::InvalidJson(message.into()))
}

fn inspection_failed(_: impl std::fmt::Display) -> EnvJsonReadError {
    // URL、パス、SQLエラーや保存された値はログ・画面へ渡さない。
    EnvJsonReadError::InvalidJson(INSPECTION_FAILED.into())
}

fn has_encrypted_keys(database_url: &str) -> Result<bool, EnvJsonReadError> {
    let options = SqliteConnectOptions::from_str(database_url).map_err(inspection_failed)?;
    let probe_url = options.clone().filename("ai-key-mode-probe").to_url_lossy();
    let memory = probe_url
        .query_pairs()
        .any(|(key, value)| key == "mode" && value == "memory");
    if memory {
        return Ok(false);
    }
    // SQLite URIや独自VFSはOSパスと接続対象が一致するとは限らない。
    // 「DBなし」と誤判定して鍵を再生成する代わりに、明示鍵の復元を求める。
    if probe_url.query_pairs().any(|(key, _)| key == "vfs")
        || options
            .get_filename()
            .to_string_lossy()
            .starts_with("file:")
    {
        return Err(inspection_failed("unsupported database path"));
    }
    match std::fs::metadata(options.get_filename()) {
        Ok(metadata) if metadata.is_file() => {},
        Ok(_) => return Err(inspection_failed("not a file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(inspection_failed(error)),
    }
    // 接続先はSQLxが解釈したファイル名を使用する。DBの新規作成やmigrationは行わない。
    let database = Connection::open_with_flags(
        options.get_filename(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(inspection_failed)?;
    database
        .busy_timeout(Duration::from_secs(5))
        .map_err(inspection_failed)?;
    let table_exists: bool = database
        .query_row(
            r#"
                SELECT EXISTS (
                    SELECT 1 FROM sqlite_schema
                    WHERE type = 'table' AND name = 'ai_settings'
                )
            "#,
            [],
            |row| row.get(0),
        )
        .map_err(inspection_failed)?;
    if !table_exists {
        return Ok(false);
    }
    database
        .query_row(
            r#"
                SELECT EXISTS (
                    SELECT 1 FROM ai_settings
                    WHERE encrypted_api_key IS NOT NULL
                       OR encrypted_speech_api_key IS NOT NULL
                )
            "#,
            [],
            |row| row.get(0),
        )
        .map_err(inspection_failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> AiEncryptionKey {
        AiEncryptionKey::new(STANDARD.encode([byte; 32])).unwrap()
    }

    fn database(directory: &std::path::Path) -> (String, Connection) {
        let path = directory.join("ai-settings.sqlite");
        let url = file_url(&path);
        (url, Connection::open(path).unwrap())
    }

    fn file_url(path: &std::path::Path) -> String {
        format!(
            "sqlite:{}",
            path.to_string_lossy()
                .replace('%', "%25")
                .replace('?', "%3F")
                .replace('#', "%23")
        )
    }

    #[test]
    fn new_key_has_valid_size_and_secret_debug_is_redacted() {
        let generated = complete(None, None, "sqlite::memory:").unwrap();
        assert_eq!(STANDARD.decode(generated.as_ref()).unwrap().len(), 32);
        assert!(!format!("{generated:?}").contains(generated.as_ref()));
        assert_eq!(
            serde_json::to_value(&generated).unwrap(),
            generated.as_ref()
        );
    }

    #[test]
    fn inherited_key_is_adopted_but_does_not_replace_json_and_invalid_is_rejected() {
        let stored = key(1);
        let inherited = key(2);
        // 既存鍵があればDBを開かず、環境側が異なってもJSON鍵は保持する。
        assert_eq!(
            complete(
                Some(stored.clone()),
                Some(OsStr::new(inherited.as_ref())),
                "invalid-url"
            )
            .unwrap(),
            stored
        );
        assert_eq!(
            complete(None, Some(OsStr::new(inherited.as_ref())), "invalid-url").unwrap(),
            inherited
        );
        for raw in ["", " ", "not-a-base64-secret", &STANDARD.encode([0; 31])] {
            let error =
                complete(Some(key(1)), Some(OsStr::new(raw)), "sqlite::memory:").unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                    "設定ファイルのJSONが不正です: {}",
                    AiEncryptionKey::INVALID_MESSAGE
                )
            );
        }
        let padded = format!(" {}\n", key(3).as_ref());
        assert_eq!(
            complete(None, Some(OsStr::new(&padded)), "sqlite::memory:")
                .unwrap()
                .as_ref(),
            padded
        );
    }

    #[test]
    fn existing_encrypted_keys_require_restoration_without_changing_database() {
        let directory = tempfile::tempdir().unwrap();
        let (url, database) = database(directory.path());
        database
            .execute_batch(
                "CREATE TABLE ai_settings (encrypted_api_key BLOB, encrypted_speech_api_key BLOB)",
            )
            .unwrap();
        // 空テーブル・NULLのみは生成可能。
        assert!(complete(None, None, &url).is_ok());
        database
            .execute("INSERT INTO ai_settings VALUES (NULL, NULL)", [])
            .unwrap();
        assert!(complete(None, None, &url).is_ok());
        for column in ["encrypted_api_key", "encrypted_speech_api_key"] {
            database
                .execute(&format!("UPDATE ai_settings SET {column} = X'010203'"), [])
                .unwrap();
            let before = std::fs::read(directory.path().join("ai-settings.sqlite")).unwrap();
            assert!(
                complete(None, None, &url)
                    .unwrap_err()
                    .to_string()
                    .contains(RESTORE_REQUIRED)
            );
            assert_eq!(
                before,
                std::fs::read(directory.path().join("ai-settings.sqlite")).unwrap()
            );
            database
                .execute(&format!("UPDATE ai_settings SET {column} = NULL"), [])
                .unwrap();
        }
    }

    #[test]
    fn missing_table_is_safe_but_unreadable_schema_or_corruption_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let (url, database) = database(directory.path());
        assert!(complete(None, None, &url).is_ok());
        database
            .execute_batch("CREATE TABLE ai_settings (unexpected TEXT)")
            .unwrap();
        assert!(
            complete(None, None, &url)
                .unwrap_err()
                .to_string()
                .contains(INSPECTION_FAILED)
        );
        drop(database);
        std::fs::write(
            directory.path().join("ai-settings.sqlite"),
            b"private-corrupt-content",
        )
        .unwrap();
        let error = complete(None, None, &url).unwrap_err().to_string();
        assert!(error.contains(INSPECTION_FAILED));
        assert!(!error.contains("private-corrupt-content"));
        assert!(!error.contains(&url));
    }

    #[test]
    fn sqlx_escaped_paths_and_memory_options_do_not_create_or_misidentify_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("AI %23# 設定.sqlite");
        let url = file_url(&path);
        assert!(complete(None, None, &url).is_ok());
        assert!(!path.exists());
        let database = Connection::open(&path).unwrap();
        database.execute_batch("CREATE TABLE ai_settings (encrypted_api_key BLOB, encrypted_speech_api_key BLOB); INSERT INTO ai_settings VALUES (X'01', NULL)").unwrap();
        assert!(
            complete(None, None, &url)
                .unwrap_err()
                .to_string()
                .contains(RESTORE_REQUIRED)
        );
        assert!(complete(None, None, "sqlite://ignored-name?mode=memory&cache=shared").is_ok());
        for url in [
            "sqlite:file:existing.sqlite",
            "sqlite:existing.sqlite?vfs=custom-vfs",
        ] {
            assert!(
                complete(None, None, url)
                    .unwrap_err()
                    .to_string()
                    .contains(INSPECTION_FAILED)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_environment_key_is_rejected() {
        use std::os::unix::ffi::OsStrExt;
        let error =
            complete(None, Some(OsStr::from_bytes(&[0xff])), "sqlite::memory:").unwrap_err();
        assert!(error.to_string().contains(AiEncryptionKey::INVALID_MESSAGE));
    }
}
