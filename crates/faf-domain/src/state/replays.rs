//! Replays slice: watching a live game or a local `.fafreplay` file.
//!
//! Mirrors the Python client's `fa/replaylivestreamer.py` / `fa/replay.py`: a
//! live watch fetches a WebSocket relay for an in-progress game, a file watch
//! decompresses a recorded replay. Both converge on the same FA `/replay`
//! launch; this slice only tracks the resulting status, the actual IO lives
//! behind [`crate`]'s port boundary (`ReplayPort` in `faf-app`).

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
    /// The game this describes, so a late answer for one replay is not drawn
    /// over another.
    pub uid: i32,
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
    /// Deferred replay metadata keyed by replay uid. Details are loaded only
    /// when requested because parsing the command stream can be expensive.
    #[serde(default)]
    pub replay_details: std::collections::HashMap<i32, ReplayDetails>,
    #[serde(default)]
    pub details_loading: Option<i32>,
    #[serde(default)]
    pub details_error: Option<String>,
    /// The analysed replay, and only the most recent one.
    ///
    /// One of these is megabytes of orders and targets. Keeping a map of them
    /// the way the details are kept would grow the state by a replay every
    /// time somebody opened a panel, so the newest answer replaces the last.
    #[serde(default)]
    pub analysis: Option<ReplayAnalysis>,
    #[serde(default)]
    pub analysis_loading: Option<i32>,
    #[serde(default)]
    pub analysis_error: Option<String>,
    /// Vault answers for single game ids, keyed by that id. Filled by
    /// [`ReplayCommand::LookUpOnline`] on behalf of local replays; see
    /// [`OnlineLookup`].
    #[serde(default)]
    pub online_lookups: std::collections::HashMap<i32, OnlineLookup>,
    /// Map folders read out of the replay files themselves, keyed by game id.
    /// An empty value means the file was read and named no map, so the view
    /// stops asking. See [`ReplayCommand::ResolveMaps`].
    #[serde(default)]
    pub resolved_maps: std::collections::HashMap<i32, String>,
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
    VaultDownloaded {
        uid: i32,
        replay: LocalReplay,
    },
    VaultDownloadFailed {
        uid: i32,
        reason: String,
    },
    LocalLoadFailed {
        reason: String,
    },
    DetailsLoading {
        uid: i32,
    },
    DetailsLoaded {
        uid: i32,
        details: ReplayDetails,
    },
    DetailsFailed {
        uid: i32,
        reason: String,
    },
    AnalysisLoading {
        uid: i32,
    },
    AnalysisLoaded {
        analysis: ReplayAnalysis,
    },
    AnalysisFailed {
        uid: i32,
        reason: String,
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
    /// Load the deferred game options, in-game chat, and FAF version from a
    /// replay body.
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
    /// after, and they arrive while this is still walking.
    #[serde(rename_all = "camelCase")]
    LoadAnalysis {
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
        }
        ReplayEvent::Playing { uid, warning } => {
            state.status = ReplayStatus::Playing { uid: *uid };
            state.last_warning = warning.clone();
            // `WatchVault` downloads into the cache as part of the playback
            // operation. Its successful completion has no LocalReplay record,
            // so clear only the transient download indicator here. Explicit
            // save-to-library downloads still finish through VaultDownloaded.
            if matches!(
                state.download_status,
                ReplayDownloadStatus::Downloading { .. }
            ) {
                state.download_status = ReplayDownloadStatus::Idle;
            }
        }
        ReplayEvent::Failed { reason } => {
            state.status = ReplayStatus::Failed {
                reason: reason.clone(),
            };
            if matches!(
                state.download_status,
                ReplayDownloadStatus::Downloading { .. }
            ) {
                state.download_status = ReplayDownloadStatus::Idle;
            }
        }
        ReplayEvent::Closed => {
            state.status = ReplayStatus::Idle;
            // A `WatchVault` called off part-way leaves its download showing in
            // the shared status task otherwise, with nothing left to finish it.
            if matches!(
                state.download_status,
                ReplayDownloadStatus::Downloading { .. }
            ) {
                state.download_status = ReplayDownloadStatus::Idle;
            }
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
            state.download_status = ReplayDownloadStatus::Downloading { uid: *uid };
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
        ReplayEvent::DetailsLoading { uid } => {
            state.details_loading = Some(*uid);
            state.details_error = None;
        }
        ReplayEvent::DetailsLoaded { uid, details } => {
            if state.details_loading == Some(*uid) {
                state.details_loading = None;
            }
            state.replay_details.insert(*uid, details.clone());
            state.details_error = None;
        }
        ReplayEvent::DetailsFailed { uid, reason } => {
            if state.details_loading == Some(*uid) {
                state.details_loading = None;
            }
            state.details_error = Some(reason.clone());
        }
        ReplayEvent::AnalysisLoading { uid } => {
            state.analysis_loading = Some(*uid);
            state.analysis_error = None;
            // The panel being opened is not the one the held analysis is of.
            if state.analysis.as_ref().is_some_and(|held| held.uid != *uid) {
                state.analysis = None;
            }
        }
        ReplayEvent::AnalysisLoaded { analysis } => {
            if state.analysis_loading == Some(analysis.uid) {
                state.analysis_loading = None;
            }
            state.analysis = Some(analysis.clone());
            state.analysis_error = None;
        }
        ReplayEvent::AnalysisFailed { uid, reason } => {
            if state.analysis_loading == Some(*uid) {
                state.analysis_loading = None;
            }
            state.analysis_error = Some(reason.clone());
        }
        ReplayEvent::OnlineLookupStarted { uid } => {
            state.online_lookups.insert(*uid, OnlineLookup::Loading);
        }
        ReplayEvent::MapsResolved { maps } => {
            for resolved in maps {
                state
                    .resolved_maps
                    .insert(resolved.uid, resolved.map.clone());
            }
        }
        ReplayEvent::OnlineLookupFinished { uid, replay } => {
            let outcome = match replay {
                Some(replay) => OnlineLookup::Found(replay.clone()),
                None => OnlineLookup::Missing,
            };
            state.online_lookups.insert(*uid, outcome);
        }
        ReplayEvent::OnlineLookupFailed { uid, reason } => {
            state.online_lookups.insert(
                *uid,
                OnlineLookup::Failed {
                    reason: reason.clone(),
                },
            );
        }
    }
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

    #[test]
    fn playback_completion_clears_only_the_transient_watch_download() {
        let mut s = ReplayState::default();
        reduce(&mut s, &ReplayEvent::VaultDownloadStarted { uid: 42 });
        reduce(
            &mut s,
            &ReplayEvent::Playing {
                uid: Some(42),
                warning: None,
            },
        );
        assert_eq!(s.download_status, ReplayDownloadStatus::Idle);

        // A completed save-to-library download is a separate terminal state
        // and should remain available to the download button.
        let replay = local_replay("42.fafreplay");
        reduce(&mut s, &ReplayEvent::VaultDownloaded { uid: 42, replay });
        assert!(matches!(
            s.download_status,
            ReplayDownloadStatus::Downloaded { uid: 42, .. }
        ));
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
                        country: None,
                    },
                    LocalReplayPlayer {
                        name: "guest".into(),
                        faction: None,
                        rating: None,
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
            ReplayDownloadStatus::Downloading { uid: 42 }
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
}
