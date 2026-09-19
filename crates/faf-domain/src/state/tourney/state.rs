//! The slice: what the client holds about the tournaments tab, and the
//! actions that are in flight.

use super::*;

/// Whether this account may host a tournament at all.
///
/// Hosting is approval-only: the site admin grants it per account. Asked for
/// once and kept, because the alternative is offering a create button that
/// answers "your FAF account is not approved to host tournaments yet".
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingStatus {
    pub logged_in: bool,
    pub allowed: bool,
    /// A request is in with the site admin.
    pub pending: bool,
}

// ---------------------------------------------------------------------------
// The slice: what the tab holds, what it can be asked to do, and what happened.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyLoadStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
        kind: RequestFailureKind,
    },
}

/// A write that has not answered yet.
///
/// Carried in state rather than in the component so the whole pane can disable
/// itself while one is in flight. Two "enter tournament" clicks would otherwise
/// both reach the server, and the second comes back "You are already signed
/// up", which reads like a bug rather than a double click.
///
/// Each variant names the thing it is acting on, so a spinner can sit on the
/// one match being reported instead of over the whole bracket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyAction {
    AddingPlayer,
    /// Saving this account's own Discord handle.
    SavingProfile,
    #[serde(rename_all = "camelCase")]
    AnsweringSignup {
        player_id: String,
    },
    #[serde(rename_all = "camelCase")]
    RemovingPlayer {
        player_id: String,
    },
    /// Organiser team management, keyed by the entrant so one row's spinner does
    /// not disable the whole list.
    #[serde(rename_all = "camelCase")]
    MovingPlayer {
        player_id: String,
    },
    #[serde(rename_all = "camelCase")]
    EditingPlayer {
        player_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SettingCaptain {
        player_id: String,
    },
    Inviting,
    Reseeding,
    Dividing,
    PostingNews,
    CreatingTeam,
    #[serde(rename_all = "camelCase")]
    AnsweringTeam {
        team_id: String,
    },
    LeavingTeam,
    #[serde(rename_all = "camelCase")]
    InvitingToTeam {
        player_id: String,
    },
    RenamingTeam,
    Creating,
    Editing,
    Publishing,
    #[serde(rename_all = "camelCase")]
    Advancing {
        phase: TourneyPhase,
    },
    Archiving,
    SigningUp,
    Withdrawing,
    CheckingIn,
    #[serde(rename_all = "camelCase")]
    AnsweringReport {
        match_id: String,
    },
    #[serde(rename_all = "camelCase")]
    DecidingReport {
        match_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PostingChat {
        room_id: String,
    },
    #[serde(rename_all = "camelCase")]
    AssigningPool {
        round_key: String,
    },
    #[serde(rename_all = "camelCase")]
    Vetoing {
        match_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ReportingFfa {
        match_id: String,
    },
    Drafting,
    SavingMap,
    #[serde(rename_all = "camelCase")]
    PublishingMap {
        map_id: String,
    },
    #[serde(rename_all = "camelCase")]
    DeletingMap {
        map_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PublishingPool {
        pool_id: String,
    },
    #[serde(rename_all = "camelCase")]
    DeletingPool {
        pool_id: String,
    },
    SavingPool,
    EditingFormat,
    #[serde(rename_all = "camelCase")]
    MutingChat {
        faf_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    DeletingChatPost {
        post_id: String,
    },
    AddingOrganiser,
    #[serde(rename_all = "camelCase")]
    SettingCaster {
        faf_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    SettingOrganiserVisibility {
        faf_id: i32,
    },
    Abandoning,
    #[serde(rename_all = "camelCase")]
    EditingNews {
        news_id: String,
    },
    SavingSeries,
    #[serde(rename_all = "camelCase")]
    DeletingSeries {
        series_id: String,
    },
    SettingSeries,
    AddingQualifier,
    #[serde(rename_all = "camelCase")]
    RemovingQualifier {
        link_id: String,
    },
}

/// A write that came back refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyActionFailure {
    pub action: TourneyAction,
    /// The server's own sentence. It says which rating gate was missed or how
    /// many replay ids are still wanted, and nothing the client could write in
    /// its place would be as useful.
    pub reason: String,
    pub kind: RequestFailureKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyState {
    pub events: Vec<Tourney>,
    pub status: TourneyLoadStatus,
    /// Which event's detail pane is open.
    pub selected_id: Option<String>,
    /// The whole open event: entrants, teams, bracket, pools.
    ///
    /// Loaded separately from the list because the list carries only counts;
    /// the people and the bracket are a second, much larger request, and the
    /// list has to stay usable while it arrives.
    pub detail: Option<Tourney>,
    pub detail_status: TourneyLoadStatus,
    pub pending: Option<TourneyAction>,
    /// The last refused write. Survives until it is dismissed or another action
    /// starts, because a message that vanished on the next re-render would
    /// never be read.
    pub action_error: Option<TourneyActionFailure>,
    /// FAF accounts behind the open event's entrants.
    ///
    /// Kept beside the entrants rather than merged into them because they come
    /// from a different service: the tournament service owns the entry, FAF
    /// owns the player, and an entrant whose avatar failed to load must still
    /// appear in the bracket.
    pub entrant_profiles: Vec<PlayerSummary>,
    pub chat_rooms: Vec<ChatRoom>,
    pub open_room_id: Option<String>,
    pub chat_posts: Vec<ChatPost>,
    pub chat_status: TourneyLoadStatus,
    /// The site-wide rules pages, loaded once.
    pub articles: Vec<Article>,
    /// Whether this account may host at all, asked for once.
    pub hosting: HostingStatus,
    /// Accounts matching what the organiser is typing into an add or invite
    /// field.
    ///
    /// Kept in the slice rather than in the component because it is the answer
    /// to a request, and every other request's answer lives here too. It is also
    /// what makes adding an entrant a *choice of a person* rather than a typed
    /// string: the server matches names exactly and refuses anything it cannot
    /// find, so guessing the spelling is the failure mode this removes.
    pub account_search: AccountSearch,
    /// Every series, for the picker and the series list. Loaded on demand
    /// rather than with the tab: most visits never open a series, and the list
    /// is a second request against a different endpoint.
    pub series: Vec<TourneySeries>,
    pub series_status: TourneyLoadStatus,
    /// The open series with its editions, or `None` while the list is showing.
    pub open_series: Option<SeriesDetail>,
    /// The Discord handle this account has given the tournament service.
    ///
    /// Empty for an account that has not given one, which is the same state as
    /// having cleared it. Held per session rather than per event, because that
    /// is how the service stores it: one handle per FAF id, shown to the
    /// organisers and teammates of every event that account enters.
    pub discord: String,
    /// Where the service lives, so a relative image url can be resolved.
    ///
    /// The organiser's uploads come back as `/desc-images/{file}`, which is a
    /// path on the tournament server and nothing at all inside a desktop
    /// client. The base is a deployment setting rather than a fact about any
    /// one event, so it is carried once here rather than pasted onto every
    /// image on the way through the codec.
    pub asset_base: String,
}

/// A name-to-account search, as the organiser types.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountSearch {
    /// The text the results belong to. Held so a slower answer for an older
    /// query can be dropped rather than replacing a newer one's results.
    pub query: String,
    pub matches: Vec<PlayerSummary>,
    pub status: TourneyLoadStatus,
}

impl AccountSearch {
    /// Whether a result set for `query` is still the one being shown.
    ///
    /// Compared case-insensitively and trimmed, because that is how the query
    /// was sent: the same word typed with a stray space must not look like a
    /// different search.
    pub fn is_current(&self, query: &str) -> bool {
        self.query.trim().eq_ignore_ascii_case(query.trim())
    }
}

impl TourneyState {
    /// The FAF account behind an entrant, when the entry carries one.
    ///
    /// Not every entrant has one: an organiser can add a player by hand, and
    /// that entry has a name and nothing else.
    pub fn profile_of(&self, entrant: &TourneyPlayer) -> Option<&PlayerSummary> {
        let faf_id = entrant.faf_id?;
        self.entrant_profiles
            .iter()
            .find(|profile| profile.id == faf_id)
    }

    /// The open event, if the detail on hand is really its.
    ///
    /// Guards the window between selecting a row and its detail arriving, where
    /// the previous event's bracket would otherwise be shown under the new
    /// event's name.
    pub fn open_event(&self) -> Option<&Tourney> {
        let detail = self.detail.as_ref()?;
        (self.selected_id.as_deref() == Some(detail.id.as_str())).then_some(detail)
    }

    /// Unread messages across every room of the open event.
    pub fn unread_total(&self) -> i32 {
        self.chat_rooms.iter().map(|room| room.unread).sum()
    }

    /// The rooms still worth having open, and the finished ones behind them.
    ///
    /// The split the service asks for by sending `done` at all: a room per
    /// match piles up over a bracket, and the ones whose match is played are
    /// noise by the quarter-finals. Order is preserved inside each group,
    /// because the service already sorted it: global first, then the bracket.
    pub fn chat_groups(&self) -> (Vec<&ChatRoom>, Vec<&ChatRoom>) {
        self.chat_rooms.iter().partition(|room| !room.done)
    }

    /// Whether a collapsed "completed" group still has to announce itself.
    ///
    /// Being named by `@` in a room that is folded away would otherwise be
    /// invisible, which is the one case where hiding finished rooms costs
    /// something.
    pub fn completed_wants_attention(&self) -> bool {
        self.chat_rooms
            .iter()
            .any(|room| room.done && room.mentioned)
    }

    /// The one match a write is in flight against, if the pending write names
    /// one at all.
    ///
    /// Only the two reporting actions do; every other write is event-wide.
    /// Answered as the single id rather than tested per match because that is
    /// what a bracket needs: it reads this once and compares, instead of asking
    /// the same question of every match it draws.
    pub fn busy_match_id(&self) -> Option<&str> {
        match &self.pending {
            Some(
                TourneyAction::AnsweringReport { match_id }
                | TourneyAction::DecidingReport { match_id }
                | TourneyAction::Vetoing { match_id }
                | TourneyAction::ReportingFfa { match_id },
            ) => Some(match_id),
            _ => None,
        }
    }

    /// Whether a write is in flight against this match.
    ///
    /// One match's spinner should not disable the rest of the bracket.
    pub fn is_busy_with(&self, match_id: &str) -> bool {
        self.busy_match_id() == Some(match_id)
    }
}
