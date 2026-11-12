//! 操作ごとの取消、協調的な期限判定、取得側から読み出す上限付きの進捗管理。
//!
//! 操作コンテキストは使い切りとし、複製間では取消トークン・期限・監視状態を共有する。
//! 次の要求には新しいコンテキストを作成する。監視時に利用側のコールバックを呼ばず、
//! 未読の進捗がイベントキューへ蓄積することもない。

use std::{
    cell::Cell,
    fmt,
    marker::PhantomData,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Result, bail};

use crate::tilegen::cancel::{CancellationToken, is_interrupted};

const UNSET: u64 = u64::MAX;
/// 1操作で保持する診断情報の最大件数。
pub const MAX_DIAGNOSTICS: usize = 32;
/// 保持する診断情報1件のUTF-8本文の最大バイト数。省略記号も含む。
pub const MAX_DIAGNOSTIC_BYTES: usize = 512;
static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

/// 取消確認箇所で、操作の協調的な期限超過を検出したことを表す。
#[derive(Debug, Clone, Copy)]
pub struct DeadlineExceeded;

impl fmt::Display for DeadlineExceeded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("operation deadline exceeded")
    }
}
impl std::error::Error for DeadlineExceeded {}

/// 開始済みのコンテキストは別の操作へ再利用できない。
#[derive(Debug, Clone, Copy)]
pub struct OperationAlreadyStarted;

impl fmt::Display for OperationAlreadyStarted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("operation context already started; create a new context")
    }
}
impl std::error::Error for OperationAlreadyStarted {}

pub fn is_deadline_exceeded(error: &anyhow::Error) -> bool {
    error.is::<DeadlineExceeded>() || error.chain().any(|cause| cause.is::<DeadlineExceeded>())
}

/// 操作の最新段階。件数は各段階内の値であり、全体の割合ではない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
#[repr(u8)]
pub enum Stage {
    NotStarted,
    Validating,
    Searching,
    Drawing,
    Encoding,
    ImportPass1,
    ImportPass2,
    BuildingGeometry,
    FinalValidation,
    Publishing,
    Completed,
    /// 再開分を含む、一括出力時のタイル完了数の集計。
    Exporting,
    /// 新形式で、RelationとWayを選別した後に必要Nodeを解決する。
    ImportPass3,
    /// 処理済み海陸ポリゴンの読み込み。
    ImportLandmask,
    /// 標高格子の読み込みと準備。
    ImportElevation,
    /// 標高格子からの等高線生成。
    BuildingContours,
}

impl Stage {
    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Validating,
            2 => Self::Searching,
            3 => Self::Drawing,
            4 => Self::Encoding,
            5 => Self::ImportPass1,
            6 => Self::ImportPass2,
            7 => Self::BuildingGeometry,
            8 => Self::FinalValidation,
            9 => Self::Publishing,
            10 => Self::Completed,
            11 => Self::Exporting,
            12 => Self::ImportPass3,
            13 => Self::ImportLandmask,
            14 => Self::ImportElevation,
            15 => Self::BuildingContours,
            _ => Self::NotStarted,
        }
    }
}

/// 生成元ワーカーが終了した後も、最終状態を読み取れる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
#[repr(u8)]
pub enum Status {
    Pending,
    Running,
    Succeeded,
    Cancelled,
    DeadlineExceeded,
    Failed,
}

impl Status {
    fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Pending,
            1 => Self::Running,
            2 => Self::Succeeded,
            3 => Self::Cancelled,
            4 => Self::DeadlineExceeded,
            _ => Self::Failed,
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending | Self::Running)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub stage: Stage,
    pub message: String,
}

/// 所有されたスナップショット。保持に必要なメモリは呼出元が管理する。
#[derive(Debug, Clone)]
pub struct ProgressSnapshot {
    pub operation_id: u64,
    pub status: Status,
    pub stage: Stage,
    pub completed: u64,
    pub total: Option<u64>,
    /// `start`より前の待機時間を除く実行時間。
    pub elapsed: Duration,
    pub diagnostics: Vec<Diagnostic>,
    /// バッファーが満杯、または読取中のため省略した診断情報も含む。
    pub dropped_diagnostics: u64,
}

pub type OperationSnapshot = ProgressSnapshot;

