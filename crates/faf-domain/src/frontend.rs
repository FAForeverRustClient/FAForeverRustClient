//! Authoritative updates for the window's state mirror.
//!
//! Small slices are replaced after Rust reduces them. Large/live slices retain
//! compact deltas until their measured update contracts can be narrowed safely.
//! Settings replace only the changed, already-normalized preference group.

use crate::protocol::map_generator::GeneratorOptions;
use crate::state::settings::MapPoolsSeen;
use crate::state::*;
use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(test)]
mod tests;
use crate::{AppEvent, AppState};

fn boxed<T: Clone>(value: &T) -> Box<T> {
    Box::new(value.clone())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "event")]
pub enum FrontendUpdate {
    Session(Box<SessionState>),
    Auth(Box<AuthState>),
    /// Auth changes together with the reset chat and notification slices.
    AccountSession(Box<AccountSessionUpdate>),
    Nav(Box<NavState>),
    Notifications(Box<NotificationState>),
    Clan(Box<ClanState>),
    Reporting(Box<ReportingState>),
    Reviews(Box<ReviewsState>),
    Streams(Box<StreamsState>),
    Tutorials(Box<TutorialsState>),
    GalacticWar(Box<GalacticWarState>),
    LinuxRuntime(Box<LinuxRuntimeState>),
    Install(Box<InstallState>),
    Connectivity(Box<ConnectivityState>),
    Settings(Box<SettingsUpdate>),
    Chat(Box<ChatEvent>),
    Lobby(Box<LobbyEvent>),
    Replays(Box<ReplayEvent>),
    Maps(Box<MapsEvent>),
    Mods(Box<ModsEvent>),
    Social(Box<SocialEvent>),
    Tourney(Box<TourneyEvent>),
    Changelog(Box<ChangelogEvent>),
    UnitHistory(Box<UnitHistoryEvent>),
    ClientUpdate(Box<ClientUpdateEvent>),
    Guides(Box<GuidesEvent>),
    Uploads(Box<UploadsEvent>),
    Training(Box<TrainingEvent>),
    PlayerCard(Box<PlayerCardEvent>),
    Leaderboard(Box<LeaderboardEvent>),
    MapGenerator(Box<MapGeneratorEvent>),
    Events(Box<EventsEvent>),
    Coop(Box<CoopEvent>),
}

impl FrontendUpdate {
    /// Capture under the same state guard as reduction and revision assignment.
    /// The match and destructuring require an explicit choice for a new slice.
    pub fn capture(state: &AppState, event: &AppEvent) -> Option<Self> {
        let AppState {
            session,
            auth,
            nav,
            notifications,
            clan,
            reporting,
            reviews,
            streams,
            tutorials,
            galactic_war,
            linux_runtime,
            install,
            connectivity,
            chat,
            lobby,
            replays,
            maps,
            mods,
            social,
            tourney,
            changelog,
            unit_history,
            client_update,
            guides,
            uploads,
            training,
            player_card,
            leaderboard,
            map_generator,
            events,
            coop,
            settings,
        } = state;
        // Live slice values are deliberately not copied into their deltas.
        let _ = (
            chat,
            lobby,
            replays,
            maps,
            mods,
            social,
            tourney,
            changelog,
            unit_history,
            client_update,
            guides,
            uploads,
            training,
            player_card,
            leaderboard,
            map_generator,
            events,
            coop,
        );
        match event {
            AppEvent::Session(_) => Some(Self::Session(boxed(session))),
            AppEvent::Auth(event) if event.resets_account_activity() => {
                Some(Self::AccountSession(Box::new(AccountSessionUpdate {
                    auth: auth.clone(),
                    chat: chat.clone(),
                    notifications: notifications.clone(),
                })))
            }
            AppEvent::Auth(_) => Some(Self::Auth(boxed(auth))),
            AppEvent::Nav(_) => Some(Self::Nav(boxed(nav))),
            AppEvent::Notifications(_) => Some(Self::Notifications(boxed(notifications))),
            AppEvent::Clan(_) => Some(Self::Clan(boxed(clan))),
            AppEvent::Reporting(_) => Some(Self::Reporting(boxed(reporting))),
            AppEvent::Reviews(_) => Some(Self::Reviews(boxed(reviews))),
            AppEvent::Streams(_) => Some(Self::Streams(boxed(streams))),
            AppEvent::Tutorials(_) => Some(Self::Tutorials(boxed(tutorials))),
            AppEvent::GalacticWar(_) => Some(Self::GalacticWar(boxed(galactic_war))),
            AppEvent::LinuxRuntime(_) => Some(Self::LinuxRuntime(boxed(linux_runtime))),
            AppEvent::Install(_) => Some(Self::Install(boxed(install))),
            AppEvent::Connectivity(_) => Some(Self::Connectivity(boxed(connectivity))),
            AppEvent::Settings(event) => Some(Self::Settings(Box::new(
                SettingsUpdate::after_reduce(settings, event),
            ))),
            AppEvent::Chat(_) => None,
            AppEvent::Lobby(_) => None,
            AppEvent::Replays(_) => None,
            AppEvent::Maps(_) => None,
            AppEvent::Mods(_) => None,
            AppEvent::Social(_) => None,
            AppEvent::Tourney(_) => None,
            AppEvent::Changelog(_) => None,
            AppEvent::UnitHistory(_) => None,
            AppEvent::ClientUpdate(_) => None,
            AppEvent::Guides(_) => None,
            AppEvent::Uploads(_) => None,
            AppEvent::Training(_) => None,
            AppEvent::PlayerCard(_) => None,
            AppEvent::Leaderboard(_) => None,
            AppEvent::MapGenerator(_) => None,
            AppEvent::Events(_) => None,
            AppEvent::Coop(_) => None,
        }
    }

