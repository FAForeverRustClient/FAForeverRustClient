//! The commands the tab sends and the events the service answers with.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyCommand {
    Load,
    #[serde(rename_all = "camelCase")]
    Select {
        tournament_id: String,
    },
    /// Enter as the signed-in player. The primary action of the whole tab.
    #[serde(rename_all = "camelCase")]
    SignUp {
        tournament_id: String,
    },
    /// Leave again. Which entry to remove is read from the open event's viewer
    /// block rather than passed in: the server hands out that id, and a client
    /// that supplied its own could only ever be wrong about it.
    #[serde(rename_all = "camelCase")]
    Withdraw {
        tournament_id: String,
    },
    #[serde(rename_all = "camelCase")]
    CheckIn {
        tournament_id: String,
    },
    /// Agree with, or refuse, the score the opponent submitted.
    ///
    /// The one report-shaped thing a player does here. Raising a result is the
    /// organiser's, but answering one raised elsewhere is not the same act, and
    /// a client that showed a pending report it could not answer would be worse
    /// than one that never showed it.
    #[serde(rename_all = "camelCase")]
    AnswerReport {
        tournament_id: String,
        match_id: String,
        accept: bool,
    },
    /// Set a result as an organiser, which needs no confirmation.
    #[serde(rename_all = "camelCase")]
    DecideReport {
        tournament_id: String,
        report: MatchReport,
    },
    /// Load the room list for the open event.
    #[serde(rename_all = "camelCase")]
    LoadChat {
        tournament_id: String,
    },
    /// Open one room and read it.
    #[serde(rename_all = "camelCase")]
    OpenRoom {
        tournament_id: String,
        room_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PostChat {
        tournament_id: String,
        room_id: String,
        body: String,
    },
    /// Re-read the open room and the room list, without saying so.
    ///
    /// The service has no push of any kind: it is HTTP, and the website polls.
    /// Without this the tab can send a message and never receive one, which
    /// looks like a working chat until somebody else types.
    ///
    /// Distinct from [`Self::OpenRoom`] because it must be silent: announcing a
    /// load every few seconds would blink the room out and back, and would
    /// fight the reader's scroll position.
    #[serde(rename_all = "camelCase")]
    RefreshChat {
        tournament_id: String,
        room_id: String,
    },
    /// Start a team and captain it.
    #[serde(rename_all = "camelCase")]
    CreateTeam {
        tournament_id: String,
        name: String,
    },
    /// Ask a team for a place. The captain answers; there is no instant join,
    /// because the server removed that path.
    #[serde(rename_all = "camelCase")]
    RequestJoin {
        tournament_id: String,
        team_id: String,
    },
    /// Withdraw an outstanding request.
    #[serde(rename_all = "camelCase")]
    CancelJoin {
        tournament_id: String,
        team_id: String,
    },
    /// Answer somebody's request, as the captain.
    #[serde(rename_all = "camelCase")]
    RespondJoin {
        tournament_id: String,
        team_id: String,
        player_id: String,
        accept: bool,
    },
    /// Ask a player to join, as the captain.
    #[serde(rename_all = "camelCase")]
    InviteToTeam {
        tournament_id: String,
        team_id: String,
        player_id: String,
    },
    /// Answer an invitation addressed to this account.
    #[serde(rename_all = "camelCase")]
    RespondInvite {
        tournament_id: String,
        team_id: String,
        accept: bool,
    },
    /// Leave the team. The last member out dissolves it, and a departing
    /// captain hands the armband to the next member.
    #[serde(rename_all = "camelCase")]
    LeaveTeam {
        tournament_id: String,
    },
    /// Take the team apart, as its captain or an organiser.
    #[serde(rename_all = "camelCase")]
    DisbandTeam {
        tournament_id: String,
        team_id: String,
    },
    #[serde(rename_all = "camelCase")]
    RenameTeam {
        tournament_id: String,
        team_id: String,
        name: String,
    },
    /// Add an entrant by FAF name, as the organiser.
    ///
    /// The name is looked up against FAF server-side; there is no free-typed
    /// entrant, which is what keeps an entry attached to a real account.
    #[serde(rename_all = "camelCase")]
    AddPlayer {
        tournament_id: String,
        name: String,
        /// Only used by an unrated tournament, where the server has no rating
        /// to fetch and asks the organiser for one.
        rating: Option<i32>,
    },
    /// Approve or decline a signup that is waiting, in request mode.
    #[serde(rename_all = "camelCase")]
    RespondSignup {
        tournament_id: String,
        player_id: String,
        accept: bool,
    },
    /// Take an entrant out, as the organiser.
    #[serde(rename_all = "camelCase")]
    RemovePlayer {
        tournament_id: String,
        player_id: String,
    },
    /// Hand the armband to another member of a team.
    #[serde(rename_all = "camelCase")]
    SetCaptain {
        tournament_id: String,
        team_id: String,
        player_id: String,
    },
    /// Move an entrant to another team, or off every team.
    ///
    /// `team_id` of `None` takes them out without removing them from the event,
    /// which is how a substitute is parked. Emptying a team dissolves it, and a
    /// departing captain's armband passes to the next member: the server does
    /// both, so the client reloads rather than guessing.
    #[serde(rename_all = "camelCase")]
    MovePlayer {
        tournament_id: String,
        player_id: String,
        team_id: Option<String>,
    },
    /// Attach a note to an entrant, and set their rating where the event has none.
    ///
    /// Renaming is deliberately absent: identity comes from FAF and the server
    /// refuses it outright. A note is how a substitute or a late arrival gets
    /// labelled. The rating is accepted only by an unrated event.
    #[serde(rename_all = "camelCase")]
    EditPlayer {
        tournament_id: String,
        player_id: String,
        note: String,
        /// Only sent by an unrated event; the server refuses it otherwise.
        rating: Option<i32>,
    },
    /// Ask somebody to enter, by FAF name.
    #[serde(rename_all = "camelCase")]
    InvitePlayer {
        tournament_id: String,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    Uninvite {
        tournament_id: String,
        faf_id: i32,
    },
    /// Set the seeding, at random or in a given order.
    #[serde(rename_all = "camelCase")]
    Reseed {
        tournament_id: String,
        order: SeedOrder,
    },
    /// Split the field into divisions by combined rating, or back to one with
    /// a count of 1.
    #[serde(rename_all = "camelCase")]
    SplitDivisions {
        tournament_id: String,
        divisions: i32,
    },
    #[serde(rename_all = "camelCase")]
    SetDivision {
        tournament_id: String,
        team_id: String,
        division: i32,
    },
    #[serde(rename_all = "camelCase")]
    PostNews {
        tournament_id: String,
        body: String,
        important: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeleteNews {
        tournament_id: String,
        news_id: String,
    },
    LoadArticles,
    /// Ask whether this account may host, which gates the create button.
    LoadHosting,
    /// Read this account's own Discord handle off the service.
    LoadProfile,
    /// Set or clear the Discord handle. Empty clears it.
    SetDiscord {
        handle: String,
    },
    /// Find FAF accounts whose name starts with what has been typed.
    ///
    /// Reuses the same batch account lookup the player card and the leaderboard
    /// read: an organiser adding an entrant is choosing a person, and the client
    /// already knows how to show one. A blank or too-short query clears the list
    /// instead of asking the API for everybody.
    SearchAccounts {
        query: String,
    },
    /// Drop the results: somebody was picked, or the field was left.
    ClearAccountSearch,
    /// Create an event. It becomes the open one, so the organiser lands in it
    /// rather than back at an unchanged list.
    Create {
        draft: TourneyDraft,
    },
    /// Change an existing event's settings. Only the fields a draft carries;
    /// the best-of plan and the veto configuration stay on the website.
    #[serde(rename_all = "camelCase")]
    EditInfo {
        tournament_id: String,
        draft: TourneyDraft,
    },
    /// Make a draft event visible to everyone.
    #[serde(rename_all = "camelCase")]
    Publish {
        tournament_id: String,
    },
    /// Move the event along: form teams, draw the bracket, or go back.
    #[serde(rename_all = "camelCase")]
    Advance {
        tournament_id: String,
        phase: TourneyPhase,
        /// The best-of plan, on `start_bracket` alone. `None` everywhere else,
        /// and on a draw that takes the service's own defaults.
        config: Option<BracketConfig>,
    },
    /// Hide the event. Restorable by a site admin, which is why it is not
    /// called delete.
    #[serde(rename_all = "camelCase")]
    Archive {
        tournament_id: String,
    },
    /// Bind a map pool to a round, or clear it with an empty `pool_id`.
    #[serde(rename_all = "camelCase")]
    AssignPool {
        tournament_id: String,
        round_key: String,
        pool_id: String,
    },
    /// Take the draft pick that is due.
    #[serde(rename_all = "camelCase")]
    DraftPickPlayer {
        tournament_id: String,
        player_id: String,
    },
    /// Take back the last pick.
    #[serde(rename_all = "camelCase")]
    DraftUndo {
        tournament_id: String,
    },
    /// Mark which entrants captain a team, before the draft starts.
    #[serde(rename_all = "camelCase")]
    SetCaptains {
        tournament_id: String,
        player_ids: Vec<String>,
    },
    /// Record a free-for-all lobby: either who went through, or the points.
    #[serde(rename_all = "camelCase")]
    ReportFfa {
        tournament_id: String,
        report: FfaReport,
    },
    /// Take the veto step that is due: ban or pick the named map.
    #[serde(rename_all = "camelCase")]
    VetoAct {
        tournament_id: String,
        match_id: String,
        /// A map id from the run's `remaining`.
        map_id: String,
    },
    /// Say which of the two teams is A, before the run starts.
    #[serde(rename_all = "camelCase")]
    VetoSetSides {
        tournament_id: String,
        match_id: String,
        team_a: String,
    },
    /// Take back the last step. The organiser's, for a misclick.
    #[serde(rename_all = "camelCase")]
    VetoUndo {
        tournament_id: String,
        match_id: String,
    },
    /// Add a map to the event's own database, or edit one already in it.
    #[serde(rename_all = "camelCase")]
    SaveMap {
        tournament_id: String,
        map: MapDraft,
    },
    /// Show or hide one map.
    #[serde(rename_all = "camelCase")]
    PublishMap {
        tournament_id: String,
        map_id: String,
        published: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeleteMap {
        tournament_id: String,
        map_id: String,
    },
    /// Show or hide one pool. Publishing also publishes the maps in it.
    #[serde(rename_all = "camelCase")]
    PublishPool {
        tournament_id: String,
        pool_id: String,
        published: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeletePool {
        tournament_id: String,
        pool_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SavePool {
        tournament_id: String,
        pool: PoolDraft,
    },
    /// Load every series, for the picker and the series list.
    LoadSeries,
    /// Open one series and read its editions.
    #[serde(rename_all = "camelCase")]
    OpenSeries {
        series_id: String,
    },
    /// Close it again, back to the list.
    CloseSeries,
    /// Create a series, or rename one that exists.
    SaveSeries {
        draft: SeriesDraft,
    },
    /// Delete a series. Its editions are unfiled, not deleted.
    #[serde(rename_all = "camelCase")]
    DeleteSeries {
        series_id: String,
    },
    /// File this event under a series, or take it out with `None`.
    #[serde(rename_all = "camelCase")]
    SetSeries {
        tournament_id: String,
        series_id: Option<String>,
    },
    /// Link an event whose result feeds entrants into this one.
    #[serde(rename_all = "camelCase")]
    AddQualifier {
        tournament_id: String,
        /// The child event.
        qualifier_id: String,
        rule: QualifierRule,
    },
    /// Unlink one. Invites it already sent are kept, which is why this is not
    /// an undo.
    #[serde(rename_all = "camelCase")]
    RemoveQualifier {
        tournament_id: String,
        /// The link's own id, not the child's.
        link_id: String,
    },
    /// Change the shape of the competition, before the bracket is drawn.
    #[serde(rename_all = "camelCase")]
    EditFormat {
        tournament_id: String,
        format: FormatDraft,
    },
    /// Silence an account in the event's chat, or let it speak again.
    #[serde(rename_all = "camelCase")]
    MuteChat {
        tournament_id: String,
        faf_id: i32,
        /// Carried so the muted list can name them: the service stores the name
        /// alongside the id, having no other way to resolve it afterwards.
        name: String,
        muted: bool,
    },
    /// Take one post out of a room.
    #[serde(rename_all = "camelCase")]
    DeleteChatPost {
        tournament_id: String,
        room_id: String,
        post_id: String,
    },
    /// Give a FAF account organiser rights here.
    ///
    /// There is no counterpart: taking them away is the site admin's, and the
    /// client cannot tell whether this account is one.
    #[serde(rename_all = "camelCase")]
    AddOrganiser {
        tournament_id: String,
        faf_id: i32,
        name: String,
    },
    /// Let a FAF account cast this event, or take that back.
    ///
    /// One command for both directions: the two service endpoints differ only
    /// in whether a name rides along, and a pair of commands could disagree
    /// about which way the flag pointed.
    #[serde(rename_all = "camelCase")]
    SetCaster {
        tournament_id: String,
        faf_id: i32,
        name: String,
        casting: bool,
    },
    /// Show or hide one organiser in the public list. They stay an organiser
    /// either way.
    #[serde(rename_all = "camelCase")]
    SetOrganiserVisibility {
        tournament_id: String,
        faf_id: i32,
        hidden: bool,
    },
    /// Mark the event as called off, or take that back.
    #[serde(rename_all = "camelCase")]
    Abandon {
        tournament_id: String,
        abandoned: bool,
    },
    /// Correct an announcement already posted.
    #[serde(rename_all = "camelCase")]
    EditNews {
        tournament_id: String,
        news_id: String,
        body: String,
        important: bool,
    },
    /// Clear this account's unread badge, on every device.
    #[serde(rename_all = "camelCase")]
    MarkNewsRead {
        tournament_id: String,
    },
    DismissActionError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyEvent {
    Loading,
    Loaded {
        events: Vec<Tourney>,
    },
    /// Where the service lives, so the tab can resolve an image path.
    ///
    /// Its own event rather than a field on `Loaded`: it is a deployment
    /// setting that cannot change while the client runs, so it is sent once
    /// with the first load and has nothing to do with what that load found.
    AssetBase {
        base: String,
    },
    LoadFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    #[serde(rename_all = "camelCase")]
    Selected {
        tournament_id: String,
    },
    DetailLoading,
    DetailLoaded {
        /// Boxed because a whole tournament is by far the largest thing this
        /// enum carries, and every other variant would be padded up to it.
        event: Box<Tourney>,
    },
    DetailLoadFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    ActionStarted {
        action: TourneyAction,
    },
    #[serde(rename_all = "camelCase")]
    ActionSucceeded {
        action: TourneyAction,
        /// The event to open afterwards, which is how a freshly created one
        /// becomes the selected row.
        select: Option<String>,
    },
    ActionFailed {
        failure: TourneyActionFailure,
    },
    ActionErrorDismissed,
    EntrantProfilesLoaded {
        profiles: Vec<PlayerSummary>,
    },
    ChatRoomsLoaded {
        rooms: Vec<ChatRoom>,
    },
    #[serde(rename_all = "camelCase")]
    RoomOpened {
        room_id: String,
    },
    ChatLoading,
    #[serde(rename_all = "camelCase")]
    ChatLoaded {
        room_id: String,
        posts: Vec<ChatPost>,
    },
    ChatFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    ArticlesLoaded {
        articles: Vec<Article>,
    },
    HostingLoaded {
        hosting: HostingStatus,
    },
    /// This account's Discord handle, as the service holds it.
    ///
    /// One event for both directions: reading it at startup and writing it from
    /// the signup dialog land the same fact, and the write answers with what was
    /// actually stored rather than with what was typed.
    DiscordLoaded {
        discord: String,
    },
    /// An account search started; the field carries the query it is for.
    AccountSearchStarted {
        query: String,
    },
    AccountSearchLoaded {
        query: String,
        matches: Vec<PlayerSummary>,
    },
    AccountSearchFailed {
        query: String,
        reason: String,
        kind: RequestFailureKind,
    },
    /// The organiser picked somebody, or left the field: drop the list.
    AccountSearchCleared,
    SeriesLoading,
    SeriesLoaded {
        series: Vec<TourneySeries>,
    },
    SeriesFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    /// One series opened, with its editions.
    SeriesOpened {
        /// Boxed for the same reason the tournament detail is: a series with
        /// its editions is the largest thing this enum carries.
        detail: Box<SeriesDetail>,
    },
    SeriesClosed,
}