struct Inner {
    operation_id: u64,
    created: Instant,
    cancel: CancellationToken,
    parent: Option<OperationContext>,
    deadline_ns: AtomicU64,
    started: AtomicBool,
    sequence: AtomicU64,
    status: AtomicU8,
    stage: AtomicU8,
    completed: AtomicU64,
    total: AtomicU64,
    has_total: AtomicU8,
    started_ns: AtomicU64,
    finished_ns: AtomicU64,
    diagnostics: Mutex<Vec<Diagnostic>>,
    dropped_diagnostics: AtomicU64,
}

impl Inner {
    fn now_ns(&self) -> u64 {
        self.created.elapsed().as_nanos().min(u128::from(UNSET - 1)) as u64
    }

    // 進捗を書き込むのは単一のOperationGuardだけ。ロックやコールバックを使わず、
    // シーケンス番号によって読取側が整合した一組のカウンターを取得できるようにする。
    fn update(&self, change: impl FnOnce()) {
        self.sequence.fetch_add(1, Ordering::AcqRel);
        change();
        self.sequence.fetch_add(1, Ordering::Release);
    }
}

/// 1操作の協調的な制御と監視の状態。
#[derive(Clone)]
pub struct OperationContext(Arc<Inner>);

impl fmt::Debug for OperationContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OperationContext")
            .field("operation_id", &self.0.operation_id)
            .field(
                "status",
                &Status::from_code(self.0.status.load(Ordering::Acquire)),
            )
            .finish_non_exhaustive()
    }
}

impl Default for OperationContext {
    fn default() -> Self {
        Self::new(CancellationToken::new())
    }
}

impl OperationContext {
    pub fn new(cancel: CancellationToken) -> Self {
        Self::create(cancel, None)
    }

    fn create(cancel: CancellationToken, parent: Option<Self>) -> Self {
        Self(Arc::new(Inner {
            operation_id: NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed),
            created: Instant::now(),
            cancel,
            parent,
            deadline_ns: AtomicU64::new(UNSET),
            started: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            status: AtomicU8::new(Status::Pending as u8),
            stage: AtomicU8::new(Stage::NotStarted as u8),
            completed: AtomicU64::new(0),
            total: AtomicU64::new(0),
            has_total: AtomicU8::new(0),
            started_ns: AtomicU64::new(UNSET),
            finished_ns: AtomicU64::new(UNSET),
            diagnostics: Mutex::new(Vec::with_capacity(MAX_DIAGNOSTICS)),
            dropped_diagnostics: AtomicU64::new(0),
        }))
    }

    /// 内部ワーカーのスコープは、親の制御変更を逐次確認しつつ、独自の進捗と取消トークンを持つ。
    /// このスコープを中断しても、呼出元のコンテキストや独立した兄弟スコープは取り消さない。
    #[cfg(test)]
    pub(crate) fn child(&self) -> Self {
        Self::create(CancellationToken::new(), Some(self.clone()))
    }

    /// このコンテキストのすべての複製で共有する期限を設定する。再設定では短縮だけを許し、
    /// 実行中の操作の期限を誤って延長しない。期限判定は協調的に行うため、
    /// OSのI/Oや内部へ介入できない呼び出しの所要時間を制限するものではない。
    pub fn with_deadline(self, deadline: Instant) -> Self {
        let offset = deadline
            .saturating_duration_since(self.0.created)
            .as_nanos()
            .min(u128::from(UNSET - 1)) as u64;
        self.0.deadline_ns.fetch_min(offset, Ordering::AcqRel);
        self
    }

    pub fn cancellation_token(&self) -> &CancellationToken {
        &self.0.cancel
    }

    pub fn monitor(&self) -> OperationMonitor {
        OperationMonitor(self.0.clone())
    }

    /// アトミック操作と単調時計だけを使い、SQLiteの進捗フックから呼べる軽さを保つ。
    /// 進捗・診断情報のミューテックスや、呼出元のコールバックには触れない。
    pub fn check(&self) -> Result<()> {
        let mut current = Some(self);
        while let Some(context) = current {
            context.0.cancel.check()?;
            let deadline = context.0.deadline_ns.load(Ordering::Acquire);
            if deadline != UNSET && context.0.now_ns() >= deadline {
                bail!(DeadlineExceeded);
            }
            current = context.0.parent.as_ref();
        }
        Ok(())
    }

    /// バッファーを即座に利用できる場合だけ、上限内で診断情報を保持する。
    /// 取得側が遅い場合や未読の場合も生成側を待たせず、省略件数を記録する。
    pub fn diagnostic(&self, level: DiagnosticLevel, message: impl AsRef<str>) {
        let mut buffer = match self.0.diagnostics.try_lock() {
            Ok(buffer) => buffer,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                self.0.dropped_diagnostics.fetch_add(1, Ordering::Relaxed);
                return;
            },
        };
        if buffer.len() == MAX_DIAGNOSTICS {
            self.0.dropped_diagnostics.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let message = message.as_ref();
        let message = if message.len() <= MAX_DIAGNOSTIC_BYTES {
            message.to_owned()
        } else {
            let mut end = MAX_DIAGNOSTIC_BYTES - 3;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            let mut text = String::with_capacity(MAX_DIAGNOSTIC_BYTES);
            text.push_str(&message[..end]);
            text.push_str("...");
            text
        };
        buffer.push(Diagnostic {
            level,
            stage: Stage::from_code(self.0.stage.load(Ordering::Acquire)),
            message,
        });
    }

    pub(crate) fn start(&self) -> Result<OperationGuard> {
        if self
            .0
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            bail!(OperationAlreadyStarted);
        }
        self.0.update(|| {
            self.0.started_ns.store(self.0.now_ns(), Ordering::Release);
            self.0
                .stage
                .store(Stage::Validating as u8, Ordering::Release);
            self.0
                .status
                .store(Status::Running as u8, Ordering::Release);
        });
        let guard = OperationGuard {
            context: self.clone(),
            finished: false,
            _single_writer: PhantomData,
        };
        if let Err(error) = self.check() {
            guard.fail(&error);
            return Err(error);
        }
        Ok(guard)
    }
}

