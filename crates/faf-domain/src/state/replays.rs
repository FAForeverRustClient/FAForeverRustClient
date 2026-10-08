//! Replays slice: watching a live game or a local `.fafreplay` file.
//!
//! Mirrors the Python client's `fa/replaylivestreamer.py` / `fa/replay.py`: a
//! live watch fetches a WebSocket relay for an in-progress game, a file watch
//! decompresses a recorded replay. Both converge on the same FA `/replay`
//! launch; this slice only tracks the resulting status, the actual IO lives
//! behind [`crate`]'s port boundary (the replay ports in `faf-app`'s
//! `ports::replay`).

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use specta::Type;

pub use crate::protocol::replay_query::{
    ReplayQuery, ReplaySortField, MAX_RATING, MIN_RATING, VICTORY_CONDITIONS,
};

/// How long after a match starts its live stream becomes watchable.
///
/// This is an **anti-ghosting** rule, not a technical one: without it a player
/// could open a live replay of a game they are not in and read their opponent's
/// scouting, build order and army positions in real time. The FAF replay server
/// holds the stream back by this much, and both reference clients refuse to
/// launch before then: the Java client gates its Discord spectate link on
/// `watchDelaySeconds`, and the Python client's live streamer warns and blocks.
///
/// Enforced in `faf-app`'s replay service so every route to a live watch is
/// covered, and mirrored in the UI (`LIVE_REPLAY_DELAY_SECONDS`) as a countdown
/// on the button.
pub const LIVE_REPLAY_DELAY_SECONDS: u32 = 300;

/// Seconds still to wait before a match launched at `launched_at` may be
/// watched live. `0` once the delay has elapsed, and for a game with no
/// recorded start time: an unknown start cannot be shown to be too recent.
pub fn live_replay_delay_remaining(launched_at: Option<u32>, now: u32) -> u32 {
    let Some(launched_at) = launched_at.filter(|started| *started > 0) else {
        return 0;
    };
    let watchable_at = launched_at.saturating_add(LIVE_REPLAY_DELAY_SECONDS);
    watchable_at.saturating_sub(now)
}

/// Enough to identify and launch a live (in-progress) game's replay stream.
/// Comes from a [`crate::state::Game`] the lobby already surfaced as playing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveReplayTarget {
    pub uid: i32,
    /// Wire key on the launch args is `mod`, a Rust keyword; the struct field
    /// avoids it like `GameLaunch::mod_name` does.
    pub mod_name: String,
    pub map: String,
}

/// What should happen when a delayed live replay becomes watchable.
///
/// The Java client exposes the same two choices. Keeping this in domain state
/// rather than a component timer means changing tabs or recovering from an IPC
/// lag snapshot does not silently forget the user's choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LiveReplayTrackingAction {
    Notify,
    Watch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveReplayTracking {
    pub target: LiveReplayTarget,
    pub title: String,
    pub action: LiveReplayTrackingAction,
    /// Unix timestamp at which the anti-ghosting delay ends.
    pub ready_at: u32,
}

/// One entry in the global "newest replays" feed, as listed from the FAF
/// Data API (`GET /data/game`, no player filter: mirrors the Java client's
/// `OnlineReplayVaultController`'s `NEWEST` category). Just enough to render
/// a row and trigger a download+play: not the full search/filter model the
/// reference clients' vault tabs have (map/player/rating filters, "own
/// replays only" toggle, are a later phase).
// No `Eq` here (unlike the other structs in this file): `reviews_average` is
// an `f32`, which doesn't implement it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultReplay {
    pub uid: i32,
    /// `game.attributes.name`: the host-chosen lobby title (e.g. "all
    /// welcome", "1200+"), distinct from the map name.
    pub title: String,
    pub map: String,
    /// `mapVersion.thumbnailUrlSmall` straight from the API. Empty string if
    /// missing (e.g. a generated/hidden map): the frontend treats that as
    /// "no thumbnail" rather than us modeling it as `Option`.
    pub map_thumbnail_url: String,
    pub mod_name: String,
    /// ISO 8601, straight from the API: rendering/formatting is a UI concern.
    pub start_time: String,
    /// When the game ended, same format, empty while it is still running.
    ///
    /// Carried rather than only folded into [`Self::duration_seconds`] because
    /// the vault can be ordered by it, and that ordering is applied to rows
    /// that have already arrived: see [`sort_vault_replays`].
    #[serde(default)]
    pub end_time: String,
    /// Whether the file has actually finished uploading to content storage.
    /// A "newest replays" listing includes very recent/still-processing
    /// games too; both reference clients disable the Watch button until this
    /// is `true` rather than filtering the row out entirely.
    pub replay_available: bool,
    /// `endTime - startTime` in seconds. `None` if either timestamp is
    /// missing/unparseable (e.g. a game still in progress has no `endTime`).
    pub duration_seconds: Option<i32>,
    /// Simulation time from `replayTicks` (10 ticks/second). Unlike the wall
    /// clock duration above, this excludes pauses and slow simulation speed.
    pub game_duration_seconds: Option<i32>,
    pub teams: Vec<ReplayTeam>,
    /// Average of all resolvable player ratings on the card: `None` if no
    /// player's rating could be resolved.
    pub average_rating: Option<i32>,
    /// TrueSkill match quality as a percentage for exactly two rated teams.
    /// `None` when the replay is not a two-team match or a rating journal is
    /// missing the values required to calculate it.
    pub quality: Option<i32>,
    pub reviews_average: Option<f32>,
    pub reviews_count: Option<i32>,
    pub game_version: Option<i32>,
    /// `game.attributes.validity`, the server's verdict on whether this game
    /// counted: `VALID`, or the reason it did not (`BAD_MOD`,
    /// `UNKNOWN_RESULT`, ...). Kept as the raw server value, because the set
    /// grows on the server and an unrecognised one still has to be reportable.
    /// Empty when the listing did not carry it.
    ///
    /// The whole result display hangs off this: an unrated game has no
    /// outcome worth showing, and saying so is the point (see
    /// `ReplayDetailRoster`).
    #[serde(default)]
    pub validity: String,
    /// `game.attributes.victoryCondition`, raw: `DEMORALIZATION`,
    /// `DOMINATION`, `ERADICATION`, `SANDBOX`, or empty when the listing did
    /// not carry one. Same posture as [`Self::validity`]: the set grows on the
    /// server, so an unrecognised value still has to survive the trip.
    ///
    /// Here for the same reason [`Self::end_time`] is: the vault can be
    /// ordered by it.
    #[serde(default)]
    pub victory_condition: String,
}

/// Order vault rows the way the API would have ordered them.
///
/// Exists because two of the vault's filters have no clause the API can answer
/// (see [`ReplayQuery::accepts_locally`]), so a search using either of them is
/// a scan the client filters itself. That scan has to read the vault in *some*
/// order, and it used to read it in the order the user had asked to see the
/// results in. Which meant the sort silently decided **which** games were
/// examined: sorted by date it scanned the newest games and matched some,
/// sorted by review score it scanned the best-reviewed games and matched
/// others, and switching between them changed the answer rather than the
/// arrangement. That is not what a sort is, and it was reported as exactly
/// that.
///
/// The scan reads newest-first now, always, and the order the user chose is
/// applied here, to the rows that matched. The set stops depending on how it
/// is displayed.
///
/// Two rules worth stating, because neither is obvious:
///
/// - **A missing value sorts last in both directions.** Almost no replay has a
///   review, and a descending sort by review score that opened with three
///   hundred unreviewed games would be useless. Absent is not "worst", it is
///   "not applicable", and it belongs at the end either way.
/// - **Ties keep the order they arrived in**, which is newest-first, because
///   the sort is stable. So ordering by title, among a thousand games all
///   called "Custom Game", still reads newest-first inside that group.
pub fn sort_vault_replays(replays: &mut [VaultReplay], sort_by: ReplaySortField, descending: bool) {
    replays.sort_by(|a, b| {
        match (
            sort_value_missing(a, sort_by),
            sort_value_missing(b, sort_by),
        ) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                let ordering = compare_on(a, b, sort_by);
                if descending {
                    ordering.reverse()
                } else {
                    ordering
                }
            }
        }
    });
}

/// Compare two rows on one field, ascending. Only ever called for two rows
/// that both have a value: [`sort_value_missing`] has already dealt with the
/// ones that do not.
fn compare_on(a: &VaultReplay, b: &VaultReplay, sort_by: ReplaySortField) -> Ordering {
    match sort_by {
        // RFC 3339 in a fixed zone, which the API returns and which compares
        // correctly as text: same length, most significant field first.
        ReplaySortField::StartTime => a.start_time.cmp(&b.start_time),
        ReplaySortField::EndTime => a.end_time.cmp(&b.end_time),
        // `replayTicks` is what the API orders by, and `game_duration_seconds`
        // is that number in seconds. The wall clock duration is a different
        // measure and would disagree with the server about any game that was
        // paused, so it is only the fallback.
        ReplaySortField::Duration => sort_duration(a).cmp(&sort_duration(b)),
        ReplaySortField::ReviewScore => review_key(a).cmp(&review_key(b)),
        // Case-insensitive, because a list where "zerg rush" sorts before
        // "All welcome" is not alphabetical to anybody reading it.
        ReplaySortField::Title => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
        ReplaySortField::Id => a.uid.cmp(&b.uid),
        ReplaySortField::VictoryCondition => a.victory_condition.cmp(&b.victory_condition),
        ReplaySortField::AverageRating => a.average_rating.cmp(&b.average_rating),
    }
}

/// Whether this row has nothing to be sorted by on that field.
///
/// An empty string counts: a game with no recorded end time has not ended
/// before every other game, it has no end time.
fn sort_value_missing(replay: &VaultReplay, sort_by: ReplaySortField) -> bool {
    match sort_by {
        ReplaySortField::StartTime => replay.start_time.is_empty(),
        ReplaySortField::EndTime => replay.end_time.is_empty(),
        ReplaySortField::Duration => sort_duration(replay).is_none(),
        ReplaySortField::ReviewScore => review_key(replay).is_none(),
        ReplaySortField::Title => replay.title.is_empty(),
        // Every row has one: it is the vault key.
        ReplaySortField::Id => false,
        ReplaySortField::VictoryCondition => replay.victory_condition.is_empty(),
        ReplaySortField::AverageRating => replay.average_rating.is_none(),
    }
}

fn sort_duration(replay: &VaultReplay) -> Option<i32> {
    replay.game_duration_seconds.or(replay.duration_seconds)
}

