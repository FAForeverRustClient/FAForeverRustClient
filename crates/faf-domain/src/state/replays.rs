//! Replays slice: watching a live game or a local `.fafreplay` file.
//!
//! Mirrors the Python client's `fa/replaylivestreamer.py` / `fa/replay.py`: a
//! live watch fetches a WebSocket relay for an in-progress game, a file watch
//! decompresses a recorded replay. Both converge on the same FA `/replay`
//! launch; this slice only tracks the resulting status, the actual IO lives
//! behind [`crate`]'s port boundary (`ReplayPort` in `faf-app`).

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
    pub reviews_average: Option<f32>,
    pub reviews_count: Option<i32>,
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
    /// 1=UEF, 2=Aeon, 3=Cybran, 4=Seraphim, 5=Random: the lobby selection
    /// recorded by `playerStats.faction`, not the faction Random resolved to.
    pub faction: Option<i32>,
    /// `round(mean - 3*deviation)` at game time, the same "displayed rating"
    /// formula the Python and Java clients use.
    pub rating: Option<i32>,
    /// Server-recorded game result (`VICTORY`, `DEFEAT`, `DRAW`, ...).
    /// Empty when older games did not record an outcome.
    pub outcome: String,
    /// Simulation score at the end of the game, when recorded.
    pub score: Option<i32>,
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
    pub modified_time: u32,
    pub file_size_bytes: u32,
    pub num_players: i32,
    pub teams: Vec<LocalReplayTeam>,
    /// Average displayed rating from the replay body header, when recorded.
    pub average_rating: Option<i32>,
    pub sim_mods: Vec<String>,
    pub status: LocalReplayStatus,
    pub watchable: bool,
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
}

/// How much trustworthy metadata was available without decoding the full replay
/// command stream. Matches the Python client's complete/incomplete/broken/
/// legacy buckets, while keeping incomplete and legacy files playable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LocalReplayStatus {
    Complete,
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
    /// The replay session ended (game process exited / stream closed): back
    /// to idle so the UI can start another one.
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
    /// Download and play a vault replay by its game id.
    WatchVault {
        uid: i32,
    },
    /// Download a vault replay into the shared local replay library without
    /// launching Forged Alliance.
    DownloadVault {
        uid: i32,
    },
    /// Scan the shared FAF replay folder for local `.fafreplay` files.
    LoadLocal,
    /// Permanently remove one replay from the shared replay folder. The port
    /// validates that the resolved file is directly inside that folder.
    DeleteLocal {
        path: String,
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
        ReplayEvent::Closed => state.status = ReplayStatus::Idle,
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTED: u32 = 1_800_000_000;

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
            replay_available: true,
            duration_seconds: None,
            game_duration_seconds: None,
            teams: Vec::new(),
            average_rating: None,
            reviews_average: None,
            reviews_count: None,
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
                    },
                    LocalReplayPlayer {
                        name: "guest".into(),
                        faction: None,
                        rating: None,
                    },
                ],
            }],
            average_rating: None,
            sim_mods: vec![],
            status: LocalReplayStatus::Complete,
            watchable: true,
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
}