/// 呼出元のUI・サーバータスクへこのハンドルを複製し、任意の頻度でポーリングする。
#[derive(Clone)]
pub struct OperationMonitor(Arc<Inner>);

impl fmt::Debug for OperationMonitor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OperationMonitor")
            .field("operation_id", &self.0.operation_id)
            .field(
                "status",
                &Status::from_code(self.0.status.load(Ordering::Acquire)),
            )
            .finish_non_exhaustive()
    }
}

impl OperationMonitor {
    pub fn snapshot(&self) -> ProgressSnapshot {
        let (status, stage, completed, total, has_total, started, finished) = loop {
            let before = self.0.sequence.load(Ordering::Acquire);
            if before & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            let fields = (
                Status::from_code(self.0.status.load(Ordering::Acquire)),
                Stage::from_code(self.0.stage.load(Ordering::Acquire)),
                self.0.completed.load(Ordering::Acquire),
                self.0.total.load(Ordering::Acquire),
                self.0.has_total.load(Ordering::Acquire),
                self.0.started_ns.load(Ordering::Acquire),
                self.0.finished_ns.load(Ordering::Acquire),
            );
            if before == self.0.sequence.load(Ordering::Acquire) {
                break fields;
            }
        };
        let elapsed = if started == UNSET {
            Duration::ZERO
        } else {
            Duration::from_nanos(
                (if finished == UNSET {
                    self.0.now_ns()
                } else {
                    finished
                })
                .saturating_sub(started),
            )
        };
        let diagnostics = self
            .0
            .diagnostics
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        ProgressSnapshot {
            operation_id: self.0.operation_id,
            status,
            stage,
            completed,
            total: (has_total != 0).then_some(total),
            elapsed,
            diagnostics,
            dropped_diagnostics: self.0.dropped_diagnostics.load(Ordering::Relaxed),
        }
    }
}

/// 単一ワーカーのライフサイクルを管理するガード。エラーや巻き戻しで破棄された場合も
/// 最終状態を公開し、終了した生成元を呼出元が永久に待ち続けることを防ぐ。
#[derive(Debug)]
pub(crate) struct OperationGuard {
    context: OperationContext,
    finished: bool,
    _single_writer: PhantomData<Cell<()>>,
}

impl OperationGuard {
    pub(crate) fn stage(&self, stage: Stage) {
        self.context.0.update(|| {
            self.context.0.completed.store(0, Ordering::Release);
            self.context.0.total.store(0, Ordering::Release);
            self.context.0.has_total.store(0, Ordering::Release);
            self.context.0.stage.store(stage as u8, Ordering::Release);
        });
    }

