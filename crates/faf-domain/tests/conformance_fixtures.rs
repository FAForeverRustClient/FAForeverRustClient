//! Generates the conformance fixture the frontend reducer is tested against.
//!
//! `ui/src/store/reducers/*.ts` are hand-written twins of the reducers in
//! `state/`. TypeScript's exhaustive `switch` catches a *missing* variant;
//! nothing catches the same variant taking a different transition, and nothing
//! reconciles the two at runtime (`src-tauri` re-sends a full snapshot only on
//! broadcast lag). One such divergence has already shipped: `userLeft` created
//! a chat channel in TS that the Rust reducer leaves alone.
//!
//! Rather than hand-write a TS test per slice: which would check the twin
//! against *someone's reading* of the Rust, the same reading that produced the
//! divergence: this records what `reduce` actually does and makes the
//! frontend replay it.
//!
//! Running `cargo test` rewrites the fixture. A reducer change therefore shows
//! up as a **failing frontend test** until the twin is updated, which is
//! exactly the signal that was missing.

use faf_domain::state::*;
use faf_domain::{reduce, AppEvent, AppState};
use serde::Serialize;
use serde_json::Value;

/// One scenario: a sequence of events applied to the default state, with the
/// state recorded after each.
///
/// Sequences rather than isolated events, because ordering is where the
/// interesting behaviour lives: "opened, then a reply for the *previous*
/// subject arrives" cannot be expressed as a single event.
#[derive(Serialize)]
struct Case {
    name: String,
    steps: Vec<Step>,
}

#[derive(Serialize)]
struct Step {
    event: AppEvent,
    /// The owning state slice afterwards. The frontend also verifies that all
    /// other slices equal their pre-event values, which preserves the
    /// cross-slice guard without repeating the full AppState for every step.
    expected: Value,
}

#[derive(Serialize)]
struct Fixture {
    /// Rust's `AppState::default()`. The frontend's hand-written `INITIAL`
    /// must equal this, or every session starts from a state the backend has
    /// never been in.
    initial: AppState,
    cases: Vec<Case>,
    helpers: HelperFixture,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperFixture {
    review_summaries: Vec<ReviewSummaryCase>,
    upload_busy: Vec<UploadBusyCase>,
    player_note_lookups: Vec<PlayerNoteLookupCase>,
    galactic_war_actions: Vec<GalacticWarActionCase>,
    tourney_rules: Vec<TourneyRuleCase>,
    tourney_open_events: Vec<TourneyOpenEventCase>,
    tourney_phase_legality: Vec<TourneyPhaseLegalityCase>,
    tourney_busy_matches: Vec<TourneyBusyMatchCase>,
    tourney_draft_rejections: Vec<TourneyDraftRejectionCase>,
    tourney_reports: Vec<TourneyReportCase>,
    tourney_map_matches: TourneyMapMatchFixture,
}

#[derive(Serialize)]
struct ReviewSummaryCase {
    reviews: Vec<Review>,
    expected: ReviewSummary,
}

#[derive(Serialize)]
struct UploadBusyCase {
    status: UploadStatus,
    expected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerNoteLookupCase {
    notes: Vec<PlayerNote>,
    player_id: i32,
    expected: String,
}

/// What the Galactic War panel derives from its slice.
///
/// The panel decides between "install", "update", "play" and "already
/// running" from these three answers, so a twin that drifts silently offers
/// the wrong button rather than failing visibly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GalacticWarActionCase {
    state: GalacticWarState,
    install_target: String,
    update_available: bool,
    can_launch: bool,
}

/// What the tournament panes gate their controls on.
///
/// These rules decide whether a "join this team" button is drawn, whether the
/// seeding section exists, and how many entrants are waiting on the organiser.
/// The frontend re-derives every one of them from the same event, so a twin that
/// drifts offers a control the server then refuses: the player fills in a form
/// and loses it. Recorded per event rather than per function so one fixture
/// entry pins the whole rule set against the same input.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyRuleCase {
    name: String,
    event: Box<Tourney>,
    /// Team id the team-scoped rules were asked about, when the event has one.
    team_id: Option<String>,
    team_rating: i32,
    would_exceed_team_cap: bool,
    self_organised: bool,
    may_reseed: bool,
    /// `Tourney::may_shuffle_teams`: whether the organiser may still move people
    /// between teams. Refused once the bracket exists.
    may_shuffle_teams: bool,
    /// `Tourney::may_set_rating`: only an unrated event takes a typed rating.
    may_set_rating: bool,
    pending_signup_ids: Vec<String>,
    /// `Tourney::members` of the team above, in the order it holds them: a twin
    /// that iterated the entrant list instead would produce a different order.
    member_ids: Vec<String>,
    /// `Tourney::my_invites`: the teams waiting on *this* account's answer.
    my_invite_team_ids: Vec<String>,
    /// `TourneyState::unread_total` over the rooms below.
    rooms: Vec<ChatRoom>,
    unread_total: i32,
}

/// The stale-detail guard: a detail is only the open event's if the selection
/// still names it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyOpenEventCase {
    detail_id: Option<String>,
    selected_id: Option<String>,
    /// The id `TourneyState::open_event` yields, or `None` for no open event.
    open_id: Option<String>,
}

/// Which match, if any, a pending write belongs to.
///
/// Only the three reporting actions name one; everything else is event-wide and
/// must leave the rest of the bracket alone.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyBusyMatchCase {
    pending: Option<TourneyAction>,
    busy_match_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyPhaseLegalityCase {
    phase: TourneyPhase,
    status: TourneyStatus,
    legal: bool,
}

/// Why the server would refuse a draft, and in which order.
///
/// The *first* refusal is the one the form shows, so the order matters as much
/// as the rules: a draft with two problems must name the same one the server
/// would. Held here because `DraftRejection` never reaches `AppState` and so is
/// absent from the generated bindings — the frontend spells the union out by
/// hand, which is exactly the kind of copy that drifts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyDraftRejectionCase {
    name: String,
    draft: Box<TourneyDraft>,
    /// `None` when the server would take it.
    rejection: Option<DraftRejection>,
    submittable: bool,
}

/// Whether the server will take a match report.
///
/// The highest-stakes rule in the tab: a twin that says yes where the Rust says
/// no throws away a player's reported score, and one that says no where the Rust
/// says yes blocks a result that would have been accepted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyReportCase {
    name: String,
    /// Only the fields both rules read.
    entry: TourneyReportEntry,
    score1: i32,
    score2: i32,
    replay_ids: Vec<String>,
    new_games: i32,
    submittable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyReportEntry {
    best_of: i32,
    handicap: i32,
    score1: Option<i32>,
    score2: Option<i32>,
}