/// Review scores are `f32`, which is not `Ord`. Hundredths as an integer keeps
/// the ordering exact for the one decimal place a five-point scale carries,
/// and drops a `NaN` into the "no value" bucket where it belongs.
fn review_key(replay: &VaultReplay) -> Option<i32> {
    replay
        .reviews_average
        .filter(|score| score.is_finite())
        .map(|score| (score * 100.0).round() as i32)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayGameOption {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayChatMessage {
    /// In-game simulation time in seconds.
    pub time_seconds: u32,
    pub sender: String,
    pub message: String,
    /// The channel the line was typed into: `all`, `allies`, or the number of
    /// the army a whisper went to. Empty where the record did not say, which
    /// old builds do not.
    #[serde(default)]
    pub to: String,
}

/// How busy one client was, counted out of the replay's own command stream.
///
/// The stream records an order per client per tick, so this is the one place
/// an "actions per minute" can come from: the API knows who played and what
/// they were rated, and nothing about what they did. Deliberately called
/// commands rather than actions, because that is what is being counted: an
/// order the engine was given. A hotkey that reissues an order counts twice,
/// and a player who clicks the same order onto forty units counts once. The
/// number is a comparison between the people in one game, not a score.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCommandStats {
    /// The login the replay's client table carries. Observers are in it too,
    /// and their command count is the handful the camera makes.
    pub player: String,
    /// Orders attributed to this client: the ones that move, build, target or
    /// cancel. The engine's bookkeeping (clock, checksums, the callbacks a UI
    /// mod fires every tick) is not counted, because a mod that chatters once
    /// a tick would otherwise outrank every player in the game.
    pub commands: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayDetails {
    pub game_options: Vec<ReplayGameOption>,
    pub chat_messages: Vec<ReplayChatMessage>,
    /// One entry per client the replay names, in the order the file lists
    /// them. Empty for a file whose stream could not be walked.
    #[serde(default)]
    pub command_stats: Vec<ReplayCommandStats>,
    /// Simulated seconds the command stream covers, which is the denominator
    /// of a per-minute rate. Simulated: a game that ran slow lasted longer on
    /// the clock than this, and the orders were still given over this much
    /// game time.
    #[serde(default)]
    pub sim_seconds: u32,
    /// Display names of the simulation mods the game ran with, read from the
    /// `.fafreplay` header rather than the command stream: the stream's own mod
    /// table is the engine's, keyed by install paths. Empty for a legacy
    /// `.scfareplay`, which has no header to read.
    #[serde(default)]
    pub sim_mods: Vec<String>,
    /// SupCom patch number parsed from the replay body header. The API game
    /// resource does not expose this value reliably, so detailed parsing is
    /// the source of truth when the listing has no version yet.
    pub game_version: Option<i32>,
}

// The full read of a replay file, for the panel that analyses one.
//
// Everything below is what the Python client's replay window reads out of the
// same file (`src/replays/replaydetails/` in FAForever/client), modelled as
// types rather than as the HTML that client builds. It is loaded separately
// from `ReplayDetails`, and only when somebody asks for it: a twenty minute
// eight player game is a quarter of a million records in the command stream,
// and the orders and targets pulled out of it are the largest thing this
// client ever puts in its state.

/// One army in the game, as the replay's own header describes it.
///
/// The header is the only place most of this exists: the API knows who played
/// and what they were rated, and nothing about their colour, their start spot
/// or which client was driving them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayArmy {
    /// Index into the client table, which is what the command stream switches
    /// between. `-1` for an AI, which has an army and no client.
    pub source: i32,
    pub name: String,
    /// `ARMY_1` and so on: the engine's own name for the slot.
    pub army_name: String,
    /// 1 UEF, 2 Aeon, 3 Cybran, 4 Seraphim, 5 Random.
    pub faction: i32,
    /// 1-based index into the game's colour palette.
    pub color: i32,
    pub team: i32,
    pub start_spot: i32,
    pub human: bool,
    /// Two-letter country code, where the player had one set.
    pub country: String,
    pub clan: String,
    /// `trunc(mean - 3*deviation)` at the moment the game launched, which is
    /// the displayed rating both reference clients compute.
    pub rating: Option<i32>,
}

/// The map and the lobby settings the game was played under.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayScenario {
    pub name: String,
    pub description: String,
    /// The map folder, out of the scenario path the engine loaded.
    pub map_folder: String,
    /// Map edge length in world units, which is what a heatmap point is in.
    pub width: i32,
    pub height: i32,
    pub options: Vec<ReplayGameOption>,
}

/// When one client was giving orders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayActivity {
    pub source: i32,
    /// The tick of every order this client gave, in order.
    ///
    /// Deduplicated the way the Python client does it: orders of the same kind
    /// on the same tick count once, because one click that queues a command
    /// onto a group of units is one action however many records it writes.
    pub command_ticks: Vec<u32>,
    /// The last tick this client did anything, which is the denominator of its
    /// rate. A player who was killed at minute ten is measured over ten
    /// minutes, not over the forty the game ran for.
    pub last_tick: u32,
}

/// One order, for the timeline under the activity graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayOrder {
    pub source: i32,
    pub tick: u32,
    /// `EUnitCommandType`: 8 is a mobile build, 27 an upgrade, 28 a script.
    pub command: i32,
    /// The unit ordered, where the order names one.
    pub blueprint: String,
    /// The enhancement or task a script order carried, where it had one.
    pub detail: String,
}

/// Where on the map an order was aimed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPoint {
    pub tick: u32,
    /// World units, rounded. A heatmap bins these into cells, and no bin is
    /// small enough for the fraction to matter.
    pub x: i32,
    pub y: i32,
    pub command: i32,
    pub source: i32,
}

/// A line the game announced rather than a player typed: the notify channel,
/// which is where the in-game mod reports what it is upgrading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayNotice {
    pub tick: u32,
    /// The client the announcement came from, as an index into the same table
    /// [`ReplayArmy::source`] points into. `-1` where the record named nobody.
    pub source: i32,
    pub text: String,
}

/// Mass, energy and unit count, the three the engine scores everything in.
///
/// Whole numbers, although the simulation sends fractions: a mass total of
/// `30050.0625` is drawn as a bar, and the sixteenth of a mass point at the end
/// of it is not a thing anybody reads. Integers also keep these types
/// comparable and keep every field on the TypeScript side non-null, which a
/// float cannot be: a Rust `f64` can be `NaN`, so the generator makes it
/// nullable and every use of it has to say what nothing means.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTotals {
    pub mass: i32,
    pub energy: i32,
    pub count: i32,
}

/// One category of unit, for one player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayUnitStat {
    /// `land`, `air`, `naval`, `tech1` to `tech3`, `experimental`, `engineer`,
    /// `structures`, `cdr`, `sacu`, `transportation`.
    pub category: String,
    pub built: i32,
    pub lost: i32,
    pub kills: i32,
}

/// One resource flow, for one player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResourceStat {
    /// `massin`, `massout`, `energyin`, `energyout`, `storage`.
    pub resource: String,
    pub total: i32,
    pub reclaimed: i32,
    /// What the flow wasted, which only the outgoing ones record.
    pub excess: i32,
}

/// What the simulation itself said about one player when the game ended.
///
/// Not parsed out of the command stream: the game sends it, once, as a
/// `ModeratorEvent` callback carrying a `JsonStats` payload. Absent from a
/// replay of a game that ended before the sim sent one, and from any game old
/// enough to predate it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPlayerStats {
    pub name: String,
    pub faction: i32,
    /// `Human` or the AI's own kind.
    pub kind: String,
    pub defeated: bool,
    pub score: i32,
    pub built: ReplayTotals,
    pub lost: ReplayTotals,
    pub kills: ReplayTotals,
    pub units: Vec<ReplayUnitStat>,
    pub resources: Vec<ReplayResourceStat>,
}

/// Everything the analysis panel draws, from one read of one replay file.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayAnalysis {
    /// The game this describes, 0 for a file whose header names none.
    pub uid: i32,
    /// The read this answers, as [`replay_read_key`] names it, so a late
    /// answer for one replay is not drawn over another. Two files without a
    /// game id are both uid 0 and only this tells them apart.
    ///
    /// Filled in by the replay service from the request, not by whatever
    /// walked the file: the walk knows the bytes, not which path the panel
    /// asked about.
    pub key: String,
    /// Simulation ticks the stream covers. Ten to the second.
    pub ticks: u32,
    /// The engine build the game ran on, as the file's first line spells it.
    pub game_version: String,
    pub armies: Vec<ReplayArmy>,
    /// Clients that were watching rather than playing.
    pub observers: Vec<String>,
    pub scenario: ReplayScenario,
    pub activity: Vec<ReplayActivity>,
    pub orders: Vec<ReplayOrder>,
    pub points: Vec<ReplayPoint>,
    pub notices: Vec<ReplayNotice>,
    pub stats: Vec<ReplayPlayerStats>,
}

/// One game's map, as its replay file names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedReplayMap {
    pub uid: i32,
    /// The map folder the replay was played on, or empty when the file named
    /// none. Empty is an answer: it stops the view asking a second time.
    pub map: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTeam {
    pub team: i32,
    pub players: Vec<ReplayPlayer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPlayer {
    pub name: String,
    /// Absolute URL of the player's selected avatar, when the vault response
    /// includes the player's avatar assignment.
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// 1=UEF, 2=Aeon, 3=Cybran, 4=Seraphim, 5=Random: the lobby selection
    /// recorded by `playerStats.faction`, not the faction Random resolved to.
    pub faction: Option<i32>,
    /// `trunc(mean - 3*deviation)` at game time, the "displayed rating" both
    /// reference clients compute: Java casts (`RatingUtil.getRating`), Python
    /// casts (`rating_estimate`), and neither rounds.
    pub rating: Option<i32>,
    /// What this game did to that rating: displayed rating after minus
    /// displayed rating before, from the player's first rating journal.
    ///
    /// `None` when the game was not rated, which the journal signals by having
    /// no `meanAfter`. That is the case the score used to paper over: a score
    /// exists for games whose result the server never resolved, so a number
    /// appeared next to "unknown result" and read as a rating change that had
    /// not happened. Java's `PlayerCardController::getRatingChange`.
    #[serde(default)]
    pub rating_change: Option<i32>,
    /// Server-recorded game result (`VICTORY`, `DEFEAT`, `DRAW`, ...).
    /// Empty when older games did not record an outcome.
    pub outcome: String,
    /// Simulation score at the end of the game, when recorded.
    pub score: Option<i32>,
    /// Two-letter country code, when a replay file on disk says it. The API
    /// has no country for an account, so an online listing never carries one.
    #[serde(default)]
    pub country: Option<String>,
}

/// One `.fafreplay` file already on disk, from the shared FAF replay folder
/// (`%ProgramData%\FAForever\replays` on Windows: every FAF client writes
/// here, mirrors `DataPrefs.getReplaysDirectory()` in the Java client). Read
/// from the JSON header line and compact binary replay header, not the full
/// compressed command stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalReplay {
    pub path: String,
    pub file_name: String,
    pub uid: Option<i32>,
    pub map: String,
    pub mod_name: String,
    pub title: String,
    pub recorder: String,
    pub start_time: Option<u32>,
    /// How long the game ran, in seconds, from the envelope's own `launched_at`
    /// and `game_end`.
    ///
    /// Wall-clock, not sim time: the number of seconds the people in it spent
    /// playing, which is what the vault calls a replay's real-time duration.
    /// The sim's own length would mean walking the whole command stream
    /// counting ticks, and the archive lists thousands of files.
    ///
    /// `None` when the envelope does not carry both ends, or carries them
    /// equal. The listing used to show "N/A" for every local replay whatever
    /// the file said, which is what the report was about.
    pub duration_seconds: Option<i32>,
    pub modified_time: u32,
    pub file_size_bytes: u32,
    pub num_players: i32,
    pub teams: Vec<LocalReplayTeam>,
    /// Average displayed rating from the replay body header, when recorded.
    pub average_rating: Option<i32>,
    pub sim_mods: Vec<String>,
    pub status: LocalReplayStatus,
    pub watchable: bool,
    pub game_version: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalReplayTeam {
    pub team: String,
    pub players: Vec<LocalReplayPlayer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalReplayPlayer {
    pub name: String,
    /// 1=UEF, 2=Aeon, 3=Cybran, 4=Seraphim, 5=Random.
    pub faction: Option<i32>,
    /// The displayed rating recorded in the replay header.
    pub rating: Option<i32>,
    /// An army with no client behind it: an AI somebody added to the lobby.
    ///
    /// The vault lists accounts, so these are the players only the file knows
    /// about, and the only ones worth adding to the vault's lineup. A person
    /// the vault is missing by name has been renamed since, not left out: the
    /// file carries the name they played under and the vault their current
    /// one, and adding them read as the same player twice. `false` where the
    /// file only had the header's name list to go on.
    #[serde(default)]
    pub ai: bool,
    /// Two-letter country code from the army table, where the file has one.
    #[serde(default)]
    pub country: Option<String>,
}

/// How much trustworthy metadata was available without decoding the full replay
/// command stream. Matches the Python client's complete/incomplete/broken/
/// legacy buckets, while keeping incomplete and legacy files playable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LocalReplayStatus {
    Complete,
    /// Listed from the directory, header not read yet. The archive is listed in
    /// full but only the newest pages are read up front; this marks the rest so
    /// the UI can say "not loaded" rather than imply the file is damaged.
    Unread,
    Incomplete,
    Legacy,
    Broken,
}

/// One step of a replay launch's preparation, as the dialog shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPreparation {
    pub detail: String,
    /// Percent, when the step can say how far along it is.
    pub progress: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReplayStatus {
    #[default]
    Idle,
    Connecting,
    /// FA has been launched. `uid` is `None` for a local file whose header
    /// failed to parse (playback still proceeds; we just can't label it).
    Playing {
        uid: Option<i32>,
    },
    Failed {
        reason: String,
    },
}

/// Where the vault list stands. Separate from [`ReplayStatus`] (playback),
/// you can be browsing the vault (`Ready`) while also `Playing` a replay.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum VaultStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// The independent download-to-library lifecycle. Downloading a replay must
/// not pretend that FA is launching (`ReplayStatus`) or that the online search
/// is refreshing (`VaultStatus`), so it has its own small state machine.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReplayDownloadStatus {
    #[default]
    Idle,
    Downloading {
        uid: i32,
        /// Percent received, when the server said how big the file is.
        progress: Option<u8>,
    },
    Downloaded {
        uid: i32,
        path: String,
    },
    Failed {
        uid: i32,
        reason: String,
    },
}

