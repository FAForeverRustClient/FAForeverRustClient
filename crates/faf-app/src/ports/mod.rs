//! Port traits: the external boundaries of the application.
//!
//! Each external system becomes a trait here, implemented in [`crate::infra`]
//! and mocked in tests. Services depend on these traits, never on concrete IO.
//! See ARCHITECTURE.md §5 for the full Port table.

pub mod auth;
pub mod chat;
pub mod client_update;
pub mod coop;
pub mod discord;
pub mod error;
pub mod ice;
pub mod leaderboard;
pub mod lobby;
pub mod map_generator;
pub mod maps;
pub mod mods;
pub mod player_card;
pub mod process;
pub mod replay;
pub mod reporting;
pub mod reviews;
pub mod settings;
pub mod tournaments;
pub mod tutorials;
pub mod updater;
pub mod uploads;

pub use auth::{AuthError, AuthPort, AuthResult};
pub use chat::{ChatPort, ChatUpdate};
pub use client_update::{ClientUpdatePort, DownloadProgress};
pub use coop::CoopPort;
pub use discord::{DiscordPort, DiscordRequest};
pub use error::RequestError;
pub use ice::{ConnectivitySession, IceParams, IcePort, RelayMsg};
pub use leaderboard::LeaderboardPort;
pub use lobby::{LobbyPort, LobbyUpdate, ServerNoticeStyle};
pub use map_generator::{GeneratorUpdate, MapGeneratorPort};
pub use maps::MapsPort;
pub use mods::ModsPort;
pub use player_card::PlayerCardPort;
pub use process::{DiscoveredInstallPaths, GameLaunchParams, InstallPresence, ProcessPort};
pub use replay::{ReplayPort, VaultSearchResult};
pub use reporting::{GameParticipation, ReportPlayerRequest, ReportingPort};
pub use reviews::{ReviewPage, ReviewsPort};
pub use settings::SettingsPort;
pub use tournaments::TournamentsPort;
pub use tutorials::TutorialsPort;
pub use updater::{GamePreparation, GameUpdaterPort, PreparationStep, UpdateProgress};
pub use uploads::UploadsPort;

use std::sync::Arc;

/// The bundle of ports injected into every service via [`crate::ServiceCtx`].
///
/// Cheap to clone (everything behind `Arc`). Grows one field per external system.
#[derive(Clone)]
pub struct Ports {
    pub auth: Arc<dyn AuthPort>,
    pub chat: Arc<dyn ChatPort>,
    pub coop: Arc<dyn CoopPort>,
    pub discord: Arc<dyn DiscordPort>,
    pub lobby: Arc<dyn LobbyPort>,
    pub settings: Arc<dyn SettingsPort>,
    /// Connectivity + launch ports. Authenticated sessions use real adapters;
    /// the explicit offline/test port set supplies inert fakes. The GPGNet
    /// relay server is an internal detail of the Go adapter backend, so it is
    /// no longer a top-level port.
    pub ice: Arc<dyn IcePort>,
    pub process: Arc<dyn ProcessPort>,
    /// Brings the live install up to date before a launch. Paired with
    /// `process`: it patches the very install `process` is about to run.
    pub updater: Arc<dyn GameUpdaterPort>,
    pub replay: Arc<dyn ReplayPort>,
    pub maps: Arc<dyn MapsPort>,
    pub map_generator: Arc<dyn MapGeneratorPort>,
    pub mods: Arc<dyn ModsPort>,
    pub leaderboard: Arc<dyn LeaderboardPort>,
    pub player_card: Arc<dyn PlayerCardPort>,
    pub reporting: Arc<dyn ReportingPort>,
    pub reviews: Arc<dyn ReviewsPort>,
    pub tournaments: Arc<dyn TournamentsPort>,
    pub tutorials: Arc<dyn TutorialsPort>,
    pub uploads: Arc<dyn UploadsPort>,
    /// Replaces the *client*, not the game. Distinct from `updater` above,
    /// which patches the Forged Alliance install.
    pub client_update: Arc<dyn ClientUpdatePort>,
    /// True when `auth` is the offline stub rather than real FAF OAuth.
    ///
    /// A property of the bundle rather than of any one port: it is how the
    /// shell tells the UI that credential-free affordances are meaningful in
    /// this build. Against real ports the test login fabricates a player the
    /// server has never heard of, so the UI must not offer it.
    pub offline_auth: bool,
    /// The user's language as the OS reports it, read once at startup, empty
    /// when the platform does not say.
    ///
    /// Also a bundle property rather than a port: it is a single immutable
    /// string, and threading it here keeps `services` free of environment
    /// reads, so the auto-join tests do not depend on the locale of whichever
    /// machine runs them. Selects FAF's language channel; see
    /// [`faf_domain::state::language_channel`].
    pub os_language: String,
}
