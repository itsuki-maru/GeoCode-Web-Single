use super::{
    message,
    protocol::{self, Operation, Receipt, Request},
};
use crate::local_tiles::config::LocalTileConfig;
use fs2::FileExt;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub(super) struct Paths {
    pub request: PathBuf,
    pub receipt: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
}
impl Paths {
    pub fn new(root: &Path, id: &str) -> Self {
        Self {
            request: root.join(format!("{id}.request.json")),
            receipt: root.join(format!("{id}.receipt.json")),
            lock: root.join(format!("{id}.lock")),
            log: root.join(format!("{id}.log")),
        }
    }
}
fn namespace(config_path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let path = config_path.canonicalize().map_err(message)?;
    Ok(format!(
        "{:x}",
        Sha256::digest(path.to_string_lossy().as_bytes())
    ))
}
pub(super) fn request_root(
    config: &LocalTileConfig,
    config_path: &Path,
    create: bool,
) -> Result<PathBuf, String> {
    if create {
        fs::create_dir_all(&config.work_path).map_err(message)?;
    }
    let work = if config.work_path.exists() {
        config.work_path.canonicalize().map_err(message)?
    } else {
        config.work_path.clone()
    };
    let mut root = work.clone();
    for component in ["tile-manager".to_owned(), namespace(config_path)?] {
        root.push(component);
        match fs::symlink_metadata(&root) {
            Ok(meta) if protocol::is_link(&meta) || !meta.is_dir() => {
                return Err("管理処理の保存先にリンクや通常ファイルは使用できません。".into());
            },
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create {
                    fs::create_dir(&root).map_err(message)?;
                }
            },
            Err(error) => return Err(error.to_string()),
        }
        if root.exists() {
            if protocol::is_link(&fs::symlink_metadata(&root).map_err(message)?) {
                return Err("管理処理の保存先にリンクは使用できません。".into());
            }
            root = root.canonicalize().map_err(message)?;
            if !root.starts_with(&work) {
                return Err("管理処理の保存先が作業領域の外を指しています。".into());
            }
        }
    }
    Ok(root)
}
pub(super) fn lock_file(path: &Path) -> Result<File, String> {
    if path.exists() && protocol::is_link(&fs::symlink_metadata(path).map_err(message)?) {
        return Err("受付ロックにリンクは使用できません。".into());
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(message)
}
pub(super) fn existing_request(
    config: &LocalTileConfig,
    config_path: &Path,
    id: &str,
    operation: &Operation,
) -> Result<Option<Receipt>, String> {
    let root = request_root(config, config_path, false)?;
    let paths = Paths::new(&root, id);
    if !paths.request.exists() {
        return Ok(None);
    }
    let request: Request = protocol::read_json(&paths.request)?;
    if request.id != id
        || request.config_path != config_path.canonicalize().map_err(message)?
        || serde_json::to_value(&request.operation).map_err(message)?
            != serde_json::to_value(operation).map_err(message)?
    {
        return Err("同じ受付IDに異なる処理条件は指定できません。".into());
    }
    if paths.receipt.exists() {
        Ok(Some(read_receipt(&paths)?))
    } else {
        let mut receipt = Receipt::new(id.into(), operation.name(), paths.log);
        receipt.update("interrupted");
        receipt.error =
            Some("受付記録の保存前に処理が中断されました。同じ受付IDでは再起動しません。".into());
        Ok(Some(receipt))
    }
}

pub(super) fn submit(
    config: &LocalTileConfig,
    config_path: &Path,
    executable: &Path,
    id: String,
    operation: Operation,
) -> Result<Receipt, String> {
    submit_with_spawn(
        config,
        config_path,
        executable,
        id,
        operation,
        Command::spawn,
    )
}

fn submit_with_spawn(
    config: &LocalTileConfig,
    config_path: &Path,
    executable: &Path,
    id: String,
    operation: Operation,
    spawn: impl FnOnce(&mut Command) -> std::io::Result<std::process::Child>,
) -> Result<Receipt, String> {
    protocol::absolute(config_path)?;
    protocol::absolute(executable)?;
    let root = request_root(config, config_path, true)?;
    let submission_lock = lock_file(&root.join("submission.lock"))?;
    submission_lock
        .try_lock_exclusive()
        .map_err(|_| "別の画面が処理を受け付けています。再度確認してください。")?;
    if let Some(receipt) = existing_request(config, config_path, &id, &operation)? {
        return Ok(receipt);
    }
    if list_receipts(config, config_path)?
        .iter()
        .any(|receipt| receipt["state"].as_str().is_some_and(active))
    {
        return Err("別の生成処理を受付・実行中です。完了後に開始してください。".into());
    }
    let paths = Paths::new(&root, &id);
    let lock = lock_file(&paths.lock)?;
    lock.try_lock_exclusive()
        .map_err(|_| "同じ受付IDを別の処理が使用しています。")?;
    let config_path = config_path.canonicalize().map_err(message)?;
    let executable = executable.canonicalize().map_err(message)?;
    let request = Request {
        version: 1,
        id: id.clone(),
        config_sha256: protocol::file_hash(&config_path)?,
        config_path,
        executable_sha256: protocol::file_hash(&executable)?,
        executable: executable.clone(),
        operation,
    };
    let mut receipt = Receipt::new(id.clone(), request.operation.name(), paths.log.clone());
    protocol::atomic_json(&paths.request, &request)?;
    receipt.request_sha256 = protocol::file_hash(&paths.request)?;
    protocol::atomic_json(&paths.receipt, &receipt)?;
    let index_path = root.join("requests.json");
    let mut index: Vec<String> = if index_path.exists() {
        protocol::read_json(&index_path)?
    } else {
        Vec::new()
    };
    index.retain(|saved| saved != &id);
    index.insert(0, id);
    index.truncate(200);
    protocol::atomic_json(&index_path, &index)?;
    let log = OpenOptions::new()
        .create_new(true)
        .append(true)
        .open(&paths.log)
        .map_err(message)?;
    let mut command = Command::new(executable);
    command
        .args(["local-tiles", "worker", "--request"])
        .arg(&paths.request)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(message)?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW（debug版のconsoleも作らない）
    }
    match spawn(&mut command) {
        Ok(mut child) => {
            receipt.worker_pid = Some(child.id());
            protocol::atomic_json(&paths.receipt, &receipt)?;
            let receipt_path = paths.receipt.clone();
            let lock_path = paths.lock.clone();
            // 所有ハンドルを回収するだけ。画面終了時にkill・取消は行わない。
            std::thread::spawn(move || {
                let result = child.wait();
                if let Ok(lock) = lock_file(&lock_path) {
                    if lock.try_lock_exclusive().is_ok() {
                        if let Ok(mut receipt) = protocol::read_json::<Receipt>(&receipt_path) {
                            if active(&receipt.state) {
                                receipt.update("interrupted");
                                receipt.error = Some(format!(
                                    "生成プロセスが終了しました: {result:?}。ログを確認してください。"
                                ));
                                let _ = protocol::atomic_json(&receipt_path, &receipt);
                            }
                        }
                    }
                }
            });
        },
        Err(error) => {
            receipt.update("failed");
            receipt.error = Some(format!("生成プロセスを起動できません: {error}"));
            protocol::atomic_json(&paths.receipt, &receipt)?;
        },
    }
    drop(lock);
    drop(submission_lock);
    Ok(receipt)
}

