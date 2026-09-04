//! Application state: the single source of truth.
//!
//! [`AppState`] is pure aggregation of independent slices. It has no behaviour
//! beyond holding slices; mutation happens only through [`crate::reduce`].
//! Add a feature by adding a slice module here (see ARCHITECTURE.md §8).

pub mod auth;
pub mod changelog;
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
pub mod tourney;
pub mod tutorials;
pub mod uploads;

pub use auth::{AuthCommand, AuthEvent, AuthMode, AuthState, AuthStatus, Player};
pub use changelog::{
    ChangelogCommand, ChangelogEntryStatus, ChangelogEvent, ChangelogState, ChangelogStatus,
};
pub use chat::{
    auto_join_channels, language_channel, mentions, normalize_channels, player_total_games,
    read_marker_key, ChatChannel, ChatCommand, ChatEvent, ChatMessage, ChatMessageKind, ChatState,
    ChatStatus, ChatUser, MessageReactions, Reaction, TypingNotice, DEFAULT_CHANNEL,
    DEFAULT_NEWBIE_THRESHOLD, NEWBIE_CHANNEL, TYPING_TIMEOUT_SECONDS,
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
pub use install::{InstallEvent, InstallState, ResolvedPaths};
pub use leaderboard::{
    LeaderboardCommand, LeaderboardEntry, LeaderboardEvent, LeaderboardMode, LeaderboardState,
    LeaderboardStatus, LeaderboardTier, League, LeagueSeason, RatingLeaderboard, RatingPage,
    RatingQuery, SeasonLeaderboard,
};
pub use lobby::{
    AvailableAvatar, AvatarListStatus, Game, GameLaunch, HostGameConfig, JoinState, LobbyCommand,
    LobbyEvent, LobbyState, LobbyStatus, MatchmakerQueue, MatchmakingState, PartyMember,
    PartyState, PlayMode, PlayerVeto, RatingRange,
};
pub use map_generator::{
    is_valid_preset_name, preset_file_name, DecodedMapName, DecodedStyle, GenerationType,
    GeneratorOptionLists, GeneratorOptionQuery, GeneratorOptions, GeneratorPreset, GeneratorStatus,
    GeneratorVersion, MapGeneratorCommand, MapGeneratorEvent, MapGeneratorState, StyleConstraints,
    ValidationIssue, MAX_PRESET_NAME,
};
pub use maps::{
    InstalledMap, LocalMapPreview, MapInstallStatus, MapListStatus, MapVisibilityStatus,
    MapsCommand, MapsEvent, MapsState, MatchmakerMapPool, MatchmakerPoolMap, VaultMap,
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
    aggregate_map_stats, ClanMember, MatchmakerPlayerProfile, PlayedGame, PlayerAchievement,
    PlayerAchievementState, PlayerAvatar, PlayerCardCommand, PlayerCardEvent, PlayerCardProfile,
    PlayerCardState, PlayerCardStatus, PlayerClan, PlayerEventCount, PlayerLeaguePlacement,
    PlayerMapStat, PlayerMapStats, PlayerNameRecord, PlayerRatingSummary, PlayerSummary,
    RatingHistoryPage, RatingHistoryPeriod, RatingHistoryPoint, RatingHistoryQuery,
};
pub use replays::{
    live_replay_delay_remaining, LiveReplayTarget, LiveReplayTracking, LiveReplayTrackingAction,
    LocalReplay, LocalReplayPlayer, LocalReplayStatus, LocalReplayTeam, ReplayChatMessage,
    ReplayCommand, ReplayDetails, ReplayEvent, ReplayGameOption, ReplayPlayer, ReplayQuery,
    ReplaySortField, ReplayState, ReplayStatus, ReplayTeam, VaultReplay, VaultStatus,
    LIVE_REPLAY_DELAY_SECONDS,
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
    AppearancePreferences, BrowsingPreferences, CachedGameVersion, ChatNameColors, ChatPreferences,
    ConnectivityPreferences, CustomGameBrowserPreferences, CustomGameFilterConstraint,
    CustomGameFilterField, CustomGameFilterRule, CustomGameSort, CustomGameView, DebugPreferences,
    DiscordPreferences, GameCacheInfo, GamePreferences, GeneralPreferences, HostGamePreferences,
    IceAdapter, LiveReplayFilters, NotificationPreferences, PathPreferences, PlayerNote,
    SettingsCommand, SettingsEvent, SettingsState, SocialPreferences, Theme, UiDensity,
    UpdatePreferences,
};
pub use social::{
    PlayerLobbyRating, PlayerProfile, Relation, SocialCommand, SocialEvent, SocialState,
};
pub use tourney::{
    map_key, match_vault_map, Article, AuditEntry, BracketKind, BracketSide, ChatMute, ChatPost,
    ChatRoom, Competition, DraftRejection, Formation, HostingStatus, InviteStatus, MapDraft,
    MapPool, MatchLink, MatchReport, MatchStatus, NewsPost, Organiser, PendingReport, PoolAction,
    PoolAssignment, PoolDraft, PoolRejection, PoolSide, PoolStep, RatingGate, RatingKind,
    SeedOrder, Seeding, SignupMode, Standing, StandingOutcome, StandingsKind, TeamExit,
    TeamRequest, Tourney, TourneyAction, TourneyActionFailure, TourneyCategory, TourneyCommand,
    TourneyDraft, TourneyEvent, TourneyInvite, TourneyLoadStatus, TourneyMap, TourneyMatch,
    TourneyPhase, TourneyPlayer, TourneyState, TourneyStatus, TourneyTeam, TourneyViewer,
};
pub use tourney::{
    BracketConfig, Caster, Currency, FeedsInto, FormatDraft, MatchPlan, Prize, Qualifier,
    QualifierKind, QualifierRejection, QualifierRule, RoomBadge, RoundKey, RoundPlan, SeriesColour,
    SeriesDetail, SeriesDraft, SeriesEdition, Stream, TourneySeries, BEST_OF_CHOICES,
};
pub use tourney::{
    Draft, DraftPick, FfaConfig, FfaMode, FfaReport, MatchVeto, TeamPoints, VetoChoice, VetoConfig,
    VetoDecider, VetoMode, VetoTurn,
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
    pub tourney: TourneyState,
    pub tutorials: TutorialsState,
    pub uploads: UploadsState,
    pub galactic_war: GalacticWarState,
    pub client_update: ClientUpdateState,
    pub settings: SettingsState,
    pub changelog: ChangelogState,
}
