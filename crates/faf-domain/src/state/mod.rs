//! Application state: the single source of truth.
//!
//! [`AppState`] is pure aggregation of independent slices. It has no behaviour
//! beyond holding slices; mutation happens only through [`crate::reduce`].
//! Add a feature by adding a slice module here (see ARCHITECTURE.md §8).

pub mod auth;
pub mod chat;
pub mod client_update;
pub mod coop;
pub mod failure;
pub mod galactic_war;
pub mod install;
pub mod leaderboard;
pub mod lobby;
pub mod map_generator;
pub mod maps;
pub mod mods;
pub mod nav;
pub mod notifications;
pub mod player_card;
pub mod replays;
pub mod reporting;
pub mod reviews;
pub mod session;
pub mod settings;
pub mod social;
pub mod tournaments;
pub mod tutorials;
pub mod uploads;

pub use auth::{AuthCommand, AuthEvent, AuthMode, AuthState, AuthStatus, Player};
pub use chat::{
    auto_join_channels, language_channel, mentions, normalize_channels, read_marker_key,
    ChatChannel, ChatCommand, ChatEvent, ChatMessage, ChatMessageKind, ChatState, ChatStatus,
    ChatUser, DEFAULT_CHANNEL,
};
pub use client_update::{
    compare_versions, is_release_version, should_update, strip_version_prefix, ClientRelease,
    ClientUpdateCommand, ClientUpdateEvent, ClientUpdateState, ClientUpdateStatus, ReleaseChannel,
};
pub use coop::{
    missions_of, rank_results, CoopCategory, CoopCommand, CoopEvent, CoopFaction, CoopMission,
    CoopResult, CoopScenario, CoopState, CoopStatus, ANY_PLAYER_COUNT, PLAYER_COUNT_OPTIONS,
};
pub use failure::RequestFailureKind;
pub use galactic_war::{
    ClientVersions, GalacticWarAlltime, GalacticWarCommand, GalacticWarEvent, GalacticWarFaction,
    GalacticWarSeason, GalacticWarState, GalacticWarStatistics, GalacticWarStatus,
    StatisticsStatus,
};
pub use install::{InstallEvent, InstallState};
pub use leaderboard::{
    LeaderboardCommand, LeaderboardEntry, LeaderboardEvent, LeaderboardMode, LeaderboardState,
    LeaderboardStatus, LeaderboardTier, League, LeagueSeason, RatingLeaderboard, RatingPage,
    RatingQuery, SeasonLeaderboard,
};
pub use lobby::{
    AvailableAvatar, AvatarListStatus, Game, GameLaunch, HostGameConfig, JoinState, LobbyCommand,
    LobbyEvent, LobbyState, LobbyStatus, MatchmakerQueue, MatchmakingState, PartyMember,
    PartyState, PlayMode, PlayerVeto,
};
pub use map_generator::{
    GenerationType, GeneratorOptionLists, GeneratorOptionQuery, GeneratorOptions, GeneratorStatus,
    GeneratorVersion, MapGeneratorCommand, MapGeneratorEvent, MapGeneratorState,
};
pub use maps::{
    InstalledMap, MapInstallStatus, MapListStatus, MapsCommand, MapsEvent, MapsState,
    MatchmakerMapPool, MatchmakerPoolMap, VaultMap,
};
pub use mods::{
    InstalledMod, ModInstallStatus, ModListStatus, ModToggleStatus, ModType, ModsCommand,
    ModsEvent, ModsState, VaultMod,
};
pub use nav::{NavCommand, NavEvent, NavState, Tab};
pub use notifications::{
    ClientNotification, NotificationAction, NotificationCommand, NotificationEvent,
    NotificationKind, NotificationState,
};
pub use player_card::{
    ClanMember, MatchmakerPlayerProfile, PlayerAchievement, PlayerAchievementState, PlayerAvatar,
    PlayerCardCommand, PlayerCardEvent, PlayerCardProfile, PlayerCardState, PlayerCardStatus,
    PlayerClan, PlayerEventCount, PlayerLeaguePlacement, PlayerNameRecord, PlayerRatingSummary,
    RatingHistoryPage, RatingHistoryPeriod, RatingHistoryPoint, RatingHistoryQuery,
};
pub use replays::{
    live_replay_delay_remaining, LiveReplayTarget, LiveReplayTracking, LiveReplayTrackingAction,
    LocalReplay, LocalReplayPlayer, LocalReplayStatus, LocalReplayTeam, ReplayCommand, ReplayEvent,
    ReplayPlayer, ReplayQuery, ReplaySortField, ReplayState, ReplayStatus, ReplayTeam, VaultReplay,
    VaultStatus, LIVE_REPLAY_DELAY_SECONDS,
};
pub use reporting::{
    ModerationReportSummary, ReportHistoryStatus, ReportStatus, ReportingCommand, ReportingEvent,
    ReportingState,
};
pub use reviews::{
    clamp_score, own_review, summarize, Review, ReviewKind, ReviewSubmitStatus, ReviewSummary,
    ReviewTarget, ReviewsCommand, ReviewsEvent, ReviewsState, ReviewsStatus, MAX_SCORE, MIN_SCORE,
};
pub use session::{ConnectionStatus, SessionCommand, SessionEvent, SessionState};
pub use settings::{
    AppearancePreferences, BrowsingPreferences, ChatNameColors, ChatPreferences,
    ConnectivityPreferences, CustomGameBrowserPreferences, CustomGameFilterConstraint,
    CustomGameFilterField, CustomGameFilterRule, CustomGameSort, CustomGameView,
    DiscordPreferences, GamePreferences, GeneralPreferences, HostGamePreferences, IceAdapter,
    LiveReplayFilters, NotificationPreferences, PlayerNote, SettingsCommand, SettingsEvent,
    SettingsState, SocialPreferences, Theme, UiDensity, UpdatePreferences,
};
pub use social::{
    PlayerLobbyRating, PlayerProfile, Relation, SocialCommand, SocialEvent, SocialState,
};
pub use tournaments::{
    sort_tournaments, Tournament, TournamentStatus, TournamentsCommand, TournamentsEvent,
    TournamentsState, TournamentsStatus,
};
pub use tutorials::{
    tutorials_of, Tutorial, TutorialCategory, TutorialLaunchStatus, TutorialsCommand,
    TutorialsEvent, TutorialsState, TutorialsStatus, TUTORIALS_FEATURED_MOD,
};
pub use uploads::{
    is_safe_folder_name, UploadKind, UploadRequest, UploadStatus, UploadsCommand, UploadsEvent,
    UploadsState,
};

use serde::{Deserialize, Serialize};
use specta::Type;

/// The complete client state. One field per domain slice.
// No `Eq`: `ReplayState` carries an `f32` (vault replay review score).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub session: SessionState,
    pub install: InstallState,
    pub auth: AuthState,
    pub nav: NavState,
    pub notifications: NotificationState,
    pub chat: ChatState,
    pub coop: CoopState,
    pub lobby: LobbyState,
    pub replays: ReplayState,
    pub maps: MapsState,
    pub map_generator: MapGeneratorState,
    pub mods: ModsState,
    pub leaderboard: LeaderboardState,
    pub player_card: PlayerCardState,
    pub reporting: ReportingState,
    pub reviews: ReviewsState,
    pub social: SocialState,
    pub tournaments: TournamentsState,
    pub tutorials: TutorialsState,
    pub uploads: UploadsState,
    pub galactic_war: GalacticWarState,
    pub client_update: ClientUpdateState,
    pub settings: SettingsState,
}
