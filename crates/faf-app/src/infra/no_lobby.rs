//! The Android client's ports where the desktop client has the lobby, the ICE
//! adapter and the check of that adapter's relays.
//!
//! The Android client watches replays and plays against the AI. Joining FAF
//! games, custom or matchmade, hosted or not, is the desktop client's, and on
//! Android that is decided when the client is compiled: `lobby_ws` and the ICE
//! adapters are not built there, so no setting, flag or environment variable
//! can bring them back. These stand in for them (`infra::real_ports`).
//!
//! They build on every platform, like the fakes, so the desktop tests can hold
//! the service to them: a lobby that never opens a socket and says why, which
//! the service then neither connects to nor retries, and requests that are
//! refused with that reason, whoever sends them.

use async_trait::async_trait;
use faf_domain::protocol::stun::IceUrl;
use faf_domain::state::{
    Contact, HostGameConfig, LobbyUnavailable, PlayerVeto, ProbeFailure, Relation,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::ports::{
    AdapterInventory, AdapterLogTail, ConnectivityPort, ConnectivitySession, IceParams, IcePort,
    JavaRuntimeProblem, KnownRelayAddresses, LobbyPort, LobbySendError, LobbyUpdate, ProbeAnswer,
    RelayListError, RelayServer,
};

/// Why the stand-ins below say no.
const REASON: LobbyUnavailable = LobbyUnavailable::NotInAndroidClient;

/// What the ICE stand-ins answer, where the answer is text. A clause, since
/// the connectivity check sets it into sentences of its own ("Could not run
/// java: ...").
const NO_ADAPTER: &str =
    "there is no ICE adapter in the Android client, which watches replays and plays against the AI";

/// A lobby that is never connected to and refuses every request.
///
/// The Android client's lobby service has nothing in it that would connect or
/// send, and on the desktop the service asks [`LobbyPort::unavailable`] first
/// and does neither then (`services::lobby`). Everything below is the second
/// lock on the same door: no socket, and nothing sent, whoever calls.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoLobby;

impl NoLobby {
    fn refusal() -> LobbySendError {
        LobbySendError::Unavailable(REASON)
    }
}

#[async_trait]
impl LobbyPort for NoLobby {
    async fn resolve_contacts(&self, _ids: &[i32]) -> Result<(), String> {
        Err(Self::refusal().reason().into())
    }

    fn unavailable(&self) -> Option<LobbyUnavailable> {
        Some(REASON)
    }

    /// A stream that has already ended: its sender is gone before it is
    /// handed back, which is how a port says the connection closed.
    async fn connect(&self) -> mpsc::Receiver<LobbyUpdate> {
        mpsc::channel(1).1
    }

    fn join(&self, _id: i32, _password: Option<String>) -> bool {
        false
    }

    fn host(&self, _config: HostGameConfig) -> Result<(), LobbySendError> {
        Err(Self::refusal())
    }

    fn matchmake(&self, _queue_names: &[String], _start: bool) -> Result<(), LobbySendError> {
        Err(Self::refusal())
    }

    fn leave_party(&self) {}

    fn kick_party_member(&self, _player_id: i32) {}

    fn invite_to_party(&self, _player_id: i32) {}

    fn accept_party_invite(&self, _player_id: i32) -> Result<(), LobbySendError> {
        Err(Self::refusal())
    }

    fn set_party_factions(&self, _factions: Vec<String>) {}

    fn set_contact_relation(
        &self,
        _contact: Contact,
        _member: bool,
        _remove: Option<Relation>,
    ) -> bool {
        false
    }

    fn set_player_vetoes(&self, _vetoes: Vec<PlayerVeto>) {}

    fn request_avatars(&self) -> bool {
        false
    }

    fn select_avatar(&self, _url: Option<String>) -> bool {
        false
    }

    fn restore_game_session(&self, _game_id: i32) -> bool {
        false
    }

    fn send_game_relay(&self, _command: String, _args: Vec<Value>) {}

    fn disconnect(&self) {}
}

/// An ICE port that starts nothing. A game it would bridge comes only from
/// a lobby's launch order, which [`NoLobby`] never gives.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoIce;

#[async_trait]
impl IcePort for NoIce {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        Err(NO_ADAPTER.into())
    }

    fn stop(&self) {}
}

