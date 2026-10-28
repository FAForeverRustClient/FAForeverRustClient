//! Tournament proposals (#569): a player builds an event the way they want
//! it played and proposes it to the TD team, and a tournament director takes
//! it over and runs it, or declines it with what is missing.
//!
//! The website added this in FAForever/faf-tournaments#7 (its decision 59).
//! A proposal is an ordinary unpublished draft with a `proposal` record on it:
//! `draft` while its proposer builds it, `proposed` while it waits for a
//! director, `taken` once one runs it. Every time here is Unix seconds; the
//! service sends milliseconds.

use super::*;

/// Where a proposal stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProposalState {
    /// Being built, or back with its proposer.
    #[default]
    Draft,
    /// Waiting for a tournament director; nothing in it can change.
    Proposed,
    /// A director took it over and runs it.
    Taken,
}

/// The last thing that happened to a proposal: who declined it, gave it back,
/// or let it come back by not deciding.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalStep {
    /// The service's word: `declined`, `timeout`, `withdrawn`, `released`,
    /// `taken`, `proposed`, `unlocked maps`, `unlocked format`.
    pub act: String,
    pub by_name: String,
    pub at: Option<u32>,
    pub reason: String,
}

/// A proposal as one viewer may see it.
///
/// The detail sends the whole record to its proposer, its organisers and the
/// directors, and only `credit` to anyone else once the event is out; the
/// list sends a short form of it (`prop`) on unpublished rows. One type for
/// the three, with what a reader was not sent left empty.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyProposal {
    /// `None` for the public view, which is only the credit.
    pub state: Option<ProposalState>,
    /// Who proposed it.
    pub by_name: String,
    pub proposed_at: Option<u32>,
    /// When it goes back to its proposer if no director decides.
    pub until: Option<u32>,
    /// How many days a proposal waits, the site's setting.
    pub days: i32,
    /// The director must keep the maps, pools and vetoes as proposed.
    pub lock_maps: bool,
    /// The director must keep the format and bracket as proposed.
    pub lock_format: bool,
    /// The proposer stays a co-organiser once it is taken over.
    pub keep: bool,
    /// The proposer's note to the TD team.
    pub note: String,
    pub taken_by_name: String,
    pub taken_at: Option<u32>,
    /// The director's note to the proposer, on taking it over.
    pub take_note: String,
    pub last: Option<ProposalStep>,
    /// This account proposed it.
    pub mine: bool,
    /// This account is one of its named organisers.
    pub organizer: bool,
    pub can_submit: bool,
    pub can_withdraw: bool,
    /// Take it over or decline it: a director who neither proposed it nor
    /// organises it.
    pub can_decide: bool,
    /// Turn it back into an ordinary draft that its proposer hosts.
    pub can_drop: bool,
    /// Give it back to its proposer.
    pub can_release: bool,
    /// Lift a lock the proposer asked for.
    pub can_unlock: bool,
    /// "Proposed by X and run by the TD team", on the published event.
    pub credit: String,
}

/// One proposal waiting for a director, as the console lists it: enough of
/// the event to decide on, without opening it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalCard {
    pub tournament_id: String,
    pub name: String,
    pub by_name: String,
    pub proposed_at: Option<u32>,
    pub until: Option<u32>,
    pub note: String,
    pub lock_maps: bool,
    pub lock_format: bool,
    pub keep: bool,
    /// Proposed or organised by this account, so another director decides.
    pub mine: bool,
    pub competition: Competition,
    pub team_size: i32,
    pub bracket_kind: BracketKind,
    /// The planned start, if the proposer set one.
    pub event_date: Option<u32>,
    pub event_days: i32,
    pub signup_mode: SignupMode,
    pub max_teams: i32,
    pub min_teams: i32,
    pub rating_kind: RatingKind,
    pub min_rating: Option<i32>,
    pub max_rating: Option<i32>,
    pub map_count: i32,
    /// Each pool as "name: maps".
    pub pools: Vec<String>,
    pub prize: Option<Prize>,
    pub rewards: String,
    pub description: String,
}

/// One decision in the console's "Recent decisions".
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDecision {
    pub tournament_id: String,
    pub name: String,
    /// The same words as [`ProposalStep::act`].
    pub act: String,
    pub by_name: String,
    pub at: Option<u32>,
    pub reason: String,
    pub proposer: String,
}

/// The console's Proposals tab.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalQueue {
    pub pending: Vec<ProposalCard>,
    pub recent: Vec<ProposalDecision>,
    /// How many days a proposal waits, and the site's default for it.
    pub days: i32,
    pub days_default: i32,
}

/// How a director runs a proposal they take over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProposalArea {
    /// The maps, map pools and vetoes.
    Maps,
    /// The format and bracket.
    Format,
}