/// Which replay a read of its details or analysis is about.
///
/// The detail panel asks for these on demand and the answers come back later,
/// so every answer and every failure names the read it belongs to, and the
/// panel shows only its own. The game id used to be that name on its own, and
/// a file whose header carries no game id is uid 0: every such file shared one
/// name, so the second one opened showed the first one's analysis and never
/// asked for its own.
///
/// - A replay with a game id is named by it, `uid:123`, wherever its file
///   came from. The vault's copy and a downloaded or recorded copy of the same
///   game are the same game, and reading either says the same thing about it.
/// - A replay without one is named by its file, `path:` and the path as
///   [`normalize_replay_path`] spells it. One file reached two ways (the
///   library's scan, a file handed to the client, a path written with the
///   other slash) is one read, not two. The panel and the service both work
///   the key out with this function or its twin, so they still agree on it.
/// - With neither, `uid:0`: there is nothing else to tell it apart by.
///
/// A string rather than a struct because it keys [`ReplayState::replay_details`],
/// and a JSON object key has to be one. The frontend twin is `replayReadKey`
/// in `ui/src/shared/rules/replayReadKey.ts`, held to this one by the
/// conformance fixture.
pub fn replay_read_key(uid: i32, local_path: Option<&str>) -> String {
    match local_path {
        Some(path) if uid <= 0 && !path.is_empty() => {
            format!("path:{}", normalize_replay_path(path))
        }
        _ => format!("uid:{uid}"),
    }
}

/// One spelling for every way of writing the same replay file's path, worked
/// out from the text alone.
///
/// The same file arrives spelt differently depending on who names it: the
/// library's own scan, a file the shell hands the client, a path somebody
/// typed. Keyed as given, each spelling was a read of its own, so one file was
/// read twice, and a note written on it under one spelling was missing under
/// the other.
///
/// Separators become `/`, repeated ones collapse, `.` segments go, `..` takes
/// the segment before it, and a trailing separator is dropped. A path that
/// looks like a Windows one, with a drive letter (`C:`) or a UNC `//` prefix,
/// is also lowercased, because Windows does not tell `Replays` from
/// `replays`; any other path keeps its case, because Linux does.
///
/// Lexical only, and pure: this never asks the filesystem, so a symbolic link
/// and its target stay two spellings. `..` cannot climb above the root of an
/// absolute path and is kept at the start of a relative one, and a relative
/// path that resolves to nothing is `.`, so a path that is not empty never
/// normalises to an empty one. The frontend twin is `normalizeReplayPath` in
/// `ui/src/shared/rules/replayReadKey.ts`.
pub fn normalize_replay_path(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let bytes = unified.as_bytes();
    // What comes before the first segment, and whether case is to be folded.
    let (prefix, rest, windows) = if let Some(rest) = unified.strip_prefix("//") {
        ("//", rest, true)
    } else if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        (&unified[..2], &unified[2..], true)
    } else {
        ("", unified.as_str(), false)
    };
    // A UNC path is always absolute. A drive letter may be followed by a
    // relative path (`C:replays`), which is relative to that drive.
    let rooted = prefix == "//" || rest.starts_with('/');

    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split('/') {
        match segment {
            "" | "." => {}
            ".." => match segments.last() {
                Some(last) if *last != ".." => {
                    segments.pop();
                }
                // Above the root is still the root; above where a relative
                // path starts is somewhere this cannot name, so it stays.
                _ if rooted => {}
                _ => segments.push(".."),
            },
            _ => segments.push(segment),
        }
    }

    let mut normalized = String::from(prefix);
    if rooted && prefix != "//" {
        normalized.push('/');
    }
    normalized.push_str(&segments.join("/"));
    if normalized.is_empty() {
        normalized.push('.');
    }
    if windows {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// Why reading one replay file failed, and which read it was.
///
/// The detail panel reads the details and the analysis on demand, and a reader
/// who opens one replay and then another has two reads in flight at once. A
/// bare reason in the state could not say whose it was, so the second panel
/// showed the first one's failure as its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayReadError {
    /// The read that failed, as [`replay_read_key`] names it.
    pub key: String,
    pub reason: String,
}

/// What the vault knows about one game id, looked up for a replay the client
/// only has as a file on disk.
///
/// A `.fafreplay` header carries who played and at what rating, and nothing
/// about what the game did to those ratings: rating journals live on the
/// server. So the detail panel for a local replay asks the vault for the one
/// game, and this is the answer. All four states are distinct to the reader:
/// [`Self::Missing`] is "the vault has no such game" (a skirmish against AI, a
/// replay from another install), which is a different sentence from
/// [`Self::Failed`] ("we could not ask"), and both are different from having
/// no entry at all, which means nobody has asked yet.
// No `Eq`: `VaultReplay` carries an `f32`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum OnlineLookup {
    Loading,
    Found(Box<VaultReplay>),
    Missing,
    Failed { reason: String },
}

// No `Eq` (unlike most state structs): `VaultReplay` carries an `f32`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayState {
    pub status: ReplayStatus,
    /// A non-fatal issue from the last launch's prep steps (engine
    /// version/map staging: see `infra/game_updater.rs`), e.g. "could not
    /// stage map X". `None` means the last launch's prep was clean or none
    /// has happened yet. Separate from [`ReplayStatus::Failed`], which is
    /// for launches that didn't happen at all: this is for ones that did,
    /// but might misbehave in FA itself (stuck loading screen, etc.) because
    /// a non-fatal prep step failed. Cleared on the next [`ReplayEvent::Connecting`].
    pub last_warning: Option<String>,
    /// What the launch in progress is doing right now (#392): downloading an
    /// old engine build file by file can take minutes on a slow line, and a
    /// bar that only says "starting" read as stuck. Set while
    /// [`ReplayStatus::Connecting`], cleared by every change of status.
    #[serde(default)]
    pub preparing: Option<ReplayPreparation>,
    /// At most one delayed live replay is tracked, matching the Java client:
    /// scheduling another replaces the previous choice.
    pub live_tracking: Option<LiveReplayTracking>,
    pub vault: Vec<VaultReplay>,
    pub vault_status: VaultStatus,
    /// The query the current [`Self::vault`] results answer. The search *form*
    /// is local to the view (a text box that dispatched on every keystroke
    /// would be absurd); this is the last query actually executed, which is
    /// what paging and the "showing results for…" summary read.
    pub vault_query: ReplayQuery,
    /// Whether another page of results is likely to exist.
    pub vault_has_more: bool,
    pub vault_total_pages: Option<i32>,
    pub vault_total_records: Option<i32>,
    /// Saving an online replay to the shared local replay library is separate
    /// from watching it and from loading either catalogue.
    pub download_status: ReplayDownloadStatus,
    /// Featured mod technical names, for the search form's mod filter.
    pub featured_mods: Vec<String>,
    pub local: Vec<LocalReplay>,
    pub local_status: VaultStatus,
    /// Deferred replay metadata keyed by [`replay_read_key`]: the game id, or
    /// the file for a replay without one. Details are loaded only when
    /// requested because parsing the command stream can be expensive.
    ///
    /// At most [`REPLAY_DETAILS_KEPT`] of them, the ones stored last; see
    /// [`Self::replay_details_order`].
    #[serde(default)]
    pub replay_details: std::collections::HashMap<String, ReplayDetails>,
    /// The keys of [`Self::replay_details`], oldest stored first, so the
    /// oldest is the one that goes when the map is full.
    ///
    /// A list beside the map rather than an ordered map in its place: the
    /// panel looks its own entry up by key, and a JSON object is what lets it
    /// do that without a search.
    #[serde(default)]
    pub replay_details_order: Vec<String>,
    /// The read whose details were asked for last, while it runs. Only its
    /// failure is recorded: an older read still finishing describes a panel
    /// nobody is looking at.
    #[serde(default)]
    pub details_loading: Option<String>,
    #[serde(default)]
    pub details_error: Option<ReplayReadError>,
    /// The analysed replay, and only the one asked for last.
    ///
    /// One of these is megabytes of orders and targets. Keeping a map of them
    /// the way the details are kept would grow the state by a replay every
    /// time somebody opened a panel, so only the answer to the newest request
    /// is held. An older request finishing later is dropped rather than
    /// allowed to replace it: the newer panel would otherwise reject the
    /// stranger's analysis and sit on "reading" with nothing left coming.
    #[serde(default)]
    pub analysis: Option<ReplayAnalysis>,
    /// The read whose analysis was asked for last, while it runs.
    #[serde(default)]
    pub analysis_loading: Option<String>,
    #[serde(default)]
    pub analysis_error: Option<ReplayReadError>,
    /// Vault answers for single game ids, keyed by that id. Filled by
    /// [`ReplayCommand::LookUpOnline`] on behalf of local replays; see
    /// [`OnlineLookup`].
    ///
    /// At most [`ONLINE_LOOKUPS_KEPT`] of them, the ones stored last; see
    /// [`Self::online_lookups_order`].
    #[serde(default)]
    pub online_lookups: std::collections::HashMap<i32, OnlineLookup>,
    /// The keys of [`Self::online_lookups`], oldest stored first, so the
    /// oldest is the one that goes when the map is full. A list beside the
    /// map for the reason [`Self::replay_details_order`] is one.
    #[serde(default)]
    pub online_lookups_order: Vec<i32>,
    /// Map folders read out of the replay files themselves, keyed by game id.
    /// An empty value means the file was read and named no map, so the view
    /// stops asking. See [`ReplayCommand::ResolveMaps`].
    ///
    /// At most [`RESOLVED_MAPS_KEPT`] of them, never one of the vault page on
    /// screen; see [`Self::resolved_maps_order`].
    #[serde(default)]
    pub resolved_maps: std::collections::HashMap<i32, String>,
    /// The keys of [`Self::resolved_maps`], oldest stored first.
    #[serde(default)]
    pub resolved_maps_order: Vec<i32>,
    /// The signed-in player's latest matchmaker games, newest first (#301).
    ///
    /// Its own list rather than a vault search, so showing it on the
    /// matchmaker tab never replaces whatever the Replays tab was showing.
    pub recent_matchmaker: Vec<VaultReplay>,
    pub recent_matchmaker_status: VaultStatus,
}

// No `Eq`: `VaultLoaded` carries `VaultReplay`, which has an `f32` field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReplayEvent {
    Connecting,
    /// One step of the launch being prepared. See [`ReplayState::preparing`].
    Preparing {
        step: ReplayPreparation,
    },
    /// `warning` carries a non-fatal prep-step issue (see
    /// [`ReplayState::last_warning`]): `None` when prep was clean/skipped.
    Playing {
        uid: Option<i32>,
        warning: Option<String>,
    },
    Failed {
        reason: String,
    },
    /// The replay session ended (game process exited / stream closed), or the
    /// start of one was called off before the game had it: back to idle so the
    /// UI can start another one. A cancelled start is deliberately not a
    /// [`Self::Failed`] -- nothing went wrong.
    Closed,
    LiveTrackingScheduled {
        tracking: LiveReplayTracking,
    },
    LiveTrackingCleared,
    VaultLoading,
    VaultLoaded {
        replays: Vec<VaultReplay>,
        /// The query these results answer, echoed back so the view and the
        /// results can never disagree about what is being shown (paging in
        /// particular reads the page number from here, not from the form).
        /// Boxed: `ReplayQuery` is a wide struct of strings, and every clone of
        /// an event/command would otherwise carry it inline. Transparent on the
        /// wire: serde and specta both see straight through the box.
        query: Box<ReplayQuery>,
        /// Whether a further page is likely to exist: a full page came back.
        has_more: bool,
        #[serde(default)]
        total_pages: Option<i32>,
        #[serde(default)]
        total_records: Option<i32>,
    },
    VaultLoadFailed {
        reason: String,
    },
    RecentMatchmakerLoading,
    RecentMatchmakerLoaded {
        replays: Vec<VaultReplay>,
    },
    RecentMatchmakerFailed {
        reason: String,
    },
    /// The featured-mod list backing the vault search's mod filter.
    FeaturedModsLoaded {
        mods: Vec<String>,
    },
    LocalLoading,
    LocalLoaded {
        replays: Vec<LocalReplay>,
    },
    LocalDeleted {
        path: String,
    },
    VaultDownloadStarted {
        uid: i32,
    },
    /// How much of replay `uid` has arrived. Lands only on that download.
    VaultDownloadProgressed {
        uid: i32,
        progress: Option<u8>,
    },
    VaultDownloaded {
        uid: i32,
        replay: LocalReplay,
    },
    VaultDownloadFailed {
        uid: i32,
        reason: String,
    },
    /// The download of `uid` was called off before the file was written: back
    /// to idle, and not a failure.
    VaultDownloadCancelled {
        uid: i32,
    },
    LocalLoadFailed {
        reason: String,
    },
    /// A details read has begun. This and the five details and analysis
    /// events after it name their read by [`replay_read_key`], not by game id:
    /// two files without a game id are both uid 0, and only the key tells
    /// their answers apart.
    DetailsLoading {
        key: String,
    },
    DetailsLoaded {
        key: String,
        details: ReplayDetails,
    },
    DetailsFailed {
        key: String,
        reason: String,
    },
    AnalysisLoading {
        key: String,
    },
    /// Carries its key in [`ReplayAnalysis::key`].
    AnalysisLoaded {
        analysis: ReplayAnalysis,
    },
    AnalysisFailed {
        key: String,
        reason: String,
    },
    /// The panel that asked for `key`'s details and analysis was closed, and
    /// the reads still running for it were called off. Neither will answer,
    /// so neither is still loading: the next panel opened on the same replay
    /// asks again instead of waiting for an answer that is not coming.
    ReadsCancelled {
        key: String,
    },
    /// The vault is being asked about one game id (see [`OnlineLookup`]).
    OnlineLookupStarted {
        uid: i32,
    },
    /// The answer. `replay` is `None` when the vault has no such game, which
    /// is a result, not a failure.
    /// What [`ReplayCommand::ResolveMaps`] found, one entry per game it was
    /// asked about. A game whose file could not be read carries an empty map,
    /// which is how the view knows it has been asked already.
    MapsResolved {
        maps: Vec<ResolvedReplayMap>,
    },
    OnlineLookupFinished {
        uid: i32,
        replay: Option<Box<VaultReplay>>,
    },
    OnlineLookupFailed {
        uid: i32,
        reason: String,
    },
}

