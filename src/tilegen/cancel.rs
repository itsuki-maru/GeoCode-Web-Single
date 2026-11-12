use anyhow::{Result, bail};
use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            bail!(Interrupted);
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct Interrupted;
impl fmt::Display for Interrupted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ユーザー操作により中断しました")
    }
}
impl std::error::Error for Interrupted {}

pub fn is_interrupted(error: &anyhow::Error) -> bool {
    error.is::<Interrupted>() || error.chain().any(|e| e.is::<Interrupted>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_stop_context_preserves_the_original_cause() {
        let cause = std::io::Error::new(std::io::ErrorKind::Interrupted, "SQL query stopped");
        let error = anyhow::Error::new(cause)
            .context(Interrupted)
            .context("export worker");
        assert!(is_interrupted(&error));
        assert!(error.chain().any(|cause| cause.is::<std::io::Error>()));
    }
}