pub(super) fn active(state: &str) -> bool {
    matches!(state, "starting" | "running" | "accepted")
}
fn read_receipt(paths: &Paths) -> Result<Receipt, String> {
    let mut receipt: Receipt = protocol::read_json(&paths.receipt)?;
    if !active(&receipt.state) {
        return Ok(receipt);
    }
    let lock = match fs::symlink_metadata(&paths.lock) {
        Ok(meta) => {
            if protocol::is_link(&meta) || !meta.is_file() {
                return Err("受付ロックの形式が不正です。".into());
            }
            Some(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&paths.lock)
                    .map_err(message)?,
            )
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(message(error)),
    };
    let available = match &lock {
        Some(file) => file.try_lock_exclusive().is_ok(),
        None => true,
    };
    if available {
        receipt = protocol::read_json(&paths.receipt)?;
        let age = chrono::DateTime::parse_from_rfc3339(&receipt.updated_at)
            .ok()
            .map(|updated| {
                chrono::Utc::now()
                    .signed_duration_since(updated)
                    .num_seconds()
            })
            .unwrap_or(0);
        if active(&receipt.state) && (lock.is_none() || receipt.state != "starting" || age > 30) {
            receipt.update("interrupted");
            receipt.error =
                Some("生成プロセスの所有権がありません。中断状態とログを確認してください。".into());
        }
    }
    Ok(receipt)
}
pub(super) fn read_log(
    config: &LocalTileConfig,
    config_path: &Path,
    id: &str,
) -> Result<Value, String> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| "受付IDはUUIDで指定してください。")?
        .to_string();
    let root = request_root(config, config_path, false)?;
    let paths = Paths::new(&root, &id);
    let request: Request = protocol::read_json(&paths.request)?;
    if request.id != id || request.config_path != config_path.canonicalize().map_err(message)? {
        return Err("この設定の受付ログではありません。".into());
    }
    let meta = fs::symlink_metadata(&paths.log).map_err(message)?;
    if !meta.is_file() || protocol::is_link(&meta) {
        return Err("ログファイルの形式が不正です。".into());
    }
    const LIMIT: u64 = 64 * 1024;
    let start = meta.len().saturating_sub(LIMIT);
    let mut file = File::open(&paths.log).map_err(message)?;
    file.seek(SeekFrom::Start(start)).map_err(message)?;
    let mut bytes = Vec::new();
    file.take(LIMIT).read_to_end(&mut bytes).map_err(message)?;
    Ok(
        serde_json::json!({"text":String::from_utf8_lossy(&bytes),"truncated":start>0,"path":paths.log}),
    )
}
pub(super) fn list_receipts(
    config: &LocalTileConfig,
    config_path: &Path,
) -> Result<Vec<Value>, String> {
    let root = request_root(config, config_path, false)?;
    let index = root.join("requests.json");
    if !index.exists() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = protocol::read_json(&index)?;
    if ids.len() > 200 {
        return Err("管理受付一覧が上限を超えています。".into());
    }
    let mut values = Vec::new();
    for id in ids {
        if uuid::Uuid::parse_str(&id)
            .map(|value| value.to_string())
            .ok()
            .as_deref()
            != Some(&id)
        {
            return Err("管理受付IDが不正です。".into());
        }
        let paths = Paths::new(&root, &id);
        let receipt = read_receipt(&paths)?;
        if receipt.id != id {
            return Err("受付結果のIDが一致しません。".into());
        }
        values.push(serde_json::to_value(receipt).map_err(message)?);
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_receipts_atomically_and_reject_mismatched_duplicate_requests() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("receipt.json");
        let mut receipt = Receipt::new(
            uuid::Uuid::new_v4().to_string(),
            "prepare",
            root.path().join("log"),
        );
        protocol::atomic_json(&path, &receipt).unwrap();
        receipt.update("succeeded");
        protocol::atomic_json(&path, &receipt).unwrap();
        assert_eq!(
            protocol::read_json::<Receipt>(&path).unwrap().state,
            "succeeded"
        );
        let operation = Operation::parse(
            "register",
            serde_json::json!({"database":root.path().join("map.sqlite"),"name":"試験"}),
            &receipt.id,
        )
        .unwrap();
        assert_eq!(operation.name(), "register");
        assert!(
            Operation::parse(
                "register",
                serde_json::json!({"database":"relative.sqlite","name":"試験"}),
                &receipt.id
            )
            .is_err()
        );
    }
    #[test]
    fn persist_spawn_failures_and_uuid_retries_and_restrict_log_reads() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("設定.json");
        fs::write(&config_path, b"{}").unwrap();
        let config = LocalTileConfig::defaults(root.path());
        let executable = std::env::current_exe().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let op =
            Operation::parse("prepare", serde_json::json!({"dataset":"dataset"}), &id).unwrap();
        // 不正なexeを実際に起動するとWindowsが16bit互換性の警告を表示する。
        // 起動失敗だけを注入し、受付の永続化・再送・ログ検査は実経路で確認する。
        let mut spawn_attempts = 0;
        let receipt = submit_with_spawn(
            &config,
            &config_path,
            &executable,
            id.clone(),
            op.clone(),
            |_| {
                spawn_attempts += 1;
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "simulated worker spawn failure",
                ))
            },
        )
        .unwrap();
        assert_eq!(receipt.state, "failed");
        assert_eq!(spawn_attempts, 1);
        assert!(receipt.worker_pid.is_none());
        assert!(
            receipt
                .error
                .as_deref()
                .unwrap()
                .contains("simulated worker spawn failure")
        );
        let replay = submit_with_spawn(&config, &config_path, &executable, id.clone(), op, |_| {
            panic!("the same request must not spawn another worker");
        })
        .unwrap();
        assert_eq!(replay.created_at, receipt.created_at);
        assert_eq!(replay.state, "failed");
        assert_eq!(replay.error, receipt.error);
        let different =
            Operation::parse("prepare", serde_json::json!({"dataset":"different"}), &id).unwrap();
        assert!(existing_request(&config, &config_path, &id, &different).is_err());
        let mut bytes = vec![b'a'; 100 * 1024];
        bytes.extend_from_slice("診断の末尾\n".as_bytes());
        fs::write(&receipt.log_path, bytes).unwrap();
        let log = read_log(&config, &config_path, &id).unwrap();
        assert_eq!(log["truncated"], true);
        assert!(log["text"].as_str().unwrap().ends_with("診断の末尾\n"));
        assert!(log["text"].as_str().unwrap().len() <= 64 * 1024);
        assert!(read_log(&config, &config_path, "../設定.json").is_err());
    }
    #[test]
    fn poll_without_creating_lock_files_and_mark_orphaned_requests_interrupted() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("settings.json");
        fs::write(&config_path, b"{}").unwrap();
        let config = LocalTileConfig::defaults(root.path());
        let directory = request_root(&config, &config_path, true).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let paths = Paths::new(&directory, &id);
        let mut receipt = Receipt::new(id.clone(), "precompute", paths.log.clone());
        receipt.update("running");
        protocol::atomic_json(&paths.receipt, &receipt).unwrap();
        protocol::atomic_json(&directory.join("requests.json"), &vec![id]).unwrap();
        let values = list_receipts(&config, &config_path).unwrap();
        assert_eq!(values[0]["state"], "interrupted");
        assert!(!paths.lock.exists());
        // 表示用overlayなので永続receiptは変更しない。
        assert_eq!(
            protocol::read_json::<Receipt>(&paths.receipt)
                .unwrap()
                .state,
            "running"
        );
    }
    #[test]
    #[cfg_attr(
        windows,
        ignore = "Windowsのシンボリックリンク作成権限が必要。権限のある環境で--ignoredを指定して実行する"
    )]
    fn reject_symlinked_manager_ancestors_before_creation() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("settings.json");
        fs::write(&config_path, b"{}").unwrap();
        let config = LocalTileConfig::defaults(root.path());
        fs::create_dir_all(&config.work_path).unwrap();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        #[cfg(windows)]
        let result =
            std::os::windows::fs::symlink_dir(&outside, config.work_path.join("tile-manager"));
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(&outside, config.work_path.join("tile-manager"));
        result.expect("this test requires filesystem support and permission to create symlinks");
        assert!(request_root(&config, &config_path, true).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }
}
