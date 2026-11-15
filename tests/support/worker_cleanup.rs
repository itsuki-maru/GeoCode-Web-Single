//! Windowsの試験が受け付けたworkerだけを、所有handleで終了・回収する。
use geocode_web_single::{
    init::read_env_json_readonly, local_tiles::config::LocalTileConfig, tile_manager::Manager,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{OsString, c_void},
    io::{self, Write},
    mem::size_of,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    process::Child,
    sync::mpsc,
    time::Duration,
};

type Handle = *mut c_void;
const PROCESS_TERMINATE: u32 = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}
impl FileTime {
    fn ticks(&self) -> u64 {
        (u64::from(self.high) << 32) | u64::from(self.low)
    }
}

#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    priority: i32,
    flags: u32,
    image: [u16; 260],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "OpenProcess"]
    fn open_process(access: u32, inherit: i32, pid: u32) -> Handle;
    #[link_name = "QueryFullProcessImageNameW"]
    fn query_full_process_image_name_w(
        process: Handle,
        flags: u32,
        image: *mut u16,
        size: *mut u32,
    ) -> i32;
    #[link_name = "GetProcessTimes"]
    fn get_process_times(
        process: Handle,
        created: *mut FileTime,
        exited: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    #[link_name = "GetSystemTimePreciseAsFileTime"]
    fn get_system_time_precise_as_file_time(time: *mut FileTime);
    #[link_name = "WaitForSingleObject"]
    fn wait_for_single_object(handle: Handle, milliseconds: u32) -> u32;
    #[link_name = "TerminateProcess"]
    fn terminate_process(process: Handle, exit_code: u32) -> i32;
    #[link_name = "CreateToolhelp32Snapshot"]
    fn create_toolhelp32_snapshot(flags: u32, pid: u32) -> Handle;
    #[link_name = "Process32FirstW"]
    fn process32_first_w(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    #[link_name = "Process32NextW"]
    fn process32_next_w(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
}

pub fn process_clock() -> u64 {
    let mut time = FileTime::default();
    unsafe { get_system_time_precise_as_file_time(&mut time) };
    time.ticks()
}

struct ProcessHandle(OwnedHandle);
impl ProcessHandle {
    fn capture(pid: u32, executable: &Path, before: u64, after: u64) -> io::Result<Option<Self>> {
        let raw = unsafe {
            open_process(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            // PIDが既に消えていれば終了済み。別PIDを探したり終了したりしない。
            return if error.raw_os_error() == Some(87) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        let process = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
        if process.wait(Duration::ZERO)? {
            return Ok(None);
        }
        let mut image = vec![0_u16; 32768];
        let mut length = image.len() as u32;
        if unsafe { query_full_process_image_name_w(raw, 0, image.as_mut_ptr(), &mut length) } == 0
        {
            return if process.wait(Duration::ZERO)? {
                Ok(None)
            } else {
                Err(io::Error::last_os_error())
            };
        }
        let image = PathBuf::from(OsString::from_wide(&image[..length as usize])).canonicalize()?;
        let mut created = FileTime::default();
        let mut exited = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        if unsafe { get_process_times(raw, &mut created, &mut exited, &mut kernel, &mut user) } == 0
        {
            return if process.wait(Duration::ZERO)? {
                Ok(None)
            } else {
                Err(io::Error::last_os_error())
            };
        }
        let parent = match parent_pid(pid) {
            Ok(parent) => parent,
            Err(_) if process.wait(Duration::ZERO)? => return Ok(None),
            Err(error) => return Err(error),
        };
        if image != executable
            || !(before..=after).contains(&created.ticks())
            || parent != std::process::id()
        {
            return Err(io::Error::other(
                "workerの実行ファイル・生成時刻・親PIDが試験の受付と一致しません",
            ));
        }
        Ok(Some(process))
    }

    fn wait(&self, timeout: Duration) -> io::Result<bool> {
        match unsafe {
            wait_for_single_object(
                self.0.as_raw_handle(),
                timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32,
            )
        } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }

    fn stop(&self) -> io::Result<()> {
        if self.wait(Duration::ZERO)? {
            return Ok(());
        }
        if unsafe { terminate_process(self.0.as_raw_handle(), 1) } == 0
            && !self.wait(Duration::ZERO)?
        {
            return Err(io::Error::last_os_error());
        }
        if !self.wait(Duration::from_secs(2))? {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "owned workerの終了待ちが期限切れです",
            ));
        }
        Ok(())
    }
}

fn parent_pid(pid: u32) -> io::Result<u32> {
    let raw = unsafe { create_toolhelp32_snapshot(2, 0) }; // TH32CS_SNAPPROCESS
    if raw.is_null() || raw == -1_isize as Handle {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = ProcessEntry {
        size: size_of::<ProcessEntry>() as u32,
        usage: 0,
        pid: 0,
        heap: 0,
        module: 0,
        threads: 0,
        parent: 0,
        priority: 0,
        flags: 0,
        image: [0; 260],
    };
    let mut found = unsafe { process32_first_w(snapshot.as_raw_handle(), &mut entry) } != 0;
    while found {
        if entry.pid == pid {
            return Ok(entry.parent);
        }
        found = unsafe { process32_next_w(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "workerの親PIDを確認できません",
    ))
}

struct Request {
    before: u64,
    after: u64,
    captured: bool,
    job: String,
}

pub struct WorkerCleanup {
    config: PathBuf,
    executable: PathBuf,
    receipts: PathBuf,
    requests: BTreeMap<String, Request>,
    processes: Vec<ProcessHandle>,
    expected_forced_cleanup: bool,
    finished: bool,
}

impl WorkerCleanup {
    pub fn for_child(executable: &Path) -> Result<Self, String> {
        Ok(Self {
            config: PathBuf::new(),
            executable: executable
                .canonicalize()
                .map_err(|error| error.to_string())?,
            receipts: PathBuf::new(),
            requests: BTreeMap::new(),
            processes: Vec::new(),
            // 回収の回帰試験では、正常な自己test exeの強制終了自体が期待動作。
            expected_forced_cleanup: true,
            finished: false,
        })
    }

    pub fn new(config: &Path, executable: &Path) -> Result<Self, String> {
        let config = config.canonicalize().map_err(|error| error.to_string())?;
        let settings = read_env_json_readonly(&config).map_err(|error| error.to_string())?;
        let local = LocalTileConfig::from_setup(&settings)?;
        let namespace = format!("{:x}", Sha256::digest(config.to_string_lossy().as_bytes()));
        Ok(Self {
            config,
            executable: executable
                .canonicalize()
                .map_err(|error| error.to_string())?,
            receipts: local.work_path.join("tile-manager").join(namespace),
            requests: BTreeMap::new(),
            processes: Vec::new(),
            expected_forced_cleanup: false,
            finished: false,
        })
    }

    pub async fn submit(
        &mut self,
        manager: &Manager,
        action: &str,
        payload: Value,
        id: String,
    ) -> Result<Value, String> {
        if self.finished {
            return Err("cleanup完了後にはworkerを起動できません".into());
        }
        let id = uuid::Uuid::parse_str(&id)
            .map_err(|error| error.to_string())?
            .to_string();
        self.requests.entry(id.clone()).or_insert_with(|| Request {
            before: process_clock(),
            after: process_clock(),
            captured: false,
            job: id.clone(),
        });
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            manager.submit(action, payload, id.clone()),
        )
        .await
        .map_err(|_| "worker受付が30秒を超えました".to_owned())
        .and_then(|result| result);
        self.requests.get_mut(&id).unwrap().after = process_clock();
        self.capture_receipts()?;
        result
    }

    fn capture_receipts(&mut self) -> Result<(), String> {
        for (id, request) in &mut self.requests {
            let path = self.receipts.join(format!("{id}.receipt.json"));
            let bytes = match std::fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            let receipt: Value =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if receipt["id"].as_str() != Some(id.as_str()) {
                return Err("受付IDがcleanup対象と一致しません".into());
            }
            if let Some(job) = receipt["job_id"].as_str() {
                request.job = job.to_owned();
            }
            if request.captured {
                continue;
            }
            if let Some(pid) = receipt["worker_pid"].as_u64() {
                let pid = u32::try_from(pid).map_err(|_| "worker PIDが不正です")?;
                if let Some(process) =
                    ProcessHandle::capture(pid, &self.executable, request.before, request.after)
                        .map_err(|error| error.to_string())?
                {
                    self.processes.push(process);
                }
                request.captured = true;
            }
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), String> {
        self.cleanup()
    }

    fn cleanup(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        let mut failures = Vec::new();
        if let Err(error) = self.capture_receipts() {
            failures.push(error);
        }
        let active = self
            .processes
            .iter()
            .any(|process| !process.wait(Duration::from_millis(100)).unwrap_or(false));
        if !self.requests.is_empty()
            && (active
                || !failures.is_empty()
                || self.requests.values().any(|request| !request.captured))
        {
            let config = self.config.clone();
            let executable = self.executable.clone();
            let jobs: Vec<_> = self
                .requests
                .values()
                .map(|request| request.job.clone())
                .collect();
            let (send, receive) = mpsc::sync_channel(1);
            let cancellation = std::thread::Builder::new()
                .name("test-worker-cancel".into())
                .spawn(move || {
                    if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        runtime.block_on(async {
                            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                                let manager = Manager::new(config, executable);
                                for job in jobs {
                                    let _ = manager.query("cancel", json!({"job":job})).await;
                                }
                            })
                            .await;
                        });
                        runtime.shutdown_timeout(Duration::from_millis(100));
                    }
                    let _ = send.send(());
                });
            match cancellation {
                Ok(_) => {
                    let _ = receive.recv_timeout(Duration::from_secs(3));
                },
                Err(error) => failures.push(error.to_string()),
            }
        }
        for process in self.processes.drain(..) {
            match process.wait(Duration::from_millis(500)) {
                Ok(true) => {},
                _ => {
                    if let Err(error) = process.stop() {
                        failures.push(error.to_string());
                    } else if !self.expected_forced_cleanup {
                        failures.push("正常終了前のworkerをcleanupで強制終了しました".into());
                    }
                },
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    /// 正規の自己test exeを使うcleanup回帰試験専用。PIDから別プロセスを探さない。
    pub fn track_child(&mut self, child: &Child, before: u64, after: u64) -> Result<bool, String> {
        if let Some(process) = ProcessHandle::capture(child.id(), &self.executable, before, after)
            .map_err(|error| error.to_string())?
        {
            self.processes.push(process);
            return Ok(true);
        }
        Ok(false)
    }
}

impl Drop for WorkerCleanup {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            let _ = writeln!(io::stderr().lock(), "test worker cleanup: {error}");
        }
    }
}