// No `Eq`: `ReplayQuery` carries an `f32` (minimum review score).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReplayCommand {
    WatchLive(LiveReplayTarget),
    TrackLive {
        target: LiveReplayTarget,
        action: LiveReplayTrackingAction,
    },
    CancelLiveTracking,
    /// Call off the replay that is starting.
    ///
    /// Starting one is several seconds of fetching, decompressing and
    /// preparing before Forged Alliance appears, and until now the only thing
    /// the overlay over that wait could do was get out of the way. Once the
    /// game has been handed the file this has nothing left to stop, and says
    /// so by doing nothing.
    CancelWatch,
    /// Play a `.fafreplay`/`.scfareplay` file by path: used both for the
    /// file-picker flow and for watching a [`LocalReplay`] row.
    OpenFile {
        path: String,
    },
    /// Search the vault. A default [`ReplayQuery`] is the unfiltered
    /// newest-first feed the tab opens with, so this covers both "browse" and
    /// "search" without a second command.
    SearchVault {
        /// Boxed: `ReplayQuery` is a wide struct of strings, and every clone of
        /// an event/command would otherwise carry it inline. Transparent on the
        /// wire: serde and specta both see straight through the box.
        query: Box<ReplayQuery>,
    },
    /// Fetch the featured-mod list for the search form's mod filter.
    LoadFeaturedMods,
    /// The signed-in player's latest matchmaker games, for the matchmaker tab.
    LoadRecentMatchmaker,
    /// Download and play a vault replay by its game id.
    WatchVault {
        uid: i32,
    },
    /// Download a vault replay into the shared local replay library without
    /// launching Forged Alliance.
    DownloadVault {
        uid: i32,
    },
    /// Call off the download of `uid` into the library while it runs.
    ///
    /// The transfer stops where it is, and a file being written when the call
    /// arrives is written to a temporary name that is deleted rather than
    /// published, so the library never holds part of a replay. Does nothing
    /// once the file is in place.
    CancelDownload {
        uid: i32,
    },
    /// Load the deferred game options, in-game chat, and FAF version from a
    /// replay body. The answer is keyed by [`replay_read_key`] of these two
    /// fields, which the panel works out the same way to find it.
    #[serde(rename_all = "camelCase")]
    LoadDetails {
        uid: i32,
        #[serde(default)]
        local_path: Option<String>,
    },
    /// Read the whole command stream: orders, where they were aimed, what the
    /// sim announced, and the end-of-game statistics.
    ///
    /// Separate from [`Self::LoadDetails`] because it is the expensive half.
    /// The options and the chat are what somebody opening the panel is usually
    /// after, and they arrive while this is still walking. Keyed the same way.
    #[serde(rename_all = "camelCase")]
    LoadAnalysis {
        uid: i32,
        #[serde(default)]
        local_path: Option<String>,
    },
    /// The detail panel that asked for this replay's details and analysis was
    /// closed: call off whichever of the two reads is still running for it.
    ///
    /// Either can be the whole replay fetched from the vault and then walked
    /// command by command, and the answer would only land in a panel nobody
    /// has open. Keyed the way the reads are, so it never stops a read for
    /// another replay. Ends with [`ReplayEvent::ReadsCancelled`] when a read
    /// was running.
    #[serde(rename_all = "camelCase")]
    CancelReads {
        uid: i32,
        #[serde(default)]
        local_path: Option<String>,
    },
    /// Scan the shared FAF replay folder for local `.fafreplay` files.
    /// Scan the shared replay folder. `limit` bounds how many of the newest
    /// files have their headers read, which is the expensive part; the view
    /// raises it when the user pages past what is loaded.
    #[serde(rename_all = "camelCase")]
    LoadLocal {
        limit: u32,
    },
    /// Permanently remove one replay from the shared replay folder. The port
    /// validates that the resolved file is directly inside that folder.
    DeleteLocal {
        path: String,
    },
    /// Read the real map out of the replay files themselves, for games whose
    /// listing has none.
    ///
    /// The API records a game's map as a `map_version` row, and a campaign
    /// mission is not one, so every co-op game arrives with no map at all.
    /// The replay knows: its body opens with the scenario the engine loaded,
    /// which is the mission's own folder. See
    /// [`ReplayEvent::MapsResolved`].
    ResolveMaps {
        uids: Vec<i32>,
    },
    /// Ask the vault what it knows about one game id, without disturbing the
    /// browse/search results in [`ReplayState::vault`].
    ///
    /// This exists for local replays: the file on disk has no rating data in
    /// it, so the only honest way to show a rating change for one is to ask
    /// the server about the game it came from.
    LookUpOnline {
        uid: i32,
    },
    /// The same question about a whole page of games at once.
    ///
    /// The live-replay grid asks it: the lobby tells it who is in a running
    /// game but not what they are playing, and the vault's row for that game
    /// exists from the moment it launches. One request for the games on
    /// screen, rather than one per card in a list that refreshes itself.
    ///
    /// Answers land in `online_lookups` exactly as the single lookup's do, so
    /// a game already asked about is never asked about again.
    LookUpOnlineMany {
        uids: Vec<i32>,
    },
}

pub fn reduce(state: &mut ReplayState, event: &ReplayEvent) {
    match event {
        ReplayEvent::Connecting => {
            state.status = ReplayStatus::Connecting;
            state.last_warning = None;
            state.preparing = None;
        }
        ReplayEvent::Preparing { step } => {
            // Only while a launch is starting: a step that arrives after the
            // game is up, or after a cancel, describes nothing on screen.
            if state.status == ReplayStatus::Connecting {
                state.preparing = Some(step.clone());
            }
        }
        // None of the three touches `download_status`. `WatchVault` used to
        // mark its download there and these three cleared it again, which
        // also cleared a download into the library running beside the watch.
        // A watch's download is a step of its launch now, narrated through
        // `preparing` like every other step, so the library download's status
        // belongs to the library download alone.
        ReplayEvent::Playing { uid, warning } => {
            state.status = ReplayStatus::Playing { uid: *uid };
            state.last_warning = warning.clone();
            state.preparing = None;
        }
        ReplayEvent::Failed { reason } => {
            state.status = ReplayStatus::Failed {
                reason: reason.clone(),
            };
            state.preparing = None;
        }
        ReplayEvent::Closed => {
            state.status = ReplayStatus::Idle;
            state.preparing = None;
        }
        ReplayEvent::LiveTrackingScheduled { tracking } => {
            state.live_tracking = Some(tracking.clone());
        }
        ReplayEvent::LiveTrackingCleared => state.live_tracking = None,
        ReplayEvent::VaultLoading => state.vault_status = VaultStatus::Loading,
        ReplayEvent::VaultLoaded {
            replays,
            query,
            has_more,
            total_pages,
            total_records,
        } => {
            state.vault = replays.clone();
            state.vault_query = (**query).clone();
            state.vault_has_more = *has_more;
            state.vault_total_pages = *total_pages;
            state.vault_total_records = *total_records;
            state.vault_status = VaultStatus::Ready;
        }
        ReplayEvent::FeaturedModsLoaded { mods } => state.featured_mods = mods.clone(),
        ReplayEvent::VaultLoadFailed { reason } => {
            state.vault_status = VaultStatus::Failed {
                reason: reason.clone(),
            }
        }
        ReplayEvent::RecentMatchmakerLoading => {
            state.recent_matchmaker_status = VaultStatus::Loading;
        }
        ReplayEvent::RecentMatchmakerLoaded { replays } => {
            state.recent_matchmaker = replays.clone();
            state.recent_matchmaker_status = VaultStatus::Ready;
        }
        ReplayEvent::RecentMatchmakerFailed { reason } => {
            state.recent_matchmaker_status = VaultStatus::Failed {
                reason: reason.clone(),
            };
        }
        ReplayEvent::LocalLoading => state.local_status = VaultStatus::Loading,
        ReplayEvent::LocalLoaded { replays } => {
            state.local = replays.clone();
            state.local_status = VaultStatus::Ready;
        }
        ReplayEvent::LocalDeleted { path } => {
            state.local.retain(|replay| replay.path != *path);
            state.local_status = VaultStatus::Ready;
        }
        ReplayEvent::VaultDownloadStarted { uid } => {
            state.download_status = ReplayDownloadStatus::Downloading {
                uid: *uid,
                progress: None,
            };
        }
        ReplayEvent::VaultDownloadProgressed { uid, progress } => {
            if let ReplayDownloadStatus::Downloading {
                uid: downloading,
                progress: shown,
            } = &mut state.download_status
            {
                if downloading == uid {
                    *shown = *progress;
                }
            }
        }
        ReplayEvent::VaultDownloadCancelled { uid } => {
            if matches!(
                state.download_status,
                ReplayDownloadStatus::Downloading { uid: downloading, .. } if downloading == *uid
            ) {
                state.download_status = ReplayDownloadStatus::Idle;
            }
        }
        ReplayEvent::VaultDownloaded { uid, replay } => {
            state.local.retain(|known| known.path != replay.path);
            state.local.insert(0, replay.clone());
            state.download_status = ReplayDownloadStatus::Downloaded {
                uid: *uid,
                path: replay.path.clone(),
            };
        }
        ReplayEvent::VaultDownloadFailed { uid, reason } => {
            state.download_status = ReplayDownloadStatus::Failed {
                uid: *uid,
                reason: reason.clone(),
            };
        }
        ReplayEvent::LocalLoadFailed { reason } => {
            state.local_status = VaultStatus::Failed {
                reason: reason.clone(),
            }
        }
        ReplayEvent::DetailsLoading { key } => {
            state.details_loading = Some(key.clone());
            state.details_error = None;
        }
        ReplayEvent::DetailsLoaded { key, details } => {
            // Stored whoever asked: details are kept per read, so a late
            // answer fills in its own entry and cannot overwrite another's.
            store_replay_details(state, key, details);
            if state.details_loading.as_ref() == Some(key) {
                state.details_loading = None;
            }
            if state
                .details_error
                .as_ref()
                .is_some_and(|error| error.key == *key)
            {
                state.details_error = None;
            }
        }
        ReplayEvent::DetailsFailed { key, reason } => {
            // Only the newest request's failure is shown. A late one for a
            // replay no longer asked about would sit in the error slot of the
            // panel that is open, or push out that panel's own failure.
            if state.details_loading.as_ref() == Some(key) {
                state.details_loading = None;
                state.details_error = Some(ReplayReadError {
                    key: key.clone(),
                    reason: reason.clone(),
                });
            }
        }
        ReplayEvent::AnalysisLoading { key } => {
            state.analysis_loading = Some(key.clone());
            state.analysis_error = None;
            // The panel being opened is not the one the held analysis is of.
            if state.analysis.as_ref().is_some_and(|held| held.key != *key) {
                state.analysis = None;
            }
        }
        ReplayEvent::AnalysisLoaded { analysis } => {
            // One analysis is held, so only the newest request's answer may
            // take the slot. An older read finishing last would replace it,
            // and the open panel, seeing another read's key, would go back to
            // "reading" with nothing more on the way.
            if state.analysis_loading.as_ref() == Some(&analysis.key) {
                state.analysis_loading = None;
                state.analysis = Some(analysis.clone());
                state.analysis_error = None;
            }
        }
        ReplayEvent::AnalysisFailed { key, reason } => {
            if state.analysis_loading.as_ref() == Some(key) {
                state.analysis_loading = None;
                state.analysis_error = Some(ReplayReadError {
                    key: key.clone(),
                    reason: reason.clone(),
                });
            }
        }
        ReplayEvent::ReadsCancelled { key } => {
            // Only the reads of the panel that closed: another panel's read in
            // flight keeps its loading line.
            if state.details_loading.as_ref() == Some(key) {
                state.details_loading = None;
            }
            if state.analysis_loading.as_ref() == Some(key) {
                state.analysis_loading = None;
            }
        }
        ReplayEvent::OnlineLookupStarted { uid } => {
            store_online_lookup(state, *uid, OnlineLookup::Loading);
        }
        ReplayEvent::MapsResolved { maps } => store_resolved_maps(state, maps),
        ReplayEvent::OnlineLookupFinished { uid, replay } => {
            let outcome = match replay {
                Some(replay) => OnlineLookup::Found(replay.clone()),
                None => OnlineLookup::Missing,
            };
            store_online_lookup(state, *uid, outcome);
        }
        ReplayEvent::OnlineLookupFailed { uid, reason } => {
            store_online_lookup(
                state,
                *uid,
                OnlineLookup::Failed {
                    reason: reason.clone(),
                },
            );
        }
    }
}

