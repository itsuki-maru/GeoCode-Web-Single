use crate::error::AppError;
use crate::model::LayerIsMaster;
use sqlx::Pool;
use sqlx::query_as;
use sqlx::sqlite::Sqlite;
use std::collections::HashMap;
use std::hash::Hash;
use std::path::Path;
use tokio::fs;
use tokio::io;

const MIN_PASSWORD_LENGTH: usize = 8;
const MIN_USERNAME_LENGTH: usize = 3;
const MAX_USERNAME_LENGTH: usize = 256;

pub fn validate_password(password: &str) -> Result<(), AppError> {
    if password.chars().count() < MIN_PASSWORD_LENGTH {
        Err(AppError::Validation(format!(
            "Password must be at least {} characters.",
            MIN_PASSWORD_LENGTH
        )))
    } else {
        Ok(())
    }
}

pub fn validate_username(username: &str) -> Result<(), AppError> {
    let username_length = username.chars().count();
    if username_length < MIN_USERNAME_LENGTH {
        return Err(AppError::Validation(format!(
            "Username must be at least {} characters.",
            MIN_USERNAME_LENGTH
        )));
    }

    if username_length > MAX_USERNAME_LENGTH {
        return Err(AppError::Validation(format!(
            "Username must be at most {} characters.",
            MAX_USERNAME_LENGTH
        )));
    }

    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '_' | '-' | '.'))
    {
        return Err(AppError::Validation(
            "Username can contain only letters, numbers, @, _, -, and .".to_string(),
        ));
    }

    Ok(())
}

pub async fn check_ismaster_handler(
    user_id: &String,
    layer_id: &String,
    pool: &Pool<Sqlite>,
) -> bool {
    let result = query_as!(
        LayerIsMaster,
        r#"
        SELECT is_master
        FROM layer_model
        WHERE id = $1 AND user_id = $2
        "#,
        layer_id,
        user_id,
    )
    .fetch_one(&pool.clone())
    .await;

    match result {
        Ok(is_master) => {
            if is_master.is_master {
                true
            } else {
                false
            }
        },
        Err(_) => false,
    }
}

pub async fn ensure_owned_layer(
    pool: &Pool<Sqlite>,
    user_id: &String,
    layer_id: &String,
) -> Result<(), AppError> {
    let owned = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM layer_model WHERE id = $1 AND user_id = $2)",
    )
    .bind(layer_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if owned {
        Ok(())
    } else {
        Err(AppError::BadRequest)
    }
}
pub async fn ensure_dir(path: &Path) -> io::Result<()> {
    match fs::create_dir_all(path).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

pub fn vec_to_hashmap<K, T, F>(vec: Vec<T>, key_fn: F) -> HashMap<K, T>
where
    K: Eq + Hash,
    F: Fn(&T) -> K,
{
    vec.into_iter().map(|item| (key_fn(&item), item)).collect()
}

/// サーバーモード起動時にコンソールを確保する（Windows リリースビルド向け）。
/// リリースビルドでは windows_subsystem="windows" によりコンソールが非表示になるため、
/// 親プロセスのコンソールへのアタッチを試み、失敗した場合は新規割り当てを行う。
#[cfg(windows)]
pub fn ensure_console() {
    use windows::Win32::System::Console::{ATTACH_PARENT_PROCESS, AllocConsole, AttachConsole};
    if !cfg!(debug_assertions) {
        unsafe {
            if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
                AllocConsole().unwrap();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_username;

    #[test]
    fn validate_username_accepts_allowed_characters() {
        assert!(validate_username("User123@_.-").is_ok());
    }

    #[test]
    fn validate_username_rejects_short_username() {
        assert!(validate_username("ab").is_err());
    }

    #[test]
    fn validate_username_rejects_over_length_username() {
        let username = "a".repeat(257);
        assert!(validate_username(&username).is_err());
    }

    #[test]
    fn validate_username_rejects_disallowed_characters() {
        assert!(validate_username("user name").is_err());
        assert!(validate_username("user#name").is_err());
        assert!(validate_username("ユーザー名").is_err());
    }
}
