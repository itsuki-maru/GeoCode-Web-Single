//! テストが起動したプロセスだけを期限付きで待ち、出力と子孫の終了を回収する。
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom},
    process::{Child, Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

const CAPTURE_LIMIT: u64 = 8 * 1024 * 1024;
const DIAGNOSTIC_TAIL: usize = 16 * 1024;

pub trait CommandTestExt {
    fn output_with_timeout(&mut self, timeout: Duration) -> io::Result<Output>;
}

impl CommandTestExt for Command {
    fn output_with_timeout(&mut self, timeout: Duration) -> io::Result<Output> {
        capture_output(self, timeout, |_| Ok(()))
    }
}

fn capture_output(
    command: &mut Command,
    timeout: Duration,
    observe_spawn: impl FnOnce(&Child) -> io::Result<()>,
) -> io::Result<Output> {
    // pipeの容量待ちや、子孫がpipeを保持したまま残ることによるjoin待ちを避ける。
    let stdout = tempfile::NamedTempFile::new()?;
    let stderr = tempfile::NamedTempFile::new()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout.reopen()?))
        .stderr(Stdio::from(stderr.reopen()?));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = OwnedChild::new(command.spawn()?);
    observe_spawn(&child.inner)?;
    let started = Instant::now();
    let result = loop {
        if let Some(status) = child.inner.try_wait()? {
            child.reaped = true;
            break Ok(status);
        }
        if stdout.as_file().metadata()?.len() > CAPTURE_LIMIT
            || stderr.as_file().metadata()?.len() > CAPTURE_LIMIT
        {
            child.terminate()?;
            break Err(io::Error::other(
                "test child output exceeded the 8 MiB limit",
            ));
        }
        if started.elapsed() >= timeout {
            child.terminate()?;
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("test child process timed out after {timeout:?}"),
            ));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = read_capture(stdout.path())?;
    let stderr = read_capture(stderr.path())?;
    let result = if result.is_ok() && (stdout.exceeded || stderr.exceeded) {
        Err(io::Error::other(
            "test child output exceeded the 8 MiB limit",
        ))
    } else {
        result
    };
    match result {
        Ok(status) => Ok(Output {
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
        }),
        Err(error) => Err(io::Error::new(
            error.kind(),
            format!(
                "{error}\nstdout tail:\n{}\nstderr tail:\n{}",
                tail(&stdout.bytes),
                tail(&stderr.bytes)
            ),
        )),
    }
}

struct Capture {
    bytes: Vec<u8>,
    exceeded: bool,
}

fn read_capture(path: &std::path::Path) -> io::Result<Capture> {
    let mut file = fs::File::open(path)?;
    let exceeded = file.metadata()?.len() > CAPTURE_LIMIT;
    if exceeded {
        file.seek(SeekFrom::End(-(DIAGNOSTIC_TAIL as i64)))?;
    }
    let mut bytes = Vec::new();
    file.take(CAPTURE_LIMIT + 1).read_to_end(&mut bytes)?;
    Ok(Capture {
        exceeded: exceeded || bytes.len() as u64 > CAPTURE_LIMIT,
        bytes,
    })
}

fn tail(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(DIAGNOSTIC_TAIL)..]).into_owned()
}

struct OwnedChild {
    inner: Child,
    reaped: bool,
}

impl OwnedChild {
    fn new(inner: Child) -> Self {
        Self {
            inner,
            reaped: false,
        }
    }

    fn terminate(&mut self) -> io::Result<ExitStatus> {
        // Childハンドルを保持しているため、Windows上で対象PIDが再利用されることはない。
        // プロセス名による一括終了や、テストが起動していないPIDの終了は行わない。
        #[cfg(windows)]
        terminate_windows_tree(self.inner.id());
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            if let Ok(id) = i32::try_from(self.inner.id()) {
                // spawn時に作った専用グループだけを終了する。wait前なのでPIDは未回収。
                let _ = unsafe { kill(-id, 9) };
            }
        }
        let _ = self.inner.kill();
        let status = self.inner.wait()?;
        self.reaped = true;
        Ok(status)
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.terminate();
        }
    }
}

#[cfg(windows)]
fn terminate_windows_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let Some(system_root) = std::env::var_os("SystemRoot") else {
        return;
    };
    let taskkill = std::path::PathBuf::from(system_root)
        .join("System32")
        .join("taskkill.exe");
    if !taskkill.is_absolute() || !taskkill.is_file() {
        return;
    }
    let Ok(mut utility) = Command::new(taskkill)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
    else {
        return;
    };
    let started = Instant::now();
    loop {
        match utility.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                thread::sleep(Duration::from_millis(10));
            },
            _ => {
                let _ = utility.kill();
                let _ = utility.wait();
                return;
            },
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::io::{AsHandle, AsRawHandle, OwnedHandle},
    };

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "WaitForSingleObject"]
        fn wait_for_single_object(handle: *mut c_void, milliseconds: u32) -> u32;
        #[link_name = "TerminateProcess"]
        fn terminate_process(handle: *mut c_void, exit_code: u32) -> i32;
    }

    struct ObservedProcess(OwnedHandle);

    impl ObservedProcess {
        fn stopped(&self) -> bool {
            // 複製した所有handleだけを見るため、PID再利用や起動通知と競合しない。
            unsafe { wait_for_single_object(self.0.as_raw_handle(), 0) == 0 }
        }
    }

    impl Drop for ObservedProcess {
        fn drop(&mut self) {
            // 回収の退行を検出してassertが失敗する場合も、この試験のchildだけを終了する。
            if !self.stopped() {
                unsafe {
                    let _ = terminate_process(self.0.as_raw_handle(), 1);
                    let _ = wait_for_single_object(self.0.as_raw_handle(), 5000);
                }
            }
        }
    }

    #[test]
    fn capture_stdout_and_stderr_without_pipe_waits() {
        let output = Command::new("pwsh.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('x' * 1048576); [Console]::Error.Write('y' * 1048576)",
            ])
            .output_with_timeout(Duration::from_secs(10))
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 1024 * 1024);
        assert_eq!(output.stderr.len(), 1024 * 1024);
        assert!(output.stdout.iter().all(|byte| *byte == b'x'));
        assert!(output.stderr.iter().all(|byte| *byte == b'y'));
    }

    #[test]
    fn terminate_and_reap_owned_children_on_timeout() {
        let started = Instant::now();
        let mut process = None;
        let error = capture_output(
            Command::new("pwsh.exe").args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]),
            Duration::from_millis(250),
            |child| {
                process = Some(ObservedProcess(child.as_handle().try_clone_to_owned()?));
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(
            process.unwrap().stopped(),
            "timed-out child remained running"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
