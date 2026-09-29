//! The tournament site outside any one tournament: who this account is to the
//! service, what is waiting on it across every event, the Hall of Fame, and
//! the site administration and director console.
//!
//! The website keeps all of this beside its tournament list. The client
//! replaces the website, so it is here too, read and written through two
//! calls, [`SiteRead`] and [`SiteWrite`], because every one of these is one
//! request whose answer is either a document to show or nothing worth keeping.

use super::*;

/// This account as the tournament service sees it, from `GET /auth/faf/me`.
///
/// The roles decide which of the site's pages and consoles are offered at all,
/// and every one of them is the server's answer rather than something worked
/// out here: the service resolves them from lists the client never sees.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyAccount {
    /// Whether the service has a session for this token at all. `false` is
    /// the `user: null` answer, where every role below is off too.
    pub logged_in: bool,
    /// Whether FAF login is configured on the server (`enabled`).
    pub oauth: bool,
    pub faf_id: Option<i32>,
    pub faf_name: String,
    pub discord: String,
    /// May edit the FAQ / Rules articles.
    pub editor: bool,
    /// May import finished tournaments from Challonge.
    pub importer: bool,
    /// A global tournament director: organiser rights on every official event.
    pub director: bool,
    /// A site admin with the powers switched on: the effective flag, `false`
    /// while the account has stood down, which is what the server checks.
    pub site_admin: bool,
    /// On the site-admin list at all, stood down or not. Only the stand-down
    /// switch asks this; everything else asks [`Self::site_admin`].
    pub site_admin_account: bool,
    /// The powers are switched off: the site shows this account exactly what
    /// a normal player sees.
    pub admin_stand_down: bool,
    /// May host: approved per account, a director, or on the site-admin list.
    pub allowed: bool,
}

/// Which access an account asks for, or an admin decides on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AccessKind {
    /// Hosting tournaments.
    Host,
    /// Editing the FAQ / Rules articles.
    Editor,
    /// Importing finished tournaments from Challonge.
    Importer,
}

/// One thing waiting on this account in some tournament (`GET /api/my/pending`).
///
/// The service words each one in English with its numbers inside; the client
/// shows its own sentence per `kind` instead, and keeps the number it needs.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingItem {
    pub tournament_id: String,
    pub tournament_name: String,
    /// `invite`, `requests`, `confirm`, `join`, `draft`, `veto`, `fveto` or
    /// `checkin`; anything newer is shown by the service's own sentence.
    pub kind: String,
    /// The website tab it opens: `players`, `bracket`, `teams` or `vetoes`.
    pub tab: String,
    /// The service's own sentence, kept for a kind the client does not know.
    pub text: String,
    /// The first number in that sentence, where it has one: how many requests,
    /// players or games.
    pub count: Option<i32>,
}

/// The pending bar: what waits on this account, and for a site admin or a
/// director, the access requests nobody has answered.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingSummary {
    pub items: Vec<PendingItem>,
    /// Requests waiting, and how many of them are new since the last dismiss;
    /// `None` without the alert.
    pub requests: Option<i32>,
    pub new_requests: Option<i32>,
}

/// One row of the Hall of Fame's players: championships and entries.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HallPlayer {
    pub faf_id: i32,
    pub name: String,
    pub wins: i32,
    pub entered: i32,
}

/// One row of the Hall of Fame's teams, by name.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HallTeam {
    pub name: String,
    pub wins: i32,
}

/// `GET /api/halloffame`, already ordered by the service.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HallOfFame {
    pub players: Vec<HallPlayer>,
    pub teams: Vec<HallTeam>,
}

/// Whether this account has, or has asked for, editor or importer access.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    pub oauth: bool,
    pub logged_in: bool,
    pub allowed: bool,
    pub pending: bool,
}

/// Which parts of the console the server lets this account use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConsoleRole {
    #[default]
    Admin,
    Director,
    Editor,
}

/// An access request, of any of the three kinds.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    pub id: String,
    pub faf_id: i32,
    pub faf_name: String,
    pub message: String,
    /// Unix seconds.
    pub at: Option<u32>,
    /// `pending`, `approved` or `denied`.
    pub status: String,
    pub decided_at: Option<u32>,
    pub decided_by: String,
}

/// An account on one of the console's lists: allowed to host, an editor, an
/// importer, a director or a site admin.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListedAccount {
    pub faf_id: i32,
    pub name: String,
    pub at: Option<u32>,
    pub by: String,
    /// Site admins only: the powers are switched off.
    pub stand_down: bool,
}

/// One line of the site's audit log.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SiteLogEntry {
    pub id: String,
    pub at: Option<u32>,
    pub action: String,
    pub actor_kind: String,
    pub actor_faf_id: Option<i32>,
    pub actor_name: String,
    pub ip: String,
    pub tournament_id: String,
    pub tournament_name: String,
    pub detail: String,
}

/// An archived tournament, hidden from everyone until restored.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedTourney {
    pub id: String,
    pub name: String,
    pub status: TourneyStatus,
    pub at: Option<u32>,
    pub players: i32,
}

/// One FAQ / Rules article as the console holds it: its markdown source, and
/// whether it is archived.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AdminArticle {
    pub id: String,
    pub title: String,
    pub body: String,
    pub parent_id: Option<String>,
    pub archived: bool,
    pub updated_at: Option<u32>,
}