/// How many replays' details [`ReplayState::replay_details`] keeps.
///
/// Every panel opened on a replay's insights adds an entry, and nothing else
/// took one away, so a long session of browsing grew the state by one replay's
/// options, chat and command counts per panel, all of it sent again with every
/// full snapshot. Fifty is far more than anybody goes back and forth between,
/// so a replay looked at again a little later is still there, while the state
/// stays a bounded size. The panel that is open asks again if its own entry is
/// ever the one that goes.
pub const REPLAY_DETAILS_KEPT: usize = 50;

/// Store one read's details as the newest, and drop the oldest past
/// [`REPLAY_DETAILS_KEPT`]. A read answered again moves to the newest place
/// rather than keeping the place of its first answer.
fn store_replay_details(state: &mut ReplayState, key: &str, details: &ReplayDetails) {
    state
        .replay_details
        .insert(key.to_string(), details.clone());
    state.replay_details_order.retain(|stored| stored != key);
    state.replay_details_order.push(key.to_string());
    let overflow = state
        .replay_details_order
        .len()
        .saturating_sub(REPLAY_DETAILS_KEPT);
    for oldest in state.replay_details_order.drain(..overflow) {
        state.replay_details.remove(&oldest);
    }
}

/// How many games' vault lookups [`ReplayState::online_lookups`] keeps.
///
/// The live tab looks up every game card it shows, seventy-five more with
/// each "show more", up to every game being played at once, which on the
/// busiest evening is a few hundred; the replay panels add one each. Nothing
/// took an entry away again, so a long session on the live tab grew the state
/// by a vault row for every game started while it was open, all of it sent
/// again with every full snapshot. A thousand is several times the largest
/// list of cards the tab can show, so the entries of the cards on screen,
/// which are the ones stored last, are not the ones that go. An entry that
/// does go is only asked for again by a view that wants it and finds it
/// missing.
pub const ONLINE_LOOKUPS_KEPT: usize = 1000;

/// How many games' maps [`ReplayState::resolved_maps`] keeps.
///
/// The vault page asks for the maps its listing lacks, a page at a time and
/// at most a hundred and twenty per command, and asks again for any of its
/// games it finds missing. Five hundred is several pages back, and the games
/// of the page on screen are never the ones that go, so a full map cannot
/// make the page ask again in a loop.
pub const RESOLVED_MAPS_KEPT: usize = 500;

/// Move `uid` to the newest end of `order`, adding it if it is not there.
fn stored_last(order: &mut Vec<i32>, uid: i32) {
    order.retain(|stored| *stored != uid);
    order.push(uid);
}

/// Store one game's lookup as the newest, and drop the oldest past
/// [`ONLINE_LOOKUPS_KEPT`]. A lookup answered again, or asked again, moves to
/// the newest place, the way [`store_replay_details`] does.
fn store_online_lookup(state: &mut ReplayState, uid: i32, lookup: OnlineLookup) {
    state.online_lookups.insert(uid, lookup);
    stored_last(&mut state.online_lookups_order, uid);
    let overflow = state
        .online_lookups_order
        .len()
        .saturating_sub(ONLINE_LOOKUPS_KEPT);
    for oldest in state.online_lookups_order.drain(..overflow) {
        state.online_lookups.remove(&oldest);
    }
}

