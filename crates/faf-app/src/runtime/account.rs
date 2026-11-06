use std::sync::Mutex;

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// One adapter connection at a time. A duplicate in the current account
/// returns immediately, but a new account waits for the old socket's teardown
/// before reusing the adapter.
#[derive(Default)]
pub(crate) struct AccountConnection {
    active: Mutex<Option<CancellationToken>>,
    released: Notify,
}

impl AccountConnection {
    pub(crate) async fn acquire(&self, session: &CancellationToken) -> Option<ConnectionGuard<'_>> {
        loop {
            let released = self.released.notified();
            {
                let mut active = super::lock_runtime(&self.active, "account connection");
                if session.is_cancelled() {
                    return None;
                }
                match &*active {
                    None => {
                        *active = Some(session.clone());
                        return Some(ConnectionGuard(self));
                    }
                    Some(previous) if !previous.is_cancelled() => return None,
                    Some(_) => {}
                }
            }
            tokio::select! {
                () = session.cancelled() => return None,
                () = released => {}
            }
        }
    }
}

pub(crate) struct ConnectionGuard<'a>(&'a AccountConnection);

impl Drop for ConnectionGuard<'_> {
    fn drop(&mut self) {
        *super::lock_runtime(&self.0.active, "account connection") = None;
        self.0.released.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn account_isolation_hands_over_the_adapter_after_teardown() {
        let connection = AccountConnection::default();
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        let old = connection.acquire(&first).await.unwrap();
        assert!(connection.acquire(&first).await.is_none());

        first.cancel();
        let handover = connection.acquire(&second);
        tokio::pin!(handover);
        assert!(futures_util::poll!(&mut handover).is_pending());
        drop(old);

        let current = handover.await.unwrap();
        assert!(connection.acquire(&first).await.is_none());
        assert!(connection.acquire(&second).await.is_none());
        drop(current);
        assert!(connection.acquire(&second).await.is_some());
    }
}
