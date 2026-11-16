use super::*;
use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
use windows::{
    Win32::{
        Foundation::{HANDLE, HLOCAL, LocalFree},
        Security::{
            ACL,
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
                SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
            },
            DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
        },
    },
    core::{BOOL, PCWSTR, w},
};

struct LocalDescriptor(PSECURITY_DESCRIPTOR);
impl Drop for LocalDescriptor {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0.0)));
        }
    }
}

fn restrict_fixture_dacl(path: &Path) {
    let mut descriptor = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("D:P(A;;FA;;;SY)(A;;FA;;;OW)"),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .unwrap();
    }
    let descriptor = LocalDescriptor(descriptor);
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut present = BOOL(0);
        let mut defaulted = BOOL(0);
        let mut dacl = std::ptr::null_mut();
        GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted).unwrap();
        assert!(present.as_bool());
        assert!(!dacl.is_null());
        SetNamedSecurityInfoW(
            PCWSTR(path.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(dacl.cast_const()),
            None,
        )
        .ok()
        .unwrap();
    }
}

// 実装のパス用GetFileSecurityWとは別に、公開ファイルのハンドルから
// OSが保持するDACLと継承保護bitを取得する。
fn actual_dacl(path: &Path) -> (Vec<u8>, bool) {
    let file = File::open(path).unwrap();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    unsafe {
        GetSecurityInfo(
            HANDLE(file.as_raw_handle()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
        .ok()
        .unwrap();
    }
    let descriptor = LocalDescriptor(descriptor);
    assert!(!dacl.is_null());
    let mut control = 0_u16;
    let mut revision = 0;
    unsafe {
        GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision).unwrap();
        assert!((*dacl).AclSize as usize >= std::mem::size_of::<ACL>());
        let bytes =
            std::slice::from_raw_parts(dacl.cast::<u8>(), (*dacl).AclSize as usize).to_vec();
        (bytes, control & SE_DACL_PROTECTED.0 != 0)
    }
}

#[test]
fn restricted_dacl_survives_plaintext_staging_backup_and_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("private-settings.json");
    let backup = directory.path().join("private-settings.json.bak");
    fs::write(&config, b"{\"before\":true}").unwrap();
    // ACLを変えるのは、このテストが作成した一時configだけ。
    restrict_fixture_dacl(&config);
    let expected = actual_dacl(&config);
    assert!(expected.1, "元のDACLは親からの継承を禁止している");

    let temporary = temporary_file(&config, &config).unwrap();
    assert_eq!(temporary.as_file().metadata().unwrap().len(), 0);
    assert_eq!(
        actual_dacl(temporary.path()),
        expected,
        "平文を書き込む前から元の制限を維持する"
    );
    drop(temporary);

    backup_configuration(&config, &backup).unwrap();
    assert_eq!(actual_dacl(&backup), expected);
    assert_eq!(fs::read(&backup).unwrap(), b"{\"before\":true}");
    write_to_json_file(config.clone(), &serde_json::json!({"after":true})).unwrap();
    assert_eq!(actual_dacl(&config), expected);
    assert_eq!(actual_dacl(&backup), expected);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(config).unwrap()).unwrap(),
        serde_json::json!({"after":true})
    );
}