/// The connectivity check where there is no adapter to check: no runtime, no
/// adapter on disk, no relay list asked for and no relay probed, each saying
/// why. Nothing here touches the network.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoConnectivity;

#[async_trait]
impl ConnectivityPort for NoConnectivity {
    async fn adapter_inventory(&self) -> AdapterInventory {
        AdapterInventory {
            forced: None,
            // The runtime the Java adapter would be started with, by the name
            // the lookup falls back to (`java_runtime::preferred_java_path`).
            java_runtime: Err(JavaRuntimeProblem {
                path: "java".into(),
                reason: NO_ADAPTER.into(),
            }),
            java_adapter: None,
            pioneer: None,
        }
    }

    async fn relay_list(&self) -> Result<Vec<RelayServer>, RelayListError> {
        Err(RelayListError::Unavailable(NO_ADAPTER.into()))
    }

    async fn relay_addresses(&self) -> KnownRelayAddresses {
        KnownRelayAddresses::None
    }

    async fn probe(&self, _url: &IceUrl) -> Result<ProbeAnswer, ProbeFailure> {
        Err(ProbeFailure::Network {
            reason: NO_ADAPTER.into(),
        })
    }

    async fn adapter_log(&self) -> Option<AdapterLogTail> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> IceParams {
        IceParams {
            player_id: 7,
            player_login: "Ada".into(),
            game_id: 1,
            init_mode: 0,
            game_title: "1v1".into(),
            hosted: false,
        }
    }

    #[tokio::test]
    async fn the_lobby_says_why_and_its_stream_has_already_ended() {
        let lobby = NoLobby;
        assert_eq!(
            lobby.unavailable(),
            Some(LobbyUnavailable::NotInAndroidClient)
        );
        let mut updates = lobby.connect().await;
        assert_eq!(updates.recv().await, None, "the stream carried something");
    }

    #[test]
    fn every_request_is_refused_with_the_reason() {
        let lobby = NoLobby;
        let refused = Err(LobbySendError::Unavailable(REASON));
        let config = HostGameConfig {
            title: "1v1".into(),
            mod_name: "faf".into(),
            visibility: "public".into(),
            map: "SCMP_009".into(),
            password: None,
            enforce_rating_range: false,
            rating_min: None,
            rating_max: None,
        };
        assert_eq!(lobby.host(config), refused);
        assert_eq!(lobby.matchmake(&["ladder1v1".into()], true), refused);
        assert_eq!(lobby.accept_party_invite(23), refused);
        assert!(!lobby.join(1, None));
        assert!(!lobby.request_avatars());
        assert!(!lobby.select_avatar(None));
        assert!(!lobby.restore_game_session(1));
    }

    #[tokio::test]
    async fn the_ice_port_starts_nothing_and_says_why() {
        match NoIce.start(params()).await {
            Err(reason) => assert_eq!(reason, NO_ADAPTER),
            Ok(_) => panic!("an ICE session was handed out"),
        }
    }

    #[tokio::test]
    async fn the_connectivity_check_finds_no_adapter_and_asks_nobody() {
        let check = NoConnectivity;
        let inventory = check.adapter_inventory().await;
        assert!(inventory.java_runtime.is_err());
        assert_eq!(inventory.java_adapter, None);
        assert_eq!(inventory.pioneer, None);
        assert_eq!(
            check.relay_list().await,
            Err(RelayListError::Unavailable(NO_ADAPTER.into()))
        );
        assert_eq!(check.relay_addresses().await, KnownRelayAddresses::None);
    }
}
