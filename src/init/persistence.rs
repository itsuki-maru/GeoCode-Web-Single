//! 起動時の設定移行を直列化し、保存中の中断で既存JSONを壊さない。
use fs2::FileExt;
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tempfile::NamedTempFile;

#[cfg(all(test, windows))]
mod windows_acl_tests;

fn regular_file_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "設定の管理ファイルにリンクや通常ファイル以外は使用できません。",
    )
}

pub(super) fn reject_non_regular_file(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let invalid = !metadata.is_file() || metadata.file_type().is_symlink();
            #[cfg(windows)]
            let invalid = {
                use std::os::windows::fs::MetadataExt;
                invalid || metadata.file_attributes() & 0x400 != 0
            };
            if invalid {
                Err(regular_file_error())
            } else {
                Ok(())
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) fn lock_configuration(config_path: &Path) -> io::Result<File> {
    reject_non_regular_file(config_path)?;
    let mut path = config_path.as_os_str().to_os_string();
    path.push(".lock");
    let path = PathBuf::from(path);
    reject_non_regular_file(&path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(path)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => return Ok(lock),
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "別の設定保存処理が実行中です。完了してから再起動してください。",
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            },
            Err(error) => return Err(error),
        }
    }
}

fn temporary_file(destination: &Path, permission_source: &Path) -> io::Result<NamedTempFile> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "設定の保存先が不正です。"))?;
    let temporary = tempfile::Builder::new()
        .prefix(".geocode-settings-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    copy_existing_dacl(permission_source, temporary.path())?;
    #[cfg(not(windows))]
    let _ = permission_source;
    Ok(temporary)
}

#[cfg(windows)]
fn copy_existing_dacl(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Security::{
            Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW},
            DACL_SECURITY_INFORMATION, GetFileSecurityW, GetSecurityDescriptorDacl,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        },
        core::{BOOL, PCWSTR},
    };
    if !source.try_exists()? {
        // 新規設定はユーザー設定ディレクトリのACLを継承する。
        return Ok(());
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut size = 0_u32;
    unsafe {
        let _ = GetFileSecurityW(
            PCWSTR(source.as_ptr()),
            DACL_SECURITY_INFORMATION.0,
            None,
            0,
            &mut size,
        );
    }
    if size == 0 || size > 1_048_576 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "設定ファイルのアクセス権を確認できません。",
        ));
    }
    // Win32のセキュリティ記述子に必要なアラインメントを確保する。
    let mut storage = vec![0_usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    let descriptor = PSECURITY_DESCRIPTOR(storage.as_mut_ptr().cast());
    unsafe {
        GetFileSecurityW(
            PCWSTR(source.as_ptr()),
            DACL_SECURITY_INFORMATION.0,
            Some(descriptor),
            size,
            &mut size,
        )
        .ok()
        .map_err(io::Error::other)?;
        let mut present = BOOL(0);
        let mut defaulted = BOOL(0);
        let mut dacl = std::ptr::null_mut();
        GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            .map_err(io::Error::other)?;
        if !present.as_bool() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "設定ファイルのアクセス権を確認できません。",
            ));
        }
        // 親ディレクトリの広い権限が追加される前に、元のDACLを適用して継承を止める。
        // 保護flagに対応したSetNamedSecurityInfoを使用する。
        SetNamedSecurityInfoW(
            PCWSTR(destination.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(dacl.cast_const()),
            None,
        )
        .ok()
        .map_err(io::Error::other)?;
    }
    Ok(())
}

pub(super) fn backup_configuration(source: &Path, backup: &Path) -> io::Result<()> {
    reject_non_regular_file(source)?;
    reject_non_regular_file(backup)?;
    if backup.try_exists()? {
        return Ok(());
    }
    let mut temporary = temporary_file(backup, source)?;
    io::copy(&mut File::open(source)?, temporary.as_file_mut())?;
    temporary.as_file_mut().flush()?;
    temporary.as_file().sync_all()?;
    let temporary = temporary.into_temp_path();
    temporary
        .persist_noclobber(backup)
        .map_err(|error| error.error)?;
    sync_parent(backup)
}

pub(super) fn write_to_json_file<T: Serialize>(file_path: PathBuf, data: &T) -> io::Result<()> {
    write_json(file_path, data, true)
}

