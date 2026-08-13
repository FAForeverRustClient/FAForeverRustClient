//! Replay port — watching a live game or a local replay file.
//!
//! The impl fetches the replay-access relay (live) or decompresses a file,
//! then launches the game via [`crate::ports::ProcessPort::launch_replay`].
//! See `infra/replay.rs` for the real implementation and its protocol notes.

use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::{LiveReplayTarget, LocalReplay, VaultReplay};

#[async_trait]
pub trait ReplayPort: Send + Sync {
    /// Watch a game currently in progress. `player` is the identifier sent in
    /// the replay-server handshake — the server merges all players' streams,
    /// so any non-empty string works (mirrors the Python client's comment in
    /// `replaylivestreamer.py`). Same `Ok(Some(warning))`/`Err` meaning as
    /// [`Self::play_file`] (e.g. a custom map that couldn't be staged).
    async fn watch_live(
        &self,
        target: LiveReplayTarget,
        player: String,
    ) -> Result<Option<String>, String>;

    /// Play back a local `.fafreplay` (or legacy `.scfareplay`) file.
    ///
    /// `Ok(Some(warning))` means playback was launched but a non-fatal prep
    /// step failed (e.g. the replay's map couldn't be staged) — FA may still
    /// misbehave (stuck loading screen) even though this call "succeeded".
    /// `Err` means playback did not launch at all (e.g. the engine version
    /// couldn't be matched, which FA always refuses to load).
    async fn play_file(&self, path: PathBuf) -> Result<Option<String>, String>;

    /// List the global "newest replays" feed from the vault (FAF Data API
    /// `/data/game`, no player filter — mirrors the Java client's `NEWEST`
    /// category).
    async fn list_vault(&self) -> Result<Vec<VaultReplay>, String>;

    /// Download a vault replay by game id and play it (delegates to
    /// [`Self::play_file`] once downloaded — same `Ok(Some(warning))`/`Err`
    /// meaning).
    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String>;

    /// List `.fafreplay` files in the shared FAF replay folder (mirrors the
    /// Java client's `LocalReplayVaultController`).
    async fn list_local(&self) -> Result<Vec<LocalReplay>, String>;
}
