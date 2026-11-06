//! Explicit picker-admission decisions for the complete command surface.
//! A new command or direct payload field requires this policy to be revisited.

use faf_domain::state::settings::{GamePreferencesPatch, PathPreferencesPatch};
use faf_domain::state::{
    AuthCommand, ChangelogCommand, ChatCommand, ClanCommand, ClientUpdateCommand,
    ConnectivityCommand, CoopCommand, EventsCommand, GalacticWarCommand, GeneratorOptions,
    GuidesCommand, LeaderboardCommand, LinuxRuntimeCommand, LobbyCommand, MapGeneratorCommand,
    MapsCommand, ModsCommand, NavCommand, NotificationCommand, PlayerCardCommand, ReplayCommand,
    ReportingCommand, ReviewsCommand, SessionCommand, SettingsCommand, SocialCommand,
    StreamsCommand, TourneyCommand, TourneyRead, TourneyWrite, TrainingCommand, TutorialsCommand,
    UnitHistoryCommand, UploadsCommand,
};
use faf_domain::AppCommand;

/// Every command and every direct payload field has an explicit admission
/// decision. No catch-all or `..` patterns: adding a command or field must
/// revisit this boundary, even in the nested tournament command enums.
#[derive(Debug, PartialEq)]
pub(super) enum PathRule<'a> {
    NoSelection,
    GamePath(&'a str),
    ReplayGamePath(&'a str),
    Paths(&'a PathPreferencesPatch),
    Generator(&'a GeneratorOptions),
    Launch(&'a GamePreferencesPatch),
    ReplayFile(&'a str),
    ReplayRead(&'a str),
    Upload(Option<&'a str>),
}

pub(super) fn path_rule(command: &AppCommand) -> PathRule<'_> {
    match command {
        AppCommand::Settings(SettingsCommand::SetGamePath { path }) => PathRule::GamePath(path),
        AppCommand::Settings(SettingsCommand::SetReplayGamePath { path }) => {
            PathRule::ReplayGamePath(path)
        }
        AppCommand::Settings(SettingsCommand::PatchPaths { patch }) => PathRule::Paths(patch),
        AppCommand::Settings(SettingsCommand::SetMapGenerator { preferences }) => {
            PathRule::Generator(preferences)
        }
        AppCommand::Settings(SettingsCommand::PatchGame { patch }) => PathRule::Launch(patch),
        AppCommand::MapGenerator(
            MapGeneratorCommand::Generate { options }
            | MapGeneratorCommand::SetOptions { options }
            | MapGeneratorCommand::Preflight { options }
            | MapGeneratorCommand::SavePreset {
                name: _,
                options,
                request_id: _,
            },
        ) => PathRule::Generator(options),
        AppCommand::Replays(ReplayCommand::OpenFile { path }) => PathRule::ReplayFile(path),
        AppCommand::Replays(
            ReplayCommand::LoadDetails {
                uid: _,
                local_path: Some(path),
                request_id: _,
            }
            | ReplayCommand::LoadAnalysis {
                uid: _,
                local_path: Some(path),
                request_id: _,
            }
            | ReplayCommand::DeleteLocal { path },
        ) => PathRule::ReplayRead(path),
        AppCommand::Uploads(UploadsCommand::Open { request }) => {
            PathRule::Upload(upload_path(request))
        }
        // Local replay-note/review references and CancelReads are metadata or
        // state lookups, not file IO. Validate only computes option issues.
        AppCommand::Session(SessionCommand::Hello)
        | AppCommand::Auth(
            AuthCommand::Login { remember: _ }
            | AuthCommand::CancelLogin
            | AuthCommand::Restore
            | AuthCommand::PlayOffline
            | AuthCommand::LaunchOfflineGame
            | AuthCommand::LoginTest
            | AuthCommand::Logout
            | AuthCommand::LogoutTest,
        )
        | AppCommand::Nav(
            NavCommand::Select { tab: _ }
            | NavCommand::SelectMapsSection { section: _ }
            | NavCommand::SelectModsSection { section: _ }
            | NavCommand::SelectReplaysSection { section: _ }
            | NavCommand::SelectSettingsSection { section: _ }
            | NavCommand::SelectChangelogSection { section: _ }
            | NavCommand::SelectChangelogClientRelease { version: _ }
            | NavCommand::OpenLink { url: _ }
            | NavCommand::LinkShown { id: _ },
        )
        | AppCommand::Notifications(
            NotificationCommand::MarkRead { id: _ }
            | NotificationCommand::Dismiss { id: _ }
            | NotificationCommand::Clear,
        )
        | AppCommand::Chat(
            ChatCommand::Connect { username: _ }
            | ChatCommand::SendMessage {
                channel: _,
                content: _,
                reply_to: _,
            }
            | ChatCommand::JoinChannel { channel: _ }
            | ChatCommand::LeaveChannel { channel: _ }
            | ChatCommand::SelectChannel { channel: _ }
            | ChatCommand::SetShowJoinsParts { enabled: _ }
            | ChatCommand::SetTyping {
                channel: _,
                composing: _,
            }
            | ChatCommand::React {
                channel: _,
                msgid: _,
                emoji: _,
            }
            | ChatCommand::Unreact {
                channel: _,
                msgid: _,
                emoji: _,
            }
            | ChatCommand::Disconnect,
        )
        | AppCommand::Clan(
            ClanCommand::Load
            | ClanCommand::Create { draft: _ }
            | ClanCommand::Edit { draft: _ }
            | ClanCommand::SearchCandidates { query: _ }
            | ClanCommand::Invite {
                player_id: _,
                login: _,
            }
            | ClanCommand::ClearInvitation
            | ClanCommand::AcceptInvitation { token: _ }
            | ClanCommand::Remove { player_id: _ }
            | ClanCommand::Leave
            | ClanCommand::HandOver { player_id: _ }
            | ClanCommand::Disband,
        )
        | AppCommand::Coop(
            CoopCommand::LoadCatalog
            | CoopCommand::RefreshCatalog
            | CoopCommand::SelectMission { mission_id: _ }
            | CoopCommand::SetPlayerCount { player_count: _ },
        )
        | AppCommand::Lobby(
            LobbyCommand::Connect
            | LobbyCommand::Join {
                id: _,
                password: _,
                replace_mods: _,
            }
            | LobbyCommand::Host { config: _ }
            | LobbyCommand::PrepareHost { title: _ }
            | LobbyCommand::DeclineModReplacement
            | LobbyCommand::CancelJoin
            | LobbyCommand::ClearHostPrefill
            | LobbyCommand::Matchmake {
                queue_name: _,
                start: _,
            }
            | LobbyCommand::StartSearch { queue_names: _ }
            | LobbyCommand::LeaveParty
            | LobbyCommand::KickPartyMember { player_id: _ }
            | LobbyCommand::InviteToParty { player_id: _ }
            | LobbyCommand::AcceptPartyInvite {
                player_id: _,
                notification_id: _,
            }
            | LobbyCommand::SetPartyFactions { factions: _ }
            | LobbyCommand::SetPlayMode { mode: _ }
            | LobbyCommand::SetPlayerVetoes { vetoes: _ }
            | LobbyCommand::LoadAvatars
            | LobbyCommand::SelectAvatar { url: _ }
            | LobbyCommand::TerminateGame
            | LobbyCommand::Disconnect,
        )
        | AppCommand::Replays(
            ReplayCommand::WatchLive(_)
            | ReplayCommand::TrackLive {
                target: _,
                action: _,
            }
            | ReplayCommand::CancelLiveTracking
            | ReplayCommand::CancelWatch
            | ReplayCommand::SearchVault { query: _ }
            | ReplayCommand::LoadFeaturedMods
            | ReplayCommand::LoadRecentMatchmaker
            | ReplayCommand::WatchVault { uid: _ }
            | ReplayCommand::DownloadVault { uid: _ }
            | ReplayCommand::CancelDownload { uid: _ }
            | ReplayCommand::CancelReads {
                uid: _,
                local_path: _,
                request_id: _,
            }
            | ReplayCommand::LoadLocal { limit: _ }
            | ReplayCommand::ResolveMaps { uids: _ }
            | ReplayCommand::ResolveSimMods { uid: _ }
            | ReplayCommand::LookUpOnline { uid: _ }
            | ReplayCommand::LookUpOnlineMany { uids: _ }
            | ReplayCommand::LoadDetails {
                uid: _,
                local_path: None,
                request_id: _,
            }
            | ReplayCommand::LoadAnalysis {
                uid: _,
                local_path: None,
                request_id: _,
            },
        )
        | AppCommand::Maps(
            MapsCommand::CancelVaultLoad
            | MapsCommand::LoadVault
            | MapsCommand::SearchVault { query: _ }
            | MapsCommand::LoadInstalled
            | MapsCommand::ResolveVaultFolders { folder_names: _ }
            | MapsCommand::ResolveVaultNames { display_names: _ }
            | MapsCommand::LoadLocalPreviews { folder_names: _ }
            | MapsCommand::LoadMatchmakerPools { queue_name: _ }
            | MapsCommand::InstallMap {
                folder_name: _,
                download_url: _,
            }
            | MapsCommand::CancelInstall { folder_name: _ }
            | MapsCommand::UninstallMap { folder_name: _ }
            | MapsCommand::SetMapVersionHidden {
                version_id: _,
                hidden: _,
            },
        )
        | AppCommand::MapGenerator(
            MapGeneratorCommand::GenerateNamed { map_name: _ }
            | MapGeneratorCommand::LoadOptions { version: _ }
            | MapGeneratorCommand::Validate { options: _ }
            | MapGeneratorCommand::DecodeNames { map_names: _ }
            | MapGeneratorCommand::LoadPreviews { map_names: _ }
            | MapGeneratorCommand::LoadHelp { version: _ }
            | MapGeneratorCommand::Cancel
            | MapGeneratorCommand::LoadPresets
            | MapGeneratorCommand::RenamePreset {
                name: _,
                new_name: _,
            }
            | MapGeneratorCommand::DeletePreset { name: _ }
            | MapGeneratorCommand::CleanUp,
        )
        | AppCommand::Mods(
            ModsCommand::CancelVaultLoad
            | ModsCommand::LoadVault
            | ModsCommand::ReloadVault
            | ModsCommand::SearchVault { query: _ }
            | ModsCommand::LoadInstalled
            | ModsCommand::InstallMod {
                uid: _,
                download_url: _,
            }
            | ModsCommand::QueryDownloadSizes { targets: _ }
            | ModsCommand::UpdateMod {
                uid: _,
                folder_name: _,
                download_url: _,
            }
            | ModsCommand::CancelInstall { uid: _ }
            | ModsCommand::UninstallMod {
                folder_name: _,
                uid: _,
            }
            | ModsCommand::ToggleMod { uid: _, enabled: _ }
            | ModsCommand::SetActiveMods { uids: _ },
        )
        | AppCommand::Leaderboard(
            LeaderboardCommand::SetMode { mode: _ }
            | LeaderboardCommand::LoadCatalog
            | LeaderboardCommand::LoadRatings { query: _ }
            | LeaderboardCommand::SelectLeague { league_id: _ }
            | LeaderboardCommand::SelectSeason { season_id: _ },
        )
        | AppCommand::PlayerCard(
            PlayerCardCommand::Open {
                player_id: _,
                login: _,
            }
            | PlayerCardCommand::LookUpAccounts { query: _ }
            | PlayerCardCommand::Close
            | PlayerCardCommand::LoadHistory { query: _ }
            | PlayerCardCommand::LoadMatchmakerProfile {
                player_id: _,
                login: _,
            }
            | PlayerCardCommand::LoadMapStats {
                player_id: _,
                full: _,
            }
            | PlayerCardCommand::LoadPartyPlacements { player_ids: _ },
        )
        | AppCommand::Reporting(
            ReportingCommand::Open {
                player_id: _,
                login: _,
            }
            | ReportingCommand::OpenByLogin { login: _ }
            | ReportingCommand::Close
            | ReportingCommand::LoadHistory
            | ReportingCommand::AttachLog { game_id: _ }
            | ReportingCommand::DetachLog
            | ReportingCommand::Submit {
                player_id: _,
                login: _,
                description: _,
                game_id: _,
                incident_time: _,
                attach_log: _,
            },
        )
        | AppCommand::Reviews(
            ReviewsCommand::Open { target: _ }
            | ReviewsCommand::Close
            | ReviewsCommand::Submit { score: _, text: _ }
            | ReviewsCommand::Delete,
        )
        | AppCommand::Social(
            SocialCommand::SetContactsOpen { open: _ }
            | SocialCommand::ResolveContacts
            | SocialCommand::SetRelation {
                player_id: _,
                login: _,
                relation: _,
                member: _,
            }
            | SocialCommand::LookUpLogin { login: _ },
        )
        | AppCommand::Streams(StreamsCommand::Check)
        | AppCommand::Tourney(
            TourneyCommand::Read(
                TourneyRead::Load
                | TourneyRead::Select { tournament_id: _ }
                | TourneyRead::RefreshDetail { tournament_id: _ }
                | TourneyRead::CheckRating { tournament_id: _ }
                | TourneyRead::LoadPlayerRatings {
                    tournament_id: _,
                    player_id: _,
                    refresh: _,
                }
                | TourneyRead::LoadCopySources
                | TourneyRead::LoadPresets
                | TourneyRead::LoadSite { read: _ }
                | TourneyRead::LoadTemplate { tournament_id: _ }
                | TourneyRead::LoadCopySource { tournament_id: _ }
                | TourneyRead::LoadChat { tournament_id: _ }
                | TourneyRead::OpenRoom {
                    tournament_id: _,
                    room_id: _,
                }
                | TourneyRead::RefreshChat {
                    tournament_id: _,
                    room_id: _,
                }
                | TourneyRead::PinRoom {
                    tournament_id: _,
                    room_id: _,
                }
                | TourneyRead::LoadArticles
                | TourneyRead::LoadHosting
                | TourneyRead::LoadProfile
                | TourneyRead::SetDiscord { handle: _ }
                | TourneyRead::SearchAccounts { query: _ }
                | TourneyRead::ClearAccountSearch
                | TourneyRead::CheckRenames { tournament_id: _ }
                | TourneyRead::LoadSeries
                | TourneyRead::OpenSeries { series_id: _ }
                | TourneyRead::CloseSeries
                | TourneyRead::MarkNewsRead { tournament_id: _ }
                | TourneyRead::DismissActionError,
            )
            | TourneyCommand::Write(
                TourneyWrite::SignUp {
                    tournament_id: _,
                    rating: _,
                }
                | TourneyWrite::DeclineInvite { tournament_id: _ }
                | TourneyWrite::UploadDescImage {
                    tournament_id: _,
                    data_url: _,
                    request_id: _,
                }
                | TourneyWrite::SiteWrite { write: _ }
                | TourneyWrite::BanPlayer {
                    tournament_id: _,
                    player_id: _,
                    faf_id: _,
                    name: _,
                    reason: _,
                    expires: _,
                    remove: _,
                }
                | TourneyWrite::Withdraw { tournament_id: _ }
                | TourneyWrite::CheckIn {
                    tournament_id: _,
                    checked_in: _,
                }
                | TourneyWrite::AnswerReport {
                    tournament_id: _,
                    match_id: _,
                    accept: _,
                }
                | TourneyWrite::DecideReport {
                    tournament_id: _,
                    report: _,
                }
                | TourneyWrite::SubmitReport {
                    tournament_id: _,
                    report: _,
                }
                | TourneyWrite::PostChat {
                    tournament_id: _,
                    room_id: _,
                    body: _,
                    reply_to: _,
                }
                | TourneyWrite::CreateTeam {
                    tournament_id: _,
                    name: _,
                }
                | TourneyWrite::RequestJoin {
                    tournament_id: _,
                    team_id: _,
                }
                | TourneyWrite::CancelJoin {
                    tournament_id: _,
                    team_id: _,
                }
                | TourneyWrite::RespondJoin {
                    tournament_id: _,
                    team_id: _,
                    player_id: _,
                    accept: _,
                }
                | TourneyWrite::InviteToTeam {
                    tournament_id: _,
                    team_id: _,
                    player_id: _,
                }
                | TourneyWrite::RespondInvite {
                    tournament_id: _,
                    team_id: _,
                    accept: _,
                }
                | TourneyWrite::LeaveTeam { tournament_id: _ }
                | TourneyWrite::DisbandTeam {
                    tournament_id: _,
                    team_id: _,
                }
                | TourneyWrite::RenameTeam {
                    tournament_id: _,
                    team_id: _,
                    name: _,
                }
                | TourneyWrite::AddPlayer {
                    tournament_id: _,
                    name: _,
                    rating: _,
                }
                | TourneyWrite::RespondSignup {
                    tournament_id: _,
                    player_id: _,
                    accept: _,
                }
                | TourneyWrite::RemovePlayer {
                    tournament_id: _,
                    player_id: _,
                }
                | TourneyWrite::SetCaptain {
                    tournament_id: _,
                    team_id: _,
                    player_id: _,
                }
                | TourneyWrite::MovePlayer {
                    tournament_id: _,
                    player_id: _,
                    team_id: _,
                }
                | TourneyWrite::EditPlayer {
                    tournament_id: _,
                    player_id: _,
                    note: _,
                    rating: _,
                }
                | TourneyWrite::InvitePlayer {
                    tournament_id: _,
                    name: _,
                }
                | TourneyWrite::Uninvite {
                    tournament_id: _,
                    faf_id: _,
                }
                | TourneyWrite::Reseed {
                    tournament_id: _,
                    order: _,
                }
                | TourneyWrite::SplitDivisions {
                    tournament_id: _,
                    divisions: _,
                }
                | TourneyWrite::SetDivision {
                    tournament_id: _,
                    team_id: _,
                    division: _,
                }
                | TourneyWrite::PostNews {
                    tournament_id: _,
                    body: _,
                    important: _,
                }
                | TourneyWrite::DeleteNews {
                    tournament_id: _,
                    news_id: _,
                }
                | TourneyWrite::Create { draft: _ }
                | TourneyWrite::EditInfo {
                    tournament_id: _,
                    draft: _,
                }
                | TourneyWrite::Publish { tournament_id: _ }
                | TourneyWrite::Advance {
                    tournament_id: _,
                    phase: _,
                    config: _,
                }
                | TourneyWrite::Archive { tournament_id: _ }
                | TourneyWrite::AssignPool {
                    tournament_id: _,
                    round_key: _,
                    pool_id: _,
                }
                | TourneyWrite::DraftPickPlayer {
                    tournament_id: _,
                    player_id: _,
                }
                | TourneyWrite::DraftUndo { tournament_id: _ }
                | TourneyWrite::SetCaptains {
                    tournament_id: _,
                    player_ids: _,
                }
                | TourneyWrite::ReportFfa {
                    tournament_id: _,
                    report: _,
                }
                | TourneyWrite::VetoAct {
                    tournament_id: _,
                    match_id: _,
                    map_id: _,
                }
                | TourneyWrite::VetoSetSides {
                    tournament_id: _,
                    match_id: _,
                    team_a: _,
                }
                | TourneyWrite::VetoUndo {
                    tournament_id: _,
                    match_id: _,
                }
                | TourneyWrite::FactionVeto {
                    tournament_id: _,
                    match_id: _,
                    game: _,
                    faction: _,
                }
                | TourneyWrite::SetFactionVeto {
                    tournament_id: _,
                    config: _,
                }
                | TourneyWrite::Administer {
                    tournament_id: _,
                    change: _,
                }
                | TourneyWrite::SaveMap {
                    tournament_id: _,
                    map: _,
                }
                | TourneyWrite::PublishMap {
                    tournament_id: _,
                    map_id: _,
                    published: _,
                }
                | TourneyWrite::DeleteMap {
                    tournament_id: _,
                    map_id: _,
                }
                | TourneyWrite::PublishPool {
                    tournament_id: _,
                    pool_id: _,
                    published: _,
                }
                | TourneyWrite::DeletePool {
                    tournament_id: _,
                    pool_id: _,
                }
                | TourneyWrite::SavePool {
                    tournament_id: _,
                    pool: _,
                }
                | TourneyWrite::SaveSeries { draft: _ }
                | TourneyWrite::DeleteSeries { series_id: _ }
                | TourneyWrite::SetSeries {
                    tournament_id: _,
                    series_id: _,
                }
                | TourneyWrite::AddQualifier {
                    tournament_id: _,
                    qualifier_id: _,
                    rule: _,
                }
                | TourneyWrite::RemoveQualifier {
                    tournament_id: _,
                    link_id: _,
                }
                | TourneyWrite::EditFormat {
                    tournament_id: _,
                    format: _,
                }
                | TourneyWrite::MuteChat {
                    tournament_id: _,
                    faf_id: _,
                    name: _,
                    muted: _,
                }
                | TourneyWrite::DeleteChatPost {
                    tournament_id: _,
                    room_id: _,
                    post_id: _,
                }
                | TourneyWrite::AddOrganiser {
                    tournament_id: _,
                    faf_id: _,
                    name: _,
                }
                | TourneyWrite::SetCaster {
                    tournament_id: _,
                    faf_id: _,
                    name: _,
                    casting: _,
                }
                | TourneyWrite::SetOrganiserVisibility {
                    tournament_id: _,
                    faf_id: _,
                    hidden: _,
                }
                | TourneyWrite::Abandon {
                    tournament_id: _,
                    abandoned: _,
                }
                | TourneyWrite::EditNews {
                    tournament_id: _,
                    news_id: _,
                    body: _,
                    important: _,
                },
            ),
        )
        | AppCommand::Training(
            TrainingCommand::Load
            | TrainingCommand::SetQuery { query: _ }
            | TrainingCommand::Select { resource_id: _ }
            | TrainingCommand::ReadGuide { resource_id: _ }
            | TrainingCommand::OpenReview {
                replay_uid: _,
                local_path: _,
            }
            | TrainingCommand::ComposeReview { draft: _ }
            | TrainingCommand::CloseReview
            | TrainingCommand::OpenContribution
            | TrainingCommand::ChangeContribution { draft: _ }
            | TrainingCommand::ComposeContribution { draft: _ }
            | TrainingCommand::CloseContribution
            | TrainingCommand::LaunchLesson { resource_id: _ }
            | TrainingCommand::CancelLessonLaunch,
        )
        | AppCommand::Tutorials(
            TutorialsCommand::CancelLaunch
            | TutorialsCommand::Load
            | TutorialsCommand::Select { tutorial_id: _ }
            | TutorialsCommand::Launch { tutorial_id: _ },
        )
        | AppCommand::Changelog(
            ChangelogCommand::Search { query: _ }
            | ChangelogCommand::Load
            | ChangelogCommand::Select { id: _ },
        )
        | AppCommand::UnitHistory(
            UnitHistoryCommand::LoadList
            | UnitHistoryCommand::Select { id: _ }
            | UnitHistoryCommand::SetSelection { ids: _ },
        )
        | AppCommand::Events(
            EventsCommand::Load
            | EventsCommand::SetView { view: _ }
            | EventsCommand::SetAnchor { day: _ }
            | EventsCommand::SetQuery { query: _ }
            | EventsCommand::Select { occurrence_id: _ }
            | EventsCommand::Remind {
                occurrence_id: _,
                title: _,
                starts_at: _,
                lead_minutes: _,
            }
            | EventsCommand::Forget { occurrence_id: _ },
        )
        | AppCommand::Uploads(
            UploadsCommand::Close
            | UploadsCommand::SetRanked { ranked: _ }
            | UploadsCommand::Start
            | UploadsCommand::Cancel,
        )
        | AppCommand::GalacticWar(
            GalacticWarCommand::CancelInstall
            | GalacticWarCommand::Refresh
            | GalacticWarCommand::RefreshStatistics
            | GalacticWarCommand::Install
            | GalacticWarCommand::Play,
        )
        | AppCommand::LinuxRuntime(LinuxRuntimeCommand::Prepare | LinuxRuntimeCommand::Cancel)
        | AppCommand::Guides(
            GuidesCommand::Restore
            | GuidesCommand::SignIn
            | GuidesCommand::CancelSignIn
            | GuidesCommand::SignOut
            | GuidesCommand::LoadQueue
            | GuidesCommand::Accept { number: _ }
            | GuidesCommand::Reject {
                number: _,
                reason: _,
                note: _,
            }
            | GuidesCommand::Submit {
                draft: _,
                images: _,
            },
        )
        | AppCommand::ClientUpdate(
            ClientUpdateCommand::Check
            | ClientUpdateCommand::Download
            | ClientUpdateCommand::CancelDownload
            | ClientUpdateCommand::Install
            | ClientUpdateCommand::Dismiss
            | ClientUpdateCommand::LoadNotes
            | ClientUpdateCommand::DismissWhatsNew,
        )
        | AppCommand::Settings(
            SettingsCommand::Load
            | SettingsCommand::SetTheme { theme: _ }
            | SettingsCommand::PatchGeneral { patch: _ }
            | SettingsCommand::PatchAppearance { patch: _ }
            | SettingsCommand::SetPlayerNote {
                player_id: _,
                login: _,
                note: _,
            }
            | SettingsCommand::SetReplayNote {
                replay_id: _,
                local_path: _,
                comment: _,
                tags: _,
            }
            | SettingsCommand::RenameReplayTag { from: _, to: _ }
            | SettingsCommand::PatchNotifications { patch: _ }
            | SettingsCommand::RemoveNotificationSound { name: _ }
            | SettingsCommand::PatchChat { patch: _ }
            | SettingsCommand::PatchDiscord { patch: _ }
            | SettingsCommand::PatchConnectivity { patch: _ }
            | SettingsCommand::PatchDebug { patch: _ }
            | SettingsCommand::PatchUpdates { patch: _ }
            | SettingsCommand::PatchBrowsing { patch: _ }
            | SettingsCommand::PatchEvents { patch: _ }
            | SettingsCommand::SetListMember {
                list: _,
                value: _,
                member: _,
            }
            | SettingsCommand::SetPlayerNameColor {
                player: _,
                color: _,
            }
            | SettingsCommand::SaveModPreset { preset: _ }
            | SettingsCommand::DeleteModPreset { name: _ }
            | SettingsCommand::SaveSearchPreset { preset: _ }
            | SettingsCommand::DeleteSearchPreset { list: _, name: _ }
            | SettingsCommand::CheckInstalls
            | SettingsCommand::RefreshGameCache
            | SettingsCommand::ClearGameCache,
        )
        | AppCommand::Connectivity(
            ConnectivityCommand::RunCheck | ConnectivityCommand::RefreshRelayStatus,
        ) => PathRule::NoSelection,
    }
}

fn upload_path(request: &faf_domain::state::UploadRequest) -> Option<&str> {
    let faf_domain::state::UploadRequest {
        kind: _,
        folder_name: _,
        display_name: _,
        ranked: _,
        source_path,
        rename_to: _,
    } = request;
    source_path.as_deref()
}
