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