/// Resolving an organiser's hand-typed map name against FAF's vault.
///
/// Pinned because the two sides fold the name differently by construction: Rust
/// filters on `char::is_alphanumeric`, the frontend on a `\p{L}|\p{N}` regex.
/// They agree today, and a divergence would not fail anything: it would silently
/// drop the map preview for one spelling, which reads as a vault gap rather than
/// as a bug.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyMapMatchFixture {
    /// The vault both sides resolve against.
    vault: Vec<TourneyMapVaultEntry>,
    cases: Vec<TourneyMapMatchCase>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TourneyMapVaultEntry {
    display_name: String,
    folder_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TourneyMapMatchCase {
    /// The name as an organiser typed it into the tournament's map database.
    typed: String,
    /// `map_key` of that name.
    key: String,
    /// The vault entry it resolves to, or `None` for a map never uploaded.
    resolved_display_name: Option<String>,
}

fn galactic_war_state(
    installed: Option<&str>,
    versions: Option<(&str, Option<&str>)>,
    status: GalacticWarStatus,
    below_minimum: bool,
) -> GalacticWarState {
    GalacticWarState {
        status,
        installed_version: installed.map(Into::into),
        versions: versions.map(|(required, latest)| ClientVersions {
            required_version: required.into(),
            latest_version: latest.map(Into::into),
        }),
        below_minimum,
        ..Default::default()
    }
}

fn review(id: i32, score: i32, player: &str) -> Review {
    Review {
        id,
        score,
        text: String::new(),
        player: player.into(),
        version: "1".into(),
    }
}

fn tourney_player(
    id: &str,
    rating: Option<i32>,
    team: Option<&str>,
    pending: bool,
) -> TourneyPlayer {
    TourneyPlayer {
        id: id.into(),
        name: id.to_uppercase(),
        faf_id: None,
        rating,
        rating_actual: rating,
        team_id: team.map(Into::into),
        manual: false,
        late: false,
        pending,
        note: String::new(),
        signed_at: None,
    }
}

fn tourney_team(id: &str, players: &[&str]) -> TourneyTeam {
    TourneyTeam {
        id: id.into(),
        name: id.to_uppercase(),
        seed: 0,
        captain_id: players.first().map(|first| (*first).to_string()),
        player_ids: players.iter().map(|id| (*id).to_string()).collect(),
        division: 0,
        checked_in: false,
        eliminated: false,
        final_rank: None,
        captain_renamed: false,
        join_requests: Vec::new(),
        invites: Vec::new(),
    }
}

/// One rule case, with every rule read off the same event.
fn tourney_rule_case(
    name: &str,
    event: Tourney,
    team_id: Option<&str>,
    rooms: Vec<ChatRoom>,
) -> TourneyRuleCase {
    let team = team_id.and_then(|id| event.team(id)).cloned();
    let state = TourneyState {
        chat_rooms: rooms.clone(),
        ..TourneyState::default()
    };
    TourneyRuleCase {
        name: name.to_string(),
        team_id: team_id.map(Into::into),
        team_rating: team.as_ref().map_or(0, |team| event.team_rating(team)),
        would_exceed_team_cap: team
            .as_ref()
            .is_some_and(|team| event.would_exceed_team_cap(team)),
        self_organised: event.teams_are_self_organised(),
        may_reseed: event.may_reseed(),
        may_shuffle_teams: event.may_shuffle_teams(),
        may_set_rating: event.may_set_rating(),
        pending_signup_ids: event
            .pending_signups()
            .into_iter()
            .map(|player| player.id.clone())
            .collect(),
        member_ids: team.as_ref().map_or_else(Vec::new, |team| {
            event
                .members(team)
                .into_iter()
                .map(|player| player.id.clone())
                .collect()
        }),
        my_invite_team_ids: event
            .my_invites()
            .into_iter()
            .map(|team| team.id.clone())
            .collect(),
        unread_total: state.unread_total(),
        rooms,
        event: Box::new(event),
    }
}

fn tourney_rule_cases() -> Vec<TourneyRuleCase> {
    // An open 2v2 taking signups, with a combined-rating ceiling that this
    // account would push `t1` over but not `t2`.
    let capped = Tourney {
        id: "cap".into(),
        status: TourneyStatus::Signup,
        formation: Formation::Open,
        team_size: 2,
        rating: RatingGate {
            max_team: Some(3_000),
            ..RatingGate::default()
        },
        players: vec![
            tourney_player("me", Some(1_600), None, false),
            tourney_player("p1", Some(1_800), Some("t1"), false),
            tourney_player("p2", Some(900), Some("t2"), false),
            // No rating at all: must count as nothing rather than break the sum.
            tourney_player("p3", None, Some("t2"), false),
            tourney_player("p9", Some(1_000), None, true),
        ],
        teams: vec![
            tourney_team("t1", &["p1"]),
            // Has asked this account to join: the one thing in the teams pane
            // that is waiting on the reader rather than on somebody else.
            TourneyTeam {
                invites: vec![TeamRequest {
                    player_id: "me".into(),
                    name: "ME".into(),
                    at: None,
                }],
                ..tourney_team("t2", &["p2", "p3"])
            },
        ],
        viewer: TourneyViewer {
            logged_in: true,
            signed_up_player_id: Some("me".into()),
            ..TourneyViewer::default()
        },
        ..Tourney::default()
    };
    let under_cap = Tourney {
        id: "under".into(),
        ..capped.clone()
    };
    // Teams formed, bracket not drawn: the one window seeds can change in.
    let drafted = Tourney {
        id: "drafted".into(),
        status: TourneyStatus::Drafted,
        formation: Formation::Open,
        team_size: 2,
        players: vec![tourney_player("p1", Some(1_500), Some("t1"), false)],
        teams: vec![tourney_team("t1", &["p1"])],
        ..Tourney::default()
    };
    // A solo event: nothing to form, so no team controls at all, and no seeding
    // either until teams exist.
    let solo = Tourney {
        id: "solo".into(),
        status: TourneyStatus::Signup,
        formation: Formation::Solo,
        team_size: 1,
        players: vec![tourney_player("p1", Some(1_500), None, true)],
        ..Tourney::default()
    };

    // The organiser's own view of the same drafted event: this is where team
    // shuffling is offered, and nowhere else.
    let organised = Tourney {
        id: "organised".into(),
        viewer: TourneyViewer {
            logged_in: true,
            organiser: true,
            ..TourneyViewer::default()
        },
        ..drafted.clone()
    };
    // The same, once the bracket exists: the draw was made from these teams, so
    // the service refuses to move anyone.
    let organised_running = Tourney {
        id: "organised-running".into(),
        status: TourneyStatus::Running,
        ..organised.clone()
    };
    // An unrated event, which is the only kind that takes a typed rating.
    let unrated = Tourney {
        id: "unrated".into(),
        rating_kind: RatingKind::None,
        ..organised.clone()
    };

    vec![
        tourney_rule_case(
            "an open 2v2 where joining would break the team cap",
            capped,
            Some("t1"),
            vec![tourney_room("global", 3), tourney_room("m1", 1)],
        ),
        tourney_rule_case(
            "the same event, for a team there is still room under",
            under_cap,
            Some("t2"),
            Vec::new(),
        ),
        tourney_rule_case(
            "teams formed, bracket not drawn",
            drafted,
            Some("t1"),
            vec![],
        ),
        tourney_rule_case("a solo event with a signup waiting", solo, None, vec![]),
        tourney_rule_case(
            "the organiser's view before the draw: teams can still be shuffled",
            organised,
            Some("t1"),
            vec![],
        ),
        tourney_rule_case(
            "the same event once the bracket exists: shuffling is refused",
            organised_running,
            Some("t1"),
            vec![],
        ),
        tourney_rule_case(
            "an unrated event, the only kind that takes a typed rating",
            unrated,
            Some("t1"),
            vec![],
        ),
    ]
}

fn tourney_open_event_cases() -> Vec<TourneyOpenEventCase> {
    [
        (Some("e1"), Some("e1")),
        // The window between selecting a row and its detail arriving: the
        // previous event's bracket must not appear under the new name.
        (Some("e1"), Some("e2")),
        (Some("e1"), None),
        (None, Some("e1")),
        (None, None),
    ]
    .into_iter()
    .map(|(detail_id, selected_id)| {
        let state = TourneyState {
            detail: detail_id.map(|id| Tourney {
                id: id.into(),
                ..Tourney::default()
            }),
            selected_id: selected_id.map(Into::into),
            ..TourneyState::default()
        };
        TourneyOpenEventCase {
            detail_id: detail_id.map(Into::into),
            selected_id: selected_id.map(Into::into),
            open_id: state.open_event().map(|event| event.id.clone()),
        }
    })
    .collect()
}

fn tourney_busy_match_cases() -> Vec<TourneyBusyMatchCase> {
    [
        None,
        Some(TourneyAction::SubmittingReport {
            match_id: "m1".into(),
        }),
        Some(TourneyAction::AnsweringReport {
            match_id: "m2".into(),
        }),
        Some(TourneyAction::DecidingReport {
            match_id: "m3".into(),
        }),
        // Event-wide writes: the whole pane disables, no single match does.
        Some(TourneyAction::SigningUp),
        Some(TourneyAction::Reseeding),
        // Names an id, but not a match's: must not be mistaken for one.
        Some(TourneyAction::PostingChat {
            room_id: "m1".into(),
        }),
        Some(TourneyAction::AnsweringTeam {
            team_id: "m1".into(),
        }),
    ]
    .into_iter()
    .map(|pending| {
        let state = TourneyState {
            pending,
            ..TourneyState::default()
        };
        TourneyBusyMatchCase {
            busy_match_id: state.busy_match_id().map(Into::into),
            pending: state.pending,
        }
    })
    .collect()
}

fn tourney_phase_legality_cases() -> Vec<TourneyPhaseLegalityCase> {
    let phases = [
        TourneyPhase::FormTeams,
        TourneyPhase::StartBracket,
        TourneyPhase::ReopenSignups,
    ];
    let statuses = [
        TourneyStatus::Draft,
        TourneyStatus::Signup,
        TourneyStatus::Drafted,
        TourneyStatus::Running,
        TourneyStatus::Finished,
        TourneyStatus::Unknown,
    ];
    phases
        .into_iter()
        .flat_map(|phase| {
            statuses
                .into_iter()
                .map(move |status| TourneyPhaseLegalityCase {
                    phase,
                    status,
                    legal: phase.is_legal_from(status),
                })
        })
        .collect()
}

fn tourney_draft_rejection_cases() -> Vec<TourneyDraftRejectionCase> {
    let named = |over: TourneyDraft| TourneyDraft {
        name: "Weekend Cup".into(),
        ..over
    };
    let cases: Vec<(&str, TourneyDraft)> = vec![
        ("a plain valid draft", named(TourneyDraft::new())),
        (
            "no name at all, which is the server's first complaint",
            TourneyDraft::new(),
        ),
        (
            "a name of nothing but spaces still counts as none",
            TourneyDraft {
                name: "   ".into(),
                ..TourneyDraft::new()
            },
        ),
        (
            "a team of seven",
            named(TourneyDraft {
                team_size: 7,
                ..TourneyDraft::new()
            }),
        ),
        (
            "a team of none",
            named(TourneyDraft {
                team_size: 0,
                ..TourneyDraft::new()
            }),
        ),
        (
            "a rating floor above the ceiling",
            named(TourneyDraft {
                rating: RatingGate {
                    min: Some(1_800),
                    max: Some(1_200),
                    ..RatingGate::default()
                },
                ..TourneyDraft::new()
            }),
        ),
        (
            "a gate on an unrated event, which could only refuse everybody",
            named(TourneyDraft {
                rating_kind: RatingKind::None,
                rating: RatingGate {
                    min: Some(1_200),
                    ..RatingGate::default()
                },
                ..TourneyDraft::new()
            }),
        ),
        (
            "an unrated event with no gate is fine",
            named(TourneyDraft {
                rating_kind: RatingKind::None,
                ..TourneyDraft::new()
            }),
        ),
        (
            "signups closing before they open",
            named(TourneyDraft {
                signup_opens_at: Some(1_800_000_000),
                signup_closes_at: Some(1_700_000_000),
                ..TourneyDraft::new()
            }),
        ),
        (
            "signups opening and closing at the same instant",
            named(TourneyDraft {
                signup_opens_at: Some(1_700_000_000),
                signup_closes_at: Some(1_700_000_000),
                ..TourneyDraft::new()
            }),
        ),
        (
            // Two problems at once: the order decides which is shown, and it has
            // to be the server's order.
            "a nameless draft that also has an inverted rating range",
            TourneyDraft {
                rating: RatingGate {
                    min: Some(1_800),
                    max: Some(1_200),
                    ..RatingGate::default()
                },
                ..TourneyDraft::new()
            },
        ),
    ];
    cases
        .into_iter()
        .map(|(name, draft)| TourneyDraftRejectionCase {
            name: name.to_string(),
            rejection: draft.rejection(),
            submittable: draft.is_submittable(),
            draft: Box::new(draft),
        })
        .collect()
}

fn tourney_report_cases() -> Vec<TourneyReportCase> {
    let entry =
        |best_of: i32, handicap: i32, score1: Option<i32>, score2: Option<i32>| TourneyMatch {
            id: "m1".into(),
            bracket: BracketSide::Winners,
            round: 1,
            index: 0,
            best_of,
            handicap,
            division: 0,
            team1: Some("t1".into()),
            team2: Some("t2".into()),
            score1,
            score2,
            status: MatchStatus::Ready,
            winner: None,
            loser: None,
            winner_to: None,
            loser_to: None,
            pending_report: None,
            replay_ids: Vec::new(),
        };
    let ids = |count: usize| -> Vec<String> {
        (0..count).map(|index| format!("replay-{index}")).collect()
    };

    let cases: Vec<(&str, TourneyMatch, i32, i32, Vec<String>)> = vec![
        (
            "a fresh Bo3 taken 2-0",
            entry(3, 0, None, None),
            2,
            0,
            ids(2),
        ),
        (
            "the same, one replay id short",
            entry(3, 0, None, None),
            2,
            0,
            ids(1),
        ),
        ("one id too many", entry(3, 0, None, None), 2, 0, ids(3)),
        (
            // Blank fields are not ids, which is what the trimming is for.
            "two boxes filled, one of them blank",
            entry(3, 0, None, None),
            2,
            0,
            vec!["replay-0".into(), "   ".into()],
        ),
        (
            "a Bo3 at 1-1 reported as 2-1: one new game",
            entry(3, 0, Some(1), Some(1)),
            2,
            1,
            ids(1),
        ),
        (
            "re-reporting a score already confirmed adds nothing",
            entry(3, 0, Some(2), Some(0)),
            2,
            0,
            Vec::new(),
        ),
        (
            "scoring past the series length",
            entry(3, 0, None, None),
            3,
            0,
            ids(3),
        ),
        (
            "both sides winning it",
            entry(3, 0, None, None),
            2,
            2,
            ids(4),
        ),
        ("a negative score", entry(3, 0, None, None), -1, 2, ids(1)),
        (
            // The handicap case: an absent score is not zero here, so a naive
            // twin counts one game too many.
            "a handicapped grand final starting the favourite at 1-0",
            entry(5, 1, None, None),
            3,
            1,
            ids(3),
        ),
        (
            "the same handicapped final, counted as if from 0-0",
            entry(5, 1, None, None),
            3,
            1,
            ids(4),
        ),
        (
            "an even Bo2, where one win is not yet enough",
            entry(2, 0, None, None),
            1,
            0,
            ids(1),
        ),
    ];

    cases
        .into_iter()
        .map(|(name, held, score1, score2, replay_ids)| {
            let report = MatchReport {
                match_id: held.id.clone(),
                score1,
                score2,
                replay_ids: replay_ids.clone(),
                draw_replay_ids: Vec::new(),
                winner: None,
                forfeit: None,
            };
            TourneyReportCase {
                name: name.to_string(),
                entry: TourneyReportEntry {
                    best_of: held.best_of,
                    handicap: held.handicap,
                    score1: held.score1,
                    score2: held.score2,
                },
                new_games: report.new_games(&held),
                submittable: report.is_submittable(&held),
                score1,
                score2,
                replay_ids,
            }
        })
        .collect()
}

fn tourney_map_match_fixture() -> TourneyMapMatchFixture {
    let vault = vec![
        TourneyMapVaultEntry {
            display_name: "Seton's Clutch".into(),
            folder_name: "scmp_009.v0002".into(),
        },
        TourneyMapVaultEntry {
            display_name: "Open Palms".into(),
            folder_name: "scmp_001".into(),
        },
        TourneyMapVaultEntry {
            display_name: "Adaptive Tabula".into(),
            folder_name: "adaptive_tabula.v0006".into(),
        },
    ];
    let typed = [
        // The four spellings the same map arrives as.
        "Seton's Clutch",
        "setons clutch",
        "SCMP_009",
        "scmp_009.v0001",
        // Punctuation and spacing are noise; a version on both sides comes off.
        "  adaptive-tabula  ",
        "Adaptive Tabula.v0009",
        // Nothing to compare on, and a map that was never uploaded.
        "",
        "!!!",
        "Some Private Map",
    ];
    let cases = typed
        .into_iter()
        .map(|name| {
            let tourney_map = TourneyMap {
                id: "m".into(),
                name: name.into(),
                image_url: String::new(),
            };
            TourneyMapMatchCase {
                typed: name.into(),
                key: map_key(name),
                resolved_display_name: match_vault_map(
                    &tourney_map,
                    &vault,
                    |entry| &entry.display_name,
                    |entry| &entry.folder_name,
                )
                .map(|entry| entry.display_name.clone()),
            }
        })
        .collect();
    TourneyMapMatchFixture { vault, cases }
}

fn helper_fixture() -> HelperFixture {
    let review_sets = vec![
        Vec::new(),
        vec![review(1, 5, "Ada"), review(2, 2, "Bob")],
        vec![
            review(3, 1, "Ada"),
            review(4, 2, "Bob"),
            review(5, 2, "Cid"),
        ],
        vec![review(6, -1, "Ada"), review(7, 9, "Bob")],
    ];
    let statuses = vec![
        UploadStatus::Idle,
        UploadStatus::Compressing,
        UploadStatus::Uploading {
            sent_bytes: 5,
            total_bytes: 10,
        },
        UploadStatus::Finishing,
        UploadStatus::Succeeded,
        UploadStatus::Failed {
            reason: "rejected".into(),
        },
    ];
    let note_lookups = vec![
        (
            vec![
                PlayerNote {
                    player_id: 42,
                    login: "Aurora".into(),
                    note: "Reliable teammate".into(),
                },
                PlayerNote {
                    player_id: 7,
                    login: "Ada".into(),
                    note: "Map specialist".into(),
                },
            ],
            7,
        ),
        (Vec::new(), 99),
    ];
    let galactic_war_states = vec![
        // Nothing known at all.
        galactic_war_state(None, None, GalacticWarStatus::Idle, false),
        // Never installed, the gateway has answered: a first install.
        galactic_war_state(
            None,
            Some(("v2026.04.04.1", None)),
            GalacticWarStatus::Idle,
            false,
        ),
        // Current, and startable.
        galactic_war_state(
            Some("v2026.04.04.1"),
            Some(("v2026.03.01.1", Some("v2026.04.04.1"))),
            GalacticWarStatus::Idle,
            false,
        ),
        // The gateway's pointer moved.
        galactic_war_state(
            Some("v2026.03.01.1"),
            Some(("v2026.03.01.1", Some("v2026.04.04.1"))),
            GalacticWarStatus::Idle,
            false,
        ),
        // Below the minimum: startable only after an update.
        galactic_war_state(
            Some("v2026.03.01.1"),
            Some(("v2026.04.04.1", None)),
            GalacticWarStatus::Idle,
            true,
        ),
        // A scheme neither side can order: the pointer still moved.
        galactic_war_state(
            Some("build-41"),
            Some(("build-42", None)),
            GalacticWarStatus::Idle,
            false,
        ),
        // In flight, and already running: both refuse a launch.
        galactic_war_state(
            Some("v1"),
            Some(("v1", None)),
            GalacticWarStatus::Downloading {
                version: "v1".into(),
                downloaded_bytes: 1,
                total_bytes: 2,
            },
            false,
        ),
        galactic_war_state(
            Some("v1"),
            Some(("v1", None)),
            GalacticWarStatus::Running,
            false,
        ),
        // A failed run must not lock the panel.
        galactic_war_state(
            Some("v1"),
            Some(("v1", None)),
            GalacticWarStatus::Failed {
                reason: "network".into(),
            },
            false,
        ),
    ];

    HelperFixture {
        review_summaries: review_sets
            .into_iter()
            .map(|reviews| ReviewSummaryCase {
                expected: summarize(&reviews),
                reviews,
            })
            .collect(),
        upload_busy: statuses
            .into_iter()
            .map(|status| UploadBusyCase {
                expected: status.is_busy(),
                status,
            })
            .collect(),
        player_note_lookups: note_lookups
            .into_iter()
            .map(|(notes, player_id)| PlayerNoteLookupCase {
                expected: SocialPreferences {
                    player_notes: notes.clone(),
                }
                .note_for(player_id)
                .map_or_else(String::new, |entry| entry.note.clone()),
                notes,
                player_id,
            })
            .collect(),
        galactic_war_actions: galactic_war_states
            .into_iter()
            .map(|state| GalacticWarActionCase {
                install_target: state.install_target().unwrap_or_default().to_string(),
                update_available: state.update_available(),
                can_launch: state.can_launch(),
                state,
            })
            .collect(),
        tourney_rules: tourney_rule_cases(),
        tourney_open_events: tourney_open_event_cases(),
        tourney_phase_legality: tourney_phase_legality_cases(),
        tourney_busy_matches: tourney_busy_match_cases(),
        tourney_draft_rejections: tourney_draft_rejection_cases(),
        tourney_reports: tourney_report_cases(),
        tourney_map_matches: tourney_map_match_fixture(),
    }
}

fn case(name: &str, events: Vec<AppEvent>) -> Case {
    let mut state = AppState::default();
    let steps = events
        .into_iter()
        .map(|event| {
            reduce(&mut state, &event);
            let slice = event_slice(&event);
            let expected = serde_json::to_value(&state)
                .expect("state must serialise")
                .get(&slice)
                .unwrap_or_else(|| panic!("event slice `{slice}` is absent from AppState"))
                .clone();
            Step { event, expected }
        })
        .collect();
    Case {
        name: name.to_string(),
        steps,
    }
}

fn event_slice(event: &AppEvent) -> String {
    let event = serde_json::to_value(event).expect("event must serialise");
    let kind = event["kind"].as_str().expect("every event is tagged");
    let mut chars = kind.chars();
    match chars.next() {
        Some(first) => first.to_ascii_lowercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

fn player() -> Player {
    Player::new(7, "Ada")
}

fn chat_message(sender: &str, content: &str) -> ChatMessage {
    ChatMessage {
        id: format!("m-{sender}-{content}"),
        sender: sender.into(),
        content: content.into(),
        timestamp: "2026-01-01T00:00:00Z".into(),
        kind: ChatMessageKind::Message,
        msgid: format!("srv-{sender}-{content}"),
        reply_to: String::new(),
    }
}

fn local_replay(uid: i32) -> LocalReplay {
    LocalReplay {
        path: format!("/replays/{uid}.fafreplay"),
        file_name: format!("{uid}.fafreplay"),
        uid: Some(uid),
        map: "scmp_009".into(),
        mod_name: "faf".into(),
        title: "Downloaded replay".into(),
        recorder: "Host".into(),
        start_time: None,
        modified_time: 1,
        file_size_bytes: 100,
        num_players: 2,
        teams: Vec::new(),
        average_rating: None,
        sim_mods: Vec::new(),
        status: LocalReplayStatus::Complete,
        watchable: true,
    }
}

fn cases() -> Vec<Case> {
    vec![
        // ── session / auth / nav ─────────────────────────────────────────
        case(
            "session connects and reports its version",
            vec![
                SessionEvent::Connecting.into(),
                SessionEvent::BackendReady {
                    version: "1.2.3".into(),
                    offline_auth: false,
                }
                .into(),
            ],
        ),
        case(
            "an offline development build keeps its flavour across a reconnect",
            vec![
                SessionEvent::BackendReady {
                    version: "1.2.3".into(),
                    offline_auth: true,
                }
                .into(),
                SessionEvent::Disconnected.into(),
                SessionEvent::Connecting.into(),
            ],
        ),
        case(
            "auth logs in then out",
            vec![
                AuthEvent::LoginStarted.into(),
                AuthEvent::LoggedIn { player: player() }.into(),
                AuthEvent::LoggedOut.into(),
            ],
        ),
        case(
            "auth failure keeps the error",
            vec![
                AuthEvent::LoginStarted.into(),
                AuthEvent::LoginFailed {
                    message: "bad state".into(),
                }
                .into(),
            ],
        ),
        case(
            "nav selects a tab",
            vec![
                NavEvent::TabSelected { tab: Tab::Play }.into(),
                NavEvent::TabSelected {
                    tab: Tab::Tutorials,
                }
                .into(),
            ],
        ),
        case(
            "install check flips both flags",
            vec![InstallEvent::Checked {
                game_ready: true,
                replay_ready: false,
            }
            .into()],
        ),
        // ── chat ─────────────────────────────────────────────────────────
        case(
            "chat joins, counts unread, and clears on select",
            vec![
                ChatEvent::Connected {
                    username: "Ada".into(),
                }
                .into(),
                ChatEvent::ChannelJoined {
                    channel: "#aeolus".into(),
                }
                .into(),
                ChatEvent::ChannelJoined {
                    channel: "#uef".into(),
                }
                .into(),
                ChatEvent::MessageReceived {
                    channel: "#uef".into(),
                    message: chat_message("Bob", "hello Ada"),
                }
                .into(),
                ChatEvent::ChannelSelected {
                    channel: "#uef".into(),
                }
                .into(),
            ],
        ),
        case(
            "chat restores message history when a new message recreates a conversation",
            vec![
                ChatEvent::ChannelJoined {
                    channel: "#uef".into(),
                }
                .into(),
                ChatEvent::MessageReceived {
                    channel: "#uef".into(),
                    message: chat_message("Bob", "remember this"),
                }
                .into(),
                ChatEvent::ChannelLeft {
                    channel: "#uef".into(),
                }
                .into(),
                ChatEvent::MessageReceived {
                    channel: "#uef".into(),
                    message: chat_message("Carol", "new line"),
                }
                .into(),
            ],
        ),
        case(
            "chat roster events for an unknown channel are dropped",
            vec![
                ChatEvent::ChannelJoined {
                    channel: "#uef".into(),
                }
                .into(),
                // The divergence this whole fixture exists for: these must not
                // create a channel.
                ChatEvent::UserLeft {
                    channel: "#gone".into(),
                    user: "Bob".into(),
                }
                .into(),
                ChatEvent::UserElevationChanged {
                    channel: "#gone".into(),
                    user: "Bob".into(),
                    elevation: "@".into(),
                }
                .into(),
            ],
        ),
        case(
            "chat rename updates every roster and our own name",
            vec![
                ChatEvent::Connected {
                    username: "Ada".into(),
                }
                .into(),
                ChatEvent::ChannelJoined {
                    channel: "#uef".into(),
                }
                .into(),
                ChatEvent::UserJoined {
                    channel: "#uef".into(),
                    user: ChatUser {
                        name: "Ada".into(),
                        elevation: String::new(),
                    },
                }
                .into(),
                ChatEvent::UserRenamed {
                    old_name: "Ada".into(),
                    new_name: "Zara".into(),
                }
                .into(),
                ChatEvent::Disconnected.into(),
            ],
        ),
        case(
            "chat normalizes the server's auto-join channel list",
            vec![
                // The lobby sends bare names, repeats in a different case, and
                // may send blanks. All three are handled in `normalize_channels`,
                // which the frontend hand-mirrors.
                ChatEvent::AutoJoinAnnounced {
                    channels: vec![
                        "aeolus".into(),
                        " german ".into(),
                        "#GERMAN".into(),
                        String::new(),
                        "#clan_qai".into(),
                    ],
                }
                .into(),
                // A later announcement replaces the list rather than adding to
                // it: the server sends a complete set each time.
                ChatEvent::AutoJoinAnnounced {
                    channels: vec!["aeolus".into()],
                }
                .into(),
            ],
        ),
        case(
            "chat applies connection metadata and quiet history without unread badges",
            vec![
                ChatEvent::Connecting.into(),
                ChatEvent::Connected {
                    username: "Ada".into(),
                }
                .into(),
                ChatEvent::ChannelJoined {
                    channel: "#uef".into(),
                }
                .into(),
                ChatEvent::TopicChanged {
                    channel: "#uef".into(),
                    topic: "Build orders".into(),
                }
                .into(),
                ChatEvent::UsersUpdated {
                    channel: "#uef".into(),
                    users: vec![ChatUser::new("Ada", "@"), ChatUser::new("Bob", "")],
                }
                .into(),
                ChatEvent::JoinsPartsToggled { enabled: true }.into(),
                ChatEvent::MessageReceivedQuietly {
                    channel: "#uef".into(),
                    message: chat_message("Bob", "restored history"),
                }
                .into(),
            ],
        ),
        case(
            "someone composes, reacts, and their message clears the indicator",
            vec![
                ChatEvent::Connected {
                    username: "Aurora".into(),
                }
                .into(),
                ChatEvent::ChannelJoined {
                    channel: "#aeolus".into(),
                }
                .into(),
                ChatEvent::TypingChanged {
                    channel: "#aeolus".into(),
                    nickname: "Bob".into(),
                    composing: true,
                    at_seconds: 1_000,
                }
                .into(),
                // A refresh extends the same person rather than listing them twice.
                ChatEvent::TypingChanged {
                    channel: "#aeolus".into(),
                    nickname: "Bob".into(),
                    composing: true,
                    at_seconds: 1_003,
                }
                .into(),
                // The message itself is the loudest possible "done".
                ChatEvent::MessageReceived {
                    channel: "#aeolus".into(),
                    message: chat_message("Bob", "hello"),
                }
                .into(),
                ChatEvent::ReactionReceived {
                    channel: "#aeolus".into(),
                    msgid: "srv-Bob-hello".into(),
                    emoji: "\u{1f44d}".into(),
                    sender: "Ada".into(),
                }
                .into(),
                // Same emoji, second person: one entry, two senders.
                ChatEvent::ReactionReceived {
                    channel: "#aeolus".into(),
                    msgid: "srv-Bob-hello".into(),
                    emoji: "\u{1f44d}".into(),
                    sender: "Cid".into(),
                }
                .into(),
                // A repeat from someone already counted is swallowed.
                ChatEvent::ReactionReceived {
                    channel: "#aeolus".into(),
                    msgid: "srv-Bob-hello".into(),
                    emoji: "\u{1f44d}".into(),
                    sender: "ada".into(),
                }
                .into(),
                // A reaction with no anchor is dropped entirely.
                ChatEvent::ReactionReceived {
                    channel: "#aeolus".into(),
                    msgid: String::new(),
                    emoji: "\u{1f525}".into(),
                    sender: "Ada".into(),
                }
                .into(),
                // Taking one back removes that person and nobody else.
                ChatEvent::ReactionRemoved {
                    channel: "#aeolus".into(),
                    msgid: "srv-Bob-hello".into(),
                    emoji: "\u{1f44d}".into(),
                    sender: "Cid".into(),
                }
                .into(),
                // The last holder leaving takes the whole entry with it,
                // rather than leaving an emoji showing zero.
                ChatEvent::ReactionRemoved {
                    channel: "#aeolus".into(),
                    msgid: "srv-Bob-hello".into(),
                    emoji: "\u{1f44d}".into(),
                    sender: "Ada".into(),
                }
                .into(),
                // Stopping removes the notice at once.
                ChatEvent::TypingChanged {
                    channel: "#aeolus".into(),
                    nickname: "Cid".into(),
                    composing: true,
                    at_seconds: 1_010,
                }
                .into(),
                ChatEvent::TypingChanged {
                    channel: "#aeolus".into(),
                    nickname: "Cid".into(),
                    composing: false,
                    at_seconds: 1_011,
                }
                .into(),
            ],
        ),
        // ── lobby ────────────────────────────────────────────────────────
        case(
            "lobby runs the join state machine",
            vec![
                LobbyEvent::Connecting.into(),
                LobbyEvent::Connected.into(),
                LobbyEvent::Joining {
                    id: 7,
                    prepared: false,
                }
                .into(),
                LobbyEvent::Joining {
                    id: 7,
                    prepared: true,
                }
                .into(),
                LobbyEvent::JoinCancelled.into(),
                LobbyEvent::Joining {
                    id: 7,
                    prepared: false,
                }
                .into(),
                LobbyEvent::Preparing {
                    detail: "Updating faf".into(),
                    progress: Some(50),
                }
                .into(),
                LobbyEvent::InGame.into(),
                LobbyEvent::GameTerminated.into(),
                LobbyEvent::Disconnected.into(),
            ],
        ),
        case(
            "matchmaker queues merge partial pushes and keep a stable order",
            vec![
                LobbyEvent::MatchmakerQueuesUpdated {
                    queues: vec![
                        MatchmakerQueue {
                            queue_name: "tmm4v4".into(),
                            team_size: 4,
                            num_players: 1,
                            queue_pop_time_seconds: 90,
                        },
                        MatchmakerQueue {
                            queue_name: "ladder1v1".into(),
                            team_size: 1,
                            num_players: 7,
                            queue_pop_time_seconds: 30,
                        },
                    ],
                }
                .into(),
                // A push naming one queue must not erase the others.
                LobbyEvent::MatchmakerQueuesUpdated {
                    queues: vec![MatchmakerQueue {
                        queue_name: "tmm2v2".into(),
                        team_size: 2,
                        num_players: 3,
                        queue_pop_time_seconds: 60,
                    }],
                }
                .into(),
                LobbyEvent::MatchmakerQueuesUpdated {
                    queues: vec![MatchmakerQueue {
                        queue_name: "ladder1v1".into(),
                        team_size: 1,
                        num_players: 12,
                        queue_pop_time_seconds: 20,
                    }],
                }
                .into(),
                LobbyEvent::Disconnected.into(),
            ],
        ),
        case(
            "lobby keeps the play mode across a disconnect",
            vec![
                LobbyEvent::PlayModeChanged {
                    mode: PlayMode::Matchmaking,
                }
                .into(),
                LobbyEvent::Connected.into(),
                LobbyEvent::Disconnected.into(),
            ],
        ),
        case(
            "lobby owns avatar loading selection and disconnect cleanup",
            vec![
                LobbyEvent::AvatarsLoading.into(),
                LobbyEvent::AvatarsLoaded {
                    avatars: vec![AvailableAvatar {
                        url: "https://content.test/avatar.png".into(),
                        tooltip: "Winner".into(),
                    }],
                }
                .into(),
                LobbyEvent::AvatarSelectionStarted.into(),
                LobbyEvent::AvatarSelectionSucceeded.into(),
                LobbyEvent::Disconnected.into(),
            ],
        ),
        // ── coop ─────────────────────────────────────────────────────────
        case(
            "coop opens the first mission and drops a stale board",
            vec![
                CoopEvent::CatalogLoading.into(),
                CoopEvent::CatalogLoaded {
                    scenarios: vec![CoopScenario {
                        id: 1,
                        name: "Ivory Sun".into(),
                        description: String::new(),
                        order: 1,
                        faction: CoopFaction::Uef,
                        category: CoopCategory::Scfa,
                    }],
                    missions: vec![CoopMission {
                        id: 7,
                        name: "Ivory Sun 1".into(),
                        description: String::new(),
                        version: 1,
                        download_url: String::new(),
                        thumbnail_url_small: String::new(),
                        thumbnail_url_large: String::new(),
                        map_folder_name: "scmp_coop_7".into(),
                        scenario_id: Some(1),
                    }],
                }
                .into(),
                // For a mission that is not selected: must be ignored.
                CoopEvent::LeaderboardLoaded {
                    mission_id: 99,
                    player_count: 0,
                    results: Vec::new(),
                }
                .into(),
                CoopEvent::PlayerCountChanged { player_count: 2 }.into(),
                CoopEvent::LeaderboardLoadFailed {
                    reason: "session expired".into(),
                    kind: RequestFailureKind::Unauthorized,
                }
                .into(),
            ],
        ),
        // ── reviews ──────────────────────────────────────────────────────
        case(
            "reviews summarise on load and again on save",
            vec![
                ReviewsEvent::Opened {
                    target: ReviewTarget {
                        kind: ReviewKind::Map,
                        id: 42,
                        name: "Seton's".into(),
                    },
                }
                .into(),
                ReviewsEvent::Loading.into(),
                ReviewsEvent::Loaded {
                    target: ReviewTarget {
                        kind: ReviewKind::Map,
                        id: 42,
                        name: "Seton's".into(),
                    },
                    reviews: vec![
                        Review {
                            id: 1,
                            score: 5,
                            text: "Great".into(),
                            player: "Bob".into(),
                            version: "3".into(),
                        },
                        Review {
                            id: 2,
                            score: 2,
                            text: "Meh".into(),
                            player: "Cid".into(),
                            version: "2".into(),
                        },
                    ],
                }
                .into(),
                ReviewsEvent::Saving.into(),
                ReviewsEvent::Saved {
                    reviews: vec![Review {
                        id: 1,
                        score: 5,
                        text: "Great".into(),
                        player: "Bob".into(),
                        version: "3".into(),
                    }],
                }
                .into(),
            ],
        ),
        // ── uploads ──────────────────────────────────────────────────────
        case(
            "uploads keep a running publish when the dialog closes",
            vec![
                UploadsEvent::Opened {
                    request: UploadRequest {
                        kind: UploadKind::Map,
                        folder_name: "my_map.v0001".into(),
                        display_name: "My Map".into(),
                        ranked: false,
                        source_path: None,
                    },
                }
                .into(),
                UploadsEvent::RankedChanged { ranked: true }.into(),
                UploadsEvent::Progressed {
                    status: UploadStatus::Compressing,
                }
                .into(),
                UploadsEvent::Closed.into(),
                UploadsEvent::Progressed {
                    status: UploadStatus::Succeeded,
                }
                .into(),
                UploadsEvent::Closed.into(),
            ],
        ),
        // ── client self-update ───────────────────────────────────────────
        case(
            "a client update is offered, downloaded and then dismissed",
            vec![
                ClientUpdateEvent::CheckStarted {
                    current_version: "0.2.0".into(),
                }
                .into(),
                ClientUpdateEvent::Available {
                    release: ClientRelease {
                        version: "0.3.0".into(),
                        notes_url: "https://example.invalid/releases/0.3.0".into(),
                        download_url: "https://example.invalid/installer.exe".into(),
                        asset_name: "installer.exe".into(),
                        size_bytes: 4096,
                        pre_release: false,
                        published_at: "2026-02-01T00:00:00Z".into(),
                    },
                }
                .into(),
                ClientUpdateEvent::DownloadProgressed {
                    received_bytes: 2048,
                    total_bytes: 4096,
                }
                .into(),
                ClientUpdateEvent::Downloaded {
                    path: "/cache/updates/faf-client-0.3.0.exe".into(),
                }
                .into(),
                ClientUpdateEvent::Installing.into(),
                ClientUpdateEvent::Dismissed {
                    version: "0.3.0".into(),
                }
                .into(),
                // A later check finding nothing must clear the offer, not keep
                // a dismissed release lying around under an up-to-date status.
                ClientUpdateEvent::UpToDate.into(),
            ],
        ),
        // ── tournaments / tutorials ──────────────────────────────────────
        case(
            "a player enters a tournament and is refused",
            vec![
                TourneyEvent::Loading.into(),
                TourneyEvent::Loaded {
                    events: vec![tourney("e1"), tourney("e2")],
                }
                .into(),
                TourneyEvent::Selected {
                    tournament_id: "e2".into(),
                }
                .into(),
                TourneyEvent::DetailLoading.into(),
                TourneyEvent::DetailLoaded {
                    event: Box::new(tourney("e2")),
                }
                .into(),
                TourneyEvent::ActionStarted {
                    action: TourneyAction::SigningUp,
                }
                .into(),
                // The server's own sentence: it names the gate that was missed,
                // and it has to survive until it is dismissed.
                TourneyEvent::ActionFailed {
                    failure: TourneyActionFailure {
                        action: TourneyAction::SigningUp,
                        reason: "your rating (1420) is below this tournament’s minimum of 1500"
                            .into(),
                        kind: RequestFailureKind::Rejected,
                    },
                }
                .into(),
                TourneyEvent::ActionErrorDismissed.into(),
                // Entering on the second attempt. The profiles arrive after the
                // detail, from a different service: the tournament service owns
                // the entry, FAF owns the player.
                TourneyEvent::ActionStarted {
                    action: TourneyAction::SigningUp,
                }
                .into(),
                TourneyEvent::ActionSucceeded {
                    action: TourneyAction::SigningUp,
                    select: None,
                }
                .into(),
                TourneyEvent::EntrantProfilesLoaded {
                    profiles: vec![player_summary(101, "Nuggets", Some(1750))],
                }
                .into(),
                // Site-wide, and loaded once rather than per tournament.
                // Creating names the event to open afterwards, which is how
                // the organiser lands inside the one they just made.
                TourneyEvent::ActionStarted {
                    action: TourneyAction::Creating,
                }
                .into(),
                TourneyEvent::ActionSucceeded {
                    action: TourneyAction::Creating,
                    select: Some("e3".into()),
                }
                .into(),
                TourneyEvent::HostingLoaded {
                    hosting: HostingStatus {
                        logged_in: true,
                        allowed: true,
                        pending: false,
                    },
                }
                .into(),
                TourneyEvent::ArticlesLoaded {
                    articles: vec![Article {
                        id: "art33adc81d9f78".into(),
                        title: "Tournament rules".into(),
                        body: "Be on time, and post your replay ids.".into(),
                        parent_id: None,
                    }],
                }
                .into(),
                // A detail for the event nobody is looking at any more must not
                // land under the open one's heading.
                TourneyEvent::DetailLoaded {
                    event: Box::new(tourney("e1")),
                }
                .into(),
                // e2 was archived between refreshes: the selection falls back
                // and takes the bracket with it.
                TourneyEvent::Loaded {
                    events: vec![tourney("e1")],
                }
                .into(),
            ],
        ),
        case(
            "an organiser searches for an account while answers overtake each other",
            vec![
                TourneyEvent::AccountSearchStarted {
                    query: "nug".into(),
                }
                .into(),
                TourneyEvent::AccountSearchLoaded {
                    query: "nug".into(),
                    matches: vec![
                        player_summary(101, "Nuggets", Some(1750)),
                        player_summary(105, "Nugget", Some(980)),
                    ],
                }
                .into(),
                // A fourth letter: the older results are clickable, so they go
                // at once rather than when the new answer arrives.
                TourneyEvent::AccountSearchStarted {
                    query: "nugge".into(),
                }
                .into(),
                // The slower answer for the abandoned query must be dropped, not
                // shown under the newer one.
                TourneyEvent::AccountSearchLoaded {
                    query: "nug".into(),
                    matches: vec![player_summary(101, "Nuggets", Some(1750))],
                }
                .into(),
                // Trimming and case are how the query was sent, so this *is* the
                // current one and it lands.
                TourneyEvent::AccountSearchLoaded {
                    query: " NUGGE ".into(),
                    matches: vec![player_summary(101, "Nuggets", Some(1750))],
                }
                .into(),
                // A refusal names its reason: an empty list that meant "your
                // session expired" would send the organiser hunting for a typo.
                TourneyEvent::AccountSearchStarted {
                    query: "ada".into(),
                }
                .into(),
                TourneyEvent::AccountSearchFailed {
                    query: "ada".into(),
                    reason: "Sign in to FAF to look up players.".into(),
                    kind: RequestFailureKind::Unauthorized,
                }
                .into(),
                // Picking somebody, or leaving the field, drops the list.
                TourneyEvent::AccountSearchCleared.into(),
            ],
        ),
        case(
            "a tournament chat room is opened, read and left behind",
            vec![
                TourneyEvent::Loaded {
                    events: vec![tourney("e1"), tourney("e2")],
                }
                .into(),
                TourneyEvent::DetailLoaded {
                    event: Box::new(tourney("e1")),
                }
                .into(),
                TourneyEvent::ChatRoomsLoaded {
                    rooms: vec![tourney_room("global", 3), tourney_room("m1", 1)],
                }
                .into(),
                TourneyEvent::RoomOpened {
                    room_id: "global".into(),
                }
                .into(),
                TourneyEvent::ChatLoading.into(),
                // Reading is what clears the badge server-side, so it clears
                // here too rather than waiting for the next room list.
                TourneyEvent::ChatLoaded {
                    room_id: "global".into(),
                    posts: vec![ChatPost {
                        id: "c1".into(),
                        author: "Ada".into(),
                        body: "gl hf".into(),
                        at: Some(1_700_000_100),
                        system: false,
                    }],
                }
                .into(),
                // An answer for a room that is no longer open is dropped.
                TourneyEvent::ChatLoaded {
                    room_id: "m1".into(),
                    posts: vec![],
                }
                .into(),
                // Switching events takes the whole conversation with it.
                TourneyEvent::Selected {
                    tournament_id: "e2".into(),
                }
                .into(),
            ],
        ),
        case(
            "the tournament tab hands a match title to the host dialog",
            vec![
                // Crosses a tab boundary, which is why it lives in the slice
                // rather than in a component: the Play tab opens its dialog
                // when the title appears, and clears it on close so the dialog
                // does not reopen on the next visit.
                LobbyEvent::HostPrepared {
                    title: "Weekend Cup R2: Nuggets vs Ada".into(),
                }
                .into(),
                LobbyEvent::HostPrefillCleared.into(),
            ],
        ),
        case(
            "tutorials narrate a launch",
            vec![
                TutorialsEvent::Loading.into(),
                TutorialsEvent::Loaded {
                    categories: vec![TutorialCategory {
                        id: 1,
                        name: "Basics".into(),
                    }],
                    tutorials: vec![tutorial(7), tutorial(8)],
                }
                .into(),
                TutorialsEvent::Selected { tutorial_id: 8 }.into(),
                TutorialsEvent::LaunchPreparing {
                    tutorial_id: 8,
                    detail: "Updating tutorials".into(),
                }
                .into(),
                TutorialsEvent::Launched { tutorial_id: 8 }.into(),
            ],
        ),
        // ── notifications / reporting / social ───────────────────────────
        case(
            "notifications are added and dismissed",
            vec![
                NotificationEvent::Added {
                    notification: ClientNotification {
                        id: "n1".into(),
                        kind: NotificationKind::Mention,
                        title: "Hello".into(),
                        body: "World".into(),
                        action: None,
                        created_at: "2026-01-01T00:00:00Z".into(),
                        read: false,
                    },
                }
                .into(),
                NotificationEvent::Dismissed { id: "n1".into() }.into(),
            ],
        ),
        case(
            "social records relations and removes offline profiles",
            vec![
                SocialEvent::RelationsUpdated {
                    friends: vec!["Bob".into()],
                    foes: vec!["Cid".into()],
                }
                .into(),
                SocialEvent::PlayersSeen {
                    players: vec![PlayerProfile {
                        id: 2,
                        login: "Bob".into(),
                        ..Default::default()
                    }],
                }
                .into(),
                SocialEvent::PlayersRemoved {
                    logins: vec!["Bob".into()],
                }
                .into(),
            ],
        ),
        // ── maps / mods ──────────────────────────────────────────────────
        case(
            "maps load the vault and the installed list",
            vec![
                MapsEvent::VaultLoading.into(),
                MapsEvent::VaultLoadFailed {
                    reason: "503".into(),
                }
                .into(),
                MapsEvent::InstalledLoading.into(),
                MapsEvent::InstalledLoaded {
                    maps: vec![InstalledMap {
                        folder_name: "scmp_009".into(),
                        display_name: "Open Palms".into(),
                        max_players: 6,
                        width: 512,
                        height: 512,
                        version: Some("1.0".into()),
                        description: None,
                    }],
                }
                .into(),
            ],
        ),
        case(
            "mods load and report a failure",
            vec![
                ModsEvent::InstalledLoading.into(),
                ModsEvent::InstalledLoadFailed {
                    reason: "no mods folder".into(),
                }
                .into(),
            ],
        ),
        // ── map generator ────────────────────────────────────────────────
        case(
            "the map generator narrates a run and keeps its option lists",
            vec![
                MapGeneratorEvent::StatusChanged {
                    status: GeneratorStatus::ResolvingVersion,
                }
                .into(),
                MapGeneratorEvent::OptionListLoaded {
                    query: GeneratorOptionQuery::Styles,
                    values: vec!["LAND".into(), "BASIC".into()],
                }
                .into(),
                MapGeneratorEvent::StatusChanged {
                    status: GeneratorStatus::Generated {
                        maps: vec!["neroxis_map_generator_1.9.0_abc".into()],
                    },
                }
                .into(),
            ],
        ),
        case(
            "the map generator reports bad options, then a name it would produce",
            vec![
                // The dialog checks options as they are edited, so the issue
                // list has to be replaced wholesale rather than appended to:
                // a fixed problem must disappear.
                MapGeneratorEvent::ValidationChanged {
                    issues: vec![
                        faf_domain::state::ValidationIssue::SpawnsNotDivisibleByTeams {
                            spawn_count: 5,
                            num_teams: 2,
                        },
                    ],
                }
                .into(),
                MapGeneratorEvent::ValidationChanged { issues: vec![] }.into(),
                MapGeneratorEvent::NamePredicted {
                    map_name: "neroxis_map_generator_1.22.1_aaaaaaaaaayds_ayeaeaaj".into(),
                }
                .into(),
                // A cancellation is its own terminal status: not a failure.
                MapGeneratorEvent::StatusChanged {
                    status: GeneratorStatus::Cancelled,
                }
                .into(),
            ],
        ),
        case(
            "decoded map names accumulate while help text replaces itself",
            vec![
                MapGeneratorEvent::NamesDecoded {
                    decoded: std::collections::HashMap::from([(
                        "neroxis_map_generator_1.22.1_aaaaaaaaaayds_ayeaeaaj".to_string(),
                        faf_domain::protocol::map_generator_name::decode(
                            "neroxis_map_generator_1.22.1_aaaaaaaaaayds_ayeaeaaj",
                        )
                        .expect("a known-good name must decode"),
                    )]),
                }
                .into(),
                MapGeneratorEvent::HelpLoaded {
                    text: "Usage: generate [-hV]".into(),
                }
                .into(),
                // The preset library is replaced wholesale on every change, so
                // a deleted preset has to disappear rather than linger.
                MapGeneratorEvent::PresetsLoaded {
                    presets: vec![
                        faf_domain::state::GeneratorPreset {
                            name: "Team Ladder".into(),
                            saved_at: "2026-08-16T00:00:00+00:00".into(),
                            options: GeneratorOptions::default(),
                        },
                        faf_domain::state::GeneratorPreset {
                            name: "Blind 1v1".into(),
                            saved_at: "2026-08-15T00:00:00+00:00".into(),
                            options: GeneratorOptions::default(),
                        },
                    ],
                }
                .into(),
                MapGeneratorEvent::PresetsLoaded {
                    presets: vec![faf_domain::state::GeneratorPreset {
                        name: "Team Ladder".into(),
                        saved_at: "2026-08-16T00:00:00+00:00".into(),
                        options: GeneratorOptions::default(),
                    }],
                }
                .into(),
            ],
        ),
        // ── leaderboard ──────────────────────────────────────────────────
        case(
            "changing league clears stale season data",
            vec![
                LeaderboardEvent::ModeChanged {
                    mode: LeaderboardMode::Leagues,
                }
                .into(),
                LeaderboardEvent::SeasonsLoading { league_id: 3 }.into(),
                LeaderboardEvent::SeasonsLoadFailed {
                    reason: "503".into(),
                }
                .into(),
                LeaderboardEvent::SeasonsLoading { league_id: 8 }.into(),
            ],
        ),
        // ── player card ──────────────────────────────────────────────────
        case(
            "the player card opens and closes",
            vec![
                PlayerCardEvent::Loading {
                    login: "Bob".into(),
                }
                .into(),
                PlayerCardEvent::LoadFailed {
                    reason: "no such player".into(),
                }
                .into(),
                PlayerCardEvent::Closed.into(),
            ],
        ),
        case(
            "the open own profile follows avatar selections",
            vec![
                PlayerCardEvent::Loaded {
                    profile: Box::new(PlayerCardProfile {
                        player_id: 7,
                        login: "Ada".into(),
                        country: String::new(),
                        registered_at: String::new(),
                        last_seen_at: String::new(),
                        user_agent: String::new(),
                        avatars: vec![PlayerAvatar {
                            url: "old".into(),
                            tooltip: "Old".into(),
                            selected: true,
                            expires_at: None,
                        }],
                        names: Vec::new(),
                        clan: None,
                        ratings: Vec::new(),
                        league_placements: Vec::new(),
                        events: Vec::new(),
                        achievements: Vec::new(),
                        warnings: Vec::new(),
                    }),
                }
                .into(),
                PlayerCardEvent::AvatarSelected {
                    player_id: 7,
                    url: Some("new".into()),
                    tooltip: "New".into(),
                }
                .into(),
                PlayerCardEvent::AvatarSelected {
                    player_id: 7,
                    url: None,
                    tooltip: String::new(),
                }
                .into(),
            ],
        ),
        case(
            "the matchmaker profile loads independently of the investigation modal",
            vec![
                PlayerCardEvent::MatchmakerProfileLoading { player_id: 7 }.into(),
                PlayerCardEvent::MatchmakerProfileLoaded {
                    profile: Box::new(MatchmakerPlayerProfile {
                        player_id: 7,
                        login: "Ada".into(),
                        country: "de".into(),
                        clan_tag: "FAF".into(),
                        avatar_url: "avatar".into(),
                        avatar_tooltip: "Champion".into(),
                        games_played: 120,
                        ratings: Vec::new(),
                        league_placements: Vec::new(),
                        warnings: Vec::new(),
                    }),
                }
                .into(),
                PlayerCardEvent::MatchmakerProfileLoadFailed {
                    player_id: 7,
                    reason: "offline".into(),
                }
                .into(),
            ],
        ),
        // ── replays ──────────────────────────────────────────────────────
        case(
            "a replay connects, fails, and is dismissed",
            vec![
                ReplayEvent::Connecting.into(),
                ReplayEvent::Failed {
                    reason: "delayed by five minutes".into(),
                }
                .into(),
                ReplayEvent::Closed.into(),
                ReplayEvent::LiveTrackingScheduled {
                    tracking: LiveReplayTracking {
                        target: LiveReplayTarget {
                            uid: 7,
                            mod_name: "faf".into(),
                            map: "scmp_009".into(),
                        },
                        title: "Tracked replay".into(),
                        action: LiveReplayTrackingAction::Notify,
                        ready_at: 1_800_000_300,
                    },
                }
                .into(),
                ReplayEvent::LiveTrackingCleared.into(),
                ReplayEvent::VaultDownloadStarted { uid: 42 }.into(),
                ReplayEvent::VaultDownloaded {
                    uid: 42,
                    replay: local_replay(42),
                }
                .into(),
                ReplayEvent::VaultDownloadStarted { uid: 43 }.into(),
                ReplayEvent::VaultDownloadFailed {
                    uid: 43,
                    reason: "not uploaded yet".into(),
                }
                .into(),
            ],
        ),
        // ── reporting ────────────────────────────────────────────────────
        case(
            "a report is opened, submitted, and closed",
            vec![
                ReportingEvent::Opened {
                    player_id: 7,
                    login: "Bob".into(),
                }
                .into(),
                ReportingEvent::Submitting.into(),
                ReportingEvent::Submitted.into(),
                ReportingEvent::Closed.into(),
            ],
        ),
        // ── galactic war ─────────────────────────────────────────────────
        case(
            "galactic war is checked, updated, started, and reports its season",
            vec![
                GalacticWarEvent::InstallationChanged {
                    version: Some("v2026.03.01.1".into()),
                }
                .into(),
                GalacticWarEvent::StatusChanged {
                    status: GalacticWarStatus::CheckingVersion,
                }
                .into(),
                GalacticWarEvent::VersionsLoaded {
                    versions: ClientVersions {
                        required_version: "v2026.04.04.1".into(),
                        latest_version: None,
                    },
                }
                .into(),
                // The installed build turns out to be below the minimum.
                GalacticWarEvent::MinimumCheckChanged {
                    below_minimum: true,
                }
                .into(),
                GalacticWarEvent::StatusChanged {
                    status: GalacticWarStatus::Downloading {
                        version: "v2026.04.04.1".into(),
                        downloaded_bytes: 12_000_000,
                        total_bytes: 46_340_472,
                    },
                }
                .into(),
                GalacticWarEvent::StatusChanged {
                    status: GalacticWarStatus::Installing {
                        version: "v2026.04.04.1".into(),
                    },
                }
                .into(),
                GalacticWarEvent::InstallationChanged {
                    version: Some("v2026.04.04.1".into()),
                }
                .into(),
                GalacticWarEvent::MinimumCheckChanged {
                    below_minimum: false,
                }
                .into(),
                GalacticWarEvent::StatusChanged {
                    status: GalacticWarStatus::Running,
                }
                .into(),
                GalacticWarEvent::StatisticsStatusChanged {
                    status: StatisticsStatus::Loading,
                }
                .into(),
                GalacticWarEvent::StatisticsLoaded {
                    statistics: GalacticWarStatistics {
                        alltime: GalacticWarAlltime { num_players: 82 },
                        season: GalacticWarSeason {
                            started_at: "2026-03-15 22:55:15".into(),
                            name: "Testing Season 4".into(),
                            num_players: 16,
                            num_online_players: 4,
                            num_battles: 28,
                            num_planets: 1000,
                            num_factions: 4,
                            ..Default::default()
                        },
                        factions: vec![GalacticWarFaction {
                            id: 0,
                            name: "UEF".into(),
                            long_name: "United Earth Federation".into(),
                            num_planets: 254,
                            ..Default::default()
                        }],
                    },
                }
                .into(),
                // A later failure keeps the season that was already read.
                GalacticWarEvent::StatisticsStatusChanged {
                    status: StatisticsStatus::Failed {
                        reason: "gateway unreachable".into(),
                    },
                }
                .into(),
            ],
        ),
        // ── settings ─────────────────────────────────────────────────────
        case(
            "settings apply each group",
            vec![
                SettingsEvent::ThemeChanged {
                    theme: Theme::ForgeLight,
                }
                .into(),
                SettingsEvent::GamePathChanged {
                    path: "C:/games/FA/bin/ForgedAlliance.exe".into(),
                }
                .into(),
                SettingsEvent::SocialChanged {
                    preferences: SocialPreferences {
                        player_notes: vec![
                            PlayerNote {
                                player_id: 42,
                                login: "Old Aurora".into(),
                                note: "old".into(),
                            },
                            PlayerNote {
                                player_id: 7,
                                login: "Ada".into(),
                                note: "Map specialist".into(),
                            },
                            PlayerNote {
                                player_id: 42,
                                login: "Aurora".into(),
                                note: "Reliable teammate".into(),
                            },
                            PlayerNote {
                                player_id: 0,
                                login: "Invalid".into(),
                                note: "drop me".into(),
                            },
                        ],
                    },
                }
                .into(),
                SettingsEvent::DiscordChanged {
                    preferences: DiscordPreferences {
                        enabled: false,
                        disallow_joins: true,
                    },
                }
                .into(),
                SettingsEvent::BrowsingChanged {
                    preferences: Box::new(BrowsingPreferences {
                        custom_games_view: CustomGameView::List,
                        replays_view: CustomGameView::List,
                        custom_games_browser: CustomGameBrowserPreferences {
                            sort: CustomGameSort::Age,
                            hide_private: true,
                            hide_modded: true,
                            apply_filters: true,
                            rules: vec![
                                CustomGameFilterRule {
                                    field: CustomGameFilterField::Host,
                                    constraint: CustomGameFilterConstraint::Contains,
                                    value: "  noisy  ".into(),
                                },
                                CustomGameFilterRule {
                                    field: CustomGameFilterField::Host,
                                    constraint: CustomGameFilterConstraint::Contains,
                                    value: "NOISY".into(),
                                },
                            ],
                        },
                        matchmaker_unselected_queues: vec![
                            "  ladder_1v1 ".into(),
                            "LADDER_1V1".into(),
                        ],
                        matchmaker_factions: vec!["cybran".into(), "unknown".into()],
                        live_replay_filters: LiveReplayFilters {
                            search: "  tournament  ".into(),
                            game_type: " matchmaker ".into(),
                            featured_mod: " faf ".into(),
                            active_players: "04".into(),
                            max_players: "999".into(),
                            hide_modded: true,
                            hide_single_player: false,
                            friends_only: true,
                        },
                        host_game: HostGamePreferences {
                            title: " Friday game ".into(),
                            featured_mod: " faf ".into(),
                            visibility: "friends".into(),
                            map: " scmp_009 ".into(),
                            password_enabled: true,
                            password: " secret ".into(),
                            enforce_rating_range: true,
                            rating_min: 700,
                            rating_max: 1_700,
                        },
                        favorite_maps: vec!["adaptive_tabula.v0006".into()],
                        map_vault_preset: "recommended".into(),
                        mod_vault_preset: "recommended".into(),
                        leaderboard_rating_columns: vec![
                            "rating".into(),
                            "games".into(),
                            "wins".into(),
                            "winRate".into(),
                            "updated".into(),
                        ],
                        legacy_storage_migrated: true,
                    }),
                }
                .into(),
            ],
        ),
    ]
}

fn tourney(id: &str) -> Tourney {
    Tourney {
        id: id.into(),
        name: format!("Event {id}"),
        status: TourneyStatus::Signup,
        player_count: 8,
        team_count: 8,
        created_at: Some(1_700_000_000),
        ..Tourney::default()
    }
}

fn tourney_room(id: &str, unread: i32) -> ChatRoom {
    ChatRoom {
        id: id.into(),
        name: format!("Room {id}"),
        unread,
    }
}

fn player_summary(id: i32, login: &str, rating: Option<i32>) -> PlayerSummary {
    PlayerSummary {
        id,
        login: login.into(),
        avatar_url: String::new(),
        country: "de".into(),
        global_rating: rating,
        ladder_rating: None,
    }
}

fn tutorial(id: i32) -> Tutorial {
    Tutorial {
        id,
        title: format!("Lesson {id}"),
        description: String::new(),
        link_url: String::new(),
        image_url: String::new(),
        ordinal: id,
        launchable: true,
        map_folder_name: format!("scmp_tut_{id}"),
        technical_name: format!("tut_{id}"),
        category_id: Some(1),
    }
}

/// Writes the fixture. A test rather than a binary so it cannot go stale
/// without someone noticing: `cargo test` regenerates it, and the frontend
/// test then fails if the twin has not kept up.
#[test]
fn writes_the_frontend_conformance_fixture() {
    let fixture = Fixture {
        initial: AppState::default(),
        cases: cases(),
        helpers: helper_fixture(),
    };
    let json = serde_json::to_string_pretty(&fixture).expect("the fixture must serialise");

    let target =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/store/__fixtures__");
    std::fs::create_dir_all(&target).expect("could not create the fixture directory");
    std::fs::write(target.join("reducer-conformance.json"), format!("{json}\n"))
        .expect("could not write the fixture");
}

/// Every case must actually exercise something: an empty sequence would pass
/// the frontend test while proving nothing.
#[test]
fn every_case_has_steps() {
    for case in cases() {
        assert!(!case.steps.is_empty(), "`{}` has no steps", case.name);
    }
}

/// Every state slice must appear in at least one case.
///
/// Without this, adding a slice adds an untested hand-written TS twin and the
/// harness stays silent about it: which is precisely the gap the harness was
/// built to close. `AppState`'s own field names are the list, so a new slice
/// enrols itself: `AppEvent`'s `kind` tag is the same name in PascalCase.
#[test]
fn every_state_slice_is_covered_by_a_case() {
    let state = serde_json::to_value(AppState::default()).expect("state must serialise");
    let slices: Vec<String> = state
        .as_object()
        .expect("state is an object")
        .keys()
        .cloned()
        .collect();

    let mut covered = std::collections::BTreeSet::new();
    for case in cases() {
        for step in &case.steps {
            let event = serde_json::to_value(&step.event).expect("event must serialise");
            let kind = event["kind"].as_str().expect("every event is tagged");
            let mut chars = kind.chars();
            let camel = match chars.next() {
                Some(first) => first.to_ascii_lowercase().to_string() + chars.as_str(),
                None => String::new(),
            };
            covered.insert(camel);
        }
    }

    let missing: Vec<&String> = slices
        .iter()
        .filter(|slice| !covered.contains(*slice))
        .collect();
    assert!(
        missing.is_empty(),
        "these state slices have no conformance case: {missing:?}"
    );
}

/// Event variants not yet represented by a scenario. This is an explicit debt
/// baseline, not a blanket exemption: a new event fails the test until it gets
/// a conformance case or is deliberately added here. When a case is added, its
/// entry must be removed so the baseline can only shrink intentionally.
const UNCOVERED_EVENT_VARIANTS: &[&str] = &[
    "Auth:testLoggedIn",
    "ClientUpdate:failed",
    "Coop:catalogLoadFailed",
    "Coop:leaderboardLoading",
    "Coop:missionSelected",
    "Leaderboard:catalogLoadFailed",
    "Leaderboard:catalogLoaded",
    "Leaderboard:catalogLoading",
    "Leaderboard:ratingsLoadFailed",
    "Leaderboard:ratingsLoaded",
    "Leaderboard:ratingsLoading",
    "Leaderboard:seasonLoadFailed",
    "Leaderboard:seasonLoaded",
    "Leaderboard:seasonLoading",
    "Leaderboard:seasonsLoaded",
    "Lobby:avatarSelectionFailed",
    "Lobby:avatarsLoadFailed",
    "Lobby:gamesUpdated",
    "Lobby:joinFailed",
    "Lobby:launchFailed",
    "Lobby:launching",
    "Lobby:liveGamesUpdated",
    "Lobby:matchmakingUpdated",
    "Lobby:partyUpdated",
    "Lobby:vetoesUpdated",
    "MapGenerator:optionsChanged",
    "MapGenerator:previewsLoaded",
    "MapGenerator:versionResolved",
    "MapGenerator:versionsLoaded",
    "Maps:installFailed",
    "Maps:installed",
    "Maps:installedLoadFailed",
    "Maps:installing",
    "Maps:matchmakerPoolsLoadFailed",
    "Maps:matchmakerPoolsLoaded",
    "Maps:matchmakerPoolsLoading",
    "Maps:uninstallFailed",
    "Maps:uninstalled",
    "Maps:vaultLoaded",
    "Mods:installFailed",
    "Mods:installed",
    "Mods:installedLoaded",
    "Mods:installing",
    "Mods:toggleFailed",
    "Mods:toggled",
    "Mods:toggling",
    "Mods:uninstallFailed",
    "Mods:uninstalled",
    "Mods:vaultLoadFailed",
    "Mods:vaultLoaded",
    "Mods:vaultLoading",
    "Notifications:cleared",
    "Notifications:read",
    "PlayerCard:historyLoadFailed",
    "PlayerCard:historyLoaded",
    "PlayerCard:historyLoading",
    "Replays:featuredModsLoaded",
    "Replays:localDeleted",
    "Replays:localLoadFailed",
    "Replays:localLoaded",
    "Replays:localLoading",
    "Replays:playing",
    "Replays:vaultLoadFailed",
    "Replays:vaultLoaded",
    "Replays:vaultLoading",
    "Reporting:failed",
    "Reporting:historyFailed",
    "Reporting:historyLoaded",
    "Reporting:historyLoading",
    "Reviews:closed",
    "Reviews:loadFailed",
    "Reviews:saveFailed",
    "Settings:appearanceChanged",
    "Settings:chatChanged",
    "Settings:connectivityChanged",
    "Settings:gameChanged",
    "Settings:generalChanged",
    "Settings:loaded",
    "Settings:mapGeneratorChanged",
    "Settings:notificationsChanged",
    "Settings:replayGamePathChanged",
    "Settings:updatesChanged",
    "Social:cleared",
    "Social:relationSet",
    "Tourney:chatFailed",
    "Tourney:detailLoadFailed",
    "Tourney:loadFailed",
    "Tutorials:launchFailed",
    "Tutorials:loadFailed",
];

const EVENT_ENUM_SOURCES: &[(&str, &str, &str)] = &[
    ("Auth", "AuthEvent", include_str!("../src/state/auth.rs")),
    ("Chat", "ChatEvent", include_str!("../src/state/chat.rs")),
    (
        "ClientUpdate",
        "ClientUpdateEvent",
        include_str!("../src/state/client_update.rs"),
    ),
    ("Coop", "CoopEvent", include_str!("../src/state/coop.rs")),
    (
        "Install",
        "InstallEvent",
        include_str!("../src/state/install.rs"),
    ),
    (
        "Leaderboard",
        "LeaderboardEvent",
        include_str!("../src/state/leaderboard.rs"),
    ),
    ("Lobby", "LobbyEvent", include_str!("../src/state/lobby.rs")),
    (
        "MapGenerator",
        "MapGeneratorEvent",
        include_str!("../src/state/map_generator.rs"),
    ),
    ("Maps", "MapsEvent", include_str!("../src/state/maps.rs")),
    ("Mods", "ModsEvent", include_str!("../src/state/mods.rs")),
    ("Nav", "NavEvent", include_str!("../src/state/nav.rs")),
    (
        "Notifications",
        "NotificationEvent",
        include_str!("../src/state/notifications.rs"),
    ),
    (
        "PlayerCard",
        "PlayerCardEvent",
        include_str!("../src/state/player_card.rs"),
    ),
    (
        "Replays",
        "ReplayEvent",
        include_str!("../src/state/replays.rs"),
    ),
    (
        "Reporting",
        "ReportingEvent",
        include_str!("../src/state/reporting.rs"),
    ),
    (
        "Reviews",
        "ReviewsEvent",
        include_str!("../src/state/reviews.rs"),
    ),
    (
        "Session",
        "SessionEvent",
        include_str!("../src/state/session.rs"),
    ),
    (
        "Settings",
        "SettingsEvent",
        include_str!("../src/state/settings.rs"),
    ),
    (
        "Social",
        "SocialEvent",
        include_str!("../src/state/social.rs"),
    ),
    (
        "Tourney",
        "TourneyEvent",
        include_str!("../src/state/tourney.rs"),
    ),
    (
        "Tutorials",
        "TutorialsEvent",
        include_str!("../src/state/tutorials.rs"),
    ),
    (
        "Uploads",
        "UploadsEvent",
        include_str!("../src/state/uploads.rs"),
    ),
];

#[test]
fn every_event_variant_is_covered_or_explicitly_baselined() {
    use std::collections::BTreeSet;

    let covered: BTreeSet<String> = cases()
        .into_iter()
        .flat_map(|case| case.steps)
        .map(|step| {
            let event = serde_json::to_value(step.event).expect("event must serialise");
            format!(
                "{}:{}",
                event["kind"].as_str().expect("event kind is a string"),
                event["event"]["type"]
                    .as_str()
                    .expect("nested event type is a string")
            )
        })
        .collect();
    let declared: BTreeSet<String> = EVENT_ENUM_SOURCES
        .iter()
        .flat_map(|(kind, enum_name, source)| declared_variants(kind, enum_name, source))
        .collect();
    let actual_missing: BTreeSet<String> = declared.difference(&covered).cloned().collect();
    let baseline: BTreeSet<String> = UNCOVERED_EVENT_VARIANTS
        .iter()
        .map(|variant| (*variant).to_string())
        .collect();

    assert_eq!(
        actual_missing, baseline,
        "conformance coverage changed; add a case for new variants and remove newly covered variants from UNCOVERED_EVENT_VARIANTS"
    );
}

fn declared_variants(kind: &str, enum_name: &str, source: &str) -> Vec<String> {
    let declaration = format!("pub enum {enum_name} {{");
    let body = source
        .split_once(&declaration)
        .unwrap_or_else(|| panic!("could not find `{declaration}`"))
        .1;
    let mut depth = 1_i32;
    let mut variants = Vec::new();
    for line in body.lines() {
        if depth == 1 && line.starts_with("    ") && !line.starts_with("        ") {
            let identifier: String = line
                .trim_start()
                .chars()
                .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
                .collect();
            if identifier.starts_with(|character: char| character.is_ascii_uppercase()) {
                let mut characters = identifier.chars();
                let camel = characters
                    .next()
                    .map(|first| first.to_ascii_lowercase().to_string() + characters.as_str())
                    .unwrap_or_default();
                variants.push(format!("{kind}:{camel}"));
            }
        }
        depth += line.matches('{').count() as i32;
        depth -= line.matches('}').count() as i32;
        if depth == 0 {
            break;
        }
    }
    variants
}

/// The initial state must round-trip through JSON unchanged. Step expectations
/// are JSON values by design because each one is only a single heterogeneous
/// state slice.
#[test]
fn the_recorded_states_round_trip_through_json() {
    let state = AppState::default();
    let json = serde_json::to_string(&state).expect("state must serialise");
    let back: AppState = serde_json::from_str(&json).expect("state must deserialise");
    assert_eq!(back, state);
}
