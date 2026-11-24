//! The offline bundle's ICE port (`infra::fake_ports`). In a file of its own
//! because the adapters it stands in for are not built on Android, and the
//! offline bundle is.

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::ports::{ConnectivitySession, IceParams, IcePort, RelayMsg};

/// Inert ICE port: used offline and in tests. Yields a session whose channels
/// carry nothing, so the launcher's pump idles and nothing real starts.
#[derive(Debug, Clone, Default)]
pub struct FakeIce;

#[async_trait]
impl IcePort for FakeIce {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        let (_to_lobby_tx, to_lobby_rx) = mpsc::channel::<RelayMsg>(1);
        let (from_lobby_tx, _from_lobby_rx) = mpsc::channel::<RelayMsg>(1);
        Ok(ConnectivitySession {
            game_port: 0,
            to_lobby: to_lobby_rx,
            from_lobby: from_lobby_tx,
            late_failure: None,
        })
    }
    fn stop(&self) {}
}