pub(super) fn create_json_file<T: Serialize>(file_path: PathBuf, data: &T) -> io::Result<()> {
    write_json(file_path, data, false)
}

fn write_json<T: Serialize>(
    file_path: PathBuf,
    data: &T,
    replace_existing: bool,
) -> io::Result<()> {
    reject_non_regular_file(&file_path)?;
    let mut temporary = temporary_file(&file_path, &file_path)?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), data).map_err(io::Error::other)?;
    temporary.write_all(b"\n")?;
    temporary.as_file_mut().flush()?;
    temporary.as_file().sync_all()?;
    // ReplaceFileWは置換用ファイルを改めて開くため、書込ハンドルを先に閉じる。
    // TempPathは失敗時の自動削除を継続し、平文の一時ファイルを残さない。
    let temporary = temporary.into_temp_path();
    // JSON移行は既存ファイルの置換、初回作成は競合時に上書きしない公開とする。
    if replace_existing && file_path.try_exists()? {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::{
                Win32::Storage::FileSystem::{REPLACE_FILE_FLAGS, ReplaceFileW},
                core::PCWSTR,
            };
            let destination: Vec<u16> =
                file_path.as_os_str().encode_wide().chain(Some(0)).collect();
            let replacement: Vec<u16> =
                temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            // ReplaceFileは置換先のACLを保持する。ACL統合エラーも無視しない。
            unsafe {
                ReplaceFileW(
                    PCWSTR(destination.as_ptr()),
                    PCWSTR(replacement.as_ptr()),
                    PCWSTR::null(),
                    REPLACE_FILE_FLAGS(0),
                    None,
                    None,
                )
                .map_err(io::Error::other)?;
            }
        }
        #[cfg(not(windows))]
        temporary.persist(&file_path).map_err(|error| error.error)?;
    } else {
        temporary
            .persist_noclobber(&file_path)
            .map_err(|error| error.error)?;
    }
    sync_parent(&file_path)
}

fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serializer;

    struct FailingSerialization;
    impl Serialize for FailingSerialization {
        fn serialize<S: Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("test-only-error"))
        }
    }

    #[test]
    fn serialization_failure_preserves_original_and_does_not_publish_new_file() {
        let directory = tempfile::tempdir().unwrap();
        let existing = directory.path().join("existing.json");
        fs::write(&existing, b"{\"original\":true}").unwrap();
        assert!(write_to_json_file(existing.clone(), &FailingSerialization).is_err());
        assert_eq!(fs::read(existing).unwrap(), b"{\"original\":true}");
        let missing = directory.path().join("missing.json");
        assert!(write_to_json_file(missing.clone(), &FailingSerialization).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn initial_publication_never_overwrites_an_existing_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("settings.json");
        fs::write(&config, b"original-config").unwrap();
        assert!(create_json_file(config.clone(), &serde_json::json!({"new":true})).is_err());
        assert_eq!(fs::read(config).unwrap(), b"original-config");
    }

    #[test]
    fn backup_is_not_overwritten_and_atomic_replacement_preserves_valid_json() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("settings.json");
        let backup = directory.path().join("settings.json.bak");
        write_to_json_file(config.clone(), &serde_json::json!({"before":true})).unwrap();
        backup_configuration(&config, &backup).unwrap();
        let original_backup = fs::read(&backup).unwrap();
        write_to_json_file(config.clone(), &serde_json::json!({"after":true})).unwrap();
        backup_configuration(&config, &backup).unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original_backup);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(config).unwrap()).unwrap(),
            serde_json::json!({"after":true})
        );
    }

    #[cfg(unix)]
    #[test]
    fn persisted_secret_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("settings.json");
        let backup = directory.path().join("settings.json.bak");
        let _lock = lock_configuration(&config).unwrap();
        write_to_json_file(config.clone(), &serde_json::json!({"secret":"test"})).unwrap();
        backup_configuration(&config, &backup).unwrap();
        for path in [
            &config,
            &backup,
            &directory.path().join("settings.json.lock"),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn configuration_and_lock_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("other.json");
        fs::write(&target, b"original").unwrap();
        let config = directory.path().join("settings.json");
        symlink(&target, &config).unwrap();
        assert!(lock_configuration(&config).is_err());
        assert!(write_to_json_file(config, &serde_json::json!({"replace":true})).is_err());
        assert_eq!(fs::read(target).unwrap(), b"original");
    }
}