/// The console's whole document (`POST /api/siteadmin/data`). An editor gets
/// the articles alone; a director everything but the site-admin list.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SiteAdminData {
    pub role: ConsoleRole,
    pub oauth: bool,
    pub logs: Vec<SiteLogEntry>,
    pub host_requests: Vec<AccessRequest>,
    pub host_allowed: Vec<ListedAccount>,
    pub editor_requests: Vec<AccessRequest>,
    pub editor_allowed: Vec<ListedAccount>,
    pub importer_requests: Vec<AccessRequest>,
    pub importer_allowed: Vec<ListedAccount>,
    pub archived: Vec<ArchivedTourney>,
    pub articles: Vec<AdminArticle>,
    pub directors: Vec<ListedAccount>,
    pub site_admins: Vec<ListedAccount>,
    /// This account's FAF id, to mark "you" in the lists.
    pub me: Option<i32>,
    /// The global bans, on official tournaments.
    pub bans: Vec<TourneyBan>,
}

/// What the site part of the client can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SiteRead {
    Account,
    Pending,
    HallOfFame,
    Console,
    Access { kind: AccessKind },
}

/// A read's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SiteDocument {
    Account(TourneyAccount),
    Pending(PendingSummary),
    HallOfFame(HallOfFame),
    Console(Box<SiteAdminData>),
    #[serde(rename_all = "camelCase")]
    Access {
        kind: AccessKind,
        status: AccessStatus,
    },
}

/// One write to the site: a single request, and a reload of what it touched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SiteWrite {
    /// Switch this account's site-admin powers off (`on`) or back on.
    #[serde(rename_all = "camelCase")]
    StandDown { on: bool },
    /// Hide the access-request alert until a new request comes in.
    DismissRequests,
    /// Ask for hosting, editor or importer access, with an optional note.
    #[serde(rename_all = "camelCase")]
    RequestAccess { kind: AccessKind, message: String },
    /// Approve or deny an access request.
    #[serde(rename_all = "camelCase")]
    Decide {
        kind: AccessKind,
        id: String,
        approve: bool,
    },
    /// Take an account's access away.
    #[serde(rename_all = "camelCase")]
    Revoke { kind: AccessKind, faf_id: i32 },
    /// Give an account access without a request.
    #[serde(rename_all = "camelCase")]
    Grant {
        kind: AccessKind,
        faf_id: i32,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    SiteAdminGrant { faf_id: i32, name: String },
    #[serde(rename_all = "camelCase")]
    SiteAdminRevoke { faf_id: i32 },
    #[serde(rename_all = "camelCase")]
    DirectorGrant { faf_id: i32, name: String },
    #[serde(rename_all = "camelCase")]
    DirectorRevoke { faf_id: i32 },
    /// Keep an account out of every official tournament, or change the terms.
    #[serde(rename_all = "camelCase")]
    GlobalBan {
        faf_id: i32,
        name: String,
        reason: String,
        /// Unix seconds.
        expires: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    GlobalUnban { faf_id: i32 },
    /// Keep an account out of every edition of a series, or change the terms.
    #[serde(rename_all = "camelCase")]
    SeriesBan {
        series_id: String,
        faf_id: i32,
        name: String,
        reason: String,
        expires: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    SeriesUnban { series_id: String, faf_id: i32 },
    /// Create or change a FAQ / Rules article. No id creates.
    #[serde(rename_all = "camelCase")]
    ArticleSave {
        id: Option<String>,
        title: String,
        body: String,
        parent_id: Option<String>,
    },
    /// Archive an article, or restore an archived one.
    #[serde(rename_all = "camelCase")]
    ArticleArchive { id: String, restore: bool },
    /// Upload a picture for an article, as a `data:` URL; answers its path.
    #[serde(rename_all = "camelCase")]
    ArticleImage { data_url: String },
    /// Bring an archived tournament back. Site admins only.
    #[serde(rename_all = "camelCase")]
    Restore { tournament_id: String },
    /// Delete a tournament: permanently for a site admin, else archive it.
    #[serde(rename_all = "camelCase")]
    DeleteTournament { tournament_id: String },
    /// Pull a finished Challonge tournament in. The key is sent once and
    /// nowhere kept.
    #[serde(rename_all = "camelCase")]
    ImportChallonge { tournament: String, api_key: String },
}

impl SiteWrite {
    /// Whether the site's documents may have changed: everything but an
    /// image upload and an import, which touch the list rather than the site.
    pub fn touches_console(&self) -> bool {
        !matches!(self, Self::ArticleImage { .. })
    }
}

/// What the site holds, beside the tournaments. None of it belongs to the
/// open event, so selecting another leaves it alone.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneySite {
    pub account: TourneyAccount,
    pub pending: PendingSummary,
    pub hall: Option<HallOfFame>,
    pub hall_status: TourneyLoadStatus,
    pub console: Option<Box<SiteAdminData>>,
    pub console_status: TourneyLoadStatus,
    pub editor_access: AccessStatus,
    pub importer_access: AccessStatus,
    /// The last article picture uploaded, for the editor to insert.
    pub article_image: Option<String>,
}