    pub(crate) fn progress(&self, completed: u64, total: Option<u64>) {
        self.context.0.update(|| {
            self.context.0.completed.store(completed, Ordering::Release);
            self.context
                .0
                .total
                .store(total.unwrap_or(0), Ordering::Release);
            self.context
                .0
                .has_total
                .store(u8::from(total.is_some()), Ordering::Release);
        });
    }

    pub(crate) fn succeed(mut self) -> Result<()> {
        if let Err(error) = self.context.check() {
            self.finish(error_status(&error));
            return Err(error);
        }
        self.finish(Status::Succeeded);
        Ok(())
    }

    /// 公開はすでに正常確定しており、後から届いた取消では元に戻せない。
    /// 取り消せない公開が完了した後は、制御状態を再確認しない。
    pub(crate) fn succeed_committed(mut self) {
        self.finish(Status::Succeeded);
    }

    pub(crate) fn fail(mut self, error: &anyhow::Error) {
        self.finish(error_status(error));
    }

    fn finish(&mut self, status: Status) {
        self.context.0.update(|| {
            self.context
                .0
                .finished_ns
                .store(self.context.0.now_ns(), Ordering::Release);
            if status == Status::Succeeded {
                self.context
                    .0
                    .stage
                    .store(Stage::Completed as u8, Ordering::Release);
            }
            self.context.0.status.store(status as u8, Ordering::Release);
        });
        self.finished = true;
    }
}