/// Store a batch of resolved maps as the newest, and drop the oldest past
/// [`RESOLVED_MAPS_KEPT`], passing over the games of the vault page on
/// screen: that page asks again for any of its games it finds missing, and
/// one of them dropped here would come straight back and push out another.
fn store_resolved_maps(state: &mut ReplayState, maps: &[ResolvedReplayMap]) {
    for resolved in maps {
        state
            .resolved_maps
            .insert(resolved.uid, resolved.map.clone());
        stored_last(&mut state.resolved_maps_order, resolved.uid);
    }
    let mut overflow = state
        .resolved_maps_order
        .len()
        .saturating_sub(RESOLVED_MAPS_KEPT);
    if overflow == 0 {
        return;
    }
    let on_page: std::collections::HashSet<i32> =
        state.vault.iter().map(|replay| replay.uid).collect();
    let resolved_maps = &mut state.resolved_maps;
    state.resolved_maps_order.retain(|uid| {
        if overflow == 0 || on_page.contains(uid) {
            return true;
        }
        resolved_maps.remove(uid);
        overflow -= 1;
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTED: u32 = 1_800_000_000;

    /// One vault row, identified by its uid, with only the field under test
    /// filled in. Everything else is what an empty listing would give.
    fn row(uid: i32) -> VaultReplay {
        VaultReplay {
            uid,
            title: String::new(),
            map: String::new(),
            map_thumbnail_url: String::new(),
            mod_name: String::new(),
            start_time: String::new(),
            end_time: String::new(),
            replay_available: true,
            duration_seconds: None,
            game_duration_seconds: None,
            teams: Vec::new(),
            average_rating: None,
            quality: None,
            reviews_average: None,
            reviews_count: None,
            game_version: None,
            validity: String::new(),
            victory_condition: String::new(),
        }
    }

    fn uids(replays: &[VaultReplay]) -> Vec<i32> {
        replays.iter().map(|replay| replay.uid).collect()
    }

    #[test]
    fn ordering_by_a_field_is_the_same_set_read_two_ways() {
        // The whole point of sorting the matches rather than the scan: the
        // rows are the same rows, in the other order.
        let mut rows = vec![row(1), row(2), row(3)];
        rows[0].game_duration_seconds = Some(600);
        rows[1].game_duration_seconds = Some(1800);
        rows[2].game_duration_seconds = Some(1200);

        let mut ascending = rows.clone();
        sort_vault_replays(&mut ascending, ReplaySortField::Duration, false);
        assert_eq!(uids(&ascending), vec![1, 3, 2]);

        let mut descending = rows.clone();
        sort_vault_replays(&mut descending, ReplaySortField::Duration, true);
        assert_eq!(uids(&descending), vec![2, 3, 1]);
    }

    #[test]
    fn a_missing_value_sorts_last_whichever_way_the_arrow_points() {
        // Descending by review score must not open with the games nobody has
        // reviewed, and ascending must not either: they are not the worst
        // reviewed, they are unreviewed.
        let mut rows = vec![row(1), row(2), row(3)];
        rows[0].reviews_average = None;
        rows[1].reviews_average = Some(4.5);
        rows[2].reviews_average = Some(3.0);

        let mut descending = rows.clone();
        sort_vault_replays(&mut descending, ReplaySortField::ReviewScore, true);
        assert_eq!(uids(&descending), vec![2, 3, 1]);

        let mut ascending = rows.clone();
        sort_vault_replays(&mut ascending, ReplaySortField::ReviewScore, false);
        assert_eq!(uids(&ascending), vec![3, 2, 1]);
    }

    #[test]
    fn an_empty_string_is_a_missing_value_rather_than_the_smallest_one() {
        let mut rows = vec![row(1), row(2), row(3)];
        rows[0].end_time = String::new();
        rows[1].end_time = "2026-09-08T20:00:00Z".into();
        rows[2].end_time = "2026-09-09T20:00:00Z".into();

        sort_vault_replays(&mut rows, ReplaySortField::EndTime, false);
        assert_eq!(uids(&rows), vec![2, 3, 1]);
    }

    #[test]
    fn ties_keep_the_order_the_scan_produced() {
        // The scan is newest-first, so equal keys stay newest-first: a vault
        // full of games called "Custom Game" is still readable when ordered by
        // title.
        let mut rows = vec![row(9), row(8), row(7)];
        for replay in &mut rows {
            replay.title = "Custom Game".into();
        }
        sort_vault_replays(&mut rows, ReplaySortField::Title, false);
        assert_eq!(uids(&rows), vec![9, 8, 7]);
        sort_vault_replays(&mut rows, ReplaySortField::Title, true);
        assert_eq!(uids(&rows), vec![9, 8, 7]);
    }

    #[test]
    fn titles_are_ordered_as_a_reader_would_order_them() {
        let mut rows = vec![row(1), row(2)];
        rows[0].title = "zerg rush".into();
        rows[1].title = "All welcome".into();
        sort_vault_replays(&mut rows, ReplaySortField::Title, false);
        assert_eq!(uids(&rows), vec![2, 1]);
    }

    #[test]
    fn the_wall_clock_duration_is_only_the_fallback() {
        // The API orders by `replayTicks`, which is simulation time, so a
        // paused game must not be ranked by how long its players sat there.
        let mut rows = vec![row(1), row(2)];
        rows[0].game_duration_seconds = Some(600);
        rows[0].duration_seconds = Some(3600);
        rows[1].game_duration_seconds = None;
        rows[1].duration_seconds = Some(1200);
        sort_vault_replays(&mut rows, ReplaySortField::Duration, false);
        assert_eq!(uids(&rows), vec![1, 2]);
    }

    #[test]
    fn every_field_orders_something() {
        // A field that quietly did nothing would look exactly like the bug
        // this function exists to fix, so each one is exercised.
        let mut a = row(1);
        let mut b = row(2);
        a.start_time = "2026-01-01T00:00:00Z".into();
        b.start_time = "2026-02-01T00:00:00Z".into();
        a.end_time = "2026-01-01T01:00:00Z".into();
        b.end_time = "2026-02-01T01:00:00Z".into();
        a.game_duration_seconds = Some(1);
        b.game_duration_seconds = Some(2);
        a.reviews_average = Some(1.0);
        b.reviews_average = Some(2.0);
        a.title = "a".into();
        b.title = "b".into();
        a.victory_condition = "DEMORALIZATION".into();
        b.victory_condition = "ERADICATION".into();

        for field in [
            ReplaySortField::StartTime,
            ReplaySortField::EndTime,
            ReplaySortField::Duration,
            ReplaySortField::ReviewScore,
            ReplaySortField::Title,
            ReplaySortField::Id,
            ReplaySortField::VictoryCondition,
        ] {
            let mut rows = vec![b.clone(), a.clone()];
            sort_vault_replays(&mut rows, field, false);
            assert_eq!(uids(&rows), vec![1, 2], "{field:?} ascending");
            sort_vault_replays(&mut rows, field, true);
            assert_eq!(uids(&rows), vec![2, 1], "{field:?} descending");
        }
    }

    #[test]
    fn a_fresh_match_is_not_watchable_yet() {
        assert_eq!(
            live_replay_delay_remaining(Some(STARTED), STARTED),
            LIVE_REPLAY_DELAY_SECONDS
        );
        assert_eq!(live_replay_delay_remaining(Some(STARTED), STARTED + 1), 299);
    }

    #[test]
    fn the_delay_ends_exactly_on_the_boundary() {
        // Pinned because this is an anti-ghosting rule: a second early is a
        // second of live intelligence about someone else's game.
        assert_eq!(live_replay_delay_remaining(Some(STARTED), STARTED + 299), 1);
        assert_eq!(live_replay_delay_remaining(Some(STARTED), STARTED + 300), 0);
        assert_eq!(live_replay_delay_remaining(Some(STARTED), STARTED + 999), 0);
    }

    #[test]
    fn an_unknown_start_time_imposes_no_wait() {
        // The server enforces the delay regardless; refusing here on a missing
        // timestamp would block legitimate watches of games whose start the
        // lobby never reported.
        assert_eq!(live_replay_delay_remaining(None, STARTED), 0);
        assert_eq!(live_replay_delay_remaining(Some(0), STARTED), 0);
    }

    #[test]
    fn a_clock_behind_the_match_start_still_reports_a_bounded_wait() {
        // A skewed local clock must not underflow into a colossal wait, nor
        // wrap around into "watchable".
        assert_eq!(
            live_replay_delay_remaining(Some(STARTED), STARTED - 60),
            LIVE_REPLAY_DELAY_SECONDS + 60
        );
        assert_eq!(live_replay_delay_remaining(Some(u32::MAX), 0), u32::MAX);
    }

    #[test]
    fn delayed_live_tracking_is_replaceable_and_cancellable() {
        let mut state = ReplayState::default();
        let notify = LiveReplayTracking {
            target: LiveReplayTarget {
                uid: 7,
                mod_name: "faf".into(),
                map: "scmp_009".into(),
            },
            title: "First game".into(),
            action: LiveReplayTrackingAction::Notify,
            ready_at: STARTED + LIVE_REPLAY_DELAY_SECONDS,
        };
        reduce(
            &mut state,
            &ReplayEvent::LiveTrackingScheduled {
                tracking: notify.clone(),
            },
        );
        assert_eq!(state.live_tracking, Some(notify));

        let watch = LiveReplayTracking {
            target: LiveReplayTarget {
                uid: 8,
                mod_name: "fafbeta".into(),
                map: "scmp_010".into(),
            },
            title: "Replacement".into(),
            action: LiveReplayTrackingAction::Watch,
            ready_at: STARTED + LIVE_REPLAY_DELAY_SECONDS + 10,
        };
        reduce(
            &mut state,
            &ReplayEvent::LiveTrackingScheduled {
                tracking: watch.clone(),
            },
        );
        assert_eq!(state.live_tracking, Some(watch));

        reduce(&mut state, &ReplayEvent::LiveTrackingCleared);
        assert_eq!(state.live_tracking, None);
    }

    #[test]
    fn connecting_then_playing() {
        let mut s = ReplayState::default();
        assert_eq!(s.status, ReplayStatus::Idle);
        reduce(&mut s, &ReplayEvent::Connecting);
        assert_eq!(s.status, ReplayStatus::Connecting);
        reduce(
            &mut s,
            &ReplayEvent::Playing {
                uid: Some(42),
                warning: None,
            },
        );
        assert_eq!(s.status, ReplayStatus::Playing { uid: Some(42) });
        assert_eq!(s.last_warning, None);
    }

    /// A watch ending, however it ends, leaves a library download alone: the
    /// watch's own download is a step of its launch, not this status. The
    /// three endings used to clear it, and with it a download into the
    /// library that was running beside the watch.
    #[test]
    fn a_watch_ending_leaves_a_library_download_running() {
        for ending in [
            ReplayEvent::Playing {
                uid: Some(7),
                warning: None,
            },
            ReplayEvent::Failed {
                reason: "no".into(),
            },
            ReplayEvent::Closed,
        ] {
            let mut s = ReplayState::default();
            reduce(&mut s, &ReplayEvent::VaultDownloadStarted { uid: 42 });
            reduce(&mut s, &ReplayEvent::Connecting);
            reduce(&mut s, &ending);
            assert_eq!(
                s.download_status,
                ReplayDownloadStatus::Downloading {
                    uid: 42,
                    progress: None
                },
                "{ending:?}"
            );
        }

        let mut s = ReplayState::default();
        reduce(&mut s, &ReplayEvent::VaultDownloadStarted { uid: 42 });
        let replay = local_replay("42.fafreplay");
        reduce(&mut s, &ReplayEvent::VaultDownloaded { uid: 42, replay });
        assert!(matches!(
            s.download_status,
            ReplayDownloadStatus::Downloaded { uid: 42, .. }
        ));
    }

    /// The download's bar follows its own replay, and calling it off goes
    /// back to idle without a failure; a cancel or a step for another replay
    /// changes nothing.
    #[test]
    fn a_library_download_reports_progress_and_can_be_called_off() {
        let mut s = ReplayState::default();
        reduce(&mut s, &ReplayEvent::VaultDownloadStarted { uid: 42 });
        reduce(
            &mut s,
            &ReplayEvent::VaultDownloadProgressed {
                uid: 42,
                progress: Some(55),
            },
        );
        reduce(
            &mut s,
            &ReplayEvent::VaultDownloadProgressed {
                uid: 43,
                progress: Some(99),
            },
        );
        reduce(&mut s, &ReplayEvent::VaultDownloadCancelled { uid: 43 });
        assert_eq!(
            s.download_status,
            ReplayDownloadStatus::Downloading {
                uid: 42,
                progress: Some(55)
            }
        );
        reduce(&mut s, &ReplayEvent::VaultDownloadCancelled { uid: 42 });
        assert_eq!(s.download_status, ReplayDownloadStatus::Idle);
    }

    /// Closing the panel calls its reads off, and only its own: another
    /// replay's read in flight keeps loading.
    #[test]
    fn calling_a_panels_reads_off_clears_only_its_loading_lines() {
        let mut s = ReplayState::default();
        reduce(
            &mut s,
            &ReplayEvent::DetailsLoading {
                key: "uid:1".into(),
            },
        );
        reduce(
            &mut s,
            &ReplayEvent::AnalysisLoading {
                key: "uid:1".into(),
            },
        );
        reduce(
            &mut s,
            &ReplayEvent::ReadsCancelled {
                key: "uid:2".into(),
            },
        );
        assert_eq!(s.details_loading.as_deref(), Some("uid:1"));
        assert_eq!(s.analysis_loading.as_deref(), Some("uid:1"));

        reduce(
            &mut s,
            &ReplayEvent::ReadsCancelled {
                key: "uid:1".into(),
            },
        );
        assert_eq!(s.details_loading, None);
        assert_eq!(s.analysis_loading, None);
        assert_eq!(s.details_error, None, "a call-off is not a failure");
        assert_eq!(s.analysis_error, None);
    }

    #[test]
    fn playing_with_warning_records_it_and_connecting_clears_it() {
        let mut s = ReplayState::default();
        reduce(
            &mut s,
            &ReplayEvent::Playing {
                uid: Some(42),
                warning: Some("could not stage map foo".into()),
            },
        );
        assert_eq!(s.last_warning.as_deref(), Some("could not stage map foo"));
        reduce(&mut s, &ReplayEvent::Connecting);
        assert_eq!(s.last_warning, None);
    }

    #[test]
    fn failure_records_reason() {
        let mut s = ReplayState::default();
        reduce(
            &mut s,
            &ReplayEvent::Failed {
                reason: "no access".into(),
            },
        );
        assert_eq!(
            s.status,
            ReplayStatus::Failed {
                reason: "no access".into()
            }
        );
    }

    #[test]
    fn closed_resets_to_idle() {
        let mut s = ReplayState {
            status: ReplayStatus::Playing { uid: Some(1) },
            ..Default::default()
        };
        reduce(&mut s, &ReplayEvent::Closed);
        assert_eq!(s.status, ReplayStatus::Idle);
    }

    fn vault_replay(uid: i32) -> VaultReplay {
        VaultReplay {
            uid,
            title: "Test game".into(),
            map: "Seton's Clutch".into(),
            map_thumbnail_url: "".into(),
            mod_name: "faf".into(),
            start_time: "2026-01-01T00:00:00Z".into(),
            end_time: "2026-01-01T00:30:00Z".into(),
            replay_available: true,
            duration_seconds: None,
            game_duration_seconds: None,
            teams: Vec::new(),
            average_rating: None,
            quality: None,
            reviews_average: None,
            reviews_count: None,
            game_version: None,
            validity: "VALID".into(),
            victory_condition: "DEMORALIZATION".into(),
        }
    }

    #[test]
    fn vault_loading_then_loaded() {
        let mut s = ReplayState::default();
        assert_eq!(s.vault_status, VaultStatus::Idle);
        reduce(&mut s, &ReplayEvent::VaultLoading);
        assert_eq!(s.vault_status, VaultStatus::Loading);
        let query = ReplayQuery {
            map: "Setons".into(),
            page: 2,
            ..Default::default()
        };
        reduce(
            &mut s,
            &ReplayEvent::VaultLoaded {
                replays: vec![vault_replay(1), vault_replay(2)],
                query: Box::new(query.clone()),
                has_more: true,
                total_pages: Some(5),
                total_records: Some(10),
            },
        );
        assert_eq!(s.vault_status, VaultStatus::Ready);
        assert_eq!(s.vault.len(), 2);
        assert_eq!(s.vault_total_pages, Some(5));
        assert_eq!(s.vault_total_records, Some(10));
        // The executed query travels with the results, so paging and the
        // results summary can never describe a different search than the one
        // that produced these rows.
        assert_eq!(s.vault_query, query);
        assert!(s.vault_has_more);
    }

    #[test]
    fn featured_mods_are_stored_for_the_search_filter() {
        let mut s = ReplayState::default();
        reduce(
            &mut s,
            &ReplayEvent::FeaturedModsLoaded {
                mods: vec!["faf".into(), "ladder1v1".into()],
            },
        );
        assert_eq!(s.featured_mods, vec!["faf", "ladder1v1"]);
    }

    #[test]
    fn vault_load_failure_records_reason() {
        let mut s = ReplayState::default();
        reduce(
            &mut s,
            &ReplayEvent::VaultLoadFailed {
                reason: "not logged in".into(),
            },
        );
        assert_eq!(
            s.vault_status,
            VaultStatus::Failed {
                reason: "not logged in".into()
            }
        );
    }

    fn local_replay(path: &str) -> LocalReplay {
        LocalReplay {
            path: path.into(),
            file_name: path.into(),
            uid: Some(1),
            map: "scmp_009".into(),
            mod_name: "faf".into(),
            title: "1700+ !!!".into(),
            recorder: "host".into(),
            start_time: Some(1_700_000_000),
            duration_seconds: Some(1_530),
            modified_time: 1_700_000_100,
            file_size_bytes: 1_024,
            num_players: 2,
            teams: vec![LocalReplayTeam {
                team: "1".into(),
                players: vec![
                    LocalReplayPlayer {
                        name: "host".into(),
                        faction: None,
                        rating: None,
                        ai: false,
                        country: None,
                    },
                    LocalReplayPlayer {
                        name: "guest".into(),
                        faction: None,
                        rating: None,
                        ai: false,
                        country: None,
                    },
                ],
            }],
            average_rating: None,
            sim_mods: vec![],
            status: LocalReplayStatus::Complete,
            watchable: true,
            game_version: None,
        }
    }

    #[test]
    fn local_loading_then_loaded() {
        let mut s = ReplayState::default();
        assert_eq!(s.local_status, VaultStatus::Idle);
        reduce(&mut s, &ReplayEvent::LocalLoading);
        assert_eq!(s.local_status, VaultStatus::Loading);
        reduce(
            &mut s,
            &ReplayEvent::LocalLoaded {
                replays: vec![local_replay("a.fafreplay")],
            },
        );
        assert_eq!(s.local_status, VaultStatus::Ready);
        assert_eq!(s.local.len(), 1);
    }

    #[test]
    fn deleting_local_replay_removes_only_that_path() {
        let mut s = ReplayState {
            local: vec![local_replay("a.fafreplay"), local_replay("b.fafreplay")],
            local_status: VaultStatus::Ready,
            ..Default::default()
        };
        reduce(
            &mut s,
            &ReplayEvent::LocalDeleted {
                path: "a.fafreplay".into(),
            },
        );
        assert_eq!(s.local, vec![local_replay("b.fafreplay")]);
    }

    #[test]
    fn downloading_a_vault_replay_adds_it_to_the_local_library() {
        let mut state = ReplayState::default();
        reduce(&mut state, &ReplayEvent::VaultDownloadStarted { uid: 42 });
        assert_eq!(
            state.download_status,
            ReplayDownloadStatus::Downloading {
                uid: 42,
                progress: None
            }
        );

        let mut replay = local_replay("42.fafreplay");
        replay.uid = Some(42);
        reduce(
            &mut state,
            &ReplayEvent::VaultDownloaded {
                uid: 42,
                replay: replay.clone(),
            },
        );

        assert_eq!(state.local, vec![replay.clone()]);
        assert_eq!(
            state.local_status,
            VaultStatus::Idle,
            "a download must not claim the full local directory has been scanned"
        );
        assert_eq!(
            state.download_status,
            ReplayDownloadStatus::Downloaded {
                uid: 42,
                path: replay.path,
            }
        );
    }

    #[test]
    fn a_failed_vault_download_keeps_the_reason_and_uid() {
        let mut state = ReplayState::default();
        reduce(
            &mut state,
            &ReplayEvent::VaultDownloadFailed {
                uid: 7,
                reason: "not uploaded yet".into(),
            },
        );
        assert_eq!(
            state.download_status,
            ReplayDownloadStatus::Failed {
                uid: 7,
                reason: "not uploaded yet".into(),
            }
        );
    }

    #[test]
    fn local_load_failure_records_reason() {
        let mut s = ReplayState::default();
        reduce(
            &mut s,
            &ReplayEvent::LocalLoadFailed {
                reason: "folder missing".into(),
            },
        );
        assert_eq!(
            s.local_status,
            VaultStatus::Failed {
                reason: "folder missing".into()
            }
        );
    }

    /// The read of a vault replay, which its game id names.
    fn game(uid: i32) -> String {
        replay_read_key(uid, None)
    }

    /// The read of a file whose header names no game, which only its path
    /// tells apart from every other such file.
    fn file(path: &str) -> String {
        replay_read_key(0, Some(path))
    }

    const FILE_A: &str = "C:/replays/skirmish-a.fafreplay";
    const FILE_B: &str = "C:/replays/skirmish-b.fafreplay";

    fn analysis(key: &str) -> ReplayAnalysis {
        ReplayAnalysis {
            key: key.into(),
            ticks: 3_000,
            ..Default::default()
        }
    }

    fn analysis_loading(key: &str) -> ReplayEvent {
        ReplayEvent::AnalysisLoading { key: key.into() }
    }

    fn analysis_loaded(key: &str) -> ReplayEvent {
        ReplayEvent::AnalysisLoaded {
            analysis: analysis(key),
        }
    }

    fn analysis_failed(key: &str, reason: &str) -> ReplayEvent {
        ReplayEvent::AnalysisFailed {
            key: key.into(),
            reason: reason.into(),
        }
    }

    fn details_loading(key: &str) -> ReplayEvent {
        ReplayEvent::DetailsLoading { key: key.into() }
    }

    fn details_loaded(key: &str, details: ReplayDetails) -> ReplayEvent {
        ReplayEvent::DetailsLoaded {
            key: key.into(),
            details,
        }
    }

    fn details_failed(key: &str, reason: &str) -> ReplayEvent {
        ReplayEvent::DetailsFailed {
            key: key.into(),
            reason: reason.into(),
        }
    }

    fn read_error(key: &str, reason: &str) -> Option<ReplayReadError> {
        Some(ReplayReadError {
            key: key.into(),
            reason: reason.into(),
        })
    }

    #[test]
    fn a_read_is_named_by_its_game_id_or_else_by_its_file() {
        assert_eq!(replay_read_key(123, None), "uid:123");
        // A downloaded or recorded copy of a vault game is that game: the
        // online panel and the local one share what reading it says.
        assert_eq!(
            replay_read_key(123, Some("C:/replays/123.fafreplay")),
            "uid:123"
        );
        // Without a game id the file is all there is to tell two apart by.
        assert_eq!(
            replay_read_key(0, Some(FILE_A)),
            "path:c:/replays/skirmish-a.fafreplay"
        );
        assert_ne!(file(FILE_A), file(FILE_B));
        assert_eq!(replay_read_key(-1, Some(FILE_A)), file(FILE_A));
        // And with neither, there is nothing to name it by but the zero.
        assert_eq!(replay_read_key(0, None), "uid:0");
        assert_eq!(replay_read_key(0, Some("")), "uid:0");
    }

    #[test]
    fn one_file_spelt_two_ways_is_one_read() {
        // The library's scan, a file handed to the client by the shell and a
        // path typed by hand all name this one file. Each used to be a read
        // of its own, so the panel read the same file again.
        for spelling in [
            "C:\\Replays\\Skirmish-A.fafreplay",
            "c:/replays/skirmish-a.fafreplay",
            "C:/Replays//Skirmish-A.fafreplay",
            "C:\\Replays\\.\\Skirmish-A.fafreplay",
            "C:\\Replays\\old\\..\\Skirmish-A.fafreplay",
            "C:/Replays/Skirmish-A.fafreplay/",
        ] {
            assert_eq!(
                replay_read_key(0, Some(spelling)),
                "path:c:/replays/skirmish-a.fafreplay",
                "{spelling} is the same file"
            );
        }
        // A UNC share is a Windows path too, and keeps its two leading slashes.
        assert_eq!(
            normalize_replay_path("\\\\NAS\\Replays\\\\Game.fafreplay"),
            "//nas/replays/game.fafreplay"
        );
        // Any other path is case-sensitive, because its filesystem is.
        assert_eq!(
            normalize_replay_path("/home/ada/Replays/./old/../Game.fafreplay"),
            "/home/ada/Replays/Game.fafreplay"
        );
        assert_ne!(
            replay_read_key(0, Some("/home/ada/Game.fafreplay")),
            replay_read_key(0, Some("/home/ada/game.fafreplay"))
        );
    }

    #[test]
    fn a_path_normalises_by_its_text_alone() {
        // The root is as far up as `..` goes; a relative path keeps the ones
        // it cannot resolve, and one that resolves to nothing is `.`.
        assert_eq!(normalize_replay_path("/../a"), "/a");
        assert_eq!(normalize_replay_path("C:\\..\\a"), "c:/a");
        assert_eq!(normalize_replay_path("../a/./b/.."), "../a");
        assert_eq!(normalize_replay_path("a/.."), ".");
        assert_eq!(normalize_replay_path("/"), "/");
        assert_eq!(normalize_replay_path("C:\\"), "c:/");
        // A drive followed by a relative path stays relative to that drive.
        assert_eq!(normalize_replay_path("D:Replays\\A"), "d:replays/a");
        // Non-ASCII letters fold too, the way Windows compares them.
        assert_eq!(
            normalize_replay_path("C:\\Users\\JÖRG\\Ärger.fafreplay"),
            "c:/users/jörg/ärger.fafreplay"
        );
        // Normalising twice changes nothing.
        let once = normalize_replay_path("C:\\A\\..\\B\\\\c\\");
        assert_eq!(normalize_replay_path(&once), once);
    }

    #[test]
    fn two_files_without_a_game_id_each_keep_their_own_reads() {
        // The reader opens one skirmish's insights, then another's. Both
        // files are uid 0, and the second panel used to find the first one's
        // analysis already "there" and never ask for its own.
        let mut s = ReplayState::default();
        let details_a = ReplayDetails {
            sim_seconds: 600,
            ..ReplayDetails::default()
        };
        let details_b = ReplayDetails {
            sim_seconds: 1_200,
            ..ReplayDetails::default()
        };

        reduce(&mut s, &details_loading(&file(FILE_A)));
        reduce(&mut s, &analysis_loading(&file(FILE_A)));
        reduce(&mut s, &details_loaded(&file(FILE_A), details_a.clone()));
        reduce(&mut s, &analysis_loaded(&file(FILE_A)));
        assert_eq!(s.analysis, Some(analysis(&file(FILE_A))));

        // B's panel asks for its own reads, and A's analysis is not B's.
        reduce(&mut s, &details_loading(&file(FILE_B)));
        reduce(&mut s, &analysis_loading(&file(FILE_B)));
        assert_eq!(s.analysis, None, "B's panel must not draw A's analysis");
        assert_eq!(s.analysis_loading, Some(file(FILE_B)));
        assert_eq!(s.details_loading, Some(file(FILE_B)));
        assert_eq!(s.replay_details.get(&file(FILE_B)), None);

        reduce(&mut s, &details_loaded(&file(FILE_B), details_b.clone()));
        reduce(&mut s, &analysis_loaded(&file(FILE_B)));
        assert_eq!(s.analysis, Some(analysis(&file(FILE_B))));
        assert_eq!(s.replay_details.get(&file(FILE_A)), Some(&details_a));
        assert_eq!(s.replay_details.get(&file(FILE_B)), Some(&details_b));
        assert_eq!(s.details_loading, None);
        assert_eq!(s.analysis_loading, None);
    }

    #[test]
    fn a_late_answer_for_one_file_never_lands_for_another() {
        // A is opened, then B before A has been walked. A answers last.
        let mut s = ReplayState::default();
        reduce(&mut s, &details_loading(&file(FILE_A)));
        reduce(&mut s, &analysis_loading(&file(FILE_A)));
        reduce(&mut s, &details_loading(&file(FILE_B)));
        reduce(&mut s, &analysis_loading(&file(FILE_B)));

        reduce(&mut s, &analysis_loaded(&file(FILE_A)));
        assert_eq!(s.analysis, None, "A's analysis landed in B's slot");
        assert_eq!(s.analysis_loading, Some(file(FILE_B)));

        reduce(
            &mut s,
            &details_loaded(&file(FILE_A), ReplayDetails::default()),
        );
        assert_eq!(s.details_loading, Some(file(FILE_B)));
        assert_eq!(s.replay_details.get(&file(FILE_B)), None);

        // B's own answers still land once they come.
        reduce(&mut s, &analysis_loaded(&file(FILE_B)));
        assert_eq!(s.analysis, Some(analysis(&file(FILE_B))));
        // And A's answering again afterwards does not replace them.
        reduce(&mut s, &analysis_loaded(&file(FILE_A)));
        assert_eq!(s.analysis, Some(analysis(&file(FILE_B))));
    }

    #[test]
    fn read_failures_are_kept_per_file() {
        let mut s = ReplayState::default();
        reduce(&mut s, &details_loading(&file(FILE_A)));
        reduce(&mut s, &analysis_loading(&file(FILE_A)));
        reduce(&mut s, &details_loading(&file(FILE_B)));
        reduce(&mut s, &analysis_loading(&file(FILE_B)));

        // A's failures arrive while B is the one asked about: not B's.
        reduce(&mut s, &details_failed(&file(FILE_A), "A is truncated"));
        reduce(&mut s, &analysis_failed(&file(FILE_A), "A is truncated"));
        assert_eq!(s.details_error, None);
        assert_eq!(s.analysis_error, None);
        assert_eq!(s.details_loading, Some(file(FILE_B)));
        assert_eq!(s.analysis_loading, Some(file(FILE_B)));

        // B's own failures carry B's key, so A's panel would not show them.
        reduce(&mut s, &details_failed(&file(FILE_B), "B is truncated"));
        reduce(&mut s, &analysis_failed(&file(FILE_B), "B is truncated"));
        assert_eq!(s.details_error, read_error(&file(FILE_B), "B is truncated"));
        assert_eq!(
            s.analysis_error,
            read_error(&file(FILE_B), "B is truncated")
        );

        // A answering late is stored under A and leaves B's failure alone.
        reduce(
            &mut s,
            &details_loaded(&file(FILE_A), ReplayDetails::default()),
        );
        assert_eq!(s.details_error, read_error(&file(FILE_B), "B is truncated"));
    }

    #[test]
    fn a_late_analysis_never_replaces_the_newer_requests_answer() {
        // The reader opens replay 1, then replay 2 before 1 has been walked.
        // Both reads run at once and 2 is the shorter file.
        let mut s = ReplayState::default();
        reduce(&mut s, &analysis_loading(&game(1)));
        reduce(&mut s, &analysis_loading(&game(2)));
        reduce(&mut s, &analysis_loaded(&game(2)));
        assert_eq!(s.analysis, Some(analysis(&game(2))));
        assert_eq!(s.analysis_loading, None);

        reduce(&mut s, &analysis_loaded(&game(1)));
        assert_eq!(
            s.analysis,
            Some(analysis(&game(2))),
            "replay 2's panel would reject 1's analysis and wait for nothing"
        );
        assert_eq!(s.analysis_loading, None);
    }

    #[test]
    fn an_older_analysis_landing_first_leaves_the_newer_one_loading() {
        let mut s = ReplayState::default();
        reduce(&mut s, &analysis_loading(&game(1)));
        reduce(&mut s, &analysis_loading(&game(2)));
        reduce(&mut s, &analysis_loaded(&game(1)));
        assert_eq!(s.analysis, None);
        assert_eq!(s.analysis_loading, Some(game(2)));

        reduce(&mut s, &analysis_loaded(&game(2)));
        assert_eq!(s.analysis, Some(analysis(&game(2))));
        assert_eq!(s.analysis_loading, None);
    }

    #[test]
    fn a_late_analysis_failure_never_shows_for_the_newer_request() {
        let mut s = ReplayState::default();
        reduce(&mut s, &analysis_loading(&game(1)));
        reduce(&mut s, &analysis_loading(&game(2)));
        reduce(&mut s, &analysis_loaded(&game(2)));
        reduce(
            &mut s,
            &analysis_failed(&game(1), "the replay file could not be read"),
        );
        assert_eq!(s.analysis_error, None);
        assert_eq!(s.analysis, Some(analysis(&game(2))));

        // While 2 is still being walked, 1's failure is not 2's either.
        reduce(&mut s, &analysis_loading(&game(1)));
        reduce(&mut s, &analysis_loading(&game(2)));
        reduce(&mut s, &analysis_failed(&game(1), "late"));
        assert_eq!(s.analysis_error, None);
        assert_eq!(s.analysis_loading, Some(game(2)));

        // The newest request's own failure is recorded, with its key.
        reduce(&mut s, &analysis_failed(&game(2), "truncated"));
        assert_eq!(s.analysis_error, read_error(&game(2), "truncated"));
        assert_eq!(s.analysis_loading, None);
    }

    #[test]
    fn a_late_details_failure_never_shows_for_the_newer_request() {
        let mut s = ReplayState::default();
        reduce(&mut s, &details_loading(&game(1)));
        reduce(&mut s, &details_loading(&game(2)));
        reduce(&mut s, &details_loaded(&game(2), ReplayDetails::default()));
        reduce(
            &mut s,
            &details_failed(&game(1), "the replay body is truncated"),
        );
        assert_eq!(s.details_error, None);
        assert!(s.replay_details.contains_key(&game(2)));
        assert_eq!(s.details_loading, None);
    }

    #[test]
    fn a_late_details_answer_keeps_the_newer_requests_failure() {
        // 2 failed; 1 finishing afterwards is stored under its own key and
        // must not wipe the failure the open panel is showing.
        let mut s = ReplayState::default();
        reduce(&mut s, &details_loading(&game(1)));
        reduce(&mut s, &details_loading(&game(2)));
        reduce(&mut s, &details_failed(&game(2), "not uploaded yet"));
        reduce(&mut s, &details_loaded(&game(1), ReplayDetails::default()));
        assert!(s.replay_details.contains_key(&game(1)));
        assert_eq!(s.details_error, read_error(&game(2), "not uploaded yet"));
    }

    #[test]
    fn only_the_most_recently_stored_details_are_kept() {
        // A long session of opening panels: one entry per replay looked at,
        // and nothing used to take one away again.
        let mut s = ReplayState::default();
        let total = REPLAY_DETAILS_KEPT as i32 + 5;
        for uid in 1..=total {
            reduce(
                &mut s,
                &details_loaded(&game(uid), ReplayDetails::default()),
            );
        }
        assert_eq!(s.replay_details.len(), REPLAY_DETAILS_KEPT);
        assert_eq!(s.replay_details_order.len(), REPLAY_DETAILS_KEPT);
        for uid in 1..=5 {
            assert!(
                !s.replay_details.contains_key(&game(uid)),
                "the oldest go first"
            );
        }
        assert_eq!(s.replay_details_order.first(), Some(&game(6)));
        assert_eq!(s.replay_details_order.last(), Some(&game(total)));
        for key in &s.replay_details_order {
            assert!(
                s.replay_details.contains_key(key),
                "{key} is listed and kept"
            );
        }
    }

    #[test]
    fn details_answered_again_count_as_stored_last() {
        // The panel on replay 1 asks again, and its answer is the newest, so
        // it is not the entry the next one pushes out.
        let mut s = ReplayState::default();
        for uid in 1..=REPLAY_DETAILS_KEPT as i32 {
            reduce(
                &mut s,
                &details_loaded(&game(uid), ReplayDetails::default()),
            );
        }
        let fresh = ReplayDetails {
            sim_seconds: 900,
            ..ReplayDetails::default()
        };
        reduce(&mut s, &details_loaded(&game(1), fresh.clone()));
        assert_eq!(s.replay_details_order.len(), REPLAY_DETAILS_KEPT);
        assert_eq!(s.replay_details_order.last(), Some(&game(1)));

        reduce(
            &mut s,
            &details_loaded(&game(999), ReplayDetails::default()),
        );
        assert_eq!(s.replay_details.get(&game(1)), Some(&fresh));
        assert!(
            !s.replay_details.contains_key(&game(2)),
            "2 is now the oldest"
        );
        assert_eq!(s.replay_details.len(), REPLAY_DETAILS_KEPT);
    }

    #[test]
    fn an_online_lookup_walks_from_loading_to_an_answer() {
        let mut s = ReplayState::default();
        assert!(s.online_lookups.is_empty(), "nobody has asked yet");

        reduce(&mut s, &ReplayEvent::OnlineLookupStarted { uid: 21 });
        assert_eq!(s.online_lookups.get(&21), Some(&OnlineLookup::Loading));

        let replay = vault_replay(21);
        reduce(
            &mut s,
            &ReplayEvent::OnlineLookupFinished {
                uid: 21,
                replay: Some(Box::new(replay.clone())),
            },
        );
        assert_eq!(
            s.online_lookups.get(&21),
            Some(&OnlineLookup::Found(Box::new(replay)))
        );
    }

    #[test]
    fn a_game_the_vault_does_not_have_is_a_result_not_a_failure() {
        let mut s = ReplayState::default();
        reduce(
            &mut s,
            &ReplayEvent::OnlineLookupFinished {
                uid: 21,
                replay: None,
            },
        );
        assert_eq!(s.online_lookups.get(&21), Some(&OnlineLookup::Missing));

        reduce(
            &mut s,
            &ReplayEvent::OnlineLookupFailed {
                uid: 22,
                reason: "offline".into(),
            },
        );
        assert_eq!(
            s.online_lookups.get(&22),
            Some(&OnlineLookup::Failed {
                reason: "offline".into()
            }),
            "a lookup that never reached the server must not read as 'no such game'"
        );
    }

    fn found(uid: i32) -> ReplayEvent {
        ReplayEvent::OnlineLookupFinished {
            uid,
            replay: Some(Box::new(vault_replay(uid))),
        }
    }

    #[test]
    fn only_the_most_recently_stored_lookups_are_kept() {
        // A long session on the live tab: a lookup per game that started
        // while it was open, and nothing used to take one away again.
        let mut s = ReplayState::default();
        let total = ONLINE_LOOKUPS_KEPT as i32 + 5;
        for uid in 1..=total {
            reduce(&mut s, &ReplayEvent::OnlineLookupStarted { uid });
            reduce(&mut s, &found(uid));
        }
        assert_eq!(s.online_lookups.len(), ONLINE_LOOKUPS_KEPT);
        assert_eq!(s.online_lookups_order.len(), ONLINE_LOOKUPS_KEPT);
        for uid in 1..=5 {
            assert!(!s.online_lookups.contains_key(&uid), "the oldest go first");
        }
        assert_eq!(s.online_lookups_order.first(), Some(&6));
        assert_eq!(s.online_lookups_order.last(), Some(&total));
        for uid in &s.online_lookups_order {
            assert!(
                s.online_lookups.contains_key(uid),
                "{uid} is listed and kept"
            );
        }
    }

    #[test]
    fn a_lookup_answered_again_counts_as_stored_last() {
        // A panel that found its entry gone asks again, and the answer is the
        // newest, so it is not the entry the next one pushes out.
        let mut s = ReplayState::default();
        for uid in 1..=ONLINE_LOOKUPS_KEPT as i32 {
            reduce(&mut s, &found(uid));
        }
        reduce(
            &mut s,
            &ReplayEvent::OnlineLookupFailed {
                uid: 1,
                reason: "offline".into(),
            },
        );
        assert_eq!(s.online_lookups_order.last(), Some(&1));
        reduce(&mut s, &found(5_000));
        assert!(s.online_lookups.contains_key(&1));
        assert!(!s.online_lookups.contains_key(&2), "2 is now the oldest");
        assert_eq!(s.online_lookups.len(), ONLINE_LOOKUPS_KEPT);
    }

    #[test]
    fn the_largest_batch_of_cards_keeps_every_one_of_its_lookups() {
        // The live tab claims a whole list of cards at once and answers it in
        // pieces. With the store already full of older games, none of the
        // list's own claims or answers may push out another of the list's.
        let mut s = ReplayState::default();
        for uid in 1..=ONLINE_LOOKUPS_KEPT as i32 {
            reduce(&mut s, &found(uid));
        }
        let cards: Vec<i32> = (10_001..=10_400).collect();
        for uid in &cards {
            reduce(&mut s, &ReplayEvent::OnlineLookupStarted { uid: *uid });
        }
        for uid in &cards {
            reduce(&mut s, &found(*uid));
        }
        for uid in &cards {
            assert!(
                matches!(s.online_lookups.get(uid), Some(OnlineLookup::Found(_))),
                "card {uid} lost its lookup"
            );
        }
        assert_eq!(s.online_lookups.len(), ONLINE_LOOKUPS_KEPT);
    }

    fn resolved(uids: impl IntoIterator<Item = i32>) -> ReplayEvent {
        ReplayEvent::MapsResolved {
            maps: uids
                .into_iter()
                .map(|uid| ResolvedReplayMap {
                    uid,
                    map: format!("map_{uid}"),
                })
                .collect(),
        }
    }

    #[test]
    fn resolved_maps_keep_the_newest_and_never_the_page_on_screen() {
        // The page on screen asked first, so its games are the oldest stored.
        // Single games resolved for replays being prepared fill the rest. The
        // page asks again for whatever it finds missing, so dropping one of
        // its games would bring it straight back and push out the next.
        let mut s = ReplayState {
            vault: (1..=100).map(row).collect(),
            ..ReplayState::default()
        };
        reduce(&mut s, &resolved(1..=100));
        let others = RESOLVED_MAPS_KEPT as i32 + 20;
        for uid in 1_001..=1_000 + others {
            reduce(&mut s, &resolved([uid]));
        }
        assert_eq!(s.resolved_maps.len(), RESOLVED_MAPS_KEPT);
        assert_eq!(s.resolved_maps_order.len(), RESOLVED_MAPS_KEPT);
        for uid in 1..=100 {
            assert_eq!(
                s.resolved_maps.get(&uid).map(String::as_str),
                Some(format!("map_{uid}").as_str()),
                "game {uid} of the page on screen was dropped"
            );
        }
        // What went is the oldest of the rest.
        assert!(!s.resolved_maps.contains_key(&1_001));
        assert!(s.resolved_maps.contains_key(&(1_000 + others)));
        for uid in &s.resolved_maps_order {
            assert!(
                s.resolved_maps.contains_key(uid),
                "{uid} is listed and kept"
            );
        }
    }

    #[test]
    fn once_the_page_moves_on_its_games_age_out_like_any_other() {
        let mut s = ReplayState {
            vault: (1..=100).map(row).collect(),
            ..ReplayState::default()
        };
        reduce(&mut s, &resolved(1..=100));
        s.vault = (201..=300).map(row).collect();
        reduce(&mut s, &resolved(201..=300));
        for uid in 1_001..=1_000 + RESOLVED_MAPS_KEPT as i32 {
            reduce(&mut s, &resolved([uid]));
        }
        assert!(!s.resolved_maps.contains_key(&1), "the page left goes");
        assert!(s.resolved_maps.contains_key(&201), "the page shown stays");
        assert_eq!(s.resolved_maps.len(), RESOLVED_MAPS_KEPT);
    }
}
