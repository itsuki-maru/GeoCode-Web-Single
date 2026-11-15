//! SQLiteが実際に書き込みロックを待つ地点を、試験用接続だけで同期する。
use sqlx::{SqliteConnection, sqlite::SqlitePoolOptions};
use std::{
    ffi::{c_int, c_void},
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{sync::Notify, task::JoinHandle};

const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

struct State {
    entered: Notify,
    cancelled: AtomicBool,
    started: Mutex<Option<Instant>>,
}

pub struct SqliteContention {
    state: Arc<State>,
}

impl SqliteContention {
    pub fn new() -> Self {
        Self {
            state: Arc::new(State {
                entered: Notify::new(),
                cancelled: AtomicBool::new(false),
                started: Mutex::new(None),
            }),
        }
    }

    pub fn pool_options(&self, connections: u32) -> SqlitePoolOptions {
        let connected = self.state.clone();
        let acquired = self.state.clone();
        SqlitePoolOptions::new()
            // writerのロック取得前に接続初期化を終え、接続時PRAGMAの待機と混同しない。
            .max_connections(connections)
            .min_connections(connections)
            .after_connect(move |connection, _| {
                let state = connected.clone();
                Box::pin(async move {
                    // SQLiteがcollationを破棄するまでArcを保持する。panic時にpoolの
                    // DropがSQLの終了より先行しても、busy callbackのdataを失効させない。
                    let owner = state.clone();
                    connection.lock_handle().await?.create_collation(
                        "geocode_test_contention_owner",
                        move |left, right| {
                            let _keep_alive = &owner;
                            left.cmp(right)
                        },
                    )?;
                    install(connection, &state).await
                })
            })
            .before_acquire(move |connection, _| {
                let state = acquired.clone();
                Box::pin(async move {
                    install(connection, &state).await?;
                    Ok(true)
                })
            })
            .after_release(|connection, _| {
                Box::pin(async move {
                    let mut handle = connection.lock_handle().await?;
                    // poolへ戻す際に試験用callbackを解除する。
                    let result = unsafe {
                        rusqlite::ffi::sqlite3_busy_timeout(
                            handle.as_raw_handle().as_ptr(),
                            LOCK_TIMEOUT.as_millis() as c_int,
                        )
                    };
                    check(result)?;
                    Ok(true)
                })
            })
    }

    pub fn spawn<T: Send + 'static>(
        &self,
        future: impl Future<Output = T> + Send + 'static,
    ) -> ContendedTask<T> {
        ContendedTask {
            task: Some(tokio::spawn(future)),
            state: self.state.clone(),
        }
    }

    pub async fn wait_until_busy(&self) {
        tokio::time::timeout(LOCK_TIMEOUT, self.state.entered.notified())
            .await
            .expect("worker did not reach SQLite lock contention");
    }
}

async fn install(connection: &mut SqliteConnection, state: &Arc<State>) -> Result<(), sqlx::Error> {
    let mut handle = connection.lock_handle().await?;
    // SQLxとrusqliteはCargo.lock上で同じlibsqlite3-sysを共有する。
    // lock_handleによりSQLx workerと同時にこの接続を操作しない。
    // dataは上記collationの所有するArcによって接続終了まで生存する。
    let result = unsafe {
        rusqlite::ffi::sqlite3_busy_handler(
            handle.as_raw_handle().as_ptr(),
            Some(wait_for_lock),
            Arc::as_ptr(state).cast_mut().cast::<c_void>(),
        )
    };
    check(result)
}

fn check(result: c_int) -> Result<(), sqlx::Error> {
    if result == rusqlite::ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!(
            "failed to configure test SQLite busy handler: {result}"
        )))
    }
}

unsafe extern "C" fn wait_for_lock(data: *mut c_void, previous_calls: c_int) -> c_int {
    // RustのpanicをSQLiteのC ABIへ伝播させない。
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let state = unsafe { &*data.cast::<State>() };
        if state.cancelled.load(Ordering::Acquire) {
            return 0;
        }
        let expired = {
            let mut started = state
                .started
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if previous_calls == 0 {
                *started = Some(Instant::now());
                state.entered.notify_one();
            }
            started.is_none_or(|started| started.elapsed() >= LOCK_TIMEOUT)
        };
        if expired {
            return 0;
        }
        std::thread::sleep(Duration::from_millis(1));
        1
    }))
    .unwrap_or(0)
}

pub struct ContendedTask<T> {
    task: Option<JoinHandle<T>>,
    state: Arc<State>,
}

impl<T> ContendedTask<T> {
    pub fn is_finished(&self) -> bool {
        self.task.as_ref().unwrap().is_finished()
    }

    pub async fn finish(mut self) -> T {
        let result = tokio::time::timeout(Duration::from_secs(10), self.task.as_mut().unwrap())
            .await
            .expect("contended worker did not finish")
            .expect("contended worker panicked");
        self.task.take();
        result
    }
}

impl<T> Drop for ContendedTask<T> {
    fn drop(&mut self) {
        self.state.cancelled.store(true, Ordering::Release);
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