fn error_status(error: &anyhow::Error) -> Status {
    if is_interrupted(error) {
        Status::Cancelled
    } else if is_deadline_exceeded(error) {
        Status::DeadlineExceeded
    } else {
        Status::Failed
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if !self.finished {
            let status = self
                .context
                .check()
                .err()
                .as_ref()
                .map_or(Status::Failed, error_status);
            self.finish(status);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_cancel_deadline_and_terminal_reuse() -> Result<()> {
        let cancel = CancellationToken::new();
        let context = OperationContext::new(cancel.clone());
        let guard = context.start()?;
        guard.stage(Stage::Searching);
        cancel.cancel();
        let error = guard.succeed().unwrap_err();
        assert!(is_interrupted(&error));
        assert_eq!(context.monitor().snapshot().status, Status::Cancelled);
        assert!(
            context
                .start()
                .err()
                .unwrap()
                .is::<OperationAlreadyStarted>()
        );
        assert_eq!(context.monitor().snapshot().stage, Stage::Searching);

        let context = OperationContext::default().with_deadline(Instant::now());
        assert!(is_deadline_exceeded(&context.start().err().unwrap()));
        assert_eq!(
            context.monitor().snapshot().status,
            Status::DeadlineExceeded
        );
        Ok(())
    }

    #[test]
    fn final_check_and_committed_publication_have_distinct_semantics() -> Result<()> {
        let cancel = CancellationToken::new();
        let context = OperationContext::new(cancel.clone());
        let guard = context.start()?;
        cancel.cancel();
        guard.succeed_committed();
        assert_eq!(context.monitor().snapshot().status, Status::Succeeded);
        let first = context.monitor().snapshot().elapsed;
        assert_eq!(context.monitor().snapshot().elapsed, first);
        Ok(())
    }

    #[test]
    fn unread_and_busy_diagnostics_are_bounded_and_utf8_safe() -> Result<()> {
        let context = OperationContext::default();
        let guard = context.start()?;
        let message = "日本語".repeat(400);
        for _ in 0..2000 {
            context.diagnostic(DiagnosticLevel::Warning, &message);
        }
        let snapshot = context.monitor().snapshot();
        assert_eq!(snapshot.diagnostics.len(), MAX_DIAGNOSTICS);
        assert_eq!(snapshot.dropped_diagnostics, 2000 - MAX_DIAGNOSTICS as u64);
        assert!(
            snapshot
                .diagnostics
                .iter()
                .all(|item| item.message.len() <= MAX_DIAGNOSTIC_BYTES)
        );
        let lock = context.0.diagnostics.lock().unwrap();
        context.diagnostic(DiagnosticLevel::Info, "busy");
        drop(lock);
        assert_eq!(
            context.monitor().snapshot().dropped_diagnostics,
            snapshot.dropped_diagnostics + 1
        );
        guard.succeed()?;
        Ok(())
    }

    #[test]
    fn progress_is_latest_stage_local_and_drop_reaches_terminal_state() -> Result<()> {
        let context = OperationContext::default();
        let monitor = context.monitor();
        let guard = context.start()?;
        guard.stage(Stage::Searching);
        for completed in 0..10_000 {
            guard.progress(completed, None);
        }
        assert_eq!(monitor.snapshot().completed, 9_999);
        assert_eq!(monitor.snapshot().total, None);
        guard.stage(Stage::Drawing);
        assert_eq!(monitor.snapshot().completed, 0);
        guard.progress(5, Some(5));
        guard.progress(u64::MAX, Some(u64::MAX));
        assert_eq!(monitor.snapshot().total, Some(u64::MAX));
        guard.progress(5, Some(5));
        drop(guard);
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.status, Status::Failed);
        assert_eq!((snapshot.completed, snapshot.total), (5, Some(5)));
        Ok(())
    }

    #[test]
    fn cloned_deadline_is_shared_and_can_only_be_shortened() -> Result<()> {
        let context = OperationContext::default();
        let clone = context.clone();
        let context = context.with_deadline(Instant::now());
        let _later = context.with_deadline(Instant::now() + Duration::from_secs(60));
        assert!(is_deadline_exceeded(&clone.check().unwrap_err()));
        Ok(())
    }

    #[test]
    fn children_observe_live_parent_control_without_cancelling_the_caller() -> Result<()> {
        let parent = OperationContext::default();
        let child = parent.child();
        let peer = parent.child();
        child.cancellation_token().cancel();
        assert!(is_interrupted(&child.check().unwrap_err()));
        parent.check()?;
        peer.check()?;
        parent.cancellation_token().cancel();
        assert!(is_interrupted(&peer.check().unwrap_err()));

        let parent = OperationContext::default();
        let descendant = parent.child().child();
        let _shortened = parent.with_deadline(Instant::now());
        assert!(is_deadline_exceeded(&descendant.check().unwrap_err()));
        Ok(())
    }

    #[test]
    fn children_have_independent_single_writer_progress() -> Result<()> {
        let parent = OperationContext::default();
        let child = parent.child();
        let parent_guard = parent.start()?;
        let child_guard = child.start()?;
        parent_guard.stage(Stage::Exporting);
        parent_guard.progress(1, Some(2));
        child_guard.stage(Stage::Searching);
        child_guard.progress(1024, None);
        assert_ne!(
            parent.monitor().snapshot().operation_id,
            child.monitor().snapshot().operation_id
        );
        assert_eq!(parent.monitor().snapshot().stage, Stage::Exporting);
        assert_eq!(parent.monitor().snapshot().completed, 1);
        child_guard.succeed()?;
        assert_eq!(parent.monitor().snapshot().status, Status::Running);
        parent_guard.succeed()?;
        Ok(())
    }

    #[test]
    fn deadline_context_retains_the_query_cause_and_terminal_classification() -> Result<()> {
        let context = OperationContext::default();
        let guard = context.start()?;
        let error = anyhow::Error::new(std::io::Error::other("query interrupted"))
            .context(DeadlineExceeded)
            .context("export worker");
        assert!(is_deadline_exceeded(&error));
        assert!(error.chain().any(|cause| cause.is::<std::io::Error>()));
        guard.fail(&error);
        assert_eq!(
            context.monitor().snapshot().status,
            Status::DeadlineExceeded
        );
        Ok(())
    }

    #[test]
    fn concurrent_snapshots_keep_progress_pairs_coherent() -> Result<()> {
        let context = OperationContext::default();
        let monitor = context.monitor();
        let guard = context.start()?;
        std::thread::scope(|scope| -> Result<()> {
            let worker = scope.spawn(move || {
                guard.stage(Stage::Searching);
                for completed in 0..20_000 {
                    guard.progress(completed, Some(completed));
                }
                guard.succeed()
            });
            loop {
                let snapshot = monitor.snapshot();
                if let Some(total) = snapshot.total {
                    assert_eq!(snapshot.completed, total);
                }
                if snapshot.status.is_terminal() {
                    break;
                }
            }
            worker.join().unwrap()?;
            Ok(())
        })
    }
}
