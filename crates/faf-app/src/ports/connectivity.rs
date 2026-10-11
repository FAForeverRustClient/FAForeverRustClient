//! Connectivity diagnostics port: what the connectivity check asks of this
//! machine and of the network.
//!
//! The check is a sequence of questions, each a method here, and the service
//! decides what the answers mean. Everything that touches a socket, a process
//! or a file is behind this trait, so the service is tested with a scripted
//! port and no network: see `tests/connectivity_check.rs`.
//!
//! The running adapter's own view of its peers is not here. That is a
//! question for the adapter that is running, so it is [`super::IcePort`]'s
//! `relay_status`.

use std::net::SocketAddr;

use async_trait::async_trait;
use faf_domain::protocol::stun::IceUrl;
use faf_domain::state::{IceAdapter, ProbeFailure};

/// The Java runtime the Java adapter would be started with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaRuntimeInfo {
    pub path: String,
    /// What `java -version` printed as the version, when it was readable.
    pub version: Option<String>,
    /// The feature release (`21` for `21.0.2`, `8` for `1.8.0_292`).
    pub major: Option<u32>,
}

/// A runtime that could not be started, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaRuntimeProblem {
    pub path: String,
    pub reason: String,
}

/// The Java adapter's jar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaAdapterJar {
    pub path: String,
    /// The Java feature release its main class was compiled for, when the
    /// jar could be read. A runtime older than this cannot load it.
    pub required_java: Option<u32>,
}

/// What the two adapters need on disk, as found on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterInventory {
    /// `FAF_ICE_ADAPTER_KIND`, when set: it wins over both preferences.
    pub forced: Option<IceAdapter>,
    pub java_runtime: Result<JavaRuntimeInfo, JavaRuntimeProblem>,
    pub java_adapter: Option<JavaAdapterJar>,
    /// The Pioneer executable's path, when it exists.
    pub pioneer: Option<String>,
}

/// One relay the FAF API lists as active.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayServer {
    pub id: String,
    pub region: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayListError {
    /// No FAF sign-in, or the API refused the one there is.
    NeedsSignIn,
    Unavailable(String),
}

/// The relay URLs of one game's ICE session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayAddresses {
    pub game_id: i32,
    pub urls: Vec<String>,
}

/// What the check has to test.
///
/// The FAF API hands relay addresses out per game (`/ice/session/game/{id}`)
/// and its game-free listing (`/ice/server`) names relays without saying
/// where they are, so the addresses can only be the ones a game was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnownRelayAddresses {
    /// No game has been started this session.
    None,
    Known(RelayAddresses),
    /// A game was started, but its session could not be had.
    Unavailable {
        game_id: i32,
        reason: String,
    },
}

/// A relay that answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeAnswer {
    /// A STUN Binding Success over UDP, and the address it saw us at.
    Binding {
        round_trip_ms: u32,
        public_address: Option<SocketAddr>,
    },
    /// An accepted TCP connection. Says nothing about TURN beyond the port
    /// being open.
    Connected { round_trip_ms: u32 },
}

/// The end of the newest adapter log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterLogTail {
    pub file_name: String,
    /// RFC 3339.
    pub modified_at: String,
    pub tail: String,
    /// Older lines were left out.
    pub truncated: bool,
}

#[async_trait]
pub trait ConnectivityPort: Send + Sync {
    /// The Java runtime and its version, the Java adapter's jar, and the
    /// Pioneer executable, as the launch would find them.
    async fn adapter_inventory(&self) -> AdapterInventory;

    /// `GET {api}/ice/server`: the relays the API lists as active.
    async fn relay_list(&self) -> Result<Vec<RelayServer>, RelayListError>;

    /// The relay URLs of the last game this client started.
    async fn relay_addresses(&self) -> KnownRelayAddresses;

    /// Ask one relay URL whether it answers: a STUN binding over UDP, a TCP
    /// connection otherwise. Bounded by a few seconds whatever happens.
    async fn probe(&self, url: &IceUrl) -> Result<ProbeAnswer, ProbeFailure>;

    /// The end of the newest adapter log, if there is one.
    async fn adapter_log(&self) -> Option<AdapterLogTail>;
}