    /// Move compact deltas into the window message without copying their payload.
    pub fn from_delta(event: AppEvent) -> Option<Self> {
        match event {
            AppEvent::Chat(event) => Some(Self::Chat(Box::new(event))),
            AppEvent::Lobby(event) => Some(Self::Lobby(Box::new(event))),
            AppEvent::Replays(event) => Some(Self::Replays(Box::new(event))),
            AppEvent::Maps(event) => Some(Self::Maps(Box::new(event))),
            AppEvent::Mods(event) => Some(Self::Mods(Box::new(event))),
            AppEvent::Social(event) => Some(Self::Social(Box::new(event))),
            AppEvent::Tourney(event) => Some(Self::Tourney(Box::new(event))),
            AppEvent::Changelog(event) => Some(Self::Changelog(Box::new(event))),
            AppEvent::UnitHistory(event) => Some(Self::UnitHistory(Box::new(event))),
            AppEvent::ClientUpdate(event) => Some(Self::ClientUpdate(Box::new(event))),
            AppEvent::Guides(event) => Some(Self::Guides(Box::new(event))),
            AppEvent::Uploads(event) => Some(Self::Uploads(Box::new(event))),
            AppEvent::Training(event) => Some(Self::Training(Box::new(event))),
            AppEvent::PlayerCard(event) => Some(Self::PlayerCard(Box::new(event))),
            AppEvent::Leaderboard(event) => Some(Self::Leaderboard(Box::new(event))),
            AppEvent::MapGenerator(event) => Some(Self::MapGenerator(Box::new(event))),
            AppEvent::Events(event) => Some(Self::Events(Box::new(event))),
            AppEvent::Coop(event) => Some(Self::Coop(Box::new(event))),
            AppEvent::Session(_)
            | AppEvent::Auth(_)
            | AppEvent::Nav(_)
            | AppEvent::Notifications(_)
            | AppEvent::Clan(_)
            | AppEvent::Reporting(_)
            | AppEvent::Reviews(_)
            | AppEvent::Streams(_)
            | AppEvent::Tutorials(_)
            | AppEvent::GalacticWar(_)
            | AppEvent::LinuxRuntime(_)
            | AppEvent::Install(_)
            | AppEvent::Connectivity(_)
            | AppEvent::Settings(_) => None,
        }
    }

    /// The kinds [`Self::from_delta`] carries, exported to the frontend as
    /// `DELTA_EVENT_KINDS`. Written out because a `const` cannot be derived
    /// from the matches above; the conformance fixture generator checks every
    /// event variant against it (a kind is listed exactly when `capture`
    /// returns `None`), and it refuses a variant without a case.
    pub const DELTA_KINDS: &'static [&'static str] = &[
        "Chat",
        "Lobby",
        "Replays",
        "Maps",
        "Mods",
        "Social",
        "Tourney",
        "Changelog",
        "UnitHistory",
        "ClientUpdate",
        "Guides",
        "Uploads",
        "Training",
        "PlayerCard",
        "Leaderboard",
        "MapGenerator",
        "Events",
        "Coop",
    ];
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountSessionUpdate {
    pub auth: AuthState,
    pub chat: ChatState,
    pub notifications: NotificationState,
}

