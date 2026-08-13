//! Replays slice — watching a live game or a local `.fafreplay` file.
//!
//! Mirrors the Python client's `fa/replaylivestreamer.py` / `fa/replay.py`: a
//! live watch fetches a WebSocket relay for an in-progress game, a file watch
//! decompresses a recorded replay. Both converge on the same FA `/replay`
//! launch; this slice only tracks the resulting status, the actual IO lives
//! behind [`crate`]'s port boundary (`ReplayPort` in `faf-app`).

use serde::{Deserialize, Serialize};
use specta::Type;

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

/// One entry in the global "newest replays" feed, as listed from the FAF
/// Data API (`GET /data/game`, no player filter — mirrors the Java client's
/// `OnlineReplayVaultController`'s `NEWEST` category). Just enough to render
/// a row and trigger a download+play — not the full search/filter model the
/// reference clients' vault tabs have (map/player/rating filters, "own
/// replays only" toggle, are a later phase).
// No `Eq` here (unlike the other structs in this file): `reviews_average` is
// an `f32`, which doesn't implement it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultReplay {
    pub uid: i32,
    /// `game.attributes.name` — the host-chosen lobby title (e.g. "all
    /// welcome", "1200+"), distinct from the map name.
    pub title: String,
    pub map: String,
    /// `mapVersion.thumbnailUrlSmall` straight from the API. Empty string if
    /// missing (e.g. a generated/hidden map) — the frontend treats that as
    /// "no thumbnail" rather than us modeling it as `Option`.
    pub map_thumbnail_url: String,
    pub mod_name: String,
    /// ISO 8601, straight from the API — rendering/formatting is a UI concern.
    pub start_time: String,
    /// Whether the file has actually finished uploading to content storage.
    /// A "newest replays" listing includes very recent/still-processing
    /// games too; both reference clients disable the Watch button until this
    /// is `true` rather than filtering the row out entirely.
    pub replay_available: bool,
    /// `endTime - startTime` in seconds. `None` if either timestamp is
    /// missing/unparseable (e.g. a game still in progress has no `endTime`).
    pub duration_seconds: Option<i32>,
    pub teams: Vec<ReplayTeam>,
    /// Average of all resolvable player ratings on the card — `None` if no
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
    /// 1=UEF, 2=Aeon, 3=Cybran, 4=Seraphim — matches the FAF API's
    /// `playerStats.faction` convention.
    pub faction: Option<i32>,
    /// `round(mean - 3*deviation)` at game time, the same "displayed rating"
    /// formula the Python and Java clients use.
    pub rating: Option<i32>,
}

/// One `.fafreplay` file already on disk, from the shared FAF replay folder
/// (`%ProgramData%\FAForever\replays` on Windows — every FAF client writes
/// here, mirrors `DataPrefs.getReplaysDirectory()` in the Java client). Read
/// from just the file's JSON header line, not the full compressed body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalReplay {
    pub path: String,
    pub uid: Option<i32>,
    pub map: String,
    pub mod_name: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReplayStatus {
    #[default]
    Idle,
    Connecting,
    /// FA has been launched. `uid` is `None` for a local file whose header
    /// failed to parse (playback still proceeds; we just can't label it).
    Playing { uid: Option<i32> },
    Failed { reason: String },
}

/// Where the vault list stands. Separate from [`ReplayStatus`] (playback) —
/// you can be browsing the vault (`Ready`) while also `Playing` a replay.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum VaultStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed { reason: String },
}

// No `Eq` (unlike most state structs): `VaultReplay` carries an `f32`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayState {
    pub status: ReplayStatus,
    /// A non-fatal issue from the last launch's prep steps (engine
    /// version/map staging — see `infra/game_updater.rs`), e.g. "could not
    /// stage map X". `None` means the last launch's prep was clean or none
    /// has happened yet. Separate from [`ReplayStatus::Failed`], which is
    /// for launches that didn't happen at all — this is for ones that did,
    /// but might misbehave in FA itself (stuck loading screen, etc.) because
    /// a non-fatal prep step failed. Cleared on the next [`ReplayEvent::Connecting`].
    pub last_warning: Option<String>,
    pub vault: Vec<VaultReplay>,
    pub vault_status: VaultStatus,
    pub local: Vec<LocalReplay>,
    pub local_status: VaultStatus,
}

// No `Eq`: `VaultLoaded` carries `VaultReplay`, which has an `f32` field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReplayEvent {
    Connecting,
    /// `warning` carries a non-fatal prep-step issue (see
    /// [`ReplayState::last_warning`]) — `None` when prep was clean/skipped.
    Playing { uid: Option<i32>, warning: Option<String> },
    Failed { reason: String },
    /// The replay session ended (game process exited / stream closed) — back
    /// to idle so the UI can start another one.
    Closed,
    VaultLoading,
    VaultLoaded { replays: Vec<VaultReplay> },
    VaultLoadFailed { reason: String },
    LocalLoading,
    LocalLoaded { replays: Vec<LocalReplay> },
    LocalLoadFailed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReplayCommand {
    WatchLive(LiveReplayTarget),
    /// Play a `.fafreplay`/`.scfareplay` file by path — used both for the
    /// file-picker flow and for watching a [`LocalReplay`] row.
    OpenFile { path: String },
    /// Fetch the global "newest replays" feed from the vault.
    LoadVault,
    /// Download and play a vault replay by its game id.
    WatchVault { uid: i32 },
    /// Scan the shared FAF replay folder for local `.fafreplay` files.
    LoadLocal,
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
        }
        ReplayEvent::Failed { reason } => {
            state.status = ReplayStatus::Failed {
                reason: reason.clone(),
            }
        }
        ReplayEvent::Closed => state.status = ReplayStatus::Idle,
        ReplayEvent::VaultLoading => state.vault_status = VaultStatus::Loading,
        ReplayEvent::VaultLoaded { replays } => {
            state.vault = replays.clone();
            state.vault_status = VaultStatus::Ready;
        }
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

    #[test]
    fn connecting_then_playing() {
        let mut s = ReplayState::default();
        assert_eq!(s.status, ReplayStatus::Idle);
        reduce(&mut s, &ReplayEvent::Connecting);
        assert_eq!(s.status, ReplayStatus::Connecting);
        reduce(
            &mut s,
            &ReplayEvent::Playing { uid: Some(42), warning: None },
        );
        assert_eq!(s.status, ReplayStatus::Playing { uid: Some(42) });
        assert_eq!(s.last_warning, None);
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
        reduce(
            &mut s,
            &ReplayEvent::VaultLoaded {
                replays: vec![vault_replay(1), vault_replay(2)],
            },
        );
        assert_eq!(s.vault_status, VaultStatus::Ready);
        assert_eq!(s.vault.len(), 2);
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
            uid: Some(1),
            map: "scmp_009".into(),
            mod_name: "faf".into(),
            title: "1700+ !!!".into(),
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
