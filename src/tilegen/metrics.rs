/// プロセスの起動後に記録した常駐メモリの最大値。メモリ確保の上限値ではない。
#[cfg(windows)]
pub fn peak_rss_bytes() -> Option<u64> {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged_pool: usize,
        quota_paged_pool: usize,
        quota_peak_nonpaged_pool: usize,
        quota_nonpaged_pool: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut Counters, size: u32)
        -> i32;
    }
    let size = std::mem::size_of::<Counters>() as u32;
    let mut counters = Counters {
        cb: size,
        ..Counters::default()
    };
    // 安全性: 疑似ハンドルはこのプロセスを指す。Countersは規定のPROCESS_MEMORY_COUNTERSと
    // 同じC言語のメモリ配置を持ち、呼び出しの間は有効なままである。
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
    (ok != 0).then_some(counters.peak_working_set as u64)
}

#[cfg(target_os = "linux")]
pub fn peak_rss_bytes() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmHWM:")
                .and_then(|value| value.split_whitespace().next())
                .and_then(|value| value.parse::<u64>().ok())
                .and_then(|kb| kb.checked_mul(1024))
        })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn peak_rss_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    fn reads_os_high_water_memory() {
        assert!(super::peak_rss_bytes().is_some_and(|bytes| bytes > 0));
    }
}