/// Preference-group assignments, not another implementation of normalization.
/// Changing one group never resends unrelated player notes or browsing history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "field", content = "value", rename_all = "camelCase")]
pub enum SettingsUpdate {
    All(Box<SettingsState>),
    Theme(Box<Theme>),
    GamePath(Box<String>),
    ReplayGamePath(Box<String>),
    Paths(Box<PathPreferences>),
    General(Box<GeneralPreferences>),
    Appearance(Box<AppearancePreferences>),
    Social(Box<SocialPreferences>),
    Notifications(Box<NotificationPreferences>),
    Chat(Box<ChatPreferences>),
    Game(Box<GamePreferences>),
    Discord(Box<DiscordPreferences>),
    WebLink(Box<WebLinkPreferences>),
    Connectivity(Box<ConnectivityPreferences>),
    Debug(Box<DebugPreferences>),
    Updates(Box<UpdatePreferences>),
    Browsing(Box<BrowsingPreferences>),
    Events(Box<EventsPreferences>),
    KeptGeneratedMaps(Box<Vec<String>>),
    MapGenerator(Box<GeneratorOptions>),
    MatchmakerVetoes(Box<Vec<PlayerVeto>>),
    MapPoolsSeen(Box<Vec<MapPoolsSeen>>),
    AvatarHistory(Box<Vec<String>>),
    CacheInfo(Box<GameCacheInfo>),
}

impl SettingsUpdate {
    fn after_reduce(state: &SettingsState, event: &SettingsEvent) -> Self {
        match event {
            SettingsEvent::Loaded { .. } => Self::All(boxed(state)),
            SettingsEvent::ThemeChanged { .. } => Self::Theme(boxed(&state.theme)),
            SettingsEvent::GamePathChanged { .. } => Self::GamePath(boxed(&state.game_path)),
            SettingsEvent::ReplayGamePathChanged { .. } => {
                Self::ReplayGamePath(boxed(&state.replay_game_path))
            }
            SettingsEvent::PathsChanged { .. } => Self::Paths(boxed(&state.paths)),
            SettingsEvent::GeneralChanged { .. } => Self::General(boxed(&state.general)),
            SettingsEvent::AppearanceChanged { .. } => Self::Appearance(boxed(&state.appearance)),
            SettingsEvent::SocialChanged { .. } => Self::Social(boxed(&state.social)),
            SettingsEvent::NotificationsChanged { .. } => {
                Self::Notifications(boxed(&state.notifications))
            }
            SettingsEvent::ChatChanged { .. } => Self::Chat(boxed(&state.chat)),
            SettingsEvent::GameChanged { .. } => Self::Game(boxed(&state.game)),
            SettingsEvent::DiscordChanged { .. } => Self::Discord(boxed(&state.discord)),
            SettingsEvent::WebLinkChanged { .. } => Self::WebLink(boxed(&state.web_link)),
            SettingsEvent::ConnectivityChanged { .. } => {
                Self::Connectivity(boxed(&state.connectivity))
            }
            SettingsEvent::DebugChanged { .. } => Self::Debug(boxed(&state.debug)),
            SettingsEvent::UpdatesChanged { .. } => Self::Updates(boxed(&state.updates)),
            SettingsEvent::BrowsingChanged { .. } => Self::Browsing(boxed(&state.browsing)),
            SettingsEvent::EventsChanged { .. } => Self::Events(boxed(&state.events)),
            SettingsEvent::KeptGeneratedMaps { .. } => {
                Self::KeptGeneratedMaps(boxed(&state.kept_generated_maps))
            }
            SettingsEvent::MapGeneratorChanged { .. } => {
                Self::MapGenerator(boxed(&state.map_generator))
            }
            SettingsEvent::MatchmakerVetoesChanged { .. } => {
                Self::MatchmakerVetoes(boxed(&state.matchmaker_vetoes))
            }
            SettingsEvent::MapPoolsSeen { .. } => Self::MapPoolsSeen(boxed(&state.map_pools_seen)),
            SettingsEvent::AvatarHistoryChanged { .. } => {
                Self::AvatarHistory(boxed(&state.avatar_history))
            }
            SettingsEvent::CacheInfoUpdated { .. } => Self::CacheInfo(boxed(&state.cache_info)),
        }
    }
}
