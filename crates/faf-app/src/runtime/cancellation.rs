//! A single-current-operation view of the shared cancellation registry.

#[derive(Default)]
pub struct CancellationSlot(super::Cancellable<()>);

impl CancellationSlot {
    pub fn begin(&self) -> tokio_util::sync::CancellationToken {
        self.0.replace(()).called_off
    }

    pub fn cancel(&self) {
        self.0.cancel(|_| true);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.last_is_cancelled()
    }
}
