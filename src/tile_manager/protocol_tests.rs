use super::persist_with_retry;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::fs::OpenOptionsExt,
    path::Path,
};
use tempfile::{NamedTempFile, TempPath};

const OLD_RECEIPT: &[u8] = br#"{"state":"starting"}"#;
const NEW_RECEIPT: &[u8] = br#"{"state":"completed"}"#;

fn hold_receipt(path: &Path) -> File {
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    // 読み取りと書き込みの共有だけを許可して、置換と競合させる。
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .unwrap()
}

fn prepared_receipt(directory: &Path) -> TempPath {
    let mut temporary = NamedTempFile::new_in(directory).unwrap();
    temporary.write_all(NEW_RECEIPT).unwrap();
    temporary.as_file().sync_all().unwrap();
    temporary.into_temp_path()
}

#[test]
fn receipt_retry_replaces_the_file_after_the_reader_closes() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("receipt.json");
    fs::write(&destination, OLD_RECEIPT).unwrap();
    let mut held = Some(hold_receipt(&destination));
    let temporary = prepared_receipt(directory.path());
    let temporary_path = temporary.to_path_buf();

    persist_with_retry(temporary, &destination, || {
        assert_eq!(fs::read(&destination).unwrap(), OLD_RECEIPT);
        assert_eq!(fs::read(&temporary_path).unwrap(), NEW_RECEIPT);
        // 最初の再試行前に共有ハンドルを閉じ、置換を可能にする。
        drop(held.take().expect("再試行は1回で完了する"));
    })
    .unwrap();

    assert!(held.is_none());
    assert_eq!(fs::read(&destination).unwrap(), NEW_RECEIPT);
    assert!(!temporary_path.exists());
}

#[test]
fn receipt_retry_exhaustion_preserves_the_existing_file() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("receipt.json");
    fs::write(&destination, OLD_RECEIPT).unwrap();
    let _held = hold_receipt(&destination);
    let temporary = prepared_receipt(directory.path());
    let temporary_path = temporary.to_path_buf();
    let mut waits = 0;

    let failure = persist_with_retry(temporary, &destination, || {
        waits += 1;
        assert_eq!(fs::read(&destination).unwrap(), OLD_RECEIPT);
    })
    .unwrap_err();

    assert_eq!(waits, 4);
    assert_eq!(&*failure.path, temporary_path.as_path());
    assert_eq!(fs::read(temporary_path).unwrap(), NEW_RECEIPT);
    assert_eq!(fs::read(destination).unwrap(), OLD_RECEIPT);
}
